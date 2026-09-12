import { createHash } from "node:crypto"
import type { BigIntStats } from "node:fs"
import { lstat, open, opendir, realpath, stat, statfs } from "node:fs/promises"
import path from "node:path"
import type { FolderMappingPreview, FolderScanActivity, FolderScanIssue, MappingPreviewItem, SyncMode } from "../shared/contracts"
import {
  estimateManifestEncodedBytes as estimateEncodedBytesForFiles,
  MAX_LEGACY_MANIFEST_ENCODED_BYTES,
} from "../shared/sync-capacity"
import { ObservationFingerprint } from "./observation-fingerprint"
import { isTetheraStagingPath, resolveWithinRoot } from "./path-safety"

export const DEFAULT_MAX_MANIFEST_FILES = 10_000
const MAX_HASH_FILE_BYTES = 16 * 1024 * 1024
const MAX_SAMPLE_ITEMS = 14
const SCAN_ACTIVITY_INTERVAL_MS = 250
const HASH_BUFFER_BYTES = 512 * 1024
export { MAX_LEGACY_MANIFEST_ENCODED_BYTES }
const MAX_MANIFEST_PATH_BYTES = 4096
/**
 * Bounded fan-out for concurrent `inspectManifestFile` calls within one scan.
 * The scan coordinator admits up to 4 concurrent scans, so this keeps the
 * worst case at 4 * 16 = 64 in-flight file operations and 4 * 16 * 512KiB =
 * 32 MiB of hash scratch buffers, instead of growing unboundedly with scan
 * count or directory size.
 */
export const SCAN_FILE_CONCURRENCY = 16

export class ScanCancelledError extends Error {
  constructor(message = "The folder scan was cancelled.") {
    super(message)
    this.name = "ScanCancelledError"
  }
}

export function isScanCancelled(error: unknown): boolean {
  if (error instanceof ScanCancelledError) return true
  if (error instanceof Error) {
    if (error.name === "AbortError") return true
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ABORT_ERR") return true
  }
  return false
}

function throwIfScanCancelled(signal: AbortSignal | null | undefined): void {
  if (signal?.aborted) throw new ScanCancelledError()
}

// Bun 1.3's `Dir.close()` returns void while Node and newer Bun return a
// promise, so never assume `.catch` exists on its result. `await` accepts
// both shapes, keeping cleanup safe on every supported runtime.
async function closeDirQuietly(directory: { close: () => unknown } | undefined): Promise<void> {
  if (!directory) return
  try {
    await directory.close()
  } catch {
    // Best-effort cleanup; the scan result already records the outcome.
  }
}

export interface FileManifestEntry {
  path: string
  size: number
  modifiedMs: number
  digest?: string
}

/**
 * Exact on-disk identity of a file. Values are decimal strings because device
 * and inode ids are 64-bit and nanosecond timestamps exceed float precision.
 */
export interface FileIdentity {
  device: string
  inode: string
  size: number
  modifiedNs: string
  changedNs: string
}

export interface CachedFileDigest extends FileIdentity {
  digest: string
}

/**
 * Durable digests from earlier full-integrity scans. A cached digest stands in
 * for reading a file only when every identity value still matches exactly;
 * ctime is part of the identity because userspace cannot set it the way
 * `touch -r` can set mtime.
 */
export interface ScanDigestCache {
  /** Recorded digests for these paths; a path without a record is simply absent. */
  lookup(relativePaths: string[]): Promise<ReadonlyMap<string, CachedFileDigest>>
  /** Offers a freshly hashed, committed file whose identity is settled enough to trust later. */
  record(relativePath: string, entry: CachedFileDigest): void
}

export interface FileManifest {
  rootPath: string
  files: FileManifestEntry[]
  ignored: number
  unreadable: number
  /** Bounded report of the first inaccessible paths, in walk order. */
  unreadableEntries: FolderScanIssue[]
  truncated: boolean
}

export interface CompareManifestOptions {
  mode: SyncMode
  localPlatform: "linux" | "windows" | "unknown"
  remotePlatform: "linux" | "windows" | "unknown"
}

export interface ScanFolderOptions {
  /** Hash every file for a transfer decision; preview scans retain the bounded fast path. */
  hashAllFiles?: boolean
  /**
   * Ceiling on collected files before the manifest reports `truncated`.
   * `undefined` (the default) resolves to `DEFAULT_MAX_MANIFEST_FILES`;
   * `null` removes the ceiling for an explicitly opted-in unbounded scan.
   * A number must be a positive safe integer; anything else fails closed.
   */
  maxFiles?: number | null
  /**
   * Per-file size ceiling. A file larger than this is excluded from the
   * manifest and counted as `ignored`, exactly like an ignore-pattern match,
   * so it is never previewed, transferred, or served to a peer.
   * `undefined` and `null` both mean no limit.
   */
  maxFileBytes?: number | null
  /** Time-throttled local activity, including long hashes and scans of small folders. */
  onActivity?: (activity: FolderScanActivity) => void
  /**
   * Cooperative cancellation. Checked before/after awaits and between hash
   * chunks; an abort escapes per-file catch blocks instead of counting the
   * file as unreadable. Never used for filesystem commit/recovery sequences.
   */
  signal?: AbortSignal | null
  /**
   * Skips re-reading files whose identity matches an earlier full-integrity
   * digest. Honoured only with `hashAllFiles`, so preview scans never gain
   * digests they would not otherwise compute.
   */
  digestCache?: ScanDigestCache
  /**
   * Digests captured by an earlier scan of the same root and rules, keyed by
   * relative path. A file is read only when its exact on-disk identity no
   * longer matches the captured one, so this is safe for every scan mode:
   * the entry is a hint, never a substitute for the identity check.
   */
  reuse?: ReadonlyMap<string, CachedFileDigest>
  /**
   * Called for each file whose digest settled during this scan (`reused` or
   * freshly hashed). The caller can feed the entries back as `reuse` for a
   * later scan of the same tree.
   */
  onSettledDigest?: (relativePath: string, digest: CachedFileDigest) => void
  /**
   * Called for every inaccessible item, including those beyond the bounded
   * `unreadableEntries` report. Planning uses the complete set so a file
   * hidden behind a path omitted from the report can never be pulled into it.
   */
  onUnreadable?: (issue: FolderScanIssue) => void
  /** Final counters for tests and user-facing progress. Called once per scan. */
  onMetrics?: (metrics: ScanMetrics) => void
}

