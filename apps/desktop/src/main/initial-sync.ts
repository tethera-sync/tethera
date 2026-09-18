import { constants, link, lstat, mkdir, open, realpath, rename, statfs, unlink } from "./synced-fs"
import { createHash, randomBytes } from "node:crypto"
import path from "node:path"
import type { FolderScanIssue, SyncMode } from "../shared/contracts"
import type { FileManifest, FileManifestEntry } from "./folder-manifest"
import { createDestinationOccupancyCheck, createScanIssueBlocklist, findCaseCollisions, manifestEntriesMatch } from "./folder-manifest"
import { isTetheraStagingPath, resolveWithinRoot } from "./path-safety"
import { SCAN_GENERATION_CAPABILITY } from "./scan-generation"
import { describeTransferFile, FileChangedError, isSha256HexDigest } from "./file-transfer"
import { formatBytes } from "../shared/byte-format"
import { invertMode } from "../shared/folder-sharing-consent"
import {
  archiveDisplacedFile,
  displacedFilePath,
  replacementStagingPath,
  type DurableReplacementHooks,
} from "./version-archive"
import { syncDirectory } from "./fs-durability"

const MIN_FREE_SPACE_AFTER_TRANSFER = 64 * 1024 * 1024
/** Kept spare once a whole merge has landed, so the operating system and other apps keep working. */
const INITIAL_MERGE_FREE_SPACE_RESERVE = 1024 ** 3
export const INITIAL_MERGE_FREE_SPACE_CAPABILITY = "initial-merge-free-space-v1"
/**
 * Both participants can stage their merge scans as sealed generations and plan
 * additively from them. Advertised separately from `scan-generations-v1`
 * because a build that stages continuous generations does not necessarily
 * implement the merge scan request or the additive plan.
 */
export const INITIAL_MERGE_GENERATIONS_CAPABILITY = "initial-merge-generations-v1"

/**
 * Whether both peers can stage and plan an initial merge from sealed
 * generations. The merge request stages a generation, so the continuous
 * generation capability is required alongside the merge-specific one.
 */
export function shouldUseMergeGenerations(capabilities: ReadonlySet<string>): boolean {
  return capabilities.has(SCAN_GENERATION_CAPABILITY) && capabilities.has(INITIAL_MERGE_GENERATIONS_CAPABILITY)
}
const INITIAL_CONFLICT_REASON = "Exists on both computers with different content; both copies were preserved for review in Recovery."
/** Merge attempts before files that keep changing stop the merge instead of being merged again. */
const MAX_INITIAL_MERGE_ATTEMPTS = 3

/** Final verification still found files on only one computer: they appeared or changed during the copy. */
export class InitialMergeChangedError extends Error {
  readonly pendingPaths: readonly string[]
  /** True changing-file count, when only a bounded sample was retained. */
  readonly pendingTotal: number

  constructor(pendingPaths: readonly string[], pendingTotal = pendingPaths.length) {
    super(
      `Files kept changing while the initial merge ran (${describePathSample(pendingPaths, pendingTotal)}). The copied files are safe. ` +
      "Close programs that are writing to these files or add ignore rules for them, then retry.",
    )
    this.pendingPaths = pendingPaths
    this.pendingTotal = pendingTotal
  }
}

export function describePathSample(paths: readonly string[], total = paths.length): string {
  const shown = paths.slice(0, 3).join(", ")
  const remaining = total - Math.min(paths.length, 3)
  return remaining > 0 ? `${shown} and ${remaining.toLocaleString("en-GB")} more` : shown
}

class DestinationExistsError extends Error {
  constructor(relativePath: string, cause: unknown) {
    super(`A file already exists at ${relativePath}; its local copy was preserved.`, { cause })
  }
}

type InitialSyncFileResult =
  | { status: "copied"; bytes: number }
  | { status: "identical" }
  | { status: "conflict"; skip: SyncSkip }
  | { status: "occupied" }
  | { status: "source-changed" }

