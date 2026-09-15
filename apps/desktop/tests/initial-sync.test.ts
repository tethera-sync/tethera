import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { FileChangedError } from "../src/main/file-transfer"
import {
  assessInitialMergeConvergence,
  assertInitialMergeCapacity,
  assertInitialMergePathCompatibility,
  computeSyncPlan,
  InitialMergeChangedError,
  mergeInitialSyncFile,
  runCoordinatedInitialMerge,
  writeFileAtomic,
  writeFileChunksAtomic,
} from "../src/main/initial-sync"
import { createScanIssueBlocklist, type FileManifest } from "../src/main/folder-manifest"
import { archiveObjectPath } from "../src/main/version-archive"
import { manifest, sha256Hex } from "./helpers"

describe("createScanIssueBlocklist", () => {
  test("blocks a directory subtree, only the exact path for a file, and the whole tree for the root", () => {
    const blocked = createScanIssueBlocklist([
      { path: "locked", reason: "Permission denied", kind: "directory" },
      { path: "locked.txt", reason: "Permission denied", kind: "file" },
    ])
    expect(blocked("locked")).toBe(true)
    expect(blocked("locked/nested/file.txt")).toBe(true)
    expect(blocked("locked.txt")).toBe(true)
    expect(blocked("locked.txt.bak")).toBe(false)
    expect(blocked("other.txt")).toBe(false)
    expect(blocked("locked-elsewhere/file.txt")).toBe(false)

    expect(createScanIssueBlocklist([{ path: "", reason: "Permission denied", kind: "directory" }])("anything")).toBe(true)
    expect(createScanIssueBlocklist([])("anything")).toBe(false)
  })
})

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
      { path: "changed.txt", reason: "Exists on both computers with different content; both copies were preserved for review in Recovery." },
    ])
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

  test("plans remote-only files of any size for chunked transfer", () => {
    const plan = computeSyncPlan(
      manifest([]),
      manifest([{ path: "huge.bin", size: 128 * 1024 * 1024, modifiedMs: 1, digest: "remote-version" }]),
      "two-way",
    )
    expect(plan.toPull.map((entry) => entry.path)).toEqual(["huge.bin"])
    expect(plan.skipped).toEqual([])
  })

  test("receive-only mode pulls remote-only files", () => {
    const plan = computeSyncPlan(
      manifest([]),
      manifest([{ path: "new.txt", size: 1, modifiedMs: 1, digest: "remote-version" }]),
      "receive-only",
    )
    expect(plan.toPull.map((entry) => entry.path)).toEqual(["new.txt"])
  })

  test("leaves paths blocked by an accepted scan issue out of the plan", () => {
    const plan = computeSyncPlan(
      manifest([]),
      manifest([
        { path: "locked/hidden.txt", size: 4, modifiedMs: 1, digest: "hidden" },
        { path: "locked.txt", size: 4, modifiedMs: 1, digest: "locked-file" },
        { path: "free.txt", size: 4, modifiedMs: 1, digest: "free" },
      ]),
      "two-way",
      {
        destinationBlocked: [
          { path: "locked", reason: "Permission denied", kind: "directory" },
          { path: "locked.txt", reason: "Permission denied", kind: "file" },
        ],
      },
    )
    expect(plan.toPull.map((entry) => entry.path)).toEqual(["free.txt"])
  })

  test("leaves out remote-only files whose path is already a folder, link or special entry here", () => {
    const local: FileManifest = {
      ...manifest([
        { path: "build/output.txt", size: 1, modifiedMs: 1, digest: "folder-content" },
        { path: "notes", size: 1, modifiedMs: 1, digest: "file-as-parent" },
      ]),
      occupiedPaths: [
        { path: ".claude/skills/shadcn", kind: "special" },
        { path: "empty", kind: "directory" },
      ],
    }
    const plan = computeSyncPlan(local, manifest([
      { path: ".claude/skills/shadcn", size: 26, modifiedMs: 1, digest: "link-text" },
      { path: ".claude/skills/shadcn/SKILL.md", size: 4, modifiedMs: 1, digest: "linked-content" },
      { path: "build", size: 1, modifiedMs: 1, digest: "file-over-folder" },
      { path: "notes/today.txt", size: 1, modifiedMs: 1, digest: "beneath-file" },
      { path: "empty", size: 1, modifiedMs: 1, digest: "file-over-empty-folder" },
      { path: "empty/new.txt", size: 1, modifiedMs: 1, digest: "inside-empty-folder" },
      { path: ".claude/skills/other.md", size: 1, modifiedMs: 1, digest: "sibling" },
    ]), "two-way")
    expect(plan.toPull.map((entry) => entry.path)).toEqual(["empty/new.txt", ".claude/skills/other.md"])
    expect(plan.occupied).toEqual([".claude/skills/shadcn", ".claude/skills/shadcn/SKILL.md", "build", "notes/today.txt", "empty"])
    expect(plan.skipped).toEqual([])
  })
})

