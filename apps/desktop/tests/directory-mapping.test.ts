import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DirectoryPathMapping, planDirectoryMappings } from "../src/main/directory-mapping"
import { compareManifests, scanFolder } from "../src/main/folder-manifest"
import { directoryMappingsSchema } from "../src/shared/directory-mapping"
import { previewsEqual } from "../src/main/preview-scan-session"

describe("directory case mapping", () => {
  test("uses directory mtime, preserves physical spelling and selects one sibling on each side", () => {
    const mappings = planDirectoryMappings([{ path: "lib", modifiedMs: 1 }, { path: "Lib", modifiedMs: 3 }], [{ path: "lib", modifiedMs: 2 }])
    expect(mappings).toEqual([{ path: "Lib", localPath: "Lib", remotePath: "lib", olderLocalPaths: ["lib"], olderRemotePaths: [] }])
    const local = new DirectoryPathMapping(mappings, "local")
    const remote = new DirectoryPathMapping(mappings, "remote")
    expect(local.logicalPath("lib/old.txt")).toBeUndefined()
    expect(remote.logicalPath("lib/current.txt")).toBe("Lib/current.txt")
    expect(remote.physicalPath("Lib/new.txt")).toBe("lib/new.txt")
    expect(() => remote.physicalPath("lib/old.txt")).toThrow("approved folder spelling")
  })

  test("nested mappings use only selected parents and deterministic ties", () => {
    const local = [{ path: "lib", modifiedMs: 1 }, { path: "Lib", modifiedMs: 4 }, { path: "lib/UNUSED", modifiedMs: 99 }, { path: "Lib/Sub", modifiedMs: 5 }]
    const remote = [{ path: "lib", modifiedMs: 3 }, { path: "lib/sub", modifiedMs: 5 }]
    const mappings = planDirectoryMappings(local, remote)
    expect(planDirectoryMappings([...local].reverse(), [...remote].reverse())).toEqual(mappings)
    expect(new DirectoryPathMapping(mappings, "remote").physicalPath("Lib/Sub/file.txt")).toBe("lib/sub/file.txt")
    expect(mappings.some((mapping) => mapping.path.includes("UNUSED"))).toBe(false)
  })

  test("a read-only preview resolves directories, preserves content conflicts and binds approval to selected paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tethera-directory-case-"))
    try {
      for (const name of ["left/Lib", "left/lib", "right/lib"]) await mkdir(path.join(root, name), { recursive: true })
      await writeFile(path.join(root, "left/Lib/shared.txt"), "new-folder-copy")
      await writeFile(path.join(root, "left/lib/unique.txt"), "older-unique-copy")
      await writeFile(path.join(root, "right/lib/shared.txt"), "other-computer-copy")
      await utimes(path.join(root, "left/lib"), 10, 10)
      await utimes(path.join(root, "right/lib"), 20, 20)
      await utimes(path.join(root, "left/Lib"), 30, 30)
      const local = await scanFolder(path.join(root, "left"), [], { includeDirectories: true })
      const remote = await scanFolder(path.join(root, "right"), [], { includeDirectories: true })
      const preview = compareManifests(local, remote, { mode: "two-way", localPlatform: "linux", remotePlatform: "windows" })
      expect(preview.caseCollisions).toEqual([])
      expect(preview.differentFiles).toBe(1)
      expect(preview.ignoredLocal).toBe(1)
      expect(await readFile(path.join(root, "left/lib/unique.txt"), "utf8")).toBe("older-unique-copy")
      expect(previewsEqual(preview, { ...preview, directoryMappings: [] })).toBe(false)
      const oldPeer = compareManifests(local, { ...remote, directories: undefined }, { mode: "two-way", localPlatform: "linux", remotePlatform: "windows" })
      expect(oldPeer.caseCollisions.length).toBeGreaterThan(0)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test("rejects path escapes and mappings to unrelated directories", () => {
    const mapping = { path: "Lib", localPath: "Lib", remotePath: "lib", olderLocalPaths: [], olderRemotePaths: [] }
    expect(directoryMappingsSchema.safeParse([{ ...mapping, localPath: "../Lib" }]).success).toBe(false)
    expect(directoryMappingsSchema.safeParse([{ ...mapping, remotePath: "secret" }]).success).toBe(false)
    expect(directoryMappingsSchema.safeParse([{ ...mapping, olderLocalPaths: ["Lib"] }]).success).toBe(false)
  })
})