/** How one scan spent its work: walked records and whether bytes were re-read. */
export interface ScanMetrics {
  files: number
  /** Files whose digest came from the engine digest cache or the caller's reuse map. */
  reusedFiles: number
  /** Files whose bytes were read and hashed during this scan. */
  hashedFiles: number
  /** Files collected without a digest (an oversize preview file). */
  unhashedFiles: number
  ignored: number
  unreadable: number
  truncated: boolean
}

/** One walk observation, yielded in exactly the order the sequential walk encountered it. */
type ScanRecord =
  | { kind: "ignored" }
  | { kind: "unreadable"; relativePath: string; reason: string; entryKind: "file" | "directory" }
  | { kind: "file"; relativePath: string }

/** A walked record, with any cached digest for a file attached ahead of inspection. */
type ReadyScanRecord =
  | { kind: "ignored" }
  | { kind: "unreadable"; relativePath: string; reason: string; entryKind: "file" | "directory" }
  | { kind: "file"; relativePath: string; cached?: CachedFileDigest }

type InspectionSettlement =
  | { ok: true; inspection: ManifestFileInspection }
  | { ok: false; error: unknown }

type PendingScanRecord =
  | { kind: "ignored" }
  | { kind: "unreadable"; relativePath: string; reason: string; entryKind: "file" | "directory" }
  | { kind: "file"; relativePath: string; settled: Promise<InspectionSettlement> }

interface ScanWalkContext {
  canonicalRoot: string
  matcher: (relativePath: string, directory: boolean) => boolean
  signal: AbortSignal | null
  onListing: (relativeDirectory: string) => void
}

/** Caps queued ignored/unreadable records so a slow file cannot let the walk run arbitrarily far ahead. */
const MAX_PENDING_SCAN_RECORDS = SCAN_FILE_CONCURRENCY * 8
/** Files are looked up in the digest cache this many at a time, ahead of inspection. */
const DIGEST_LOOKUP_BATCH = 256
/** Bounds walk-ahead while gathering one lookup batch through long runs of ignored entries. */
const MAX_LOOKUP_BATCH_RECORDS = DIGEST_LOOKUP_BATCH * 4
/**
 * A scan reports at most this many inaccessible paths per side. The total
 * count is never capped; only the per-entry detail the UI renders is.
 */
export const MAX_UNREADABLE_REPORTED = 100
/**
 * A digest is recorded only when the file's modification and change times sit
 * at least this far behind the moment hashing began. Coarse filesystem clocks
 * (FAT keeps a 2 s mtime) could otherwise let a write share the hashed
 * content's timestamp tick and hide behind an unchanged identity.
 */
const DIGEST_SETTLE_NS = 2_000_000_000n

/**
 * Maps a filesystem failure to a short reason that never contains an absolute
 * path or a raw operating-system message.
 */
export function describeScanReason(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error
    ? (error as NodeJS.ErrnoException).code
    : undefined
  switch (code) {
    case "EACCES": return "Permission denied"
    case "EPERM": return "Operation not permitted"
    case "ENOENT": return "No longer exists"
    case "ELOOP": return "Too many symbolic links"
    case "ENOTDIR": return "Not a folder"
    case "EBUSY": return "In use by another program"
    case "EIO": return "Filesystem read error"
    case "EMFILE":
    case "ENFILE": return "Too many open files"
    default: break
  }
  // These are Tethera's own containment/stability errors. They never embed a
  // path, so they are safe to show; any other bare message could leak one.
  if (error instanceof Error && knownScanErrorMessages.has(error.message)) return error.message
  return "Could not be read"
}

const knownScanErrorMessages = new Set([
  "The manifest path is not a regular file.",
  "The manifest file escapes the folder root.",
  "The manifest file changed while it was opened.",
  "The manifest file changed while it was read.",
])

/**
 * Depth-first walk yielding one record per entry. Traversal order, containment
 * checks and skip rules are those of the original recursive scan; counting is
 * left to the consumer so counters advance at the same logical point.
 */
async function* walkScanRecords(directoryPath: string, relativeDirectory: string, context: ScanWalkContext): AsyncGenerator<ScanRecord, void, void> {
  const { canonicalRoot, matcher, signal, onListing } = context
  throwIfScanCancelled(signal)
  onListing(relativeDirectory)
  let directory: Awaited<ReturnType<typeof opendir>> | undefined
  try {
    directory = await opendir(directoryPath)
    throwIfScanCancelled(signal)
    const canonicalDirectory = await realpath(directoryPath)
    if (!isCanonicalPathInside(canonicalRoot, canonicalDirectory)) {
      await closeDirQuietly(directory)
      yield { kind: "unreadable", relativePath: relativeDirectory, reason: "Resolves outside the folder root", entryKind: "directory" }
      return
    }
  } catch (error) {
    if (isScanCancelled(error) || signal?.aborted) throw new ScanCancelledError()
    await closeDirQuietly(directory)
    yield { kind: "unreadable", relativePath: relativeDirectory, reason: describeScanReason(error), entryKind: "directory" }
    return
  }

  try {
    for await (const entry of directory) {
      throwIfScanCancelled(signal)
      onListing(relativeDirectory)
      const relativePath = normalizeRelative(path.join(relativeDirectory, entry.name))
      if (isTetheraStagingPath(relativePath) || matcher(relativePath, entry.isDirectory()) || entry.isSymbolicLink()) {
        yield { kind: "ignored" }
        continue
      }
      if (entry.isDirectory()) {
        yield* walkScanRecords(path.join(directoryPath, entry.name), relativePath, context)
        continue
      }
      if (entry.isFile()) yield { kind: "file", relativePath }
    }
  } catch (error) {
    // Some runtimes open a directory before failing its first read, so an
    // inaccessible directory can surface here rather than at `opendir`. It is
    // an unreadable directory, never a reason to abort the whole scan.
    if (isScanCancelled(error) || signal?.aborted) throw new ScanCancelledError()
    yield { kind: "unreadable", relativePath: relativeDirectory, reason: describeScanReason(error), entryKind: "directory" }
  } finally {
    await closeDirQuietly(directory)
  }
}

