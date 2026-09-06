import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { folderManifestTestHelpers, isManifestPathIgnored, scanFolder } from "../src/main/folder-manifest"
import { manifest } from "./helpers"
import type { FolderScanActivity } from "../src/shared/contracts"

describe("folder mapping comparison", () => {
  test("classifies identical, one-sided and different files", () => {
    const preview = folderManifestTestHelpers.compareManifests(
      manifest([
        { path: "same.txt", size: 3, modifiedMs: 1, digest: "same" },
        { path: "local.txt", size: 10, modifiedMs: 2, digest: "local" },
        { path: "changed.txt", size: 8, modifiedMs: 5, digest: "new" },
      ]),
      manifest([
        { path: "same.txt", size: 3, modifiedMs: 1, digest: "same" },
        { path: "remote.txt", size: 20, modifiedMs: 2, digest: "remote" },
        { path: "changed.txt", size: 7, modifiedMs: 4, digest: "old" },
      ]),
      { mode: "two-way", localPlatform: "linux", remotePlatform: "windows" },
    )

    expect(preview.identicalFiles).toBe(1)
    expect(preview.localOnlyFiles).toBe(1)
    expect(preview.remoteOnlyFiles).toBe(1)
    expect(preview.differentFiles).toBe(1)
    expect(preview.bytesToRemote).toBe(10)
    expect(preview.bytesToLocal).toBe(20)
  })

  test("detects Windows-invalid and case-colliding paths", () => {
    expect(folderManifestTestHelpers.hasWindowsInvalidPath("CON.txt")).toBe(true)
    expect(folderManifestTestHelpers.hasWindowsInvalidPath("folder/name?.txt")).toBe(true)
    expect(
      folderManifestTestHelpers.findCaseCollisions([
        { path: "Readme.md", size: 1, modifiedMs: 1 },
        { path: "README.md", size: 1, modifiedMs: 1 },
      ]),
    ).toEqual(["Readme.md ↔ README.md"])
  })

  test("ignore matcher supports basename and recursive globs", () => {
    const matcher = folderManifestTestHelpers.createIgnoreMatcher(["node_modules/", "*.tmp", "build/**"])
    expect(matcher("node_modules", true)).toBe(true)
    expect(matcher("cache/file.tmp", false)).toBe(true)
    expect(matcher("build/assets/app.js", false)).toBe(true)
    expect(matcher("src/app.ts", false)).toBe(false)
    expect(isManifestPathIgnored("node_modules/pkg/secret.js", ["node_modules/"])).toBe(true)
    expect(isManifestPathIgnored("src/app.ts", ["node_modules/"])).toBe(false)
  })

  test("full-integrity scans hash files above the preview hashing ceiling", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tethera-manifest-test-"))
    try {
      const largeFile = path.join(root, "large.bin")
      await writeFile(largeFile, "")
      await truncate(largeFile, 16 * 1024 * 1024 + 1)
      const previewManifest = await scanFolder(root, [])
      const transferManifest = await scanFolder(root, [], { hashAllFiles: true })
      expect(previewManifest.files[0]?.digest).toBeUndefined()
      expect(transferManifest.files[0]?.digest).toMatch(/^[a-f0-9]{64}$/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("never includes crash-residue staging files in a manifest", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tethera-manifest-stage-test-"))
    try {
      await writeFile(path.join(root, ".report.tethera-tmp-0123456789abcdef0123456789abcdef"), "partial")
      await writeFile(path.join(root, ".report.tethera-displaced-0123456789abcdef0123456789abcdef"), "old")
      await writeFile(path.join(root, "report.txt"), "complete")
      const result = await scanFolder(root, [], { hashAllFiles: true })
      expect(result.files.map((entry) => entry.path)).toEqual(["report.txt"])
      expect(result.ignored).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("never synchronizes reserved replacement recovery copies", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tethera-manifest-recovery-test-"))
    try {
      await mkdir(path.join(root, ".tethera-recovery"))
      await writeFile(path.join(root, ".tethera-recovery", `${"a".repeat(64)}.backup`), "old version")
      await writeFile(path.join(root, "report.txt"), "current version")
      const result = await scanFolder(root, [], { hashAllFiles: true })
      expect(result.files.map((entry) => entry.path)).toEqual(["report.txt"])
      expect(result.ignored).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("double-star ignore patterns prune the same trees as the Rust matcher", () => {
    const cases: Array<[string, [boolean, boolean, boolean, boolean]]> = [
      ["node_modules", [true, true, false, false]],
      ["node_modules/", [true, true, false, false]],
      ["**/node_modules", [true, true, false, false]],
      ["node_modules/**", [true, false, true, false]],
      ["**/node_modules/**", [true, true, true, true]],
    ]
    for (const [pattern, expected] of cases) {
      const matcher = folderManifestTestHelpers.createIgnoreMatcher([pattern])
      expect(matcher("node_modules", true)).toBe(expected[0])
      expect(matcher("src/node_modules", true)).toBe(expected[1])
      expect(matcher("node_modules/pkg/index.js", false)).toBe(expected[2])
      expect(matcher("src/node_modules/pkg/index.js", false)).toBe(expected[3])
    }
  })

  test("a trailing double-star pattern prunes the directory itself instead of walking it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tethera-manifest-prune-test-"))
    try {
      await mkdir(path.join(root, "build"))
      await writeFile(path.join(root, "build", "output.js"), "bundle")
      await writeFile(path.join(root, "keep.txt"), "kept")
      const result = await scanFolder(root, ["build/**"])
      expect(result.files.map((entry) => entry.path)).toEqual(["keep.txt"])
      expect(result.ignored).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("prunes root and nested node_modules subtrees before applying the file ceiling", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tethera-manifest-node-modules-prune-test-"))
    try {
      await mkdir(path.join(root, "node_modules"), { recursive: true })
      await mkdir(path.join(root, "src", "node_modules"), { recursive: true })
      for (let index = 0; index < 20; index += 1) {
        await writeFile(path.join(root, "node_modules", `package-${index}.js`), "ignored")
        await writeFile(path.join(root, "src", "node_modules", `package-${index}.js`), "ignored")
      }
      await writeFile(path.join(root, "keep-a.txt"), "a")
      await writeFile(path.join(root, "keep-b.txt"), "b")

      const result = await scanFolder(root, ["**/node_modules/**"], { maxFiles: 2 })

      expect(result.files.map((entry) => entry.path).sort()).toEqual(["keep-a.txt", "keep-b.txt"])
      expect(result.ignored).toBe(2)
      expect(result.truncated).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("matches Rust on multibyte patterns: byte envelope and code-point wildcards", () => {
    // 171 × U+754C is 513 UTF-8 bytes, so Rust rejects it while a UTF-16
    // length check would accept it. The rule must be skipped, not throw.
    const oversized = "界".repeat(171)
    const oversizedMatcher = folderManifestTestHelpers.createIgnoreMatcher([oversized])
    expect(oversizedMatcher(oversized, false)).toBe(false)
    // 170 × U+754C is 510 bytes: inside the envelope, still matches itself.
    const boundary = "界".repeat(170)
    expect(folderManifestTestHelpers.createIgnoreMatcher([boundary])(boundary, false)).toBe(true)
    // `?` matches one code point, so an astral character needs one `?`, not two.
    const singleWildcard = folderManifestTestHelpers.createIgnoreMatcher(["?.txt"])
    expect(singleWildcard("😀.txt", false)).toBe(true)
    expect(singleWildcard("ab.txt", false)).toBe(false)
    // A lone surrogate can never equal a Rust str or a real filename, so
    // its rule is skipped: the pattern must not match even itself.
    const lonePattern = "\ud800.txt"
    const loneSurrogate = folderManifestTestHelpers.createIgnoreMatcher([lonePattern])
    expect(loneSurrogate(lonePattern, false)).toBe(false)
    expect(loneSurrogate("a.txt", false)).toBe(false)
  })

  test("honours an explicit scan ceiling and an explicit opt-out of it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tethera-manifest-ceiling-test-"))
    try {
      for (let index = 0; index < 5; index += 1) {
        await writeFile(path.join(root, `file-${index}.txt`), "data")
      }
      const limited = await scanFolder(root, [], { maxFiles: 3 })
      expect(limited.files).toHaveLength(3)
      expect(limited.truncated).toBe(true)
      const unlimited = await scanFolder(root, [], { maxFiles: null })
      expect(unlimited.files).toHaveLength(5)
      expect(unlimited.truncated).toBe(false)
      const byDefault = await scanFolder(root, [])
      expect(byDefault.files).toHaveLength(5)
      expect(byDefault.truncated).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("rejects a non-positive scan ceiling instead of silently truncating everything", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tethera-manifest-ceiling-invalid-test-"))
    try {
      await writeFile(path.join(root, "file.txt"), "data")
      await expect(scanFolder(root, [], { maxFiles: 0 })).rejects.toThrow("The scan limit is invalid.")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("keeps the 14 largest preview samples globally sorted with deterministic ties", () => {
    const entries = Array.from({ length: 16 }, (_, index) => ({
      path: `a-file-${index.toString().padStart(2, "0")}.txt`,
      size: index + 1,
      modifiedMs: 1,
    }))
    entries.push(
      { path: "z-late-large.txt", size: 1_000, modifiedMs: 1 },
      { path: "a-tie.txt", size: 42, modifiedMs: 1 },
      { path: "b-tie.txt", size: 42, modifiedMs: 1 },
    )

    const preview = folderManifestTestHelpers.compareManifests(
      manifest(entries),
      manifest([]),
      { mode: "two-way", localPlatform: "linux", remotePlatform: "linux" },
    )

    expect(preview.samples).toHaveLength(14)
    expect(preview.samples[0]).toEqual({ path: "z-late-large.txt", category: "local-only", size: 1_000 })
    expect(preview.samples.map((sample) => sample.path)).toEqual([
      "z-late-large.txt",
      "a-tie.txt",
      "b-tie.txt",
      "a-file-15.txt",
      "a-file-14.txt",
      "a-file-13.txt",
      "a-file-12.txt",
      "a-file-11.txt",
      "a-file-10.txt",
      "a-file-09.txt",
      "a-file-08.txt",
      "a-file-07.txt",
      "a-file-06.txt",
      "a-file-05.txt",
    ])

    const tiedPreview = folderManifestTestHelpers.compareManifests(
      manifest([
        { path: "b-tie.txt", size: 42, modifiedMs: 1 },
        { path: "a-tie.txt", size: 42, modifiedMs: 1 },
      ]),
      manifest([]),
      { mode: "two-way", localPlatform: "linux", remotePlatform: "linux" },
    )
    expect(tiedPreview.samples.map((sample) => sample.path)).toEqual(["a-tie.txt", "b-tie.txt"])
  })

  test("reports initial and final scan activity with accurate counters", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tethera-manifest-activity-test-"))
    try {
      await writeFile(path.join(root, "one.txt"), "one")
      await writeFile(path.join(root, "two.txt"), "two-two")
      await writeFile(path.join(root, "skip.tmp"), "ignored")
      const activities: FolderScanActivity[] = []
      const result = await scanFolder(root, ["*.tmp"], {
        hashAllFiles: true,
        onActivity: (activity) => activities.push(activity),
      })

      expect(activities[0]).toMatchObject({ stage: "listing", scannedFiles: 0, ignoredEntries: 0, unreadableEntries: 0, hashedBytes: 0 })
      expect(activities.at(-1)).toMatchObject({ stage: "complete", currentPath: "", scannedFiles: 2, ignoredEntries: 1, unreadableEntries: 0, hashedBytes: 10 })
      expect(result.files).toHaveLength(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("reports listing and completion activity for an empty scan", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tethera-manifest-empty-activity-test-"))
    try {
      const activities: FolderScanActivity[] = []
      await scanFolder(root, [], { onActivity: (activity) => activities.push(activity) })
      expect(activities.map((activity) => activity.stage)).toEqual(["listing", "complete"])
      expect(activities.at(-1)).toMatchObject({ scannedFiles: 0, ignoredEntries: 0, unreadableEntries: 0, hashedBytes: 0 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("ignores activity callback failures", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tethera-manifest-activity-failure-test-"))
    try {
      await writeFile(path.join(root, "file.txt"), "data")
      const result = await scanFolder(root, [], { hashAllFiles: true, onActivity: () => { throw new Error("renderer closed") } })
      expect(result.files.map((entry) => entry.path)).toEqual(["file.txt"])
      expect(result.unreadable).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
