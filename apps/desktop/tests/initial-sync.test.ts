import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { FileManifest } from "../src/main/folder-manifest"
import { computeSyncPlan, MAX_TRANSFER_FILE_BYTES, writeFileAtomic } from "../src/main/initial-sync"
import { resolveWithinRoot } from "../src/main/path-safety"

function manifest(files: FileManifest["files"]): FileManifest {
  return { rootPath: "/tmp/test", files, ignored: 0, unreadable: 0, truncated: false }
}

describe("computeSyncPlan", () => {
  test("pulls remote-only files and skips divergent ones", () => {
    const plan = computeSyncPlan(
      manifest([
        { path: "same.txt", size: 3, modifiedMs: 1, digest: "same" },
        { path: "changed.txt", size: 8, modifiedMs: 5, digest: "local-version" },
      ]),
      manifest([
        { path: "same.txt", size: 3, modifiedMs: 1, digest: "same" },
        { path: "changed.txt", size: 7, modifiedMs: 4, digest: "remote-version" },
        { path: "new.txt", size: 12, modifiedMs: 9, digest: "new" },
      ]),
      "two-way",
    )

    expect(plan.toPull.map((entry) => entry.path)).toEqual(["new.txt"])
    expect(plan.skipped).toEqual([
      { path: "changed.txt", reason: "Exists on both computers with different content; skipped until conflict resolution is available." },
    ])
  })

  test("skips remote-only files above the transfer size limit", () => {
    const plan = computeSyncPlan(
      manifest([]),
      manifest([{ path: "huge.bin", size: MAX_TRANSFER_FILE_BYTES + 1, modifiedMs: 1, digest: "x" }]),
      "two-way",
    )
    expect(plan.toPull).toEqual([])
    expect(plan.skipped).toEqual([{ path: "huge.bin", reason: "Larger than the 8 MiB initial-sync limit." }])
  })

  test("send-only mode never pulls", () => {
    const plan = computeSyncPlan(manifest([]), manifest([{ path: "new.txt", size: 1, modifiedMs: 1, digest: "x" }]), "send-only")
    expect(plan.toPull).toEqual([])
    expect(plan.skipped).toEqual([])
  })

  test("receive-only mode pulls remote-only files", () => {
    const plan = computeSyncPlan(manifest([]), manifest([{ path: "new.txt", size: 1, modifiedMs: 1, digest: "x" }]), "receive-only")
    expect(plan.toPull.map((entry) => entry.path)).toEqual(["new.txt"])
  })
})

describe("resolveWithinRoot", () => {
  test("resolves a plain relative path under the root", () => {
    expect(resolveWithinRoot("/tmp/root", "sub/file.txt")).toBe(path.resolve("/tmp/root", "sub/file.txt"))
  })

  test.each(["../escape.txt", "/etc/passwd", "sub/../../escape.txt", "sub/../..", ""])("rejects unsafe path %p", (unsafe) => {
    expect(() => resolveWithinRoot("/tmp/root", unsafe)).toThrow()
  })
})

describe("writeFileAtomic", () => {
  test("writes content and leaves no temp file behind", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tethera-sync-test-"))
    try {
      await writeFileAtomic(root, "nested/dir/file.txt", Buffer.from("hello"))
      const written = await readFile(path.join(root, "nested/dir/file.txt"), "utf8")
      expect(written).toBe("hello")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("rejects paths that escape the root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tethera-sync-test-"))
    try {
      await expect(writeFileAtomic(root, "../escape.txt", Buffer.from("bad"))).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