describe("assertInitialMergeCapacity", () => {
  const GIB = 1024 ** 3

  test("allows a merge that still leaves the spare reserve free", () => {
    expect(() => assertInitialMergeCapacity("This computer", 3 * GIB, 4 * GIB)).not.toThrow()
  })

  test("stops before copying when the planned files would not fit", () => {
    expect(() => assertInitialMergeCapacity("tommys-laptop", 31.7 * GIB, 2.5 * GIB)).toThrow(
      "tommys-laptop needs 33 GB of free space for this merge (including 1.0 GB kept spare) but has 2.5 GB.",
    )
  })

  test("refuses a merge that would eat into the spare reserve", () => {
    expect(() => assertInitialMergeCapacity("This computer", 3.5 * GIB, 4 * GIB)).toThrow("Free up space")
  })
})

describe("initial merge path compatibility", () => {
  const local = manifest([{ path: ".venv/lib/python3.12/library.so", size: 1, modifiedMs: 1, digest: "same" }])
  const remote = manifest([{ path: ".venv/Lib/python3.12/library.so", size: 1, modifiedMs: 1, digest: "same" }])

  test("explains cross-device directory casing before an existing Windows mapping copies files", () => {
    expect(() => assertInitialMergePathCompatibility(local, remote, true)).toThrow(".venv/lib ↔ .venv/Lib")
    expect(() => assertInitialMergePathCompatibility(local, remote, true)).toThrow("ignore rules")
  })

  test("preserves case-sensitive paths between Linux computers", () => {
    expect(() => assertInitialMergePathCompatibility(local, remote, false)).not.toThrow()
  })
})

