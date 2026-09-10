import { createHash } from "node:crypto"
import { lstat, open, opendir, realpath, stat } from "node:fs/promises"
import path from "node:path"
import type { FolderMappingPreview, FolderScanActivity, MappingPreviewItem, SyncMode } from "../shared/contracts"
import { MAX_SYNCABLE_FILES_PER_SIDE as MAX_LEGACY_OBSERVATION_FILES } from "../shared/sync-capacity"
import { isTetheraStagingPath, resolveWithinRoot } from "./path-safety"

export const DEFAULT_MAX_MANIFEST_FILES = 10_000
const MAX_HASH_FILE_BYTES = 16 * 1024 * 1024
const MAX_SAMPLE_ITEMS = 14
const SCAN_ACTIVITY_INTERVAL_MS = 250
const HASH_BUFFER_BYTES = 512 * 1024
/** Conservative ceiling for one legacy full-manifest peer frame, reserving room for JSON escaping, UTF-8, encryption/base64 and envelope overhead below the 16 MiB wire cap. */
export const MAX_LEGACY_MANIFEST_ENCODED_BYTES = 12 * 1024 * 1024
export { MAX_LEGACY_OBSERVATION_FILES }
const MAX_MANIFEST_PATH_BYTES = 4096

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

export interface FileManifest {
  rootPath: string
  files: FileManifestEntry[]
  ignored: number
  unreadable: number
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
}

export async function scanFolder(
  rootPath: string,
  ignorePatterns: string[],
  options: ScanFolderOptions = {},
): Promise<FileManifest> {
  const root = path.resolve(rootPath)
  const rootStat = await stat(root)
  if (!rootStat.isDirectory()) throw new Error("The selected path is not a folder.")
  const canonicalRoot = await realpath(root)

  const matcher = createIgnoreMatcher(ignorePatterns)
  const files: FileManifestEntry[] = []
  let ignored = 0
  let unreadable = 0
  let truncated = false
  const maxFiles = resolveScanLimit(options.maxFiles)
  const maxFileBytes = resolveFileSizeLimit(options.maxFileBytes)
  const signal = options.signal ?? null
  throwIfScanCancelled(signal)
  // One lazy buffer per scan, reused sequentially across files. Empty files
  // never allocate it; concurrent scans each own their buffer.
  let hashBuffer: Buffer | undefined
  function hashScratch(): Buffer {
    if (!hashBuffer) hashBuffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES)
    return hashBuffer
  }
  let hashedBytes = 0
  let lastActivityAt = -Infinity
  function reportActivity(stage: FolderScanActivity["stage"], currentPath: string, force = false): void {
    if (!options.onActivity) return
    const now = performance.now()
    if (!force && now - lastActivityAt < SCAN_ACTIVITY_INTERVAL_MS) return
    lastActivityAt = now
    try {
      options.onActivity({ stage, currentPath, scannedFiles: files.length, ignoredEntries: ignored, unreadableEntries: unreadable, hashedBytes })
    } catch {
      // Advisory UI delivery must never change the scan result.
    }
  }

  async function visit(directoryPath: string, relativeDirectory: string): Promise<void> {
    throwIfScanCancelled(signal)
    if (truncated) return
    reportActivity("listing", relativeDirectory)
    let directory: Awaited<ReturnType<typeof opendir>> | undefined
    try {
      directory = await opendir(directoryPath)
      throwIfScanCancelled(signal)
      const canonicalDirectory = await realpath(directoryPath)
      if (!isCanonicalPathInside(canonicalRoot, canonicalDirectory)) {
        await closeDirQuietly(directory)
        directory = undefined
        unreadable += 1
        return
      }
    } catch (error) {
      if (isScanCancelled(error) || signal?.aborted) throw new ScanCancelledError()
      await closeDirQuietly(directory)
      directory = undefined
      unreadable += 1
      return
    }

    try {
      for await (const entry of directory) {
        throwIfScanCancelled(signal)
        if (truncated) break
        reportActivity("listing", relativeDirectory)
        const relativePath = normalizeRelative(path.join(relativeDirectory, entry.name))
        if (isTetheraStagingPath(relativePath)) {
          ignored += 1
          continue
        }
        if (matcher(relativePath, entry.isDirectory())) {
          ignored += 1
          continue
        }
        const absolutePath = path.join(directoryPath, entry.name)
        if (entry.isSymbolicLink()) {
          ignored += 1
          continue
        }
        if (entry.isDirectory()) {
          await visit(absolutePath, relativePath)
          continue
        }
        if (!entry.isFile()) continue
        try {
          reportActivity("inspecting", relativePath)
          throwIfScanCancelled(signal)
          const inspection = await inspectManifestFile(root, canonicalRoot, relativePath, options.hashAllFiles === true, maxFileBytes, (bytesRead) => {
            hashedBytes += bytesRead
            reportActivity("hashing", relativePath)
          }, signal, hashScratch)
          throwIfScanCancelled(signal)
          // Oversize files are excluded like an ignore-pattern match, so they must not
          // consume the file ceiling: counting them would report `truncated` for a scan
          // that actually omitted nothing, and a truncated scan blocks the merge entirely.
          if (inspection.outcome === "excluded-oversize") {
            ignored += 1
            continue
          }
          if (files.length >= maxFiles) {
            truncated = true
            break
          }
          files.push(inspection.entry)
        } catch (error) {
          // Cancellation must escape instead of counting the file as unreadable.
          if (isScanCancelled(error) || signal?.aborted) throw new ScanCancelledError()
          unreadable += 1
          continue
        }
      }
    } finally {
      await closeDirQuietly(directory)
    }
  }

  try {
    await visit(root, "")
  } finally {
    // Release the per-scan scratch promptly; the manifest retains only entries.
    hashBuffer = undefined
  }
  throwIfScanCancelled(signal)
  reportActivity("complete", "", true)
  return { rootPath: root, files, ignored, unreadable, truncated }
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
  | { outcome: "collected"; entry: FileManifestEntry }
  | { outcome: "excluded-oversize" }

