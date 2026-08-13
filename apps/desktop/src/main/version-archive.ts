import { constants } from "node:fs"
import { createHash } from "node:crypto"
import { chmod, link, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises"
import path from "node:path"
import { describeTransferFile, readTransferFileChunk, TRANSFER_CHUNK_BYTES } from "./file-transfer"
import { resolveWithinRoot } from "./path-safety"

export const VERSION_ARCHIVE_DIRECTORY = "version-archive"

export type ReplacementJournalState =
  | "planned"
  | "archived"
  | "installed"
  | "completed"
  | "aborted"
  | "recovery-required"
  | "integrity-failed"

export type ArchiveObjectState = "available" | "missing" | "corrupt"

export interface ReplacementJournalEntry {
  id: string
  mappingId: string
  path: string
  syncOperationId?: number | null
  kind: "sync" | "restore"
  oldDigest?: string | null
  oldSize?: number | null
  replacementDigest: string
  replacementSize: number
  archiveDigest?: string | null
  archiveObjectKey?: string | null
  restoredFromJournalId?: string | null
  state: ReplacementJournalState
  createdAt: string
  updatedAt: string
  completedAt?: string | null
  lastError?: string | null
  localRoot: string
  archiveState?: ArchiveObjectState | null
  archiveVerifiedAt?: string | null
  archiveError?: string | null
}

export interface DurableReplacementHooks {
  journalId: string
  archiveRoot: string
  markArchived: (archive: ArchivedObject) => Promise<void>
  markInstalled: () => Promise<void>
  /** Test-only fault seam; production always uses the default same-directory rename. */
  installStaged?: (stagedPath: string, destinationPath: string) => Promise<void>
}

export interface ArchivedObject {
  digest: string
  size: number
  objectKey: string
}

export interface RecoveryInspection {
  liveDigest?: string
  archiveAvailable: boolean
  restoredDisplacedFile: boolean
}

export function archiveObjectKey(digest: string): string {
  assertDigest(digest)
  return `sha256/${digest.slice(0, 2)}/${digest}`
}

export function archiveObjectPath(archiveRoot: string, objectKey: string): string {
  if (!/^sha256\/[a-f0-9]{2}\/[a-f0-9]{64}$/.test(objectKey)) {
    throw new Error("The archive object key is invalid.")
  }
  const digest = objectKey.slice(-64)
  if (objectKey !== archiveObjectKey(digest)) throw new Error("The archive object key is inconsistent.")
  return resolveWithinRoot(archiveRoot, objectKey)
}

export function replacementStagingPath(relativePath: string, journalId: string): string {
  const identity = journalFileIdentity(journalId)
  const parsed = path.posix.parse(relativePath.replaceAll("\\", "/"))
  return path.posix.join(parsed.dir, `.${parsed.base}.tethera-tmp-${identity}`)
}

export function displacedFilePath(relativePath: string, journalId: string): string {
  const identity = journalFileIdentity(journalId)
  const parsed = path.posix.parse(relativePath.replaceAll("\\", "/"))
  return path.posix.join(parsed.dir, `.${parsed.base}.tethera-displaced-${identity}`)
}

function archiveStagingObjectKey(digest: string, journalId: string): string {
  const objectKey = archiveObjectKey(digest)
  return `${path.posix.dirname(objectKey)}/.${digest}.archive-tmp-${journalFileIdentity(journalId)}`
}

export function archiveStagingObjectPath(archiveRoot: string, digest: string, journalId: string): string {
  return archiveObjectPathUnchecked(archiveRoot, archiveStagingObjectKey(digest, journalId))
}

/** Copies the exact displaced file into a content-addressed, fsynced object outside live roots. */
export async function archiveDisplacedFile(
  liveRoot: string,
  displacedRelativePath: string,
  archiveRoot: string,
  journalId: string,
  expectedDigest: string,
  expectedSize: number,
): Promise<ArchivedObject> {
  assertDigest(expectedDigest)
  const descriptor = await describeTransferFile(liveRoot, displacedRelativePath)
  if (descriptor.digest !== expectedDigest || descriptor.size !== expectedSize) {
    throw new Error("The displaced file changed before it could be archived; replacement was stopped.")
  }

  await ensureArchiveDirectory(archiveRoot)
  await assertSeparateRoots(liveRoot, archiveRoot)
  const objectKey = archiveObjectKey(expectedDigest)
  const destination = archiveObjectPath(archiveRoot, objectKey)
  const directory = path.dirname(destination)
  await ensureArchiveDirectory(directory, archiveRoot)

  try {
    const existing = await describeTransferFile(archiveRoot, objectKey)
    if (existing.digest !== expectedDigest || existing.size !== expectedSize) {
      throw new Error("An existing archive object failed integrity verification.")
    }
    return { digest: expectedDigest, size: expectedSize, objectKey }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }

  const temporary = archiveStagingObjectPath(archiveRoot, expectedDigest, journalId)
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  const hash = createHash("sha256")
  let offset = 0
  let published = false
  try {
    while (offset < descriptor.size) {
      const length = Math.min(TRANSFER_CHUNK_BYTES, descriptor.size - offset)
      const chunk = await readTransferFileChunk(liveRoot, displacedRelativePath, descriptor, offset, length)
      let chunkOffset = 0
      while (chunkOffset < chunk.length) {
        const result = await handle.write(chunk, chunkOffset, chunk.length - chunkOffset, offset + chunkOffset)
        if (result.bytesWritten === 0) throw new Error("The archive write made no progress.")
        chunkOffset += result.bytesWritten
      }
      hash.update(chunk)
      offset += chunk.length
    }
    if (offset !== expectedSize || hash.digest("hex") !== expectedDigest) {
      throw new Error("The archived file failed integrity verification.")
    }
    await handle.sync()
    await handle.close()
    try {
      await link(temporary, destination)
      published = true
      await syncDirectory(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
    const archived = await describeTransferFile(archiveRoot, objectKey)
    if (archived.digest !== expectedDigest || archived.size !== expectedSize) {
      throw new Error("The published archive object failed integrity verification.")
    }
    return { digest: expectedDigest, size: expectedSize, objectKey }
  } finally {
    await handle.close().catch(() => undefined)
    await unlink(temporary).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(published ? "[archive] unable to remove published staging link" : "[archive] unable to remove staging file", error)
      }
    })
  }
}