/**
 * Re-yields walk records in order, looking cached digests up for up to
 * `batchSize` files per engine round trip before any of them is inspected.
 * With a batch size of one and no cache it passes records straight through.
 */
async function* withCachedDigests(
  source: AsyncGenerator<ScanRecord, void, void>,
  cache: ScanDigestCache | undefined,
  batchSize: number,
): AsyncGenerator<ReadyScanRecord, void, void> {
  try {
    for (;;) {
      const batch: ScanRecord[] = []
      const filePaths: string[] = []
      let exhausted = false
      while (filePaths.length < batchSize && batch.length < MAX_LOOKUP_BATCH_RECORDS) {
        const next = await source.next()
        if (next.done) {
          exhausted = true
          break
        }
        batch.push(next.value)
        if (next.value.kind === "file") filePaths.push(next.value.relativePath)
      }
      const cached = cache && filePaths.length > 0 ? await cache.lookup(filePaths) : undefined
      for (const record of batch) {
        yield record.kind === "file" ? { ...record, cached: cached?.get(record.relativePath) } : record
      }
      if (exhausted) return
    }
  } finally {
    await source.return(undefined)
  }
}

/**
 * Scans a folder, inspecting up to `SCAN_FILE_CONCURRENCY` files at once.
 *
 * Per-file work is dominated by syscall latency (lstat, realpath, open, stat,
 * read), so overlapping it is where scan throughput comes from. Results are
 * committed strictly in walk order, which keeps `files` ordering, every
 * counter, and the truncation point identical to a sequential scan.
 */
async function scanFolderEntries(
  rootPath: string,
  ignorePatterns: string[],
  options: ScanFolderOptions,
  onEntry: (entry: FileManifestEntry) => void,
): Promise<ScanSummary> {
  const root = path.resolve(rootPath)
  const rootStat = await stat(root)
  if (!rootStat.isDirectory()) throw new Error("The selected path is not a folder.")
  const canonicalRoot = await realpath(root)

  const matcher = createIgnoreMatcher(ignorePatterns)
  let committedFiles = 0
  let ignored = 0
  let unreadable = 0
  let truncated = false
  let reusedFiles = 0
  let hashedFiles = 0
  let unhashedFiles = 0
  const unreadableEntries: FolderScanIssue[] = []
  const maxFiles = resolveScanLimit(options.maxFiles)
  const maxFileBytes = resolveFileSizeLimit(options.maxFileBytes)
  const hashAllFiles = options.hashAllFiles === true
  // A root on FAT/exFAT (or a filesystem that cannot be identified) never
  // reuses digests, whatever the driver-synthesized inode/ctime claim.
  const identityReuseAllowed = await filesystemSupportsDigestReuse(root)
  const digestCache = identityReuseAllowed && hashAllFiles ? options.digestCache : undefined
  const signal = options.signal ?? null
  throwIfScanCancelled(signal)
  // Each in-flight inspection borrows a slot and lazily allocates that slot's
  // scratch buffer, so peak scratch memory is bounded by the concurrency and
  // scans of empty files never allocate.
  const freeSlots: Array<{ buffer?: Buffer }> = Array.from({ length: SCAN_FILE_CONCURRENCY }, () => ({}))
  let hashedBytes = 0
  let lastActivityAt = -Infinity
  function reportActivity(stage: FolderScanActivity["stage"], currentPath: string, force = false): void {
    if (!options.onActivity) return
    const now = performance.now()
    if (!force && now - lastActivityAt < SCAN_ACTIVITY_INTERVAL_MS) return
    lastActivityAt = now
    try {
      options.onActivity({ stage, currentPath, scannedFiles: committedFiles, ignoredEntries: ignored, unreadableEntries: unreadable, hashedBytes, reusedFiles })
    } catch {
      // Advisory UI delivery must never change the scan result.
    }
  }

  function recordUnreadable(issue: FolderScanIssue): void {
    unreadable += 1
    if (unreadableEntries.length < MAX_UNREADABLE_REPORTED) unreadableEntries.push(issue)
    try {
      options.onUnreadable?.(issue)
    } catch {
      // Advisory delivery must never change the scan result.
    }
  }

  function inspect(relativePath: string, cached: CachedFileDigest | undefined): Promise<InspectionSettlement> {
    // A free slot always exists: at most SCAN_FILE_CONCURRENCY files are pending.
    const slot = freeSlots.pop() ?? {}
    reportActivity("inspecting", relativePath)
    // The caller's earlier scan of this same tree supplies digests for
    // unchanged files; the per-file identity check below still decides.
    const reusable = identityReuseAllowed ? options.reuse?.get(relativePath) ?? cached : undefined
    return inspectManifestFile(root, canonicalRoot, relativePath, hashAllFiles, maxFileBytes, (bytesRead) => {
      hashedBytes += bytesRead
      reportActivity("hashing", relativePath)
    }, signal, () => (slot.buffer ??= Buffer.allocUnsafe(HASH_BUFFER_BYTES)), reusable, identityReuseAllowed)
      // Settled rather than rejected, so an inspection abandoned by truncation
      // or cancellation can never surface as an unhandled rejection.
      .then((inspection): InspectionSettlement => ({ ok: true, inspection }), (error: unknown): InspectionSettlement => ({ ok: false, error }))
      .finally(() => freeSlots.push(slot))
  }

  const walk = walkScanRecords(root, "", { canonicalRoot, matcher, signal, onListing: (directory) => reportActivity("listing", directory) })
  const records = withCachedDigests(walk, digestCache, digestCache ? DIGEST_LOOKUP_BATCH : 1)
  const pending: PendingScanRecord[] = []
  let pendingFiles = 0
  let walkDone = false
  try {
    for (;;) {
      while (!walkDone && pendingFiles < SCAN_FILE_CONCURRENCY && pending.length < MAX_PENDING_SCAN_RECORDS) {
        const next = await records.next()
        if (next.done) {
          walkDone = true
          break
        }
        const record = next.value
        if (record.kind === "file") {
          pending.push({ kind: "file", relativePath: record.relativePath, settled: inspect(record.relativePath, record.cached) })
          pendingFiles += 1
        } else {
          pending.push(record)
        }
      }

      const head = pending.shift()
      if (!head) break
      if (head.kind === "ignored") {
        ignored += 1
        continue
      }
      if (head.kind === "unreadable") {
        recordUnreadable({ path: head.relativePath, reason: head.reason, kind: head.entryKind })
        continue
      }
      pendingFiles -= 1
      const settlement = await head.settled
      throwIfScanCancelled(signal)
      if (!settlement.ok) {
        // Cancellation must escape instead of counting the file as unreadable.
        if (isScanCancelled(settlement.error) || signal?.aborted) throw new ScanCancelledError()
        recordUnreadable({ path: head.relativePath, reason: describeScanReason(settlement.error), kind: "file" })
        continue
      }
      // Oversize files are excluded like an ignore-pattern match, so they must not
      // consume the file ceiling: counting them would report `truncated` for a scan
      // that actually omitted nothing, and a truncated scan blocks the merge entirely.
      if (settlement.inspection.outcome === "excluded-oversize") {
        ignored += 1
        continue
      }
      if (committedFiles >= maxFiles) {
        truncated = true
        break
      }
      const { entry, settledIdentity, reused, hashed } = settlement.inspection
      onEntry(entry)
      committedFiles += 1
      if (reused) reusedFiles += 1
      else if (hashed) hashedFiles += 1
      else unhashedFiles += 1
      if (settledIdentity && entry.digest) {
        const settledDigest = { ...settledIdentity, digest: entry.digest }
        if (digestCache) digestCache.record(entry.path, settledDigest)
        options.onSettledDigest?.(entry.path, settledDigest)
      }
    }
  } finally {
    // Close any directories the suspended walk still holds, then let abandoned
    // inspections finish so no file handle outlives the scan's admission slot.
    await records.return(undefined)
    await Promise.all(pending.flatMap((record) => (record.kind === "file" ? [record.settled] : [])))
  }
  throwIfScanCancelled(signal)
  reportActivity("complete", "", true)
  // Advisory only: a throwing metrics listener must not fail the scan itself.
  try {
    options.onMetrics?.({ files: committedFiles, reusedFiles, hashedFiles, unhashedFiles, ignored, unreadable, truncated })
  } catch {
    // Metrics never change the scan result.
  }
  return { rootPath: root, files: committedFiles, ignored, unreadable, unreadableEntries, truncated }
}

