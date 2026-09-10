import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { lstat, mkdir, mkdtemp, opendir, rm, truncate, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  folderManifestTestHelpers,
  isManifestPathIgnored,
  SCAN_FILE_CONCURRENCY,
  scanFolder,
  type CachedFileDigest,
  type FileIdentity,
  type ScanDigestCache,
} from "../src/main/folder-manifest"
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

  test("excludes files above the per-folder size limit without hashing them", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tethera-manifest-size-test-"))
    try {
      await writeFile(path.join(root, "small.bin"), "x".repeat(1_000))
      await writeFile(path.join(root, "exactly-at-limit.bin"), "x".repeat(2_048))
      await writeFile(path.join(root, "oversize.bin"), "x".repeat(4_096))

      const limited = await scanFolder(root, [], { hashAllFiles: true, maxFileBytes: 2_048 })
      expect(limited.files.map((entry) => entry.path).sort()).toEqual(["exactly-at-limit.bin", "small.bin"])
      // Excluded by a rule, exactly like an ignore pattern: not an unreadable file.
      expect(limited.ignored).toBe(1)
      expect(limited.unreadable).toBe(0)
      expect(limited.truncated).toBe(false)

      const unlimited = await scanFolder(root, [], { hashAllFiles: true })
      expect(unlimited.files).toHaveLength(3)
      expect(unlimited.ignored).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("oversize files do not consume the scan file ceiling", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tethera-manifest-ceiling-test-"))
    try {
      await writeFile(path.join(root, "a-keep.bin"), "x".repeat(10))
      await writeFile(path.join(root, "b-huge.bin"), "x".repeat(4_096))
      await writeFile(path.join(root, "c-huge.bin"), "x".repeat(4_096))

      // Only one file is collectable, so a ceiling of one must not report a
      // truncated scan: nothing was omitted for ceiling reasons, and a
      // truncated manifest would block the merge entirely.
      const result = await scanFolder(root, [], { maxFiles: 1, maxFileBytes: 1_024 })
      expect(result.files.map((entry) => entry.path)).toEqual(["a-keep.bin"])
      expect(result.ignored).toBe(2)
      expect(result.truncated).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("an invalid size limit fails closed instead of syncing everything", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tethera-manifest-badlimit-test-"))
    try {
      await writeFile(path.join(root, "report.txt"), "content")
      await expect(scanFolder(root, [], { maxFileBytes: 0 })).rejects.toThrow("The file size limit is invalid.")
      await expect(scanFolder(root, [], { maxFileBytes: 1.5 })).rejects.toThrow("The file size limit is invalid.")
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

/** Sequential depth-first readdir walk: the file order a one-at-a-time scan produces. */
async function sequentialWalkOrder(root: string, relative = ""): Promise<string[]> {
  const paths: string[] = []
  for await (const entry of await opendir(path.join(root, relative))) {
    const relativePath = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isDirectory()) paths.push(...(await sequentialWalkOrder(root, relativePath)))
    else if (entry.isFile()) paths.push(relativePath)
  }
  return paths
}

/**
 * Enough small files to keep every inspection slot busy, with multi-MiB files
 * spread through the tree so inspections finish out of walk order.
 */
async function buildMixedTree(root: string): Promise<{ largeFiles: string[] }> {
  const largeFiles = ["large-root.bin", "a/large-a.bin", "a/deep/large-deep.bin"]
  await mkdir(path.join(root, "a", "deep"), { recursive: true })
  await mkdir(path.join(root, "b"), { recursive: true })
  const smallFiles = Array.from({ length: SCAN_FILE_CONCURRENCY * 4 }, (_, index) => {
    const folder = ["", "a", "a/deep", "b"][index % 4]
    return `${folder ? `${folder}/` : ""}small-${String(index).padStart(3, "0")}.txt`
  })
  await Promise.all(smallFiles.map((relativePath) => writeFile(path.join(root, relativePath), `content ${relativePath}`)))
  await Promise.all(largeFiles.map((relativePath) => writeFile(path.join(root, relativePath), Buffer.alloc(6 * 1024 * 1024, 1))))
  return { largeFiles }
}

describe("concurrent scan parity", () => {
  test("commits files in walk order even when inspections finish out of order", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tethera-manifest-order-test-"))
    try {
      await buildMixedTree(root)
      const expected = await sequentialWalkOrder(root)
      const result = await scanFolder(root, [], { hashAllFiles: true, maxFiles: null })
      expect(result.files.map((entry) => entry.path)).toEqual(expected)
      expect(result.files.every((entry) => /^[a-f0-9]{64}$/.test(entry.digest ?? ""))).toBe(true)
      expect(result.truncated).toBe(false)
      expect(result.unreadable).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("truncates at exactly the file a sequential scan would stop at", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tethera-manifest-truncation-test-"))
    try {
      const { largeFiles } = await buildMixedTree(root)
      const expected = await sequentialWalkOrder(root)
      const limit = SCAN_FILE_CONCURRENCY + 3
      const limited = await scanFolder(root, [], { hashAllFiles: true, maxFiles: limit })
      expect(limited.truncated).toBe(true)
      expect(limited.files.map((entry) => entry.path)).toEqual(expected.slice(0, limit))

      // Oversize exclusions must not consume the ceiling, even while later files are in flight.
      const withoutLarge = expected.filter((relativePath) => !largeFiles.includes(relativePath))
      const sizeLimited = await scanFolder(root, [], { hashAllFiles: true, maxFiles: limit, maxFileBytes: 1024 * 1024 })
      expect(sizeLimited.truncated).toBe(true)
      expect(sizeLimited.files.map((entry) => entry.path)).toEqual(withoutLarge.slice(0, limit))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex")
}

async function identityOf(filePath: string): Promise<FileIdentity> {
  const stats = await lstat(filePath, { bigint: true })
  return {
    device: stats.dev.toString(),
    inode: stats.ino.toString(),
    size: Number(stats.size),
    modifiedNs: stats.mtimeNs.toString(),
    changedNs: stats.ctimeNs.toString(),
  }
}

function fakeDigestCache(seed: ReadonlyMap<string, CachedFileDigest> = new Map()) {
  const lookups: string[][] = []
  const recorded = new Map<string, CachedFileDigest>()
  const cache: ScanDigestCache = {
    async lookup(relativePaths) {
      lookups.push(relativePaths)
      return new Map(relativePaths.flatMap((relativePath) => {
        const entry = seed.get(relativePath)
        return entry ? [[relativePath, entry] as const] : []
      }))
    },
    record(relativePath, entry) {
      recorded.set(relativePath, entry)
    },
  }
  return { cache, lookups, recorded }
}

describe("scan digest cache", () => {
  test("uses a cached digest without reading a file whose identity is unchanged", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tethera-digest-hit-test-"))
    try {
      const filePath = path.join(root, "kept.txt")
      await writeFile(filePath, "real content")
      // A digest that the bytes on disk cannot produce proves the file was not read.
      const cachedDigest = "f".repeat(64)
      const { cache } = fakeDigestCache(new Map([["kept.txt", { ...(await identityOf(filePath)), digest: cachedDigest }]]))
      const result = await scanFolder(root, [], { hashAllFiles: true, digestCache: cache })
      expect(result.files.map((entry) => entry.digest)).toEqual([cachedDigest])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("hashes a file again once any identity value differs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tethera-digest-miss-test-"))
    try {
      await writeFile(path.join(root, "moved.txt"), "moved")
      await writeFile(path.join(root, "rewritten.txt"), "before")
      const stale = "f".repeat(64)
      const seed = new Map<string, CachedFileDigest>([
        ["moved.txt", { ...(await identityOf(path.join(root, "moved.txt"))), inode: "1", digest: stale }],
        ["rewritten.txt", { ...(await identityOf(path.join(root, "rewritten.txt"))), digest: stale }],
      ])
      // Same length, different bytes: only timestamps betray the rewrite.
      await writeFile(path.join(root, "rewritten.txt"), "after!")
      const { cache } = fakeDigestCache(seed)
      const result = await scanFolder(root, [], { hashAllFiles: true, digestCache: cache })
      const digests = new Map(result.files.map((entry) => [entry.path, entry.digest]))
      expect(digests.get("moved.txt")).toBe(sha256("moved"))
      expect(digests.get("rewritten.txt")).toBe(sha256("after!"))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("preview scans never take digests from the cache", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tethera-digest-preview-test-"))
    try {
      const filePath = path.join(root, "preview.txt")
      await writeFile(filePath, "preview content")
      const { cache, lookups } = fakeDigestCache(new Map([["preview.txt", { ...(await identityOf(filePath)), digest: "f".repeat(64) }]]))
      const result = await scanFolder(root, [], { digestCache: cache })
      expect(result.files.map((entry) => entry.digest)).toEqual([sha256("preview content")])
      expect(lookups).toHaveLength(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a correct cache produces exactly the manifest an uncached scan does", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tethera-digest-parity-test-"))
    try {
      await buildMixedTree(root)
      const uncached = await scanFolder(root, [], { hashAllFiles: true, maxFiles: null })
      const seed = new Map<string, CachedFileDigest>()
      for (const entry of uncached.files) {
        seed.set(entry.path, { ...(await identityOf(path.join(root, entry.path))), digest: entry.digest ?? "" })
      }
      const { cache } = fakeDigestCache(seed)
      const cached = await scanFolder(root, [], { hashAllFiles: true, maxFiles: null, digestCache: cache })
      expect(cached).toEqual(uncached)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("looks every file up exactly once, in batches rather than one round trip per file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tethera-digest-batch-test-"))
    try {
      const fileCount = 600
      await Promise.all(Array.from({ length: fileCount }, (_, index) => writeFile(path.join(root, `file-${index}.txt`), `${index}`)))
      const { cache, lookups } = fakeDigestCache()
      await scanFolder(root, [], { hashAllFiles: true, maxFiles: null, digestCache: cache })
      const looked = lookups.flat()
      expect(looked).toHaveLength(fileCount)
      expect(new Set(looked).size).toBe(fileCount)
      expect(lookups.length).toBeLessThan(fileCount / 10)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("records only files whose timestamps have settled past the coarse-clock window", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tethera-digest-settle-test-"))
    try {
      await writeFile(path.join(root, "settled.txt"), "settled")
      // Deliberately real time: the rule under test is about wall-clock distance.
      await Bun.sleep(2_100)
      await writeFile(path.join(root, "fresh.txt"), "fresh")
      const { cache, recorded } = fakeDigestCache()
      await scanFolder(root, [], { hashAllFiles: true, digestCache: cache })
      expect([...recorded.keys()]).toEqual(["settled.txt"])
      expect(recorded.get("settled.txt")).toEqual({ ...(await identityOf(path.join(root, "settled.txt"))), digest: sha256("settled") })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
