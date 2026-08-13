import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { FileManifest } from "../src/main/folder-manifest"
import {
  assessInitialMergeConvergence,
  computeSyncPlan,
  runCoordinatedInitialMerge,
  writeFileAtomic,
  writeFileChunksAtomic,
} from "../src/main/initial-sync"
import { isTetheraStagingPath, resolveWithinRoot } from "../src/main/path-safety"
import { archiveObjectPath } from "../src/main/version-archive"

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

  test("plans remote-only files of any size for chunked transfer", () => {
    const plan = computeSyncPlan(
      manifest([]),
      manifest([{ path: "huge.bin", size: 128 * 1024 * 1024, modifiedMs: 1, digest: "x" }]),
      "two-way",
    )
    expect(plan.toPull.map((entry) => entry.path)).toEqual(["huge.bin"])
    expect(plan.skipped).toEqual([])
  })

  test("send-only mode never pulls", () => {
    const plan = computeSyncPlan(
      manifest([{ path: "conflict.txt", size: 1, modifiedMs: 1, digest: "local" }]),
      manifest([
        { path: "new.txt", size: 1, modifiedMs: 1, digest: "remote" },
        { path: "conflict.txt", size: 1, modifiedMs: 1, digest: "remote" },
      ]),
      "send-only",
    )
    expect(plan.toPull).toEqual([])
    expect(plan.skipped.map((skip) => skip.path)).toEqual(["conflict.txt"])
  })

  test("receive-only mode pulls remote-only files", () => {
    const plan = computeSyncPlan(manifest([]), manifest([{ path: "new.txt", size: 1, modifiedMs: 1, digest: "x" }]), "receive-only")
    expect(plan.toPull.map((entry) => entry.path)).toEqual(["new.txt"])
  })
})

test("reserved staging detection handles every valid POSIX basename character", () => {
  const suffix = ".tethera-tmp-0123456789abcdef0123456789abcdef"
  expect(isTetheraStagingPath(`.line\nbreak${suffix}`)).toBe(true)
  expect(isTetheraStagingPath(`.back\\slash${suffix}`)).toBe(true)
})

describe("runCoordinatedInitialMerge", () => {
  const result = { copiedFiles: 1, copiedBytes: 5, fileCount: 2, skipped: [] }

  test("commits completion only after both directional passes succeed", async () => {
    const calls: string[] = []
    await runCoordinatedInitialMerge(
      async () => { calls.push("local"); return result },
      async () => { calls.push("peer"); return result },
      async () => { calls.push("commit") },
    )
    expect(calls).toEqual(["local", "peer", "commit"])
  })

  test("does not commit completion when the inverse peer pass fails", async () => {
    let committed = false
    await expect(
      runCoordinatedInitialMerge(
        async () => result,
        async () => { throw new Error("peer disconnected") },
        async () => { committed = true },
      ),
    ).rejects.toThrow("peer disconnected")
    expect(committed).toBe(false)
  })
})