/** Counters of a scan whose entries were streamed to a callback instead of collected. */
interface ScanSummary {
  rootPath: string
  files: number
  ignored: number
  unreadable: number
  unreadableEntries: FolderScanIssue[]
  truncated: boolean
}

export async function scanFolder(
  rootPath: string,
  ignorePatterns: string[],
  options: ScanFolderOptions = {},
): Promise<FileManifest> {
  const files: FileManifestEntry[] = []
  const summary = await scanFolderEntries(rootPath, ignorePatterns, options, (entry) => files.push(entry))
  return {
    rootPath: summary.rootPath,
    files,
    ignored: summary.ignored,
    unreadable: summary.unreadable,
    unreadableEntries: summary.unreadableEntries,
    truncated: summary.truncated,
  }
}

/** A full-integrity scan reduced to its observation fingerprint. */
export interface FolderFingerprint {
  fingerprint: string
  files: number
  ignored: number
  unreadable: number
  truncated: boolean
}

/**
 * Hashes every file exactly like a full-integrity scan but keeps only an
 * order-independent fingerprint, so memory stays flat however large the
 * folder is. The result equals `fingerprintObservation` over the manifest a
 * full-integrity scan of the same files would return.
 */
export async function fingerprintFolder(
  rootPath: string,
  ignorePatterns: string[],
  options: Omit<ScanFolderOptions, "hashAllFiles"> = {},
): Promise<FolderFingerprint> {
  const fingerprint = new ObservationFingerprint()
  const summary = await scanFolderEntries(rootPath, ignorePatterns, { ...options, hashAllFiles: true }, (entry) => {
    if (entry.digest === undefined) throw new Error("A full-integrity scan produced a file without a digest.")
    fingerprint.add(entry.path, entry.size, entry.digest)
  })
  return { fingerprint: fingerprint.value(), files: summary.files, ignored: summary.ignored, unreadable: summary.unreadable, truncated: summary.truncated }
}

/**
 * Decides whether two same-path manifest entries describe identical content.
 * A matching full-content digest wins; without digests, size plus a 2-second
 * mtime tolerance applies. Mixed digest presence never matches.
 */
export function manifestEntriesMatch(a: FileManifestEntry, b: FileManifestEntry): boolean {
  if (a.digest || b.digest) {
    return Boolean(a.digest && b.digest && a.digest === b.digest)
  }
  return a.size === b.size && Math.abs(a.modifiedMs - b.modifiedMs) <= 2_000
}

