import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { restoreArchivedVersion, type ArchiveEngineRpc } from "../src/main/archive-restore"
import {
  archiveObjectKey,
  archiveObjectPath,
  type ReplacementJournalEntry,
} from "../src/main/version-archive"

const digest = (content: Buffer | string) => createHash("sha256").update(content).digest("hex")

test("restore recreates an archived version and archives the version it replaces", async () => {
  const live = await mkdtemp(path.join(tmpdir(), "tethera-restore-live-"))
  const archive = await mkdtemp(path.join(tmpdir(), "tethera-restore-archive-"))
  const archivedContent = Buffer.from("archived old version")
  const currentContent = Buffer.from("current version")
  const archivedDigest = digest(archivedContent)
  const currentDigest = digest(currentContent)
  const source: ReplacementJournalEntry = {
    id: "source-version",
    mappingId: "mapping-1",
    path: "notes.txt",
    syncOperationId: 1,
    kind: "sync",
    oldDigest: archivedDigest,
    oldSize: archivedContent.length,
    replacementDigest: currentDigest,
    replacementSize: currentContent.length,
    archiveDigest: archivedDigest,
    archiveObjectKey: archiveObjectKey(archivedDigest),
    state: "completed",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    localRoot: live,
  }
  let restore: ReplacementJournalEntry | undefined
  let losePrepareResponse = false
  let loseCompletionResponse = false
  const rpc: ArchiveEngineRpc = {
    async request<T>(method: string, params?: unknown): Promise<T> {
      const input = params as Record<string, unknown> | undefined
      if (method === "archive.get") return (input?.entryId === source.id ? source : restore) as T
      if (method === "archive.prepareRestore") {
        restore = {
          id: String(input?.id),
          mappingId: source.mappingId,
          path: source.path,
          kind: "restore",
          oldDigest: String(input?.expectedCurrentDigest),
          oldSize: Number(input?.expectedCurrentSize),
          replacementDigest: archivedDigest,
          replacementSize: archivedContent.length,
          restoredFromJournalId: source.id,
          localRoot: String(input?.localRoot),
          state: "planned",
          createdAt: String(input?.createdAt),
          updatedAt: String(input?.createdAt),
        }
        if (losePrepareResponse) {
          losePrepareResponse = false
          throw new Error("database response was lost after prepare commit")
        }
        return restore as T
      }
      if (!restore) throw new Error("restore was not prepared")
      if (method === "archive.markArchived") {
        restore = {
          ...restore,
          archiveDigest: String(input?.archiveDigest),
          archiveObjectKey: String(input?.objectKey),
          state: "archived",
        }
        return restore as T
      }
      if (method === "archive.markInstalled") {
        restore = { ...restore, state: "installed" }
        return restore as T
      }
      if (method === "archive.completeRestore") {
        restore = { ...restore, state: "completed", completedAt: String(input?.occurredAt) }
        if (loseCompletionResponse) {
          loseCompletionResponse = false
          throw new Error("database response was lost after commit")
        }
        return restore as T
      }
      throw new Error(`unexpected RPC ${method}`)
    },
  }

  try {
    await writeFile(path.join(live, source.path), currentContent)
    const sourcePath = archiveObjectPath(archive, source.archiveObjectKey!)
    await mkdir(path.dirname(sourcePath), { recursive: true })
    await writeFile(sourcePath, archivedContent)

    const result = await restoreArchivedVersion(rpc, live, archive, source.id)
    expect(result.state).toBe("completed")
    expect(await readFile(path.join(live, source.path))).toEqual(archivedContent)
    expect(await readFile(archiveObjectPath(archive, archiveObjectKey(currentDigest)))).toEqual(currentContent)

    losePrepareResponse = true
    loseCompletionResponse = true
    const recoveredResult = await restoreArchivedVersion(rpc, live, archive, source.id)
    expect(recoveredResult.state).toBe("completed")
    expect(await readFile(path.join(live, source.path))).toEqual(archivedContent)
  } finally {
    await rm(live, { recursive: true, force: true })
    await rm(archive, { recursive: true, force: true })
  }
})

