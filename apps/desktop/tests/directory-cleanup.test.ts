import { expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rename, rm, symlink, utimes, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { z } from "zod"
import { cleanupOlderDirectories } from "../src/main/directory-cleanup"
import { DirectoryPathMapping } from "../src/main/directory-mapping"

const identity = z.object({ device: z.string(), inode: z.string(), modifiedNs: z.string(), changedNs: z.string() })
const request = z.object({ identity: identity.optional(), complete: z.boolean().optional() })

async function fixture(run: (root: string, trash: string) => Promise<void>) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "tethera-older-directory-"))
  const root = path.join(parent, "root")
  const trash = path.join(parent, "trash")
  try {
    await mkdir(path.join(root, "lib"), { recursive: true })
    await mkdir(path.join(root, "Lib"))
    await writeFile(path.join(root, "lib/unique.txt"), "recoverable old content")
    await writeFile(path.join(root, "Lib/current.txt"), "current content")
    await utimes(path.join(root, "lib"), 10, 10)
    await utimes(path.join(root, "Lib"), 20, 20)
    await run(root, trash)
  } finally { await rm(parent, { recursive: true, force: true }) }
}

function options(root: string, trash: string) {
  let stored: { identity: z.infer<typeof identity>; completed: boolean } | null = null
  return {
    root, mappingId: "mapping", deviceId: "device", otherRoots: [] as string[],
    routing: new DirectoryPathMapping([{ path: "Lib", localPath: "Lib", remotePath: "lib", olderLocalPaths: ["lib"], olderRemotePaths: [] }], "local"),
    rpc: { async request<T>(_method: string, params: unknown): Promise<T> {
      const parsed = request.parse(params)
      if (parsed.identity && !stored) stored = { identity: parsed.identity, completed: false }
      if (parsed.complete && stored) stored.completed = true
      return structuredClone(stored) as T
    } },
    trashItem: (target: string) => rename(target, trash),
  }
}

test("moves only the older directory to recoverable storage and never removes a recreated directory on retry", async () => fixture(async (root, trash) => {
  const input = options(root, trash)
  expect(await cleanupOlderDirectories(input)).toBe(1)
  expect(await readFile(path.join(trash, "unique.txt"), "utf8")).toBe("recoverable old content")
  expect(await readFile(path.join(root, "Lib/current.txt"), "utf8")).toBe("current content")
  await mkdir(path.join(root, "lib"))
  await writeFile(path.join(root, "lib/new.txt"), "new directory")
  expect(await cleanupOlderDirectories(input)).toBe(0)
  expect(await readFile(path.join(root, "lib/new.txt"), "utf8")).toBe("new directory")
}))

test("a failed trash operation preserves content and is retryable", async () => fixture(async (root, trash) => {
  const input = options(root, trash)
  await expect(cleanupOlderDirectories({ ...input, trashItem: async () => { throw new Error("Trash unavailable") } })).rejects.toThrow("Trash unavailable")
  expect(await readFile(path.join(root, "lib/unique.txt"), "utf8")).toBe("recoverable old content")
  expect(await cleanupOlderDirectories(input)).toBe(1)
}))

test("loss of the completion acknowledgement is safe across retry", async () => fixture(async (root, trash) => {
  const input = options(root, trash)
  let fail = true
  const original = input.rpc.request
  input.rpc.request = async <T>(method: string, params: unknown): Promise<T> => {
    if (request.parse(params).complete && fail) { fail = false; throw new Error("engine unavailable") }
    return original<T>(method, params)
  }
  await expect(cleanupOlderDirectories(input)).rejects.toThrow("engine unavailable")
  expect(await cleanupOlderDirectories(input)).toBe(0)
  expect(await readFile(path.join(trash, "unique.txt"), "utf8")).toBe("recoverable old content")
}))

test("refuses changed winners, other mapped roots and symlink escapes", async () => fixture(async (root, trash) => {
  const input = options(root, trash)
  await expect(cleanupOlderDirectories({ ...input, otherRoots: [path.join(root, "lib")] })).rejects.toThrow("another configured")
  await utimes(path.join(root, "lib"), 30, 30)
  await expect(cleanupOlderDirectories(input)).rejects.toThrow("changed after comparison")
  await rename(path.join(root, "lib"), trash)
  await symlink(trash, path.join(root, "lib"), "dir")
  await expect(cleanupOlderDirectories(input)).rejects.toThrow("symbolic link")
  expect(await readFile(path.join(trash, "unique.txt"), "utf8")).toBe("recoverable old content")
}))
