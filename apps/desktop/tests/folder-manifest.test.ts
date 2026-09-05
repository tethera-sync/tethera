import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { folderManifestTestHelpers, isManifestPathIgnored, scanFolder } from "../src/main/folder-manifest"
import { manifest } from "./helpers"

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

  test("reports scan progress so comparisons can show what is happening", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tethera-manifest-progress-test-"))
    try {
      for (let index = 0; index < 600; index += 1) {
        await writeFile(path.join(root, `file-${index}.txt`), "data")
      }
      const seen: number[] = []
      const result = await scanFolder(root, [], { onProgress: (scanned) => seen.push(scanned) })
      expect(result.files).toHaveLength(600)
      expect(seen).toEqual([500])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("does not mark a scanned file unreadable when progress delivery fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tethera-manifest-progress-failure-test-"))
    try {
      for (let index = 0; index < 500; index += 1) {
        await writeFile(path.join(root, `file-${index}.txt`), "data")
      }
      const result = await scanFolder(root, [], { onProgress: () => { throw new Error("renderer closed") } })
      expect(result.files).toHaveLength(500)
      expect(result.unreadable).toBe(0)
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
})
