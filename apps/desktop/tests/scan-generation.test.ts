import { describe, expect, test } from "bun:test"
import {
  fetchPeerGenerationPages,
  parseGenerationEntry,
  parsePeerGenerationScanReply,
} from "../src/main/scan-generation"
import { ScanCancelledError } from "../src/main/folder-manifest"

describe("scan generation contracts", () => {
  test("entry kinds default to files and occupied kinds carry nothing else", () => {
    expect(parseGenerationEntry({ path: "a.txt", size: 1, digest: "a".repeat(64) }).kind).toBe("file")
    expect(parseGenerationEntry({ path: "empty", size: 0, kind: "directory" }).kind).toBe("directory")
    expect(parseGenerationEntry({ path: "link", size: 0, kind: "special" }).kind).toBe("special")
    expect(() => parseGenerationEntry({ path: "empty", size: 4, kind: "directory" })).toThrow("occupied")
    expect(() => parseGenerationEntry({ path: "link", size: 0, digest: "a".repeat(64), kind: "special" })).toThrow("occupied")
    expect(() => parseGenerationEntry({ path: "a.txt", size: 1, kind: "other" })).toThrow("kind")
    expect(() => parseGenerationEntry({ path: "", size: 0 })).toThrow("path")
  })

  test("validates a peer's staged scan reply strictly", () => {
    const reply = parsePeerGenerationScanReply({
      generationId: "gen-1",
      entries: 2,
      occupied: 1,
      ignored: 0,
      unreadable: 0,
    })
    expect(reply.generationId).toBe("gen-1")
    expect(reply.entries).toBe(2)
    expect(() => parsePeerGenerationScanReply({ entries: 2 })).toThrow("scan generation id")
    expect(() => parsePeerGenerationScanReply({ generationId: "gen-1", entries: -1, occupied: 0, ignored: 0, unreadable: 0 })).toThrow("invalid staged scan")
    expect(() => parsePeerGenerationScanReply("gen-1")).toThrow("invalid staged scan")
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
