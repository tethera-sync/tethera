import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { applyArchiveRetention, type ArchiveRetentionRpc } from "../src/main/archive-retention"
import { archiveObjectKey, archiveObjectPath, displacedFilePath } from "../src/main/version-archive"
import { sha256Hex as digest } from "./helpers"

interface FakeEntry {
  id: string
  path: string
  localRoot: string
  oldDigest: string
  oldSize: number
  createdAt: string
}

interface FakeDeletion {
  digest: string
  objectKey: string
  size: number
}

/**
 * Models the engine side of retention: listed entries are pruned on request, and their content is
 * queued for deletion. `confirmations` records whether each object file was already gone when the
 * desktop confirmed it.
 */
class FakeRetentionEngine implements ArchiveRetentionRpc {
  readonly calls: string[] = []
  readonly confirmations: Array<{ digest: string; fileWasGone: boolean }> = []

  constructor(
    private readonly archiveRoot: string,
    readonly prunable: Map<string, FakeEntry[]>,
    readonly deletions: FakeDeletion[] = [],
  ) {}

  async request<T>(method: string, params?: unknown): Promise<T> {
    this.calls.push(method)
    const input = params as Record<string, unknown>
    switch (method) {
      case "archive.listObjectDeletions":
        return this.deletions.slice(0, Number(input.limit)) as T
      case "archive.completeObjectDeletion": {
        const index = this.deletions.findIndex((deletion) => deletion.digest === input.digest)
        const [deletion] = this.deletions.splice(index, 1)
        const fileWasGone = await stat(archiveObjectPath(this.archiveRoot, deletion.objectKey)).then(() => false, () => true)
        this.confirmations.push({ digest: deletion.digest, fileWasGone })
        return { removed: true } as T
      }
      case "archive.listPrunable":
        return (this.prunable.get(String(input.id)) ?? []) as T
      case "archive.prune": {
        const folderId = String(input.id)
        const requested = new Set(input.entryIds as string[])
        const entries = this.prunable.get(folderId) ?? []
        const pruned = entries.filter((entry) => requested.has(entry.id))
        this.prunable.set(folderId, entries.filter((entry) => !requested.has(entry.id)))
        for (const entry of pruned) {
          this.deletions.push({ digest: entry.oldDigest, objectKey: archiveObjectKey(entry.oldDigest), size: entry.oldSize })
        }
        return { prunedEntries: pruned.length, queuedObjectDeletions: pruned.length } as T
      }
      default:
        throw new Error(`Unexpected RPC ${method}`)
    }
  }
}

async function withRoots(run: (roots: { live: string; archive: string }) => Promise<void>): Promise<void> {
  const live = await mkdtemp(path.join(tmpdir(), "tethera-retention-live-"))
  const archive = await mkdtemp(path.join(tmpdir(), "tethera-retention-archive-"))
  try {
    await run({ live: await realpath(live), archive })
  } finally {
    await rm(live, { recursive: true, force: true })
    await rm(archive, { recursive: true, force: true })
  }
}

async function writeArchiveObject(archiveRoot: string, content: Buffer): Promise<string> {
  const objectPath = archiveObjectPath(archiveRoot, archiveObjectKey(digest(content)))
  await mkdir(path.dirname(objectPath), { recursive: true })
  await writeFile(objectPath, content)
  return objectPath
}

async function exists(filePath: string): Promise<boolean> {
  return stat(filePath).then(() => true, () => false)
}