export function compareManifests(
  local: FileManifest,
  remote: FileManifest,
  options: CompareManifestOptions,
): FolderMappingPreview {
  // Two passes over path-indexed maps: no global union set and no global path
  // sort. Counts are identical to the union iteration; sample membership is
  // identical because the bounded top-14 set is order-independent and its
  // final ordering is re-established by addSample.
  const localByPath = new Map<string, FileManifestEntry>()
  for (const entry of local.files) localByPath.set(entry.path, entry)
  const remoteByPath = new Map<string, FileManifestEntry>()
  for (const entry of remote.files) remoteByPath.set(entry.path, entry)

  let identicalFiles = 0
  let differentFiles = 0
  let localOnlyFiles = 0
  let remoteOnlyFiles = 0
  let bytesToRemote = 0
  let bytesToLocal = 0
  const samples: MappingPreviewItem[] = []

  for (const [relativePath, localEntry] of localByPath) {
    const remoteEntry = remoteByPath.get(relativePath)
    if (!remoteEntry) {
      localOnlyFiles += 1
      if (options.mode !== "receive-only") bytesToRemote += localEntry.size
      addSample(samples, { path: relativePath, category: "local-only", size: localEntry.size })
      continue
    }
    if (manifestEntriesMatch(localEntry, remoteEntry)) {
      identicalFiles += 1
      continue
    }
    differentFiles += 1
    // The initial merge is additive-only. Same-path differences are surfaced and left untouched
    // until durable revisions and history exist, so they must not inflate transfer estimates.
    addSample(samples, { path: relativePath, category: "different", size: Math.max(localEntry.size, remoteEntry.size) })
  }
  for (const [relativePath, remoteEntry] of remoteByPath) {
    if (localByPath.has(relativePath)) continue
    remoteOnlyFiles += 1
    if (options.mode !== "send-only") bytesToLocal += remoteEntry.size
    addSample(samples, { path: relativePath, category: "remote-only", size: remoteEntry.size })
  }

  const invalidWindowsNames = new Set<string>()
  const caseCollisions = new Set<string>()
  if (options.remotePlatform === "windows" && options.mode !== "receive-only") {
    for (const entry of local.files) if (hasWindowsInvalidPath(entry.path)) invalidWindowsNames.add(entry.path)
    for (const collision of findCaseCollisions(local.files)) caseCollisions.add(collision)
  }
  if (options.localPlatform === "windows" && options.mode !== "send-only") {
    for (const entry of remote.files) if (hasWindowsInvalidPath(entry.path)) invalidWindowsNames.add(entry.path)
    for (const collision of findCaseCollisions(remote.files)) caseCollisions.add(collision)
  }

  for (const invalid of [...invalidWindowsNames].slice(0, 4)) addSample(samples, { path: invalid, category: "invalid-name" })
  for (const collision of [...caseCollisions].slice(0, 4)) addSample(samples, { path: collision, category: "case-collision" })

  return {
    localFiles: local.files.length,
    remoteFiles: remote.files.length,
    identicalFiles,
    differentFiles,
    localOnlyFiles,
    remoteOnlyFiles,
    ignoredLocal: local.ignored + local.unreadable,
    ignoredRemote: remote.ignored + remote.unreadable,
    bytesToRemote,
    bytesToLocal,
    invalidWindowsNames: [...invalidWindowsNames].slice(0, 100),
    caseCollisions: [...caseCollisions].slice(0, 100),
    truncated: local.truncated || remote.truncated,
    samples,
    unreadableLocal: local.unreadableEntries,
    unreadableRemote: remote.unreadableEntries,
    unreadableLocalCount: local.unreadable,
    unreadableRemoteCount: remote.unreadable,
  }
}

function addSample(samples: MappingPreviewItem[], sample: MappingPreviewItem): void {
  samples.push(sample)
  samples.sort((a, b) => (b.size ?? 0) - (a.size ?? 0) || a.path.localeCompare(b.path) || a.category.localeCompare(b.category))
  if (samples.length > MAX_SAMPLE_ITEMS) samples.pop()
}

function normalizeRelative(relativePath: string): string {
  return relativePath.replaceAll("\\", "/").replace(/^\.\//, "")
}

/**
 * Normalises a per-file size ceiling to a comparable number of bytes.
 * `undefined` and `null` both mean no limit. A number must be a positive safe
 * integer; anything else fails closed rather than silently syncing everything.
 *
 * Shared with the peer file-request boundary so a file the scanner excluded can
 * never be served on a direct request.
 */
export function resolveFileSizeLimit(maxFileBytes: number | null | undefined): number {
  if (maxFileBytes === undefined || maxFileBytes === null) return Number.POSITIVE_INFINITY
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1) throw new Error("The file size limit is invalid.")
  return maxFileBytes
}

function resolveScanLimit(maxFiles: number | null | undefined): number {
  if (maxFiles === undefined) return DEFAULT_MAX_MANIFEST_FILES
  if (maxFiles === null) return Number.POSITIVE_INFINITY
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1) throw new Error("The scan limit is invalid.")
  return maxFiles
}

/**
 * Compiles one ignore-file line into its regex rule(s), mirroring
 * `sync-core::manifest::build_rule` so both scanners prune the same trees.
 *
 * A pattern normally becomes exactly one rule. A pattern ending in `/**`
 * additionally emits a derived directory-only rule for the prefix itself:
 * without it the main regex only matches paths *inside* the directory, so
 * the walk would still open an excluded directory and count every entry
 * underneath one at a time instead of pruning the subtree.
 */