/** Recheck planned additions, including files created while the transfer was in flight. */
export async function mergeInitialSyncFile(
  rootPath: string,
  entry: FileManifestEntry,
  transfer: () => Promise<{ bytes: number }>,
): Promise<InitialSyncFileResult> {
  if (!entry.digest || !isSha256HexDigest(entry.digest)) throw new Error("The initial merge requires a verified source digest.")

  const inspectDestination = async (): Promise<InitialSyncFileResult | undefined> => {
    // A folder, link or special entry is never replaced or followed. The file
    // is left out instead of stopping every other transfer in the merge.
    if (await isDestinationOccupied(rootPath, entry.path)) return { status: "occupied" }
    let current
    try {
      current = await describeTransferFile(rootPath, entry.path)
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
      throw error
    }
    return current.digest === entry.digest && current.size === entry.size
      ? { status: "identical" }
      : { status: "conflict", skip: { path: entry.path, reason: INITIAL_CONFLICT_REASON } }
  }

  const existing = await inspectDestination()
  if (existing) return existing
  try {
    const { bytes } = await transfer()
    return { status: "copied", bytes }
  } catch (error) {
    // The source was removed or edited after the scan. Leaving this file out
    // lets the rest of the merge finish; final verification still requires
    // any newer copy before activation.
    if (error instanceof FileChangedError) return { status: "source-changed" }
    if (!(error instanceof DestinationExistsError)) throw error
    const appeared = await inspectDestination()
    if (appeared) return appeared
    // A second concurrent change needs a fresh scan, not an unbounded transfer retry.
    throw error
  }
}

/**
 * Walks the destination without following links. It is occupied when an
 * existing ancestor is anything but a real folder, or when the path itself
 * exists as anything but a regular file. A missing component leaves it free.
 */
async function isDestinationOccupied(rootPath: string, relativePath: string): Promise<boolean> {
  const resolvedRoot = path.resolve(rootPath)
  const segments = path.relative(resolvedRoot, resolveWithinRoot(rootPath, relativePath)).split(path.sep)
  let current = resolvedRoot
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment)
    let metadata
    try {
      metadata = await lstat(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
      throw error
    }
    const expectedType = index === segments.length - 1 ? metadata.isFile() : metadata.isDirectory()
    if (metadata.isSymbolicLink() || !expectedType) return true
  }
  return false
}

export interface SyncSkip {
  path: string
  reason: string
}

/** A same-path file difference the merge leaves untouched on both computers. */
export function initialSyncConflictSkip(path: string): SyncSkip {
  return { path, reason: INITIAL_CONFLICT_REASON }
}

/** The one message for case-only aliases, shared by the manifest and generation paths. */
export function initialMergeCaseCollisionMessage(collisions: readonly string[]): string {
  return `Folder names differ only by capitalisation: ${collisions.slice(0, 3).join(", ")}. Windows treats these as the same path. Match the names on both computers or exclude these folders in the ignore rules before merging. Both copies have been preserved.`
}

export interface SyncPlan {
  toPull: FileManifestEntry[]
  skipped: SyncSkip[]
  /** Remote-only files left out because a folder, link or special entry already uses their path here. */
  occupied: string[]
}

export interface InitialSyncPassResult {
  copiedFiles: number
  copiedBytes: number
  fileCount: number
  skipped: SyncSkip[]
  /** Unreadable items the merge skipped after the user chose to continue. */
  unreadableSkipped: SyncSkip[]
}

export interface InitialMergeConvergence {
  skipped: SyncSkip[]
  /** Transferable files still present on only one computer. Empty once the merge has converged. */
  pendingPaths: string[]
}

export interface AtomicChunkWriteOptions {
  onChunk?: (writtenBytes: number) => void
  expectedDestinationDigest?: string
  expectedDestinationSize?: number
  replacement?: DurableReplacementHooks
}

export interface CoordinatedInitialMergeOptions {
  maxAttempts?: number
  /** Called before both passes run again for files that changed during the previous attempt. */
  onRetry?: (error: InitialMergeChangedError) => void
}

/**
 * Runs the inverse pass and completion commit strictly after the first pass
 * succeeds. When completion finds files that changed during the copy, both
 * passes run again so those files are merged too; completion still has to
 * verify the folders before anything is committed.
 */
export async function runCoordinatedInitialMerge(
  runLocalPass: (attempt: number) => Promise<InitialSyncPassResult>,
  runPeerPass: (attempt: number) => Promise<InitialSyncPassResult>,
  commitCompletion: (local: InitialSyncPassResult, peer: InitialSyncPassResult) => Promise<void>,
  options: CoordinatedInitialMergeOptions = {},
): Promise<{ local: InitialSyncPassResult; peer: InitialSyncPassResult }> {
  const maxAttempts = options.maxAttempts ?? MAX_INITIAL_MERGE_ATTEMPTS
  let local: InitialSyncPassResult | undefined
  let peer: InitialSyncPassResult | undefined
  for (let attempt = 1; ; attempt += 1) {
    local = withEarlierCopies(await runLocalPass(attempt), local)
    peer = withEarlierCopies(await runPeerPass(attempt), peer)
    try {
      await commitCompletion(local, peer)
      return { local, peer }
    } catch (error) {
      if (!(error instanceof InitialMergeChangedError) || attempt >= maxAttempts) throw error
      options.onRetry?.(error)
    }
  }
}

