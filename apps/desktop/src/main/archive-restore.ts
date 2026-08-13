import { randomUUID } from "node:crypto"
import { realpath } from "node:fs/promises"
import { describeTransferFile, readTransferFileChunk, TRANSFER_CHUNK_BYTES } from "./file-transfer"
import { writeFileChunksAtomic } from "./initial-sync"
import {
  inspectReplacementRecovery,
  type ReplacementJournalEntry,
} from "./version-archive"

export interface ArchiveEngineRpc {
  request<T>(method: string, params?: unknown): Promise<T>
}

/**
 * Restores one engine-owned archive entry. The current live file is used as an exact precondition
 * and, when present, passes through the same durable archive-before-install state machine.
 */
export async function restoreArchivedVersion(
  rpc: ArchiveEngineRpc,
  liveRoot: string,
  archiveRoot: string,
  sourceJournalId: string,
): Promise<ReplacementJournalEntry> {
  const source = await rpc.request<ReplacementJournalEntry>("archive.get", { entryId: sourceJournalId })
  if (!source.archiveObjectKey || !source.archiveDigest || source.oldSize == null) {
    throw new Error("The selected archived version has no recoverable content.")
  }
  const canonicalLiveRoot = await realpath(liveRoot)
  if (canonicalLiveRoot !== source.localRoot) {
    throw new Error("The archived version belongs to a different configured folder root.")
  }
  let archived: Awaited<ReturnType<typeof describeTransferFile>>
  try {
    archived = await describeTransferFile(archiveRoot, source.archiveObjectKey)
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT"
    const detail = missing
      ? "The selected archived version's content is missing."
      : "The selected archived version could not be verified."
    await rpc.request("archive.recordObjectIssue", {
      entryId: source.id,
      state: missing ? "missing" : "corrupt",
      detail,
      occurredAt: new Date().toISOString(),
    })
    throw new Error(detail, { cause: error })
  }
  if (archived.digest !== source.archiveDigest || archived.size !== source.oldSize) {
    await rpc.request("archive.recordObjectIssue", {
      entryId: source.id,
      state: "corrupt",
      detail: "The selected archived version failed digest or size verification.",
      occurredAt: new Date().toISOString(),
    })
    throw new Error("The selected archived version is missing or corrupt.")
  }

  let current: Awaited<ReturnType<typeof describeTransferFile>> | undefined
  try {
    current = await describeTransferFile(liveRoot, source.path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }

  const restoreId = randomUUID()
  const prepareRequest = {
    id: restoreId,
    sourceJournalId,
    expectedCurrentDigest: current?.digest,
    expectedCurrentSize: current?.size,
    localRoot: canonicalLiveRoot,
    createdAt: new Date().toISOString(),
  }
  let restore: ReplacementJournalEntry
  try {
    restore = await rpc.request<ReplacementJournalEntry>("archive.prepareRestore", prepareRequest)
  } catch {
    restore = await rpc.request<ReplacementJournalEntry>("archive.get", { entryId: restoreId })
  }

  async function* chunks() {
    for (let offset = 0; offset < archived.size; offset += TRANSFER_CHUNK_BYTES) {
      const length = Math.min(TRANSFER_CHUNK_BYTES, archived.size - offset)
      yield await readTransferFileChunk(archiveRoot, source.archiveObjectKey!, archived, offset, length)
    }
  }

  try {
    await writeFileChunksAtomic(liveRoot, source.path, archived.size, archived.digest, chunks(), {
      expectedDestinationDigest: current?.digest,
      expectedDestinationSize: current?.size,
      replacement: {
        journalId: restore.id,
        archiveRoot,
        markArchived: async (archive) => {
          await rpc.request<ReplacementJournalEntry>("archive.markArchived", {
            entryId: restore.id,
            archiveDigest: archive.digest,
            archiveSize: archive.size,
            objectKey: archive.objectKey,
            archivedAt: new Date().toISOString(),
          })
        },
        markInstalled: async () => {
          await rpc.request<ReplacementJournalEntry>("archive.markInstalled", {
            entryId: restore.id,
            occurredAt: new Date().toISOString(),
          })
        },
      },
    })
    return await rpc.request<ReplacementJournalEntry>("archive.completeRestore", {
      entryId: restore.id,
      occurredAt: new Date().toISOString(),
    })
  } catch (error) {
    const durable = await rpc.request<ReplacementJournalEntry>("archive.get", { entryId: restore.id })
    if (durable.state === "completed") return durable
    const inspection = await inspectReplacementRecovery(liveRoot, archiveRoot, durable)
    const recovered = await rpc.request<ReplacementJournalEntry>("archive.recover", {
      entryId: durable.id,
      liveDigest: inspection.liveDigest,
      archiveAvailable: inspection.archiveAvailable,
      recoveredAt: new Date().toISOString(),
    })
    if (recovered.state === "completed") return recovered
    throw error
  }
}
