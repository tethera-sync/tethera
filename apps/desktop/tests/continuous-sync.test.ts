import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fingerprintFolder, parsePeerManifest, scanFolder } from "../src/main/folder-manifest"
import { fingerprintObservation } from "../src/main/observation-fingerprint"
import {
  canSkipUnchangedCycle,
  conflictKey,
  FULL_RECONCILE_INTERVAL_MS,
  isUnchangedScanReply,
  type FileSyncOperation,
  type FileSyncState,
  type QuietReconcile,
  conflictSummary,
  findMirroredPeerOperation,
  FolderChangeMonitor,
  mirrorConflictChoice,
  observedFiles,
  replayableOperations,
  type FileSyncConflict,
  type WatchHealthReport,
} from "../src/main/continuous-sync"

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

test("FolderChangeMonitor reports a watch-depth degradation instead of silently losing coverage", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tethera-watch-depth-"))
  const reports: WatchHealthReport[] = []
  const monitor = new FolderChangeMonitor(root, [], () => {}, (report) => {
    reports.push(report)
  })
  try {
    await monitor.start()

    // collectWatchDirectories rejects a tree nested past MAX_WATCH_DEPTH (128).
    // Creating one this deep forces the next directory-refresh (triggered by
    // the "rename" event for the new top-level entry) to hit that limit.
    const segments = Array.from({ length: 140 }, (_, index) => `d${index}`)
    await mkdir(path.join(root, ...segments), { recursive: true })

    const report = await new Promise<WatchHealthReport>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("watch degradation was not reported in time")), 5_000)
      const interval = setInterval(() => {
        const first = reports[0]
        if (!first) return
        clearInterval(interval)
        clearTimeout(timeout)
        resolve(first)
      }, 50)
    })

    expect(report.status).toBe("degraded")
    if (report.status === "degraded") {
      expect(report.reason.kind).toBe("watch-depth-exceeded")
      expect(report.reason.message).toContain("watch limit")
    }
  } finally {
    monitor.close()
    await rm(root, { recursive: true, force: true })
  }
})

describe("idle continuous cycles", () => {
  const durable: FileSyncState = { mappingId: "mapping-1", initialized: true, baselineCount: 10, operations: [], conflicts: [], recoveryIssues: [] }
  const conflict: FileSyncConflict = {
    mappingId: "mapping-1",
    path: "a.txt",
    kind: "simultaneous-modification",
    localDigest: "a".repeat(64),
    remoteDigest: "b".repeat(64),
    detectedAt: "2026-09-11T00:00:00Z",
  }
  const operation: FileSyncOperation = {
    id: 1,
    mappingId: "mapping-1",
    path: "a.txt",
    direction: "push-local",
    sourceDigest: "a".repeat(64),
    sourceSize: 1,
    status: "pending",
    attempts: 0,
    createdAt: "2026-09-11T00:00:00Z",
    updatedAt: "2026-09-11T00:00:00Z",
  }
  const quiet: QuietReconcile = {
    revision: 3,
    localFingerprint: `1:${"a".repeat(64)}`,
    remoteFingerprint: `1:${"b".repeat(64)}`,
    baselineCount: 10,
    conflictKey: conflictKey([]),
    reconciledAt: 1_000,
  }

  test("skips only while the revision, durable state and recency all still match a quiet reconcile", () => {
    expect(canSkipUnchangedCycle(quiet, durable, 3, 2_000)).toBe(true)
    expect(canSkipUnchangedCycle(undefined, durable, 3, 2_000)).toBe(false)
    expect(canSkipUnchangedCycle(quiet, durable, 4, 2_000)).toBe(false)
    expect(canSkipUnchangedCycle(quiet, { ...durable, operations: [operation] }, 3, 2_000)).toBe(false)
    expect(canSkipUnchangedCycle(quiet, { ...durable, baselineCount: 11 }, 3, 2_000)).toBe(false)
    expect(canSkipUnchangedCycle(quiet, { ...durable, conflicts: [conflict] }, 3, 2_000)).toBe(false)
    expect(canSkipUnchangedCycle(quiet, { ...durable, recoveryIssues: [{ id: "journal-1", path: "a.txt", state: "recovery-required" }] }, 3, 2_000)).toBe(false)
    expect(canSkipUnchangedCycle(quiet, durable, 3, quiet.reconciledAt + FULL_RECONCILE_INTERVAL_MS)).toBe(false)
  })

  test("identifies a conflict set regardless of listing order", () => {
    const other: FileSyncConflict = { ...conflict, path: "b.txt" }
    expect(conflictKey([conflict, other])).toBe(conflictKey([other, conflict]))
    expect(conflictKey([conflict])).not.toBe(conflictKey([{ ...conflict, remoteDigest: "c".repeat(64) }]))
  })

  test("accepts only an exact unchanged reply", () => {
    expect(isUnchangedScanReply({ unchanged: true })).toBe(true)
    for (const value of [{ unchanged: "true" }, { unchanged: true, files: [] }, { rootPath: "/", files: [] }, null, [true]]) {
      expect(isUnchangedScanReply(value)).toBe(false)
    }
  })
})

describe("idle-cycle fingerprints across the wire", () => {
  test("a peer's streamed fingerprint equals the one rebuilt from the manifest it would send", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tethera-fingerprint-wire-test-"))
    try {
      await mkdir(path.join(root, "naïve", "déjà vu"), { recursive: true })
      await writeFile(path.join(root, "top.txt"), "top")
      await writeFile(path.join(root, "naïve", "café.txt"), "café")
      await writeFile(path.join(root, "naïve", "déjà vu", "日本語.bin"), Buffer.alloc(300_000, 7))
      await writeFile(path.join(root, "empty.txt"), "")
      const streamed = await fingerprintFolder(root, [], { maxFiles: null })
      const sent = await scanFolder(root, [], { hashAllFiles: true, maxFiles: null })
      // As the coordinator receives it: serialized, then validated.
      const received = parsePeerManifest(JSON.parse(JSON.stringify(sent)))
      expect(fingerprintObservation(observedFiles(received))).toBe(streamed.fingerprint)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