/** A later pass rescans everything, so only its copy counts accumulate; its skips and file count replace the earlier ones. */
function withEarlierCopies(latest: InitialSyncPassResult, earlier: InitialSyncPassResult | undefined): InitialSyncPassResult {
  if (!earlier) return latest
  return {
    ...latest,
    copiedFiles: earlier.copiedFiles + latest.copiedFiles,
    copiedBytes: earlier.copiedBytes + latest.copiedBytes,
  }
}

export interface SyncPlanOptions {
  /**
   * Inaccessible paths on the destination side. A path that could not be
   * read cannot be written either, so it is left out of the plan instead of
   * failing the whole merge. The issue is reported separately.
   */
  destinationBlocked?: readonly FolderScanIssue[]
}

/** Case-only aliases need an explicit path choice before the exact-path durable index can own them. */
export function assertInitialMergePathCompatibility(local: FileManifest, remote: FileManifest, hasWindowsPeer: boolean): void {
  if (!hasWindowsPeer) return
  const collisions = findCaseCollisions([...local.files, ...remote.files])
  if (collisions.length === 0) return
  throw new Error(initialMergeCaseCollisionMessage(collisions))
}

/**
 * Only ever pulls: files that exist on the remote side but not locally are
 * copied down. Files that exist on both sides but differ are left alone
 * (skipped, with a reason) rather than guessing a winner — that needs a
 * revision model this codebase doesn't have yet. A remote-only file whose path
 * is already a folder, link or special entry here is left out the same way.
 * The coordinator asks the other device to run the inverse pass, which copies
 * this side's local-only files.
 */
export function computeSyncPlan(local: FileManifest, remote: FileManifest, mode: SyncMode, options: SyncPlanOptions = {}): SyncPlan {
  const localByPath = new Map(local.files.map((entry) => [entry.path, entry]))
  const isBlocked = createScanIssueBlocklist(options.destinationBlocked ?? [])
  const isOccupied = createDestinationOccupancyCheck(local)
  const toPull: FileManifestEntry[] = []
  const skipped: SyncSkip[] = []
  const occupied: string[] = []

  for (const remoteEntry of remote.files) {
    const localEntry = localByPath.get(remoteEntry.path)
    if (!localEntry) {
      if (mode === "send-only" || isBlocked(remoteEntry.path)) continue
      if (isOccupied(remoteEntry.path)) occupied.push(remoteEntry.path)
      else toPull.push(remoteEntry)
      continue
    }

    if (manifestEntriesMatch(localEntry, remoteEntry)) continue

    skipped.push(initialSyncConflictSkip(remoteEntry.path))
  }

  return { toPull, skipped, occupied }
}

export function plannedBytes(entries: readonly FileManifestEntry[]): number {
  return entries.reduce((total, entry) => total + entry.size, 0)
}

export async function availableDiskBytes(directory: string): Promise<number> {
  const filesystem = await statfs(directory)
  return filesystem.bavail * filesystem.bsize
}

/**
 * Stops a merge before its first copy when a computer cannot hold everything
 * planned for it. The per-file check during transfer protects only one file,
 * so on its own a large merge fills the disk and fails partway through.
 */
export function assertInitialMergeCapacity(computer: string, requiredBytes: number, availableBytes: number): void {
  if (availableBytes - requiredBytes >= INITIAL_MERGE_FREE_SPACE_RESERVE) return
  throw new Error(
    `${computer} needs ${formatBytes(requiredBytes + INITIAL_MERGE_FREE_SPACE_RESERVE)} of free space for this merge ` +
    `(including ${formatBytes(INITIAL_MERGE_FREE_SPACE_RESERVE)} kept spare) but has ${formatBytes(availableBytes)}. ` +
    "Free up space or add ignore rules for large build or cache folders, then retry.",
  )
}

export interface ConvergenceOptions {
  /** Inaccessible paths on this computer, already accepted by the user. */
  localBlocked?: readonly FolderScanIssue[]
  /** Inaccessible paths on the paired computer, already accepted by the user. */
  remoteBlocked?: readonly FolderScanIssue[]
}