function buildIgnoreRule(pattern: string): Array<{ directoryOnly: boolean; basenameOnly: boolean; regex: RegExp }> | undefined {
  const normalized = pattern.trim().replaceAll("\\", "/").replace(/^\.\//, "")
  if (!normalized || normalized.startsWith("#")) return undefined
  const directoryOnly = normalized.endsWith("/")
  const source = directoryOnly ? normalized.slice(0, -1) : normalized
  // The size envelope is UTF-8 bytes, mirroring Rust's `str::len`, not UTF-16 code units.
  if (!source || Buffer.byteLength(source, "utf8") > 512) return undefined
  // Anchoring is decided from the full pattern, before `**` is parsed away:
  // any pattern containing a slash is anchored to the scan root.
  const basenameOnly = !source.includes("/")
  const regex = globToRegExp(source)
  if (!regex) return undefined
  const rules = [{ directoryOnly, basenameOnly, regex }]
  if (source.endsWith("/**")) {
    const prefix = source.slice(0, -3)
    if (prefix) {
      const prefixRegex = globToRegExp(prefix)
      if (!prefixRegex) return undefined
      rules.push({ directoryOnly: true, basenameOnly, regex: prefixRegex })
    }
  }
  return rules
}

export function createIgnoreMatcher(patterns: string[]): (relativePath: string, directory: boolean) => boolean {
  const rules = patterns.flatMap((pattern) => buildIgnoreRule(pattern) ?? [])

  return (relativePath, directory) => {
    const normalized = normalizeRelative(relativePath)
    const basename = normalized.split("/").at(-1) ?? normalized
    return rules.some((rule) => {
      if (rule.directoryOnly && !directory) return false
      return rule.regex.test(rule.basenameOnly ? basename : normalized)
    })
  }
}

/** Applies manifest ignore rules to a direct file request, including ignored parent folders. */
export function isManifestPathIgnored(relativePath: string, patterns: string[]): boolean {
  const normalized = normalizeRelative(relativePath)
  const matcher = createIgnoreMatcher(patterns)
  if (matcher(normalized, false)) return true
  const segments = normalized.split("/")
  for (let index = 1; index < segments.length; index += 1) {
    if (matcher(segments.slice(0, index).join("/"), true)) return true
  }
  return false
}

/**
 * Compiles a gitignore-flavoured glob body to an anchored case-insensitive
 * regex, mirroring `sync-core::manifest::glob_to_regex`.
 *
 * A double star is positional, not a bare wildcard: a leading double star
 * plus slash matches zero or more leading segments, a slash plus double
 * star plus slash in the middle matches zero or more segments between two
 * literals, a trailing slash plus double star matches a slash followed by
 * anything, and any other double star falls back to `.*`. A single `*` or
 * `?` stays within one segment.
 *
 * The unicode flag keeps `?` and negated classes on full code points, as
 * Rust matches on `char`s. Returns `undefined` when the pattern cannot
 * compile, so the caller skips the rule instead of throwing into the scan.
 */
function globToRegExp(pattern: string): RegExp | undefined {
  // A lone surrogate compiles under the unicode flag and would match
  // itself, but it can never equal a Rust `str` or a real filename, so it
  // must not become a rule.
  if (hasUnpairedSurrogate(pattern)) return undefined
  let source = ""
  let index = 0
  while (index < pattern.length) {
    if (index === 0 && pattern.startsWith("**/", index)) {
      source += "(?:.*/)?"
      index += 3
    } else if (pattern.startsWith("/**/", index)) {
      source += "/(?:.*/)?"
      index += 4
    } else if (index + 3 === pattern.length && pattern.startsWith("/**", index)) {
      source += "/.*"
      index += 3
    } else if (pattern.startsWith("**", index)) {
      source += ".*"
      index += 2
    } else if (pattern[index] === "*") {
      source += "[^/]*"
      index += 1
    } else if (pattern[index] === "?") {
      source += "[^/]"
      index += 1
    } else {
      source += pattern[index]?.replace(/[|\\{}()[\]^$+?.]/g, "\\$&") ?? ""
      index += 1
    }
  }
  try {
    return new RegExp(`^${source}$`, "iu")
  } catch {
    return undefined
  }
}

/** Whether the value holds a UTF-16 surrogate without its partner. */
function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1
        continue
      }
      return true
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true
  }
  return false
}

type ManifestFileInspection =
  | { outcome: "collected"; entry: FileManifestEntry; settledIdentity?: FileIdentity; reused: boolean; hashed: boolean }
  | { outcome: "excluded-oversize" }

/**
 * Whether a previously computed digest may be trusted from this identity at
 * all.
 *
 * A cached digest is only reusable when every identity value the platform
 * provides proves the file has not changed: a stable volume id and file id
 * (neither zero) and positive nanosecond modification and change timestamps.
 * Filesystems that cannot supply those — FAT/exFAT file ids, some network and
 * FUSE mounts, pre-epoch timestamps — fall back to rehashing forever rather
 * than trusting weaker metadata. A miss is acceptable; a false hit is not.
 *
 * This is deliberately evaluated on both sides: a digest recorded before this
 * rule existed, or by a platform that reported zeroed fields, is treated as a
 * miss.
 */
export function identityIsReusable(identity: FileIdentity): boolean {
  return isUsableDecimal(identity.device) &&
    isUsableDecimal(identity.inode) &&
    Number.isSafeInteger(identity.size) &&
    identity.size >= 0 &&
    isUsableDecimal(identity.modifiedNs) &&
    isUsableDecimal(identity.changedNs)
}

function isUsableDecimal(value: string): boolean {
  return /^[0-9]+$/.test(value) && !/^0+$/.test(value)
}

/** Linux `statfs` magics for FAT and exFAT, neither of which tracks a usable change time. */
const MSDOS_SUPER_MAGIC = 0x4d44
const EXFAT_SUPER_MAGIC = 0x2011bab0

/**
 * Whether the filesystem under a scan root can supply strong identity evidence
 * at all.
 *
 * FAT and exFAT have no file index and no change time; a driver may still
 * synthesize plausible-looking inode and ctime values that do not advance on a
 * content write. Rather than trust those, reuse is disabled for the whole root
 * on those filesystems and every file is read again. Windows skips the magic
 * check because `statfs().type` is not meaningful there, and relies on the
 * per-file gate: FAT/exFAT report a zero file index, which rejects reuse.
 * A failure to determine the filesystem is treated as weak.
 */
export async function filesystemSupportsDigestReuse(rootPath: string): Promise<boolean> {
  if (process.platform === "win32") return true
  try {
    const filesystem = await statfs(rootPath)
    return filesystem.type !== MSDOS_SUPER_MAGIC && filesystem.type !== EXFAT_SUPER_MAGIC
  } catch {
    return false
  }
}

/** Identity from a stat, or `undefined` when the platform/system values are too weak to reuse. */
function fileIdentityFromStats(stats: BigIntStats): FileIdentity | undefined {
  const identity: FileIdentity = {
    device: stats.dev.toString(),
    inode: stats.ino.toString(),
    size: Number(stats.size),
    modifiedNs: stats.mtimeNs.toString(),
    changedNs: stats.ctimeNs.toString(),
  }
  return identityIsReusable(identity) ? identity : undefined
}

/**
 * Reads the exact on-disk identity of a regular file, or `undefined` when the
 * path is a symlink, not a file, or the platform cannot prove identity. Used
 * to seed the digest cache with a file that was just written and verified.
 */
export async function statFileIdentity(absolutePath: string): Promise<FileIdentity | undefined> {
  const stats = await lstat(absolutePath, { bigint: true })
  if (stats.isSymbolicLink() || !stats.isFile()) return undefined
  return fileIdentityFromStats(stats)
}