/** Publishes a complete crash-left archive stage without trusting its name or contents. */
export async function recoverStagedArchiveObject(
  archiveRoot: string,
  journalId: string,
  expectedDigest: string,
  expectedSize: number,
): Promise<ArchivedObject | undefined> {
  const objectKey = archiveObjectKey(expectedDigest)
  if (await verifyArchiveObject(archiveRoot, objectKey, expectedDigest, expectedSize)) {
    return { digest: expectedDigest, size: expectedSize, objectKey }
  }
  const stagingKey = archiveStagingObjectKey(expectedDigest, journalId)
  const stageIsComplete = await verifyArchiveObject(archiveRoot, stagingKey, expectedDigest, expectedSize)
  if (!stageIsComplete) return undefined
  const staged = archiveObjectPathUnchecked(archiveRoot, stagingKey)
  const destination = archiveObjectPath(archiveRoot, objectKey)
  try {
    await link(staged, destination)
    await syncDirectory(path.dirname(destination))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
  if (!await verifyArchiveObject(archiveRoot, objectKey, expectedDigest, expectedSize)) {
    throw new Error("The recovered archive object failed integrity verification.")
  }
  return { digest: expectedDigest, size: expectedSize, objectKey }
}

export async function removePublishedArchiveStage(
  archiveRoot: string,
  journalId: string,
  digest: string,
): Promise<void> {
  const staging = archiveStagingObjectPath(archiveRoot, digest, journalId)
  await unlink(staging).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  })
}

export async function verifyArchiveObject(
  archiveRoot: string,
  objectKey: string | null | undefined,
  expectedDigest: string | null | undefined,
  expectedSize: number | null | undefined,
): Promise<boolean> {
  if (!objectKey || !expectedDigest || expectedSize == null) return false
  try {
    const descriptor = await describeTransferFile(archiveRoot, objectKey)
    return descriptor.digest === expectedDigest && descriptor.size === expectedSize
  } catch {
    return false
  }
}

function archiveObjectPathUnchecked(archiveRoot: string, relativePath: string): string {
  return resolveWithinRoot(archiveRoot, relativePath)
}

/**
 * Restores a displaced file after a crash-before-install, then returns digest evidence used by
 * the Rust journal to abort or roll forward. It never overwrites an unexpected live path.
 */
