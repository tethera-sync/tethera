import { constants } from "node:fs"
import { link, lstat, mkdir, open, realpath, rename, statfs, unlink } from "node:fs/promises"
import { createHash, randomBytes } from "node:crypto"
import path from "node:path"
import type { FolderScanIssue, SyncMode } from "../shared/contracts"
import type { FileManifest, FileManifestEntry } from "./folder-manifest"
import { isPathBlockedByScanIssue, manifestEntriesMatch } from "./folder-manifest"
import { isTetheraStagingPath, resolveWithinRoot } from "./path-safety"
import { describeTransferFile, isSha256HexDigest } from "./file-transfer"
import { invertMode } from "./mapping-index"
import {
  archiveDisplacedFile,
  displacedFilePath,
  replacementStagingPath,
  type DurableReplacementHooks,
} from "./version-archive"
import { syncDirectory } from "./fs-durability"

const MIN_FREE_SPACE_AFTER_TRANSFER = 64 * 1024 * 1024

export interface SyncSkip {
  path: string
  reason: string
}

export interface SyncPlan {
  toPull: FileManifestEntry[]
  skipped: SyncSkip[]
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
  complete: boolean
  skipped: SyncSkip[]
}

export interface AtomicChunkWriteOptions {
  onChunk?: (writtenBytes: number) => void
  expectedDestinationDigest?: string
  expectedDestinationSize?: number
  replacement?: DurableReplacementHooks
}

/** Runs the inverse pass and completion commit strictly after the first pass succeeds. */
export async function runCoordinatedInitialMerge(
  runLocalPass: () => Promise<InitialSyncPassResult>,
  runPeerPass: () => Promise<InitialSyncPassResult>,
  commitCompletion: (local: InitialSyncPassResult, peer: InitialSyncPassResult) => Promise<void>,
): Promise<{ local: InitialSyncPassResult; peer: InitialSyncPassResult }> {
  const local = await runLocalPass()
  const peer = await runPeerPass()
  await commitCompletion(local, peer)
  return { local, peer }
}

export interface SyncPlanOptions {
  /**
   * Inaccessible paths on the destination side. A path that could not be
   * read cannot be written either, so it is left out of the plan instead of
   * failing the whole merge. The issue is reported separately.
   */
  destinationBlocked?: readonly FolderScanIssue[]
}

/**
 * Only ever pulls: files that exist on the remote side but not locally are
 * copied down. Files that exist on both sides but differ are left alone
 * (skipped, with a reason) rather than guessing a winner — that needs a
 * revision model this codebase doesn't have yet. The coordinator asks the
 * other device to run the inverse pass, which copies this side's local-only files.
 */
export function computeSyncPlan(local: FileManifest, remote: FileManifest, mode: SyncMode, options: SyncPlanOptions = {}): SyncPlan {
  const localByPath = new Map(local.files.map((entry) => [entry.path, entry]))
  const destinationBlocked = options.destinationBlocked ?? []
  const toPull: FileManifestEntry[] = []
  const skipped: SyncSkip[] = []

  for (const remoteEntry of remote.files) {
    const localEntry = localByPath.get(remoteEntry.path)
    if (!localEntry) {
      if (mode !== "send-only" && !isPathBlockedByScanIssue(remoteEntry.path, destinationBlocked)) toPull.push(remoteEntry)
      continue
    }

    if (manifestEntriesMatch(localEntry, remoteEntry)) continue

    skipped.push({
      path: remoteEntry.path,
      reason: "Exists on both computers with different content; skipped until conflict resolution is available.",
    })
  }

  return { toPull, skipped }
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
  return {
    complete: localPlan.toPull.length === 0 && peerPlan.toPull.length === 0,
    skipped: [...byPath.values()],
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
  const filesystem = await statfs(directory)
  const availableBytes = filesystem.bavail * filesystem.bsize
  if (availableBytes - expectedSize < MIN_FREE_SPACE_AFTER_TRANSFER) {
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
      await link(tempPath, destination)
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