/**
 * Compiles an issue list into an O(path depth) predicate.
 *
 * An inaccessible file blocks exactly that path; an inaccessible directory
 * blocks the directory and everything beneath it; an inaccessible root ("")
 * blocks the whole tree. Compiling once keeps planning linear in the number
 * of files even when the block set is the complete, unbounded local report.
 */
export function createScanIssueBlocklist(issues: readonly FolderScanIssue[]): (relativePath: string) => boolean {
  const files = new Set<string>()
  const directories = new Set<string>()
  let blockedRoot = false
  for (const issue of issues) {
    if (issue.kind === "file") {
      files.add(issue.path)
      continue
    }
    if (issue.path === "") blockedRoot = true
    else directories.add(issue.path)
  }
  if (blockedRoot) return () => true
  if (files.size === 0 && directories.size === 0) return () => false
  return (relativePath) => {
    if (files.has(relativePath)) return true
    if (directories.has(relativePath)) return true
    let separator = relativePath.lastIndexOf("/")
    while (separator !== -1) {
      if (directories.has(relativePath.slice(0, separator))) return true
      separator = relativePath.lastIndexOf("/", separator - 1)
    }
    return false
  }
}

function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return a.device === b.device && a.inode === b.inode && a.size === b.size && a.modifiedNs === b.modifiedNs && a.changedNs === b.changedNs
}

/** Millisecond mtime computed with Node's own `Stats.mtimeMs` arithmetic, so manifest values are unchanged. */
function modifiedMsFromNs(modifiedNs: bigint): number {
  return Number(modifiedNs / 1_000_000_000n) * 1e3 + Number(modifiedNs % 1_000_000_000n) / 1e6
}

async function inspectManifestFile(
  rootPath: string,
  canonicalRoot: string,
  relativePath: string,
  hashAllFiles: boolean,
  maxFileBytes: number,
  onHashBytes?: (bytesRead: number) => void,
  signal?: AbortSignal | null,
  getHashBuffer?: () => Buffer,
  cached?: CachedFileDigest,
  identityReuseAllowed = true,
): Promise<ManifestFileInspection> {
  throwIfScanCancelled(signal)
  const absolutePath = resolveWithinRoot(rootPath, relativePath)
  const entry = await lstat(absolutePath, { bigint: true })
  throwIfScanCancelled(signal)
  if (entry.isSymbolicLink() || !entry.isFile()) throw new Error("The manifest path is not a regular file.")
  const canonicalFile = await realpath(absolutePath)
  if (!isCanonicalPathInside(canonicalRoot, canonicalFile)) throw new Error("The manifest file escapes the folder root.")
  // Excluded before the file is opened, so an oversize file is never read or hashed.
  if (Number(entry.size) > maxFileBytes) return { outcome: "excluded-oversize" }
  // An exact identity match means the bytes hashed earlier are still the bytes
  // on disk. Both the cached entry and the current file must carry a usable
  // identity; a legacy or weak cache row is a miss, never a hit.
  const currentIdentity = fileIdentityFromStats(entry)
  if (identityReuseAllowed && cached && identityIsReusable(cached) && currentIdentity && sameIdentity(cached, currentIdentity)) {
    return {
      outcome: "collected",
      entry: { path: relativePath, size: Number(entry.size), modifiedMs: modifiedMsFromNs(entry.mtimeNs), digest: cached.digest },
      // The cached identity is re-verified against the current file, so it can
      // seed the durable cache again: the digest still belongs to these bytes.
      settledIdentity: cached,
      reused: true,
      hashed: false,
    }
  }

  const hashStartedNs = BigInt(Date.now()) * 1_000_000n
  const handle = await open(absolutePath, "r")
  try {
    const initial = await handle.stat({ bigint: true })
    if (!initial.isFile() || initial.dev !== entry.dev || initial.ino !== entry.ino) {
      throw new Error("The manifest file changed while it was opened.")
    }
    const size = Number(initial.size)
    // Re-checked against the opened handle: a file that grew past the cap between
    // the lstat above and this open must not slip into the manifest.
    if (size > maxFileBytes) return { outcome: "excluded-oversize" }
    let digest: string | undefined
    if (hashAllFiles || size <= MAX_HASH_FILE_BYTES) {
      const hash = createHash("sha256")
      if (size > 0) {
        const buffer = getHashBuffer?.() ?? Buffer.allocUnsafe(HASH_BUFFER_BYTES)
        let offset = 0
        while (offset < size) {
          throwIfScanCancelled(signal)
          const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset)
          throwIfScanCancelled(signal)
          if (bytesRead === 0) throw new Error("The manifest file changed while it was read.")
          hash.update(buffer.subarray(0, bytesRead))
          offset += bytesRead
          onHashBytes?.(bytesRead)
        }
      } else {
        // Empty files hash without borrowing the slot's scratch buffer.
        hash.update(Buffer.alloc(0))
      }
      digest = hash.digest("hex")
    }
    const after = await handle.stat({ bigint: true })
    if (initial.size !== after.size || initial.mtimeNs !== after.mtimeNs) {
      throw new Error("The manifest file changed while it was read.")
    }
    const collected: FileManifestEntry = { path: relativePath, size, modifiedMs: modifiedMsFromNs(initial.mtimeNs), digest }
    const initialIdentity = fileIdentityFromStats(initial)
    const identity = fileIdentityFromStats(after)
    const latestChangeNs = after.mtimeNs > after.ctimeNs ? after.mtimeNs : after.ctimeNs
    // Settling requires a usable identity on both ends of the read: without
    // it the digest is still produced, but it is never offered for reuse.
    const settled = identityReuseAllowed &&
      digest !== undefined &&
      initialIdentity !== undefined &&
      identity !== undefined &&
      sameIdentity(initialIdentity, identity) &&
      latestChangeNs <= hashStartedNs - DIGEST_SETTLE_NS
    if (settled && identity !== undefined) {
      return { outcome: "collected", entry: collected, settledIdentity: identity, reused: false, hashed: true }
    }
    return { outcome: "collected", entry: collected, reused: false, hashed: digest !== undefined }
  } finally {
    await handle.close()
  }
}

