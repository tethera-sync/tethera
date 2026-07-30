import { describe, expect, test } from "bun:test"
import type { FileManifest } from "../src/main/folder-manifest"
import { folderManifestTestHelpers } from "../src/main/folder-manifest"

function manifest(files: FileManifest["files"]): FileManifest {
  return { rootPath: "/tmp/test", files, ignored: 0, unreadable: 0, truncated: false }
}

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
    expect(preview.bytesToRemote).toBe(18)
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
  })
})
