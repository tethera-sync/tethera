import { lstat, realpath, unlink } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { describeTransferFile, isSha256HexDigest } from "./file-transfer"
import { syncDirectory } from "./fs-durability"
import { resolveWithinRoot } from "./path-safety"
import { archiveObjectKey, archiveObjectPath, displacedFilePath } from "./version-archive"

/** How often each active folder's version history limits are applied. */
export const ARCHIVE_RETENTION_INTERVAL_MS = 60 * 60_000
// Each list and prune call walks the folder's settled history once, so larger batches keep the
// first cleanup of a long existing history from turning quadratic. The engine accepts up to 1,000.
const RETENTION_BATCH_SIZE = 500

export interface ArchiveRetentionRpc {
  request<T>(method: string, params?: unknown): Promise<T>
}

export interface RetentionFolder {
  id: string
  localPath: string
  /** Maps a journal's logical path to its spelling inside this computer's folder. */
  physicalPath: (logicalPath: string) => string
}

export type FolderRetentionOutcome =
  | { folderId: string; status: "applied"; prunedVersions: number; keptChangedCopies: number }
  | { folderId: string; status: "unavailable" }
  | { folderId: string; status: "failed"; detail: string }

export interface ArchiveRetentionResult {
  removedObjects: number
  folders: FolderRetentionOutcome[]
}

const sha256DigestSchema = z.string().refine(isSha256HexDigest, "The archive digest is invalid.")

const prunableEntriesSchema = z.array(z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  localRoot: z.string().min(1),
  oldDigest: sha256DigestSchema,
  oldSize: z.number().int().nonnegative(),
  createdAt: z.string(),
}))

type PrunableEntry = z.infer<typeof prunableEntriesSchema>[number]

const pruneResultSchema = z.object({
  prunedEntries: z.number().int().nonnegative(),
  queuedObjectDeletions: z.number().int().nonnegative(),
})

const objectDeletionsSchema = z.array(z.object({
  digest: sha256DigestSchema,
  objectKey: z.string(),
  size: z.number().int().nonnegative(),
}))

/**
 * Applies every folder's history limits once. Queued object removals left by an interrupted pass
 * are finished first. Folders are independent: one that is unavailable or fails is reported and
 * retried on the next pass without blocking the others.
 */
export async function applyArchiveRetention(
  rpc: ArchiveRetentionRpc,
  archiveRoot: string,
  folders: RetentionFolder[],
  now = new Date(),
): Promise<ArchiveRetentionResult> {
  let removedObjects = await removeQueuedArchiveObjects(rpc, archiveRoot)
  const outcomes: FolderRetentionOutcome[] = []
  for (const folder of folders) {
    let canonicalRoot: string
    try {
      canonicalRoot = await realpath(folder.localPath)
    } catch {
      // An unreachable root (for example an unmounted drive) could hide displaced copies, so
      // its history stays untouched until the folder is reachable again.
      outcomes.push({ folderId: folder.id, status: "unavailable" })
      continue
    }
    try {
      const pruned = await pruneFolderHistory(rpc, archiveRoot, folder, canonicalRoot, now.toISOString())
      removedObjects += pruned.removedObjects
      outcomes.push({
        folderId: folder.id,
        status: "applied",
        prunedVersions: pruned.prunedVersions,
        keptChangedCopies: pruned.keptChangedCopies,
      })
    } catch (error) {
      outcomes.push({
        folderId: folder.id,
        status: "failed",
        detail: error instanceof Error ? error.message : "Version history cleanup failed.",
      })
    }
  }
  return { removedObjects, folders: outcomes }
}

/**
 * Removes queued archive object files and confirms each removal. A file is always gone before its
 * confirmation, so the engine never allows that content to be archived again while a stale file
 * could still be deleted.
 */