function isCanonicalPathInside(canonicalRoot: string, canonicalCandidate: string): boolean {
  const relative = path.relative(canonicalRoot, canonicalCandidate)
  return !relative.startsWith("..") && !path.isAbsolute(relative)
}

function hasWindowsInvalidPath(relativePath: string): boolean {
  const reserved = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i
  return relativePath.split("/").some((segment) => {
    if (!segment || segment.endsWith(".") || segment.endsWith(" ")) return true
    if (reserved.test(segment)) return true
    return /[<>:"|?*\u0000-\u001F]/.test(segment)
  })
}

function findCaseCollisions(files: FileManifestEntry[]): string[] {
  const seen = new Map<string, string>()
  const collisions = new Set<string>()
  for (const entry of files) {
    const folded = entry.path.toLocaleLowerCase("en-US")
    const previous = seen.get(folded)
    if (previous && previous !== entry.path) collisions.add(`${previous} ↔ ${entry.path}`)
    else seen.set(folded, entry.path)
  }
  return [...collisions]
}

export const folderManifestTestHelpers = {
  compareManifests,
  createIgnoreMatcher,
  findCaseCollisions,
  hasWindowsInvalidPath,
  parsePeerManifest,
  estimateManifestEncodedBytes,
  assertManifestWithinLegacyByteBudget,
}

function isLowerHexDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
}

/**
 * Validates an untrusted peer manifest before comparison. Rejects duplicates,
 * over-long paths, negative sizes, non-finite mtimes and malformed digests.
 * A `truncated: true` preview stays an explicit partial result for preview
 * callers; transfer callers still fail closed via assertCompleteTransferManifest.
 */
export function parsePeerManifest(value: unknown): FileManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The paired computer returned an invalid folder scan.")
  }
  const candidate = value as Partial<FileManifest> & { files?: unknown; unreadableEntries?: unknown }
  if (typeof candidate.rootPath !== "string" || !Array.isArray(candidate.files)) {
    throw new Error("The paired computer returned an invalid folder scan.")
  }
  if (candidate.files.length > 1_000_000) {
    throw new Error("The paired computer returned a folder scan larger than the supported preview limit.")
  }
  const seen = new Set<string>()
  const files: FileManifestEntry[] = []
  for (const item of candidate.files) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("The paired computer returned an invalid folder scan.")
    }
    const entry = item as Partial<FileManifestEntry>
    if (
      typeof entry.path !== "string" || entry.path.length === 0 ||
      Buffer.byteLength(entry.path, "utf8") > MAX_MANIFEST_PATH_BYTES ||
      entry.path.includes("\0") ||
      typeof entry.size !== "number" || !Number.isSafeInteger(entry.size) || entry.size < 0 ||
      typeof entry.modifiedMs !== "number" || !Number.isFinite(entry.modifiedMs) ||
      (entry.digest !== undefined && !isLowerHexDigest(entry.digest))
    ) {
      throw new Error("The paired computer returned an invalid folder scan.")
    }
    if (seen.has(entry.path)) {
      throw new Error("The paired computer returned a folder scan with a duplicate path.")
    }
    seen.add(entry.path)
    files.push({ path: entry.path, size: entry.size, modifiedMs: entry.modifiedMs, digest: entry.digest })
  }
  const ignored = typeof candidate.ignored === "number" && Number.isSafeInteger(candidate.ignored) && candidate.ignored >= 0
    ? candidate.ignored
    : 0
  const unreadable = typeof candidate.unreadable === "number" && Number.isSafeInteger(candidate.unreadable) && candidate.unreadable >= 0
    ? candidate.unreadable
    : 0
  return {
    rootPath: candidate.rootPath,
    files,
    ignored,
    unreadable,
    unreadableEntries: parsePeerScanIssues(candidate.unreadableEntries),
    truncated: candidate.truncated === true,
  }
}

/**
 * Validates the bounded unreadable-path report from an untrusted peer. A
 * missing report from an older version becomes an empty list; a malformed one
 * fails closed rather than letting invented paths reach the UI.
 */
/** One persisted or peer-supplied scan issue. Shared by the peer parser and the legacy-preview validator. */
export const MAX_SCAN_ISSUE_REASON_LENGTH = 200

export function isFolderScanIssue(value: unknown): value is FolderScanIssue {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const issue = value as Partial<FolderScanIssue>
  return typeof issue.path === "string" &&
    Buffer.byteLength(issue.path, "utf8") <= MAX_MANIFEST_PATH_BYTES &&
    !issue.path.includes("\0") &&
    typeof issue.reason === "string" &&
    issue.reason.length > 0 &&
    issue.reason.length <= MAX_SCAN_ISSUE_REASON_LENGTH &&
    (issue.kind === "file" || issue.kind === "directory")
}

/** Validates the bounded unreadable-path report from an untrusted peer. A missing report from an older version becomes an empty list. */
function parsePeerScanIssues(value: unknown): FolderScanIssue[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_UNREADABLE_REPORTED) {
    throw new Error("The paired computer returned an invalid folder scan.")
  }
  return value.map((item) => {
    if (!isFolderScanIssue(item)) {
      throw new Error("The paired computer returned an invalid folder scan.")
    }
    return { path: item.path, reason: item.reason, kind: item.kind }
  })
}

/** Thin manifest-shaped wrapper over the shared estimator; see `../shared/sync-capacity` for the estimate itself. */
export function estimateManifestEncodedBytes(manifest: FileManifest): number {
  return estimateEncodedBytesForFiles(manifest.files)
}

export function assertManifestWithinLegacyByteBudget(manifest: FileManifest, computer: string): void {
  const estimated = estimateManifestEncodedBytes(manifest)
  if (estimated > MAX_LEGACY_MANIFEST_ENCODED_BYTES) {
    throw new Error(
      `${computer}'s folder scan would need about ${(estimated / 1_048_576).toFixed(1)} MiB on the peer channel, above the ${(MAX_LEGACY_MANIFEST_ENCODED_BYTES / 1_048_576).toFixed(0)} MiB legacy budget used with an older version of Tethera. Update Tethera on both computers to sync larger folders, or add ignore rules; no incomplete observation was reconciled.`,
    )
  }
}