/** A fresh two-sided check used before activation; additive conflicts are safe, missing files are not. */
export function assessInitialMergeConvergence(
  local: FileManifest,
  remote: FileManifest,
  mode: SyncMode,
  options: ConvergenceOptions = {},
): InitialMergeConvergence {
  const inverseMode = invertMode(mode)
  const localPlan = computeSyncPlan(local, remote, mode, { destinationBlocked: options.localBlocked })
  const peerPlan = computeSyncPlan(remote, local, inverseMode, { destinationBlocked: options.remoteBlocked })
  const byPath = new Map<string, SyncSkip>()
  for (const skip of [...localPlan.skipped, ...peerPlan.skipped]) byPath.set(`${skip.path}\0${skip.reason}`, skip)
  const pendingPaths = new Set([...localPlan.toPull, ...peerPlan.toPull].map((entry) => entry.path))
  return {
    skipped: [...byPath.values()],
    pendingPaths: [...pendingPaths].sort(),
  }
}

/** Writes one already-buffered file through the same verified, no-replace path as chunked transfers. */
export async function writeFileAtomic(rootPath: string, relativePath: string, content: Buffer): Promise<void> {
  const digest = createHash("sha256").update(content).digest("hex")
  await writeFileChunksAtomic(rootPath, relativePath, content.length, digest, async function* () {
    yield content
  }())
}

/**
 * Stages bounded chunks beside the destination, verifies the full SHA-256 and byte count,
 * fsyncs them, then commits a new file without replacement or durably archives the exact
 * displaced file outside the synchronized root before a verified replacement.
 */
