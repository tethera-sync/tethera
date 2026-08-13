import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { link, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { writeFileChunksAtomic } from "../src/main/initial-sync"
import {
  archiveDisplacedFile,
  archiveObjectKey,
  archiveObjectPath,
  archiveStagingObjectPath,
  displacedFilePath,
  inspectReplacementRecovery,
  recoverStagedArchiveObject,
  verifyArchiveObject,
  type ReplacementJournalEntry,
} from "../src/main/version-archive"

const digest = (content: Buffer | string) => createHash("sha256").update(content).digest("hex")

describe("durable version archive", () => {
  test("archives exact pre-replacement content outside the live root", async () => {
    const live = await mkdtemp(path.join(tmpdir(), "tethera-live-"))
    const archive = await mkdtemp(path.join(tmpdir(), "tethera-archive-"))
    const old = Buffer.from("previous version")
    const next = Buffer.from("replacement version")
    const oldDigest = digest(old)
    const nextDigest = digest(next)
    const transitions: string[] = []
    try {
      await writeFile(path.join(live, "folder", "same.txt"), old).catch(async () => {
        await mkdir(path.join(live, "folder"))
        await writeFile(path.join(live, "folder", "same.txt"), old)
      })
      await writeFileChunksAtomic(live, "folder/same.txt", next.length, nextDigest, async function* () {
        yield next
      }(), {
        expectedDestinationDigest: oldDigest,
        expectedDestinationSize: old.length,
        replacement: {
          journalId: "normal-replacement",
          archiveRoot: archive,
          markArchived: async () => { transitions.push("archived") },
          markInstalled: async () => { transitions.push("installed") },
        },
      })
      expect(transitions).toEqual(["archived", "installed"])
      expect(await readFile(path.join(live, "folder", "same.txt"))).toEqual(next)
      expect(await readFile(archiveObjectPath(archive, archiveObjectKey(oldDigest)))).toEqual(old)
    } finally {
      await rm(live, { recursive: true, force: true })
      await rm(archive, { recursive: true, force: true })
    }
  })

  test("retains the displaced inode so late writes through an open handle are not lost", async () => {
    const live = await mkdtemp(path.join(tmpdir(), "tethera-live-"))
    const archive = await mkdtemp(path.join(tmpdir(), "tethera-archive-"))
    const old = Buffer.from("previous version")
    const next = Buffer.from("replacement version")
    const journalId = "open-handle-replacement"
    let oldHandle: Awaited<ReturnType<typeof open>> | undefined
    try {
      await writeFile(path.join(live, "notes.txt"), old)
      oldHandle = await open(path.join(live, "notes.txt"), "r+")
      await writeFileChunksAtomic(live, "notes.txt", next.length, digest(next), async function* () {
        yield next
      }(), {
        expectedDestinationDigest: digest(old),
        expectedDestinationSize: old.length,
        replacement: {
          journalId,
          archiveRoot: archive,
          markArchived: async () => undefined,
          markInstalled: async () => undefined,
        },
      })
      const lateEdit = Buffer.from("late edit through old handle")
      await oldHandle.truncate(0)
      await oldHandle.write(lateEdit, 0, lateEdit.length, 0)
      await oldHandle.sync()
      expect(await readFile(path.join(live, "notes.txt"))).toEqual(next)
      expect(await readFile(path.join(live, displacedFilePath("notes.txt", journalId)))).toEqual(lateEdit)
      expect(await readFile(archiveObjectPath(archive, archiveObjectKey(digest(old))))).toEqual(old)
    } finally {
      await oldHandle?.close()
      await rm(live, { recursive: true, force: true })
      await rm(archive, { recursive: true, force: true })
    }
  })

  test("archive failure restores the old live file and prevents replacement", async () => {
    const live = await mkdtemp(path.join(tmpdir(), "tethera-live-"))
    const old = Buffer.from("do not lose me")
    const next = Buffer.from("new")
    try {
      await writeFile(path.join(live, "notes.txt"), old)
      await expect(writeFileChunksAtomic(live, "notes.txt", next.length, digest(next), async function* () {
        yield next
      }(), {
        expectedDestinationDigest: digest(old),
        expectedDestinationSize: old.length,
        replacement: {
          journalId: "bad-archive-root",
          archiveRoot: path.join(live, "nested-archive"),
          markArchived: async () => undefined,
          markInstalled: async () => undefined,
        },
      })).rejects.toThrow("outside")
      expect(await readFile(path.join(live, "notes.txt"))).toEqual(old)
    } finally {
      await rm(live, { recursive: true, force: true })
    }
  })

  test("database failure before live install leaves the archive recoverable and old file live", async () => {
    const live = await mkdtemp(path.join(tmpdir(), "tethera-live-"))
    const archive = await mkdtemp(path.join(tmpdir(), "tethera-archive-"))
    const old = Buffer.from("old")
    const next = Buffer.from("next")
    try {
      await writeFile(path.join(live, "notes.txt"), old)
      await expect(writeFileChunksAtomic(live, "notes.txt", next.length, digest(next), async function* () {
        yield next
      }(), {
        expectedDestinationDigest: digest(old),
        expectedDestinationSize: old.length,
        replacement: {
          journalId: "database-failure",
          archiveRoot: archive,
          markArchived: async () => { throw new Error("database unavailable") },
          markInstalled: async () => undefined,
        },
      })).rejects.toThrow("database unavailable")
      expect(await readFile(path.join(live, "notes.txt"))).toEqual(old)
      expect(await verifyArchiveObject(archive, archiveObjectKey(digest(old)), digest(old), old.length)).toBe(true)
    } finally {
      await rm(live, { recursive: true, force: true })
      await rm(archive, { recursive: true, force: true })
    }
  })

  test("replacement install failure keeps the old file live and its archive available", async () => {
    const live = await mkdtemp(path.join(tmpdir(), "tethera-live-"))
    const archive = await mkdtemp(path.join(tmpdir(), "tethera-archive-"))
    const old = Buffer.from("old")
    const next = Buffer.from("next")
    try {
      await writeFile(path.join(live, "notes.txt"), old)
      await expect(writeFileChunksAtomic(live, "notes.txt", next.length, digest(next), async function* () {
        yield next
      }(), {
        expectedDestinationDigest: digest(old),
        expectedDestinationSize: old.length,
        replacement: {
          journalId: "rename-failure",
          archiveRoot: archive,
          markArchived: async () => undefined,
          markInstalled: async () => undefined,
          installStaged: async () => {
            const error = new Error("destination is locked") as NodeJS.ErrnoException
            error.code = "EACCES"
            throw error
          },
        },
      })).rejects.toThrow("locked")
      expect(await readFile(path.join(live, "notes.txt"))).toEqual(old)
      expect(await verifyArchiveObject(archive, archiveObjectKey(digest(old)), digest(old), old.length)).toBe(true)
      const inspection = await inspectReplacementRecovery(live, archive, {
        id: "rename-failure",
        mappingId: "mapping-1",
        path: "notes.txt",
        kind: "sync",
        oldDigest: digest(old),
        oldSize: old.length,
        replacementDigest: digest(next),
        replacementSize: next.length,
        archiveDigest: digest(old),
        archiveObjectKey: archiveObjectKey(digest(old)),
        state: "archived",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        localRoot: live,
      })
      expect(inspection.liveDigest).toBe(digest(old))
    } finally {
      await rm(live, { recursive: true, force: true })
      await rm(archive, { recursive: true, force: true })
    }
  })

  test("a file created during archival is never overwritten by install or rollback", async () => {
    const live = await mkdtemp(path.join(tmpdir(), "tethera-live-"))
    const archive = await mkdtemp(path.join(tmpdir(), "tethera-archive-"))
    const old = Buffer.from("old")
    const next = Buffer.from("next")
    const concurrent = Buffer.from("concurrent writer")
    try {
      await writeFile(path.join(live, "notes.txt"), old)
      await expect(writeFileChunksAtomic(live, "notes.txt", next.length, digest(next), async function* () {
        yield next
      }(), {
        expectedDestinationDigest: digest(old),
        expectedDestinationSize: old.length,
        replacement: {
          journalId: "concurrent-destination",
          archiveRoot: archive,
          markArchived: async () => undefined,
          markInstalled: async () => undefined,
          installStaged: async (staged, destination) => {
            await writeFile(destination, concurrent)
            await link(staged, destination)
          },
        },
      })).rejects.toHaveProperty("code", "EEXIST")
      expect(await readFile(path.join(live, "notes.txt"))).toEqual(concurrent)
      expect(await readFile(path.join(live, displacedFilePath("notes.txt", "concurrent-destination")))).toEqual(old)
      expect(await verifyArchiveObject(archive, archiveObjectKey(digest(old)), digest(old), old.length)).toBe(true)
    } finally {
      await rm(live, { recursive: true, force: true })
      await rm(archive, { recursive: true, force: true })
    }
  })

  test("database failure after replacement leaves the old archive recoverable", async () => {
    const live = await mkdtemp(path.join(tmpdir(), "tethera-live-"))
    const archive = await mkdtemp(path.join(tmpdir(), "tethera-archive-"))
    const old = Buffer.from("old")
    const next = Buffer.from("next")
    try {
      await writeFile(path.join(live, "notes.txt"), old)
      await expect(writeFileChunksAtomic(live, "notes.txt", next.length, digest(next), async function* () {
        yield next
      }(), {
        expectedDestinationDigest: digest(old),
        expectedDestinationSize: old.length,
        replacement: {
          journalId: "post-replacement-db-failure",
          archiveRoot: archive,
          markArchived: async () => undefined,
          markInstalled: async () => { throw new Error("database commit failed") },
        },
      })).rejects.toThrow("database commit failed")
      expect(await readFile(path.join(live, "notes.txt"))).toEqual(next)
      expect(await verifyArchiveObject(archive, archiveObjectKey(digest(old)), digest(old), old.length)).toBe(true)
    } finally {
      await rm(live, { recursive: true, force: true })
      await rm(archive, { recursive: true, force: true })
    }
  })

  test("a stale destination change during staging is never overwritten", async () => {
    const live = await mkdtemp(path.join(tmpdir(), "tethera-live-"))
    const archive = await mkdtemp(path.join(tmpdir(), "tethera-archive-"))
    const old = Buffer.from("old")
    const next = Buffer.from("next")
    const changed = Buffer.from("independent current edit")
    try {
      await writeFile(path.join(live, "notes.txt"), old)
      await expect(writeFileChunksAtomic(live, "notes.txt", next.length, digest(next), async function* () {
        yield next
        await writeFile(path.join(live, "notes.txt"), changed)
      }(), {
        expectedDestinationDigest: digest(old),
        expectedDestinationSize: old.length,
        replacement: {
          journalId: "stale-replacement",
          archiveRoot: archive,
          markArchived: async () => undefined,
          markInstalled: async () => undefined,
        },
      })).rejects.toThrow("changed during transfer")
      expect(await readFile(path.join(live, "notes.txt"))).toEqual(changed)
    } finally {
      await rm(live, { recursive: true, force: true })
      await rm(archive, { recursive: true, force: true })
    }
  })

  test("restart restores a displaced file when replacement never reached the live name", async () => {
    const live = await mkdtemp(path.join(tmpdir(), "tethera-live-"))
    const archive = await mkdtemp(path.join(tmpdir(), "tethera-archive-"))
    const old = Buffer.from("old")
    const oldDigest = digest(old)
    const entry: ReplacementJournalEntry = {
      id: "crash-window",
      mappingId: "mapping-1",
      path: "notes.txt",
      syncOperationId: 1,
      kind: "sync",
      oldDigest,
      oldSize: old.length,
      replacementDigest: digest("next"),
      replacementSize: 4,
      state: "planned",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      localRoot: live,
    }
    try {
      await writeFile(path.join(live, "notes.txt"), old)
      await rename(path.join(live, "notes.txt"), path.join(live, displacedFilePath(entry.path, entry.id)))
      const inspection = await inspectReplacementRecovery(live, archive, entry)
      expect(inspection.restoredDisplacedFile).toBe(true)
      expect(inspection.liveDigest).toBe(oldDigest)
      expect(await readFile(path.join(live, "notes.txt"))).toEqual(old)
    } finally {
      await rm(live, { recursive: true, force: true })
      await rm(archive, { recursive: true, force: true })
    }
  })

  test("restart rolls forward a missing-live restore when the wire fields are null", async () => {
    const live = await mkdtemp(path.join(tmpdir(), "tethera-live-"))
    const archive = await mkdtemp(path.join(tmpdir(), "tethera-archive-"))
    const restored = Buffer.from("restored version")
    const entry: ReplacementJournalEntry = {
      id: "missing-live-restore",
      mappingId: "mapping-1",
      path: "notes.txt",
      syncOperationId: null,
      kind: "restore",
      oldDigest: null,
      oldSize: null,
      replacementDigest: digest(restored),
      replacementSize: restored.length,
      archiveDigest: null,
      archiveObjectKey: null,
      state: "installed",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      localRoot: live,
    }
    try {
      await writeFile(path.join(live, entry.path), restored)
      const inspection = await inspectReplacementRecovery(live, archive, entry)
      expect(inspection.liveDigest).toBe(entry.replacementDigest)
      expect(inspection.archiveAvailable).toBe(true)
    } finally {
      await rm(live, { recursive: true, force: true })
      await rm(archive, { recursive: true, force: true })
    }
  })

  test("duplicate basenames and malicious keys cannot collide or escape", async () => {
    const live = await mkdtemp(path.join(tmpdir(), "tethera-live-"))
    const archive = await mkdtemp(path.join(tmpdir(), "tethera-archive-"))
    try {
      const first = Buffer.from("first")
      const second = Buffer.from("second")
      await mkdir(path.join(live, "a"))
      await mkdir(path.join(live, "b"))
      await writeFile(path.join(live, "a", "same.txt"), first)
      await writeFile(path.join(live, "b", "same.txt"), second)
      const firstObject = await archiveDisplacedFile(live, "a/same.txt", archive, "first-journal", digest(first), first.length)
      const secondObject = await archiveDisplacedFile(live, "b/same.txt", archive, "second-journal", digest(second), second.length)
      expect(firstObject.objectKey).not.toBe(secondObject.objectKey)
      expect(() => archiveObjectPath(archive, "sha256/aa/../../escape")).toThrow()
    } finally {
      await rm(live, { recursive: true, force: true })
      await rm(archive, { recursive: true, force: true })
    }
  })

  test("detects missing and corrupt archive objects", async () => {
    const live = await mkdtemp(path.join(tmpdir(), "tethera-live-"))
    const archive = await mkdtemp(path.join(tmpdir(), "tethera-archive-"))
    const previous = Buffer.from("previous")
    try {
      await writeFile(path.join(live, "notes.txt"), previous)
      const archived = await archiveDisplacedFile(
        live,
        "notes.txt",
        archive,
        "integrity-journal",
        digest(previous),
        previous.length,
      )
      expect(await verifyArchiveObject(archive, archived.objectKey, archived.digest, archived.size)).toBe(true)
      await writeFile(archiveObjectPath(archive, archived.objectKey), "tampered")
      expect(await verifyArchiveObject(archive, archived.objectKey, archived.digest, archived.size)).toBe(false)
      await rm(archiveObjectPath(archive, archived.objectKey))
      expect(await verifyArchiveObject(archive, archived.objectKey, archived.digest, archived.size)).toBe(false)
    } finally {
      await rm(live, { recursive: true, force: true })
      await rm(archive, { recursive: true, force: true })
    }
  })

  test("restart publishes a complete deterministic archive stage and retains a partial one", async () => {
    const archive = await mkdtemp(path.join(tmpdir(), "tethera-archive-"))
    const previous = Buffer.from("complete staged archive")
    const previousDigest = digest(previous)
    const completeJournal = "complete-stage-journal"
    const partialJournal = "partial-stage-journal"
    try {
      const completeStage = archiveStagingObjectPath(archive, previousDigest, completeJournal)
      await mkdir(path.dirname(completeStage), { recursive: true })
      await writeFile(completeStage, previous)
      const recovered = await recoverStagedArchiveObject(
        archive,
        completeJournal,
        previousDigest,
        previous.length,
      )
      expect(recovered?.objectKey).toBe(archiveObjectKey(previousDigest))
      expect(await readFile(archiveObjectPath(archive, archiveObjectKey(previousDigest)))).toEqual(previous)

      const partial = Buffer.from("partial")
      const partialDigest = digest("expected complete object")
      const partialStage = archiveStagingObjectPath(archive, partialDigest, partialJournal)
      await mkdir(path.dirname(partialStage), { recursive: true })
      await writeFile(partialStage, partial)
      expect(await recoverStagedArchiveObject(
        archive,
        partialJournal,
        partialDigest,
        Buffer.byteLength("expected complete object"),
      )).toBeUndefined()
      expect(await readFile(partialStage)).toEqual(partial)
    } finally {
      await rm(archive, { recursive: true, force: true })
    }
  })
})
