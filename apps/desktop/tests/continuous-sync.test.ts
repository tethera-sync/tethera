import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  conflictSummary,
  findMirroredPeerOperation,
  FolderChangeMonitor,
  mirrorConflictChoice,
  observedFiles,
  replayableOperations,
  type FileSyncConflict,
} from "../src/main/continuous-sync"
import { invertMode } from "../src/main/mapping-index"

describe("continuous sync helpers", () => {
  test("replays only durable operations whose source and destination are still exact", () => {
    const operation = {
      id: 1,
      mappingId: "mapping-1",
      path: "notes.txt",
      direction: "push-local" as const,
      sourceDigest: "b".repeat(64),
      sourceSize: 4,
      expectedDestinationDigest: "c".repeat(64),
      status: "pending" as const,
      attempts: 0,
      createdAt: "2026-08-31T12:00:00Z",
      updatedAt: "2026-08-31T12:00:00Z",
    }
    expect(replayableOperations(
      [operation],
      [{ path: "notes.txt", size: 4, digest: "b".repeat(64) }],
      [{ path: "notes.txt", size: 4, digest: "c".repeat(64) }],
    )).toEqual([operation])
    expect(replayableOperations(
      [operation],
      [{ path: "notes.txt", size: 4, digest: "d".repeat(64) }],
      [{ path: "notes.txt", size: 4, digest: "c".repeat(64) }],
    )).toEqual([])
  })

  test("mirrors a conflict choice into the paired computer's orientation", () => {
    expect(mirrorConflictChoice({
      direction: "push-local",
      localDigest: "a".repeat(64),
      localSize: 10,
      remoteDigest: "b".repeat(64),
      remoteSize: 20,
    })).toEqual({
      direction: "pull-remote",
      localDigest: "b".repeat(64),
      localSize: 20,
      remoteDigest: "a".repeat(64),
      remoteSize: 10,
    })
  })

  test("binds an acknowledgement to the exact mirrored durable operation", () => {
    const localOperation = {
      id: 7,
      mappingId: "mapping-1",
      path: "notes.txt",
      direction: "pull-remote" as const,
      sourceDigest: "b".repeat(64),
      sourceSize: 20,
      expectedDestinationDigest: "a".repeat(64),
      status: "pending" as const,
      attempts: 0,
      createdAt: "2026-08-31T12:00:00Z",
      updatedAt: "2026-08-31T12:00:00Z",
    }
    const exactPeerOperation = {
      id: 11,
      path: "notes.txt",
      direction: "push-local" as const,
      sourceDigest: "b".repeat(64),
      sourceSize: 20,
      expectedDestinationDigest: "a".repeat(64),
    }
    expect(findMirroredPeerOperation(localOperation, [
      { ...exactPeerOperation, id: 10, expectedDestinationDigest: "c".repeat(64) },
      exactPeerOperation,
    ])).toEqual(exactPeerOperation)
  })

  test("requires full digests before sending an observation to Rust", () => {
    expect(() => observedFiles({
      rootPath: "/tmp/root",
      files: [{ path: "large.bin", size: 20, modifiedMs: 1 }],
      ignored: 0,
      unreadable: 0,
      truncated: false,
    })).toThrow("did not produce a digest")
  })

  test("inverts directional rules for the peer view", () => {
    expect(invertMode("send-only")).toBe("receive-only")
    expect(invertMode("receive-only")).toBe("send-only")
    expect(invertMode("two-way")).toBe("two-way")
  })

  test("summarises durable conflict kinds without claiming a winner", () => {
    const conflicts: FileSyncConflict[] = [
      { mappingId: "m", path: "a", kind: "simultaneous-modification", detectedAt: "now" },
      { mappingId: "m", path: "b", kind: "deletion-not-propagated", detectedAt: "now" },
      { mappingId: "m", path: "c", kind: "direction-blocked", localDigest: "a".repeat(64), detectedAt: "now" },
    ]
    const summary = conflictSummary(conflicts)
    expect(summary).toContain("edited on both computers")
    expect(summary).toContain("changed against the one-way direction")
    expect(summary).toContain("neither copy was changed")
  })
})

test("FolderChangeMonitor reports nested filesystem changes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tethera-watch-test-"))
  await mkdir(path.join(root, "nested"))
  let resolveChange!: () => void
  const changed = new Promise<void>((resolve) => { resolveChange = resolve })
  const monitor = new FolderChangeMonitor(root, [], resolveChange)
  try {
    await monitor.start()
    await writeFile(path.join(root, "nested", "note.txt"), "changed")
    await Promise.race([
      changed,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("watch event timed out")), 5_000)),
    ])
  } finally {
    monitor.close()
    await rm(root, { recursive: true, force: true })
  }
})