export async function removeQueuedArchiveObjects(rpc: ArchiveRetentionRpc, archiveRoot: string): Promise<number> {
  let removed = 0
  while (true) {
    const deletions = objectDeletionsSchema.parse(
      await rpc.request<unknown>("archive.listObjectDeletions", { limit: RETENTION_BATCH_SIZE }),
    )
    for (const deletion of deletions) {
      if (deletion.objectKey !== archiveObjectKey(deletion.digest)) {
        throw new Error("A queued archive object has an inconsistent object key.")
      }
      const objectPath = archiveObjectPath(archiveRoot, deletion.objectKey)
      try {
        await unlink(objectPath)
        await syncDirectory(path.dirname(objectPath))
      } catch (error) {
        if (!isMissingPathError(error)) throw error
      }
      await rpc.request("archive.completeObjectDeletion", { digest: deletion.digest })
      removed += 1
    }
    if (deletions.length < RETENTION_BATCH_SIZE) return removed
  }
}

async function pruneFolderHistory(
  rpc: ArchiveRetentionRpc,
  archiveRoot: string,
  folder: RetentionFolder,
  canonicalRoot: string,
  now: string,
): Promise<{ prunedVersions: number; keptChangedCopies: number; removedObjects: number }> {
  let prunedVersions = 0
  let keptChangedCopies = 0
  let removedObjects = 0
  while (true) {
    const entries = prunableEntriesSchema.parse(
      await rpc.request<unknown>("archive.listPrunable", { id: folder.id, now, limit: RETENTION_BATCH_SIZE }),
    )
    if (entries.length === 0) break
    for (const entry of entries) {
      // A copy recorded under an earlier root is outside the approved folder and is never touched.
      if (entry.localRoot !== canonicalRoot) continue
      const outcome = await removeDisplacedCopy(folder.localPath, folder.physicalPath(entry.path), entry)
      if (outcome === "kept") keptChangedCopies += 1
    }
    const result = pruneResultSchema.parse(
      await rpc.request<unknown>("archive.prune", { id: folder.id, entryIds: entries.map((entry) => entry.id), now }),
    )
    prunedVersions += result.prunedEntries
    removedObjects += await removeQueuedArchiveObjects(rpc, archiveRoot)
    // Listed versions that became protected before pruning stay; stop instead of re-listing them.
    if (result.prunedEntries === 0) break
  }
  return { prunedVersions, keptChangedCopies, removedObjects }
}

/**
 * Removes the same-folder copy a replacement moved aside, but only while it still holds exactly
 * the archived content. A copy that changed afterwards received late writes through a handle that
 * was already open, so it is kept rather than discarded.
 */
async function removeDisplacedCopy(
  liveRoot: string,
  physicalPath: string,
  entry: PrunableEntry,
): Promise<"removed" | "absent" | "kept"> {
  const relativePath = displacedFilePath(physicalPath, entry.id)
  const absolutePath = resolveWithinRoot(liveRoot, relativePath)
  let before: Awaited<ReturnType<typeof lstat>>
  try {
    before = await lstat(absolutePath)
  } catch (error) {
    if (isMissingPathError(error)) return "absent"
    throw error
  }
  if (!before.isFile()) return "kept"
  const content = await describeTransferFile(liveRoot, relativePath)
  if (content.digest !== entry.oldDigest || content.size !== entry.oldSize) return "kept"

  // Re-check containment and the exact file immediately before unlinking, so a swapped parent
  // directory or a replaced file is never removed in the verified copy's place.
  const [canonicalRoot, canonicalParent] = await Promise.all([realpath(liveRoot), realpath(path.dirname(absolutePath))])
  const parentRelative = path.relative(canonicalRoot, canonicalParent)
  if (parentRelative.startsWith("..") || path.isAbsolute(parentRelative)) {
    throw new Error("A displaced copy's folder no longer belongs to the configured folder root.")
  }
  const current = await lstat(absolutePath)
  if (
    current.dev !== before.dev ||
    current.ino !== before.ino ||
    current.size !== before.size ||
    current.mtimeMs !== before.mtimeMs
  ) {
    return "kept"
  }
  await unlink(absolutePath)
  await syncDirectory(path.dirname(absolutePath))
  return "removed"
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === "ENOENT" || code === "ENOTDIR"
}