describe("version history retention", () => {
  test("removes an unchanged displaced copy, prunes the version, then deletes its archive object", async () => {
    await withRoots(async ({ live, archive }) => {
      const old = Buffer.from("previous version")
      const objectPath = await writeArchiveObject(archive, old)
      // The journal stores logical paths; the displaced copy lives under this computer's spelling.
      const displaced = path.join(live, displacedFilePath("notes/today.txt", "entry-1"))
      await mkdir(path.dirname(displaced), { recursive: true })
      await writeFile(displaced, old)
      const engine = new FakeRetentionEngine(archive, new Map([["folder-1", [{
        id: "entry-1", path: "Notes/today.txt", localRoot: live, oldDigest: digest(old), oldSize: old.length, createdAt: "2026-07-01T00:00:00Z",
      }]]]))

      const result = await applyArchiveRetention(engine, archive, [
        { id: "folder-1", localPath: live, physicalPath: (logical) => logical.toLowerCase() },
      ])

      expect(result).toEqual({
        removedObjects: 1,
        folders: [{ folderId: "folder-1", status: "applied", prunedVersions: 1, keptChangedCopies: 0 }],
      })
      expect(await exists(displaced)).toBe(false)
      expect(await exists(objectPath)).toBe(false)
      expect(engine.confirmations).toEqual([{ digest: digest(old), fileWasGone: true }])
    })
  })

  test("keeps a displaced copy that was edited after the replacement", async () => {
    await withRoots(async ({ live, archive }) => {
      const old = Buffer.from("previous version")
      const displaced = path.join(live, displacedFilePath("notes.txt", "entry-1"))
      await writeFile(displaced, "late edit through an open handle")
      const engine = new FakeRetentionEngine(archive, new Map([["folder-1", [{
        id: "entry-1", path: "notes.txt", localRoot: live, oldDigest: digest(old), oldSize: old.length, createdAt: "2026-07-01T00:00:00Z",
      }]]]))

      const result = await applyArchiveRetention(engine, archive, [
        { id: "folder-1", localPath: live, physicalPath: (logical) => logical },
      ])

      expect(result.folders).toEqual([{ folderId: "folder-1", status: "applied", prunedVersions: 1, keptChangedCopies: 1 }])
      expect(await exists(displaced)).toBe(true)
    })
  })

  test("never touches a displaced copy recorded under a different folder root", async () => {
    await withRoots(async ({ live, archive }) => {
      const old = Buffer.from("previous version")
      const displaced = path.join(live, displacedFilePath("notes.txt", "entry-1"))
      await writeFile(displaced, old)
      const engine = new FakeRetentionEngine(archive, new Map([["folder-1", [{
        id: "entry-1", path: "notes.txt", localRoot: path.join(live, "earlier-root"), oldDigest: digest(old), oldSize: old.length, createdAt: "2026-07-01T00:00:00Z",
      }]]]))

      await applyArchiveRetention(engine, archive, [{ id: "folder-1", localPath: live, physicalPath: (logical) => logical }])

      expect(await exists(displaced)).toBe(true)
      expect(engine.prunable.get("folder-1")).toEqual([])
    })
  })

  test("leaves history untouched while a folder root is unavailable", async () => {
    await withRoots(async ({ live, archive }) => {
      const engine = new FakeRetentionEngine(archive, new Map([["folder-1", [{
        id: "entry-1", path: "notes.txt", localRoot: live, oldDigest: digest("old"), oldSize: 3, createdAt: "2026-07-01T00:00:00Z",
      }]]]))

      const result = await applyArchiveRetention(engine, archive, [
        { id: "folder-1", localPath: path.join(live, "unmounted"), physicalPath: (logical) => logical },
      ])

      expect(result.folders).toEqual([{ folderId: "folder-1", status: "unavailable" }])
      expect(engine.calls).toEqual(["archive.listObjectDeletions"])
      expect(engine.prunable.get("folder-1")).toHaveLength(1)
    })
  })

  test("an interrupted object removal is never confirmed and finishes on the next pass", async () => {
    await withRoots(async ({ live, archive }) => {
      const alreadyRemoved = Buffer.from("removed before the interruption")
      const blocked = Buffer.from("could not be removed yet")
      const blockedPath = archiveObjectPath(archive, archiveObjectKey(digest(blocked)))
      // A directory in the object's place makes unlink fail, standing in for a crash or I/O error.
      await mkdir(blockedPath, { recursive: true })
      const engine = new FakeRetentionEngine(archive, new Map(), [
        { digest: digest(alreadyRemoved), objectKey: archiveObjectKey(digest(alreadyRemoved)), size: alreadyRemoved.length },
        { digest: digest(blocked), objectKey: archiveObjectKey(digest(blocked)), size: blocked.length },
      ])

      await expect(applyArchiveRetention(engine, archive, [{ id: "folder-1", localPath: live, physicalPath: (l) => l }])).rejects.toThrow()
      expect(engine.confirmations).toEqual([{ digest: digest(alreadyRemoved), fileWasGone: true }])
      expect(engine.deletions.map((deletion) => deletion.digest)).toEqual([digest(blocked)])

      await rm(blockedPath, { recursive: true })
      await writeArchiveObject(archive, blocked)
      const result = await applyArchiveRetention(engine, archive, [])

      expect(result.removedObjects).toBe(1)
      expect(engine.deletions).toEqual([])
      expect(engine.confirmations.at(-1)).toEqual({ digest: digest(blocked), fileWasGone: true })
      expect(await readdir(path.dirname(blockedPath))).toEqual([])
    })
  })
})
