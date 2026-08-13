import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  conflictSummary,
  FolderChangeMonitor,
  observedFiles,
  type FileSyncConflict,
} from "../src/main/continuous-sync"
import { invertMode } from "../src/main/mapping-index"

describe("continuous sync helpers", () => {
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
