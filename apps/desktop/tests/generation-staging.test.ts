import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fingerprintFolder } from "../src/main/folder-manifest"
import {
  releaseGeneration,
  stageIncomingGeneration,
  stageLocalGeneration,
  type GenerationStagingRpc,
} from "../src/main/generation-staging"
import type { GenerationEntry } from "../src/main/scan-generation"

interface RecordedCall {
  method: string
  params?: unknown
}

interface FakeRpc extends GenerationStagingRpc {
  calls: RecordedCall[]
  appended: GenerationEntry[][]
}

function fakeRpc(options: { failOn?: (method: string, count: number) => boolean; dedupeEntries?: number } = {}): FakeRpc {
  const calls: RecordedCall[] = []
  const appended: GenerationEntry[][] = []
  const counts = new Map<string, number>()
  let stored = 0
  let dedupeRemaining = options.dedupeEntries ?? 0
  return {
    calls,
    appended,
    async request<T>(method: string, params?: unknown): Promise<T> {
      const count = (counts.get(method) ?? 0) + 1
      counts.set(method, count)
      calls.push({ method, params })
      if (options.failOn?.(method, count)) throw new Error("engine unavailable")
      if (method === "scanGeneration.begin") {
        const { generationId } = params as { generationId: string }
        return { generationId, state: "open", entryCount: 0 } as T
      }
      if (method === "scanGeneration.append") {
        const { generationId, entries } = params as { generationId: string; entries: GenerationEntry[] }
        appended.push(entries)
        // `dedupeEntries` models the engine storing identical duplicate paths
        // once, which is what a mapped-path collision looks like from here.
        const deduped = Math.min(dedupeRemaining, entries.length)
        dedupeRemaining -= deduped
        stored += entries.length - deduped
        return { generationId, state: "open", entryCount: stored } as T
      }
      return undefined as T
    },
  }
}

function appends(rpc: FakeRpc): Array<{ sequence: number; entries: GenerationEntry[] }> {
  return rpc.calls
    .filter((call) => call.method === "scanGeneration.append")
    .map((call) => call.params as { sequence: number; entries: GenerationEntry[] })
}

function sealCount(rpc: FakeRpc): number | undefined {
  const seal = rpc.calls.find((call) => call.method === "scanGeneration.seal")
  return (seal?.params as { expectedCount: number } | undefined)?.expectedCount
}