describe("mergeInitialSyncFile", () => {
  const content = Buffer.from("remote content")
  const entry = { path: "file.txt", size: content.length, modifiedMs: 1, digest: sha256Hex(content) }

  test("accepts an identical destination without transferring it again", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tethera-existing-"))
    try {
      await writeFile(path.join(root, entry.path), content)
      const result = await mergeInitialSyncFile(root, entry, async () => { throw new Error("Must not download an identical file") })
      expect(result).toEqual({ status: "identical" })
      expect(await readdir(root)).toEqual([entry.path])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("preserves different existing content regardless of the source timestamp", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tethera-conflict-"))
    try {
      await writeFile(path.join(root, entry.path), "local content")
      const result = await mergeInitialSyncFile(root, { ...entry, modifiedMs: Date.now() + 60_000 }, async () => {
        throw new Error("Must not overwrite an unbased local version")
      })
      expect(result.status).toBe("conflict")
      expect(await readFile(path.join(root, entry.path), "utf8")).toBe("local content")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  for (const appearedContent of ["remote content", "local content"]) {
    test(`reconciles a commit collision with ${appearedContent} and continues copying other files`, async () => {
      const root = await mkdtemp(path.join(tmpdir(), "tethera-commit-race-"))
      try {
        const result = await mergeInitialSyncFile(root, entry, async () => {
          await writeFileChunksAtomic(root, entry.path, entry.size, entry.digest, (async function* () {
            yield content
            await writeFile(path.join(root, entry.path), appearedContent)
          })())
          return { bytes: content.length }
        })
        expect(result.status).toBe(appearedContent === "remote content" ? "identical" : "conflict")
        const next = { ...entry, path: "next.txt" }
        expect(await mergeInitialSyncFile(root, next, async () => {
          await writeFileAtomic(root, next.path, content)
          return { bytes: content.length }
        })).toEqual({ status: "copied", bytes: content.length })
        expect(await readFile(path.join(root, entry.path), "utf8")).toBe(appearedContent)
        expect((await readdir(root)).sort()).toEqual(["file.txt", "next.txt"])
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  }

  test("leaves out a file removed or edited at the source without touching the destination", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tethera-source-changed-"))
    try {
      const result = await mergeInitialSyncFile(root, entry, async () => {
        throw new FileChangedError("file.txt changed or was removed on the other computer after the folders were compared.")
      })
      expect(result).toEqual({ status: "source-changed" })
      expect(await readdir(root)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("does not turn an integrity failure into success when a destination appears", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tethera-integrity-"))
    try {
      await expect(mergeInitialSyncFile(root, entry, async () => {
        await writeFileChunksAtomic(root, entry.path, entry.size, entry.digest, (async function* () {
          await writeFile(path.join(root, entry.path), content)
          yield Buffer.from("corrupt")
        })())
        return { bytes: content.length }
      })).rejects.toThrow("integrity verification")
      expect(await readFile(path.join(root, entry.path))).toEqual(content)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("leaves out an existing destination symlink without following or replacing it", async () => {
    if (process.platform === "win32") return
    const root = await mkdtemp(path.join(tmpdir(), "tethera-existing-link-"))
    try {
      await writeFile(path.join(root, "target.txt"), content)
      await symlink("target.txt", path.join(root, entry.path))
      expect(await mergeInitialSyncFile(root, entry, async () => {
        throw new Error("Must not transfer through a symlink")
      })).toEqual({ status: "occupied" })
      expect(await readFile(path.join(root, "target.txt"))).toEqual(content)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("leaves out a destination that is a folder or sits beneath a file or linked folder", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tethera-occupied-destination-"))
    try {
      await mkdir(path.join(root, "folder"))
      await writeFile(path.join(root, "parent-file"), "local")
      const noTransfer = async () => {
        throw new Error("Must not transfer into an occupied path")
      }
      expect(await mergeInitialSyncFile(root, { ...entry, path: "folder" }, noTransfer)).toEqual({ status: "occupied" })
      expect(await mergeInitialSyncFile(root, { ...entry, path: "parent-file/child.txt" }, noTransfer)).toEqual({ status: "occupied" })
      if (process.platform !== "win32") {
        await mkdir(path.join(root, "real"))
        await symlink("real", path.join(root, "linked"), "dir")
        expect(await mergeInitialSyncFile(root, { ...entry, path: "linked/child.txt" }, noTransfer)).toEqual({ status: "occupied" })
        expect(await readdir(path.join(root, "real"))).toEqual([])
      }
      expect(await readFile(path.join(root, "parent-file"), "utf8")).toBe("local")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("runCoordinatedInitialMerge", () => {
  const result = { copiedFiles: 1, copiedBytes: 5, fileCount: 2, skipped: [], unreadableSkipped: [] }

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

  test("runs both passes again when files changed during the copy and counts every copy", async () => {
    const attempts: number[] = []
    const retried: string[][] = []
    let verifications = 0
    const merged = await runCoordinatedInitialMerge(
      async (attempt) => { attempts.push(attempt); return result },
      async () => ({ ...result, copiedFiles: 2, skipped: [{ path: `conflict-${attempts.length}`, reason: "different" }] }),
      async () => {
        verifications += 1
        if (verifications === 1) throw new InitialMergeChangedError([".git/index.lock"])
      },
      { onRetry: (error) => retried.push([...error.pendingPaths]) },
    )
    expect(attempts).toEqual([1, 2])
    expect(retried).toEqual([[".git/index.lock"]])
    expect(merged.local.copiedFiles).toBe(2)
    expect(merged.local.copiedBytes).toBe(10)
    expect(merged.peer.copiedFiles).toBe(4)
    // The latest pass rescanned everything, so its skips replace the earlier ones.
    expect(merged.peer.skipped).toEqual([{ path: "conflict-2", reason: "different" }])
  })

  test("stops with the changing files once the attempts are used up", async () => {
    let attempts = 0
    await expect(
      runCoordinatedInitialMerge(
        async () => { attempts += 1; return result },
        async () => result,
        async () => { throw new InitialMergeChangedError(["world/region/r.0.0.mca", "a", "b", "c"]) },
        { maxAttempts: 2 },
      ),
    ).rejects.toThrow("Files kept changing while the initial merge ran (world/region/r.0.0.mca, a, b and 1 more)")
    expect(attempts).toBe(2)
  })

  test("does not repeat the merge for other completion failures", async () => {
    let attempts = 0
    await expect(
      runCoordinatedInitialMerge(
        async () => { attempts += 1; return result },
        async () => result,
        async () => { throw new Error("The peer did not confirm its durable initial-merge outcome.") },
      ),
    ).rejects.toThrow("durable initial-merge outcome")
    expect(attempts).toBe(1)
  })
})

describe("assessInitialMergeConvergence", () => {
  test("blocks activation when a fresh scan still has a transferable one-sided file", () => {
    const result = assessInitialMergeConvergence(
      manifest([{ path: "local.txt", size: 1, modifiedMs: 1, digest: "local" }]),
      manifest([]),
      "two-way",
    )
    expect(result.pendingPaths).toEqual(["local.txt"])
  })

  test("allows activation while preserving a same-path conflict", () => {
    const result = assessInitialMergeConvergence(
      manifest([{ path: "notes.txt", size: 1, modifiedMs: 1, digest: "local" }]),
      manifest([{ path: "notes.txt", size: 2, modifiedMs: 1, digest: "remote" }]),
      "two-way",
    )
    expect(result.pendingPaths).toEqual([])
    expect(result.skipped.map((skip) => skip.path)).toEqual(["notes.txt"])
  })

  test("treats files hidden by an accepted unreadable directory as converged", () => {
    const result = assessInitialMergeConvergence(
      manifest([]),
      manifest([{ path: "locked/hidden.txt", size: 1, modifiedMs: 1, digest: "hidden" }]),
      "two-way",
      { localBlocked: [{ path: "locked", reason: "Permission denied", kind: "directory" }] },
    )
    expect(result.pendingPaths).toEqual([])
  })

  test("treats files left out for a path occupied on either computer as converged", () => {
    const result = assessInitialMergeConvergence(
      { ...manifest([{ path: "tools/run", size: 1, modifiedMs: 1, digest: "script" }]), occupiedPaths: [{ path: "skills/shadcn", kind: "special" }] },
      { ...manifest([{ path: "skills/shadcn", size: 26, modifiedMs: 1, digest: "link-text" }]), occupiedPaths: [{ path: "tools/run", kind: "special" }] },
      "two-way",
    )
    expect(result).toEqual({ skipped: [], pendingPaths: [] })
  })

  test("still blocks when the accepted issue does not cover the one-sided file", () => {
    const result = assessInitialMergeConvergence(
      manifest([]),
      manifest([{ path: "other/new.txt", size: 1, modifiedMs: 1, digest: "new" }]),
      "two-way",
      { localBlocked: [{ path: "locked", reason: "Permission denied", kind: "directory" }] },
    )
    expect(result.pendingPaths).toEqual(["other/new.txt"])
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
    const digest = sha256Hex(content)
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
    const originalDigest = sha256Hex(original)
    const replacementDigest = sha256Hex(replacement)
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
    const staleDigest = sha256Hex("old baseline")
    const replacement = Buffer.from("remote replacement")
    const replacementDigest = sha256Hex(replacement)
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

  test("explains running out of space mid-copy and removes the staging file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tethera-chunk-test-"))
    try {
      await expect(
        writeFileChunksAtomic(root, "large.bin", 4, "0".repeat(64), async function* () {
          yield Buffer.from("ab")
          throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" })
        }()),
      ).rejects.toThrow("This computer ran out of free space while saving a synchronized file.")
      expect(await readdir(root)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