async function inspectManifestFile(
  rootPath: string,
  canonicalRoot: string,
  relativePath: string,
  hashAllFiles: boolean,
  maxFileBytes: number,
  onHashBytes?: (bytesRead: number) => void,
  signal?: AbortSignal | null,
  getHashBuffer?: () => Buffer,
): Promise<ManifestFileInspection> {
  throwIfScanCancelled(signal)
  const absolutePath = resolveWithinRoot(rootPath, relativePath)
  const entry = await lstat(absolutePath)
  throwIfScanCancelled(signal)
  if (entry.isSymbolicLink() || !entry.isFile()) throw new Error("The manifest path is not a regular file.")
  const canonicalFile = await realpath(absolutePath)
  if (!isCanonicalPathInside(canonicalRoot, canonicalFile)) throw new Error("The manifest file escapes the folder root.")
  // Excluded before the file is opened, so an oversize file is never read or hashed.
  if (entry.size > maxFileBytes) return { outcome: "excluded-oversize" }

  const handle = await open(absolutePath, "r")
  try {
    const initial = await handle.stat()
    if (!initial.isFile() || initial.dev !== entry.dev || initial.ino !== entry.ino) {
      throw new Error("The manifest file changed while it was opened.")
    }
    // Re-checked against the opened handle: a file that grew past the cap between
    // the lstat above and this open must not slip into the manifest.
    if (initial.size > maxFileBytes) return { outcome: "excluded-oversize" }
    let digest: string | undefined
    if (hashAllFiles || initial.size <= MAX_HASH_FILE_BYTES) {
      const hash = createHash("sha256")
      if (initial.size > 0) {
        const buffer = getHashBuffer?.() ?? Buffer.allocUnsafe(HASH_BUFFER_BYTES)
        let offset = 0
        while (offset < initial.size) {
          throwIfScanCancelled(signal)
          const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, initial.size - offset), offset)
          throwIfScanCancelled(signal)
          if (bytesRead === 0) throw new Error("The manifest file changed while it was read.")
          hash.update(buffer.subarray(0, bytesRead))
          offset += bytesRead
          onHashBytes?.(bytesRead)
        }
      } else {
        // Empty files hash without touching the shared scratch buffer.
        hash.update(Buffer.alloc(0))
      }
      digest = hash.digest("hex")
    }
    const after = await handle.stat()
    if (initial.size !== after.size || initial.mtimeMs !== after.mtimeMs) {
      throw new Error("The manifest file changed while it was read.")
    }
    return { outcome: "collected", entry: { path: relativePath, size: initial.size, modifiedMs: initial.mtimeMs, digest } }
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
  const candidate = value as Partial<FileManifest> & { files?: unknown }
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
  return { rootPath: candidate.rootPath, files, ignored, unreadable, truncated: candidate.truncated === true }
}

/**
 * Estimates the encrypted wire size of a legacy full-manifest response without
 * serializing it: per-entry UTF-8 path bytes plus JSON/envelope overhead,
 * expanded for base64 ciphertext. Used to fail closed before serialization.
 */
export function estimateManifestEncodedBytes(manifest: FileManifest): number {
  let bytes = 256
  for (const entry of manifest.files) {
    bytes += Buffer.byteLength(entry.path, "utf8") * 2 + 128
    if (entry.digest) bytes += 64
  }
  // AES-GCM ciphertext base64 expansion plus the secure-frame envelope.
  return Math.ceil(bytes * 1.37) + 512
}

export function assertManifestWithinLegacyByteBudget(manifest: FileManifest, computer: string): void {
  if (manifest.files.length > MAX_LEGACY_OBSERVATION_FILES) {
    throw new Error(
      `${computer}'s folder lists ${manifest.files.length.toLocaleString("en-GB")} files, above the supported legacy limit of ${MAX_LEGACY_OBSERVATION_FILES.toLocaleString("en-GB")} per side. Add ignore rules or wait for staged scan generations; no incomplete observation was reconciled.`,
    )
  }
  const estimated = estimateManifestEncodedBytes(manifest)
  if (estimated > MAX_LEGACY_MANIFEST_ENCODED_BYTES) {
    throw new Error(
      `${computer}'s folder scan would need about ${(estimated / 1_048_576).toFixed(1)} MiB on the peer channel, above the ${(MAX_LEGACY_MANIFEST_ENCODED_BYTES / 1_048_576).toFixed(0)} MiB legacy budget. Add ignore rules or wait for staged scan generations; no incomplete observation was reconciled.`,
    )
  }
}