export async function inspectReplacementRecovery(
  liveRoot: string,
  archiveRoot: string,
  entry: ReplacementJournalEntry,
): Promise<RecoveryInspection> {
  const displacedRelative = displacedFilePath(entry.path, entry.id)
  const displacedAbsolute = resolveWithinRoot(liveRoot, displacedRelative)
  const liveAbsolute = resolveWithinRoot(liveRoot, entry.path)
  let restoredDisplacedFile = false

  const live = await describeOptional(liveRoot, entry.path)
  const displaced = await describeOptional(liveRoot, displacedRelative)
  const archiveAvailable = entry.oldDigest == null
    ? true
    : await verifyArchiveObject(archiveRoot, entry.archiveObjectKey, entry.archiveDigest, entry.oldSize)
  if (!live && displaced) {
    if (displaced.digest !== entry.oldDigest || displaced.size !== entry.oldSize) {
      throw new Error("The displaced recovery file does not match the journaled previous version.")
    }
    const canonicalParent = await realpath(path.dirname(liveAbsolute))
    const canonicalRoot = await realpath(liveRoot)
    const parentRelative = path.relative(canonicalRoot, canonicalParent)
    if (parentRelative.startsWith("..") || path.isAbsolute(parentRelative)) {
      throw new Error("The live destination parent no longer belongs to the configured folder root.")
    }
    try {
      await link(displacedAbsolute, liveAbsolute)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      throw new Error("The live path reappeared while the displaced version was being recovered; neither file was overwritten.")
    }
    await syncDirectory(path.dirname(liveAbsolute))
    restoredDisplacedFile = true
  } else if (live && displaced) {
    const replacementIsLive = live.digest === entry.replacementDigest && live.size === entry.replacementSize
    const oldVersionWasRestored = live.digest === entry.oldDigest && live.size === entry.oldSize &&
      displaced.digest === entry.oldDigest && displaced.size === entry.oldSize
    if (!replacementIsLive && !oldVersionWasRestored) {
      throw new Error("Both live and displaced files exist with an uncertain replacement state.")
    }
    // Keep the displaced inode even after the durable archive is available. On POSIX another
    // process may still hold it open and write after the rename; deleting it here could discard
    // those late writes. A future retention policy may remove it only with an explicit safety rule.
  }

  const finalLive = await describeOptional(liveRoot, entry.path)
  const staging = resolveWithinRoot(liveRoot, replacementStagingPath(entry.path, entry.id))
  await unlink(staging).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  })
  return { liveDigest: finalLive?.digest, archiveAvailable, restoredDisplacedFile }
}

async function describeOptional(root: string, relativePath: string) {
  try {
    return await describeTransferFile(root, relativePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

function journalFileIdentity(journalId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(journalId)) {
    throw new Error("The replacement journal id is invalid.")
  }
  return createHash("sha256").update(journalId).digest("hex").slice(0, 32)
}

async function assertSeparateRoots(liveRoot: string, archiveRoot: string): Promise<void> {
  const [live, archive] = await Promise.all([realpath(liveRoot), realpath(archiveRoot)])
  const archiveFromLive = path.relative(live, archive)
  const liveFromArchive = path.relative(archive, live)
  if (
    archiveFromLive === "" ||
    (!archiveFromLive.startsWith("..") && !path.isAbsolute(archiveFromLive)) ||
    (!liveFromArchive.startsWith("..") && !path.isAbsolute(liveFromArchive))
  ) {
    throw new Error("The version archive must be outside every synchronized folder.")
  }
}

async function ensureArchiveDirectory(directory: string, archiveRoot = directory): Promise<void> {
  const root = path.resolve(archiveRoot)
  const target = path.resolve(directory)
  const relative = path.relative(root, target)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("The archive directory escapes the configured archive root.")
  }
  const missing: string[] = []
  let ancestor = root
  while (true) {
    try {
      const metadata = await lstat(ancestor)
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error("An archive path ancestor is not a real directory.")
      }
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      missing.push(ancestor)
      const parent = path.dirname(ancestor)
      if (parent === ancestor) throw new Error("No safe archive directory ancestor exists.")
      ancestor = parent
    }
  }
  for (const missingDirectory of missing.reverse()) {
    await mkdir(missingDirectory, { mode: 0o700 })
    await syncDirectory(path.dirname(missingDirectory))
  }
  const rootMetadata = await lstat(root)
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error("The archive root must be a real directory, not a symlink.")
  }
  await chmod(root, 0o700)
  let current = root
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    try {
      const metadata = await lstat(current)
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error("An archive path component is not a real directory.")
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      await mkdir(current, { mode: 0o700 })
    }
    await chmod(current, 0o700)
  }
  const [canonicalRoot, canonicalTarget] = await Promise.all([realpath(root), realpath(target)])
  const canonicalRelative = path.relative(canonicalRoot, canonicalTarget)
  if (canonicalRelative.startsWith("..") || path.isAbsolute(canonicalRelative)) {
    throw new Error("The archive directory resolves outside the configured archive root.")
  }
}

function assertDigest(digest: string): void {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("The archive digest is invalid.")
}

export async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return
  const handle = await open(directory, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}