test("restore blocks when the live file changes after the restore precondition is recorded", async () => {
  const live = await mkdtemp(path.join(tmpdir(), "tethera-restore-live-"))
  const archive = await mkdtemp(path.join(tmpdir(), "tethera-restore-archive-"))
  const archivedContent = Buffer.from("archived")
  const currentContent = Buffer.from("current")
  const laterEdit = Buffer.from("later independent edit")
  const archivedDigest = digest(archivedContent)
  const source: ReplacementJournalEntry = {
    id: "source-version",
    mappingId: "mapping-1",
    path: "notes.txt",
    kind: "sync",
    oldDigest: archivedDigest,
    oldSize: archivedContent.length,
    replacementDigest: digest(currentContent),
    replacementSize: currentContent.length,
    archiveDigest: archivedDigest,
    archiveObjectKey: archiveObjectKey(archivedDigest),
    state: "completed",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    localRoot: live,
  }
  let restore: ReplacementJournalEntry | undefined
  const rpc: ArchiveEngineRpc = {
    async request<T>(method: string, params?: unknown): Promise<T> {
      const input = params as Record<string, unknown> | undefined
      if (method === "archive.get") return (input?.entryId === source.id ? source : restore) as T
      if (method === "archive.prepareRestore") {
        restore = {
          id: String(input?.id),
          mappingId: source.mappingId,
          path: source.path,
          kind: "restore",
          oldDigest: String(input?.expectedCurrentDigest),
          oldSize: Number(input?.expectedCurrentSize),
          replacementDigest: archivedDigest,
          replacementSize: archivedContent.length,
          restoredFromJournalId: source.id,
          localRoot: String(input?.localRoot),
          state: "planned",
          createdAt: String(input?.createdAt),
          updatedAt: String(input?.createdAt),
        }
        await writeFile(path.join(live, source.path), laterEdit)
        return restore as T
      }
      if (method === "archive.recover") {
        restore = { ...restore!, state: "recovery-required", lastError: "live file changed" }
        return restore as T
      }
      throw new Error(`unexpected RPC ${method}`)
    },
  }

  try {
    await writeFile(path.join(live, source.path), currentContent)
    const sourcePath = archiveObjectPath(archive, source.archiveObjectKey!)
    await mkdir(path.dirname(sourcePath), { recursive: true })
    await writeFile(sourcePath, archivedContent)
    await expect(restoreArchivedVersion(rpc, live, archive, source.id)).rejects.toThrow("changed after reconciliation")
    expect(await readFile(path.join(live, source.path))).toEqual(laterEdit)
  } finally {
    await rm(live, { recursive: true, force: true })
    await rm(archive, { recursive: true, force: true })
  }
})

test("restore durably marks a missing completed archive object unavailable", async () => {
  const live = await mkdtemp(path.join(tmpdir(), "tethera-restore-live-"))
  const archive = await mkdtemp(path.join(tmpdir(), "tethera-restore-archive-"))
  const archivedDigest = digest("missing archived bytes")
  const source: ReplacementJournalEntry = {
    id: "missing-source-version",
    mappingId: "mapping-1",
    path: "notes.txt",
    kind: "sync",
    oldDigest: archivedDigest,
    oldSize: 22,
    replacementDigest: digest("current"),
    replacementSize: 7,
    archiveDigest: archivedDigest,
    archiveObjectKey: archiveObjectKey(archivedDigest),
    archiveState: "available",
    state: "completed",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    localRoot: live,
  }
  let recordedState: unknown
  const rpc: ArchiveEngineRpc = {
    async request<T>(method: string, params?: unknown): Promise<T> {
      if (method === "archive.get") return source as T
      if (method === "archive.recordObjectIssue") {
        recordedState = (params as { state?: unknown }).state
        return { ...source, archiveState: recordedState } as T
      }
      throw new Error(`unexpected RPC ${method}`)
    },
  }
  try {
    await expect(restoreArchivedVersion(rpc, live, archive, source.id)).rejects.toThrow("content is missing")
    expect(recordedState).toBe("missing")
  } finally {
    await rm(live, { recursive: true, force: true })
    await rm(archive, { recursive: true, force: true })
  }
})