export async function writeFileChunksAtomic(
  rootPath: string,
  relativePath: string,
  expectedSize: number,
  expectedDigest: string,
  chunks: AsyncIterable<Buffer>,
  options: AtomicChunkWriteOptions = {},
): Promise<void> {
  const { onChunk, expectedDestinationDigest, expectedDestinationSize, replacement } = options
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) throw new Error("The transferred file size is invalid.")
  if (!isSha256HexDigest(expectedDigest)) throw new Error("The transferred file digest is invalid.")
  if (expectedDestinationDigest !== undefined && !isSha256HexDigest(expectedDestinationDigest)) {
    throw new Error("The expected destination digest is invalid.")
  }
  if (expectedDestinationDigest !== undefined && (!replacement || expectedDestinationSize === undefined)) {
    throw new Error("A verified replacement requires a durable archive journal and destination size.")
  }
  if (expectedDestinationSize !== undefined && (!Number.isSafeInteger(expectedDestinationSize) || expectedDestinationSize < 0)) {
    throw new Error("The expected destination size is invalid.")
  }
  if (isTetheraStagingPath(relativePath)) throw new Error("Tethera staging paths are reserved and cannot be synchronized.")
  const destination = resolveWithinRoot(rootPath, relativePath)
  const directory = path.dirname(destination)
  await ensureContainedDestinationDirectory(rootPath, directory)
  if (await availableDiskBytes(directory) - expectedSize < MIN_FREE_SPACE_AFTER_TRANSFER) {
    throw new Error("This computer does not have enough free space to stage the synchronized file safely.")
  }
  const tempPath = replacement
    ? resolveWithinRoot(rootPath, replacementStagingPath(relativePath, replacement.journalId))
    : path.join(directory, `.${path.basename(destination)}.tethera-tmp-${randomBytes(16).toString("hex")}`)
  const handle = await open(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  const hash = createHash("sha256")
  let writtenBytes = 0
  let committed = false
  try {
    if (expectedDestinationDigest !== undefined) {
      const current = await describeTransferFile(rootPath, relativePath)
      if (current.digest !== expectedDestinationDigest) {
        throw new Error("The destination changed after reconciliation; its local copy was preserved.")
      }
    }
    await assertCanonicalPathInside(rootPath, tempPath)
    for await (const chunk of chunks) {
      if (!Buffer.isBuffer(chunk) || chunk.length === 0) continue
      if (writtenBytes + chunk.length > expectedSize) {
        throw new Error("The transferred file exceeded its declared size; integrity verification failed.")
      }
      let chunkOffset = 0
      while (chunkOffset < chunk.length) {
        const { bytesWritten } = await handle.write(chunk, chunkOffset, chunk.length - chunkOffset, writtenBytes + chunkOffset)
        if (bytesWritten === 0) throw new Error("The staged file write made no progress.")
        chunkOffset += bytesWritten
      }
      writtenBytes += chunk.length
      hash.update(chunk)
      onChunk?.(writtenBytes)
    }
    if (writtenBytes !== expectedSize || hash.digest("hex") !== expectedDigest) {
      throw new Error("The transferred file failed integrity verification.")
    }
    await handle.sync()
    await handle.close()
    await ensureContainedDestinationDirectory(rootPath, directory)
    await assertCanonicalPathInside(rootPath, tempPath)
    if (expectedDestinationDigest === undefined) {
      try {
        await link(tempPath, destination)
      } catch (error) {
        if (!replacement && error instanceof Error && "code" in error && error.code === "EEXIST") {
          throw new DestinationExistsError(relativePath, error)
        }
        throw error
      }
      if (replacement) {
        await syncDirectory(directory)
        await replacement.markInstalled()
      }
    } else {
      const current = await describeTransferFile(rootPath, relativePath)
      if (current.digest !== expectedDestinationDigest) {
        throw new Error("The destination changed during transfer; its local copy was preserved.")
      }
      const displacedRelative = displacedFilePath(relativePath, replacement!.journalId)
      const displacedDestination = resolveWithinRoot(rootPath, displacedRelative)
      let displaced = false
      try {
        await rename(destination, displacedDestination)
        displaced = true
        await syncDirectory(directory)
        const archived = await archiveDisplacedFile(
          rootPath,
          displacedRelative,
          replacement!.archiveRoot,
          replacement!.journalId,
          expectedDestinationDigest,
          expectedDestinationSize!,
        )
        await replacement!.markArchived(archived)
        await ensureContainedDestinationDirectory(rootPath, directory)
        await (replacement!.installStaged?.(tempPath, destination) ?? link(tempPath, destination))
        const installed = await describeTransferFile(rootPath, relativePath)
        if (installed.digest !== expectedDigest || installed.size !== expectedSize) {
          throw new Error("The installed replacement failed verification; recovery is required.")
        }
        await syncDirectory(directory)
        await replacement!.markInstalled()
        // Retain the displaced inode as a secondary safety copy. POSIX permits writes through an
        // already-open handle after rename; unlinking here could silently discard those late writes.
        // The content-addressed external archive remains the authoritative archived version.
      } catch (error) {
        if (displaced) {
          try {
            await ensureContainedDestinationDirectory(rootPath, directory)
            await link(displacedDestination, destination)
            await syncDirectory(directory)
          } catch (restoreError) {
            if ((restoreError as NodeJS.ErrnoException).code !== "EEXIST") throw restoreError
          }
        }
        throw error
      }
    }
    await assertCanonicalPathInside(rootPath, destination)
    committed = true
    if (!replacement) await syncDirectory(directory)
  } catch (error) {
    // Another program can use the space checked above before the copy
    // finishes; say so instead of surfacing a bare system error code.
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
    if (code === "ENOSPC" || code === "EDQUOT") {
      throw new Error("This computer ran out of free space while saving a synchronized file. Free up space, then retry.", { cause: error })
    }
    throw error
  } finally {
    try {
      await handle.close()
    } catch {
      // The success path closes before committing; repeated close is harmlessly ignored.
    }
    try {
      await unlink(tempPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          committed
            ? "[initial-sync] unable to remove a committed staging link"
            : "[initial-sync] unable to remove an incomplete staging file",
          error,
        )
      }
    }
  }
}

async function ensureContainedDestinationDirectory(rootPath: string, directory: string): Promise<void> {
  const resolvedRoot = path.resolve(rootPath)
  const relativeDirectory = path.relative(resolvedRoot, directory)
  if (relativeDirectory.startsWith("..") || path.isAbsolute(relativeDirectory)) {
    throw new Error("The destination directory escapes the folder root.")
  }

  let current = resolvedRoot
  for (const segment of relativeDirectory.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    try {
      const metadata = await lstat(current)
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error("A destination parent is not a regular folder.")
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      await mkdir(current)
    }
  }
  await assertCanonicalPathInside(rootPath, current)
}

async function assertCanonicalPathInside(rootPath: string, candidatePath: string): Promise<void> {
  const [canonicalRoot, canonicalCandidate] = await Promise.all([realpath(rootPath), realpath(candidatePath)])
  const relative = path.relative(canonicalRoot, canonicalCandidate)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("The destination resolves outside the approved folder.")
  }
}
