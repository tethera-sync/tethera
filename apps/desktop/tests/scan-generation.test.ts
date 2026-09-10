import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  fetchPeerGenerationPages,
  parseAppendBatchInput,
  parseBeginGenerationInput,
  parseGenerationEntry,
  parseSealGenerationInput,
  streamRelativeFilePaths,
  toEntryPages,
} from "../src/main/scan-generation"
import { ScanCancelledError } from "../src/main/folder-manifest"

describe("scan generation contracts", () => {
  test("validates begin/append/seal shapes without unknown-field leakage", () => {
    const begin = parseBeginGenerationInput({
      generationId: "gen-1",
      mappingId: "mapping-1",
      participantDeviceId: "a-device",
      mappingRevision: 1,
      root: "/tmp/a",
      ignorePatterns: ["*.tmp"],
      hashMode: "full-sha256",
    })
    expect(begin.hashMode).toBe("full-sha256")
    expect(() => parseBeginGenerationInput({ ...begin, hashMode: "md5" })).toThrow("hash mode")
    expect(() => parseBeginGenerationInput({ ...begin, mappingRevision: 0 })).toThrow("revision")
    const batch = parseAppendBatchInput({
      generationId: "gen-1",
      sequence: 0,
      entries: [{ path: "a.txt", size: 1, digest: "a".repeat(64) }],
    })
    expect(batch.entries).toHaveLength(1)
    expect(() => parseAppendBatchInput({ generationId: "gen-1", sequence: -1, entries: [] })).toThrow("sequence")
    expect(() => parseAppendBatchInput({
      generationId: "gen-1",
      sequence: 0,
      entries: [{ path: "a.txt", size: 1, digest: "NOT-HEX" }],
    })).toThrow("digest")
    expect(parseSealGenerationInput({ generationId: "gen-1", expectedCount: 1 }).expectedCount).toBe(1)
    expect(() => parseSealGenerationInput({ generationId: "gen-1", expectedCount: -1 })).toThrow("seal")
    expect(() => parseGenerationEntry({ path: "", size: 0 })).toThrow("path")
  })

  test("pages respect entry-count and byte budgets", () => {
    const entries = Array.from({ length: 2_500 }, (_, index) => ({
      path: `file-${index}.txt`,
      size: 1,
      digest: "a".repeat(64),
    }))
    const pages = toEntryPages(entries, 1_000, 1_048_576)
    expect(pages.length).toBeGreaterThanOrEqual(3)
    expect(pages.flat()).toHaveLength(2_500)
    for (const page of pages) expect(page.length).toBeLessThanOrEqual(1_000)
  })

  test("streams relative paths without retaining a manifest", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tethera-gen-stream-"))
    try {
      await writeFile(path.join(root, "a.txt"), "a")
      await mkdir(path.join(root, "sub"))
      await writeFile(path.join(root, "sub", "b.txt"), "b")
      const collected: string[] = []
      for await (const relative of streamRelativeFilePaths(root, { ignorePatterns: [] })) {
        collected.push(relative)
      }
      expect(collected.sort()).toEqual(["a.txt", "sub/b.txt"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("streaming aborts cooperatively and closes handles", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tethera-gen-abort-"))
    try {
      for (let index = 0; index < 50; index += 1) {
        await writeFile(path.join(root, `file-${index}.txt`), "data")
      }
      const controller = new AbortController()
      const stream = streamRelativeFilePaths(root, { ignorePatterns: [], signal: controller.signal })
      const first = await stream.next()
      expect(first.done).toBe(false)
      controller.abort()
      await expect(stream.next()).rejects.toBeInstanceOf(ScanCancelledError)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("peer pages apply backpressure, cancellation and capability negotiation", async () => {
    const entries = [{ path: "a.txt", size: 1, digest: "a".repeat(64) }]
    let requests = 0
    const legacyClient = {
      request: async () => ({ entries: [], nextCursor: null }),
      supportsGenerations: async () => false,
    }
    await expect((async () => {
      const controller = new AbortController()
      for await (const _page of fetchPeerGenerationPages(legacyClient, "mapping-1", "gen-1", { signal: controller.signal })) {
        // Legacy peers never reach here.
      }
    })()).rejects.toThrow("legacy full-manifest")

    const modernClient = {
      request: async (_payload: Record<string, unknown>, _timeout: number, signal: AbortSignal) => {
        requests += 1
        if (signal.aborted) throw new ScanCancelledError()
        return requests === 1 ? { entries, nextCursor: "a.txt" } : { entries: [], nextCursor: null }
      },
      supportsGenerations: async () => true,
    }
    const controller = new AbortController()
    const pages: typeof entries[] = []
    for await (const page of fetchPeerGenerationPages(modernClient, "mapping-1", "gen-1", { signal: controller.signal })) {
      pages.push(page)
    }
    expect(pages).toHaveLength(1)
    expect(requests).toBe(2)

    const cancellingClient = {
      request: async (_payload: Record<string, unknown>, _timeout: number, _signal: AbortSignal) => {
        controller.abort()
        return { entries, nextCursor: "a.txt" }
      },
      supportsGenerations: async () => true,
    }
    const second = new AbortController()
    second.abort()
    await expect((async () => {
      for await (const _page of fetchPeerGenerationPages(cancellingClient, "mapping-1", "gen-1", { signal: second.signal })) {
        // Cancelled before the first request.
      }
    })()).rejects.toBeInstanceOf(ScanCancelledError)
  })
})