describe("assessInitialMergeConvergence", () => {
  test("blocks activation when a fresh scan still has a transferable one-sided file", () => {
    const result = assessInitialMergeConvergence(
      manifest([{ path: "local.txt", size: 1, modifiedMs: 1, digest: "local" }]),
      manifest([]),
      "two-way",
    )
    expect(result.complete).toBe(false)
  })

  test("allows activation while preserving a same-path conflict", () => {
    const result = assessInitialMergeConvergence(
      manifest([{ path: "notes.txt", size: 1, modifiedMs: 1, digest: "local" }]),
      manifest([{ path: "notes.txt", size: 2, modifiedMs: 1, digest: "remote" }]),
      "two-way",
    )
    expect(result.complete).toBe(true)
    expect(result.skipped.map((skip) => skip.path)).toEqual(["notes.txt"])
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

  test("does not replace a file that appeared after planning", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tethera-sync-test-"))
    try {
      await writeFile(path.join(root, "existing.txt"), "local content")
      await expect(writeFileAtomic(root, "existing.txt", Buffer.from("remote content"))).rejects.toThrow()
      expect(await readFile(path.join(root, "existing.txt"), "utf8")).toBe("local content")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("does not follow a destination-parent symlink outside the approved root", async () => {
    if (process.platform === "win32") return
    const root = await mkdtemp(path.join(tmpdir(), "tethera-sync-test-"))
    const outside = await mkdtemp(path.join(tmpdir(), "tethera-sync-outside-"))
    try {
      await symlink(outside, path.join(root, "redirect"))
      await expect(writeFileAtomic(root, "redirect/escape.txt", Buffer.from("bad"))).rejects.toThrow("regular folder")
      expect(await readdir(outside)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })
})

describe("writeFileChunksAtomic", () => {
  test("verifies and commits a chunked file without exposing a partial destination", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tethera-chunk-test-"))
    const chunks = [Buffer.from("hello "), Buffer.from("from "), Buffer.from("chunks")]
    const content = Buffer.concat(chunks)
    const digest = createHash("sha256").update(content).digest("hex")
    try {
      await writeFileChunksAtomic(root, "nested/large.bin", content.length, digest, async function* () {
        for (const chunk of chunks) yield chunk
      }())
      expect(await readFile(path.join(root, "nested/large.bin"))).toEqual(content)
      expect(await readdir(path.join(root, "nested"))).toEqual(["large.bin"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("removes staging data and leaves no destination when integrity verification fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tethera-chunk-test-"))
    try {
      await expect(
        writeFileChunksAtomic(root, "bad.bin", 3, "0".repeat(64), async function* () {
          yield Buffer.from("bad")
        }()),
      ).rejects.toThrow("integrity")
      expect(await readdir(root)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("replaces only the destination version recorded by reconciliation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tethera-chunk-test-"))
    const archiveRoot = await mkdtemp(path.join(tmpdir(), "tethera-archive-test-"))
    const original = Buffer.from("verified original")
    const replacement = Buffer.from("safe replacement")
    const originalDigest = createHash("sha256").update(original).digest("hex")
    const replacementDigest = createHash("sha256").update(replacement).digest("hex")
    try {
      await writeFile(path.join(root, "notes.txt"), original)
      await writeFileChunksAtomic(
        root,
        "notes.txt",
        replacement.length,
        replacementDigest,
        async function* () { yield replacement }(),
        {
          expectedDestinationDigest: originalDigest,
          expectedDestinationSize: original.length,
          replacement: {
            journalId: "replacement-1",
            archiveRoot,
            markArchived: async () => undefined,
            markInstalled: async () => undefined,
          },
        },
      )
      expect(await readFile(path.join(root, "notes.txt"))).toEqual(replacement)
      expect(await readFile(archiveObjectPath(archiveRoot, `sha256/${originalDigest.slice(0, 2)}/${originalDigest}`))).toEqual(original)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(archiveRoot, { recursive: true, force: true })
    }
  })

  test("preserves a destination changed after reconciliation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tethera-chunk-test-"))
    const archiveRoot = await mkdtemp(path.join(tmpdir(), "tethera-archive-test-"))
    const staleDigest = createHash("sha256").update("old baseline").digest("hex")
    const replacement = Buffer.from("remote replacement")
    const replacementDigest = createHash("sha256").update(replacement).digest("hex")
    try {
      await writeFile(path.join(root, "notes.txt"), "new local edit")
      await expect(writeFileChunksAtomic(
        root,
        "notes.txt",
        replacement.length,
        replacementDigest,
        async function* () { yield replacement }(),
        {
          expectedDestinationDigest: staleDigest,
          expectedDestinationSize: 12,
          replacement: {
            journalId: "replacement-2",
            archiveRoot,
            markArchived: async () => undefined,
            markInstalled: async () => undefined,
          },
        },
      )).rejects.toThrow("local copy was preserved")
      expect(await readFile(path.join(root, "notes.txt"), "utf8")).toBe("new local edit")
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(archiveRoot, { recursive: true, force: true })
    }
  })
})