describe("generation staging", () => {
  test("streams a local scan into bounded batches and seals the exact count", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tethera-stage-local-"))
    try {
      for (let index = 0; index < 1_005; index += 1) {
        await writeFile(path.join(root, `file-${String(index).padStart(4, "0")}.txt`), `content-${index}`)
      }
      await mkdir(path.join(root, "empty"))
      await symlink("file-0000.txt", path.join(root, "link"))
      const rpc = fakeRpc()
      const staged = await stageLocalGeneration(rpc, {
        mappingId: "mapping-1",
        participantDeviceId: "linux-box",
        mappingRevision: 7,
        root,
        ignorePatterns: [],
      })
      expect(staged.files).toBe(1_005)
      expect(staged.occupied).toBe(2)
      expect(staged.unreadable).toBe(0)

      const begin = rpc.calls[0]
      expect(begin.method).toBe("scanGeneration.begin")
      expect(begin.params).toMatchObject({
        generationId: staged.generationId,
        mappingId: "mapping-1",
        participantDeviceId: "linux-box",
        mappingRevision: 7,
        hashMode: "full-sha256",
      })
      const batches = appends(rpc)
      // 1,000 files, the 5-file remainder, then the occupied paths.
      expect(batches).toHaveLength(3)
      expect(batches.map((batch) => batch.sequence)).toEqual([0, 1, 2])
      for (const batch of batches) expect(batch.entries.length).toBeLessThanOrEqual(1_000)
      const stagedEntries = batches.flatMap((batch) => batch.entries)
      expect(stagedEntries).toHaveLength(1_007)
      const files = stagedEntries.filter((entry) => entry.kind === "file")
      expect(files).toHaveLength(1_005)
      for (const file of files) expect(file.digest).toMatch(/^[a-f0-9]{64}$/)
      expect(stagedEntries.filter((entry) => entry.kind === "directory")).toHaveLength(1)
      expect(stagedEntries.filter((entry) => entry.kind === "special")).toHaveLength(1)
      expect(sealCount(rpc)).toBe(1_007)

      // The staged fingerprint equals a full-integrity fingerprint of the same files.
      const fingerprint = await fingerprintFolder(root, [])
      expect(staged.fingerprint).toBe(fingerprint.fingerprint)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("reports a mapped-path collision instead of staging a duplicate", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tethera-stage-collision-"))
    try {
      await mkdir(path.join(root, "Foo"))
      await mkdir(path.join(root, "foo"))
      await writeFile(path.join(root, "Foo", "a.txt"), "one")
      await writeFile(path.join(root, "foo", "a.txt"), "two")
      const rpc = fakeRpc()
      await expect(stageLocalGeneration(rpc, {
        mappingId: "mapping-1",
        participantDeviceId: "linux-box",
        mappingRevision: 1,
        root,
        ignorePatterns: [],
        mapPath: (relativePath) => relativePath.toLowerCase(),
      })).rejects.toThrow("mapped two different paths")
      expect(rpc.calls.some((call) => call.method === "scanGeneration.abort")).toBe(true)
      expect(rpc.calls.some((call) => call.method === "scanGeneration.seal")).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("an under-reported staged count still names the collision", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tethera-stage-count-"))
    try {
      await writeFile(path.join(root, "a.txt"), "a")
      const rpc = fakeRpc({ dedupeEntries: 1 })
      await expect(stageLocalGeneration(rpc, {
        mappingId: "mapping-1",
        participantDeviceId: "linux-box",
        mappingRevision: 1,
        root,
        ignorePatterns: [],
      })).rejects.toThrow("mapped two different paths")
      expect(rpc.calls.some((call) => call.method === "scanGeneration.abort")).toBe(true)
      expect(rpc.calls.some((call) => call.method === "scanGeneration.seal")).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("aborts the generation when a batch fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tethera-stage-abort-"))
    try {
      await writeFile(path.join(root, "a.txt"), "a")
      const rpc = fakeRpc({ failOn: (method) => method === "scanGeneration.append" })
      await expect(stageLocalGeneration(rpc, {
        mappingId: "mapping-1",
        participantDeviceId: "linux-box",
        mappingRevision: 1,
        root,
        ignorePatterns: [],
      })).rejects.toThrow("engine unavailable")
      expect(rpc.calls.some((call) => call.method === "scanGeneration.abort")).toBe(true)
      expect(rpc.calls.some((call) => call.method === "scanGeneration.seal")).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("stages a peer's pages with backpressure and seals files plus occupied paths", async () => {
    const rpc = fakeRpc()
    const pages: GenerationEntry[][] = [
      [{ path: "a.txt", size: 1, digest: "a".repeat(64), kind: "file" }],
      [
        { path: "b.txt", size: 2, digest: "b".repeat(64), kind: "file" },
        { path: "empty", size: 0, kind: "directory" },
        { path: "link", size: 0, kind: "special" },
      ],
    ]
    async function* source(): AsyncGenerator<GenerationEntry[], void, void> {
      for (const page of pages) yield page
    }
    const staged = await stageIncomingGeneration(rpc, source(), {
      mappingId: "mapping-1",
      participantDeviceId: "windows-box",
      mappingRevision: 3,
      root: "C:\\Users\\A\\Folder",
      ignorePatterns: [],
    })
    expect(staged.files).toBe(2)
    expect(staged.occupied).toBe(2)
    expect(staged.rootPath).toBe("C:\\Users\\A\\Folder")
    expect(appends(rpc).map((batch) => batch.sequence)).toEqual([0, 1])
    expect(sealCount(rpc)).toBe(4)
    // The fingerprint matches the peer's file observation, not its occupied paths.
    expect(staged.fingerprint).toMatch(/^2:[a-f0-9]{64}$/)
  })

  test("aborts the incoming generation when the peer's page fails", async () => {
    const rpc = fakeRpc()
    async function* failing(): AsyncGenerator<GenerationEntry[], void, void> {
      yield [{ path: "a.txt", size: 1, digest: "a".repeat(64), kind: "file" }]
      throw new Error("page fetch failed")
    }
    await expect(stageIncomingGeneration(rpc, failing(), {
      mappingId: "mapping-1",
      participantDeviceId: "windows-box",
      mappingRevision: 1,
      root: "C:\\Users\\A\\Folder",
      ignorePatterns: [],
    })).rejects.toThrow("page fetch failed")
    expect(rpc.calls.some((call) => call.method === "scanGeneration.abort")).toBe(true)
  })

  test("a release failure is reported without throwing", async () => {
    const rpc = fakeRpc({ failOn: (method) => method === "scanGeneration.release" })
    await releaseGeneration(rpc, "gen-1")
    expect(rpc.calls).toHaveLength(1)
  })
})
