import { describe, expect, test } from "bun:test"
import { requestPeerPreview } from "../src/main/peer-preview"
import { PEER_SCAN_PROGRESS_CAPABILITY, parsePeerScanProgress } from "../src/main/peer-scan-progress"
import { CHUNKED_FRAMES_CAPABILITY, type PeerRequest, type PeerRequestOptions } from "../src/main/peer-session-service"
import { folderComparisonResult, unwrapFolderComparisonResult } from "../src/shared/folder-comparison-result"

const peer = { id: "peer", name: "Office PC" }
const input = { path: "C:\\coding", ignorePatterns: ["**/node_modules/**"] }
const manifest = { rootPath: input.path, files: [], ignored: 0, unreadable: 0, unreadableEntries: [], truncated: false }
const activity = { stage: "hashing" as const, scannedFiles: 4, ignoredEntries: 2, unreadableEntries: 0, hashedBytes: 100 }

describe("peer preview compatibility", () => {
  test("negotiates before requesting progress and preserves the remote Windows path", async () => {
    const calls: PeerRequest[] = []
    const progress: unknown[] = []
    const client = {
      async request(_peerId: string, request: PeerRequest, _timeout?: number, options?: PeerRequestOptions): Promise<unknown> {
        calls.push(request)
        if (request.type === "scan-capabilities") return { capabilities: [PEER_SCAN_PROGRESS_CAPABILITY] }
        options?.onProgress?.(activity)
        return manifest
      },
    }
    expect(await requestPeerPreview(client, peer, input, new AbortController().signal, (value) => progress.push(value))).toEqual(manifest)
    expect(calls).toEqual([{ type: "scan-capabilities" }, { type: "scan-manifest", ...input, reportProgress: true }])
    expect(progress).toEqual([activity])
  })

  test("uses a single-response request for a peer without progress support", async () => {
    const client = {
      async request(_peerId: string, request: PeerRequest, _timeout?: number, options?: PeerRequestOptions): Promise<unknown> {
        if (request.type === "scan-capabilities") return { capabilities: ["scan-generations-v1"] }
        expect(request.reportProgress).toBeUndefined()
        expect(options?.onProgress).toBeUndefined()
        return manifest
      },
    }
    expect(await requestPeerPreview(client, peer, input, new AbortController().signal, () => {})).toEqual(manifest)
  })

  test("asks only a chunk-capable peer for a manifest larger than one frame", async () => {
    for (const [capabilities, expected] of [[[CHUNKED_FRAMES_CAPABILITY], true], [["scan-generations-v1"], undefined]] as const) {
      let scanOptions: PeerRequestOptions | undefined
      const client = {
        async request(_peerId: string, request: PeerRequest, _timeout?: number, options?: PeerRequestOptions): Promise<unknown> {
          if (request.type === "scan-capabilities") return { capabilities }
          scanOptions = options
          return manifest
        },
      }
      expect(await requestPeerPreview(client, peer, input, new AbortController().signal, () => {})).toEqual(manifest)
      expect(scanOptions?.chunked).toBe(expected)
    }
  })

  test("does not downgrade malformed capabilities or a failed connection into another scan", async () => {
    let calls = 0
    const client = { async request(): Promise<unknown> { calls += 1; return { capabilities: [42] } } }
    await expect(requestPeerPreview(client, peer, input, new AbortController().signal, () => {})).rejects.toThrow()
    expect(calls).toBe(1)
    const offline = { async request(): Promise<unknown> { throw new Error("connection closed") } }
    await expect(requestPeerPreview(offline, peer, input, new AbortController().signal, () => {})).rejects.toThrow("connection closed")
  })

  test("supports older version-4 peers that predate capability discovery", async () => {
    const client = {
      async request(_peerId: string, request: PeerRequest): Promise<unknown> {
        if (request.type === "scan-capabilities") throw new Error("This secure peer request is not supported.")
        expect(request.reportProgress).toBeUndefined()
        return manifest
      },
    }
    expect(await requestPeerPreview(client, peer, input, new AbortController().signal, () => {})).toEqual(manifest)
  })

  test("reports recovery guidance specific to legacy and progress-aware timeouts", async () => {
    for (const supported of [false, true]) {
      const client = {
        async request(_peerId: string, request: PeerRequest): Promise<unknown> {
          if (request.type === "scan-capabilities") return { capabilities: supported ? [PEER_SCAN_PROGRESS_CAPABILITY] : [] }
          throw Object.assign(new Error("timeout"), { code: "PEER_RESPONSE_TIMEOUT" })
        },
      }
      await expect(requestPeerPreview(client, peer, input, new AbortController().signal, () => {})).rejects.toThrow(
        supported ? "Office PC stopped reporting scan progress" : "Update Tethera on both computers",
      )
    }
  })

  test("cancellation cannot return a late successful manifest", async () => {
    const controller = new AbortController()
    const client = {
      async request(_peerId: string, request: PeerRequest): Promise<unknown> {
        if (request.type === "scan-capabilities") return { capabilities: [] }
        controller.abort()
        return manifest
      },
    }
    await expect(requestPeerPreview(client, peer, input, controller.signal, () => {})).rejects.toThrow("cancelled")
  })

  test("does not describe a capability-check timeout as a completed five-minute scan wait", async () => {
    const client = { async request(): Promise<unknown> { throw Object.assign(new Error("timeout"), { code: "PEER_RESPONSE_TIMEOUT" }) } }
    await expect(requestPeerPreview(client, peer, input, new AbortController().signal, () => {})).rejects.toThrow("scan-support check")
  })
})

describe("scan progress boundary", () => {
  test("accepts bounded counters and rejects paths, invalid stages and unsafe numbers", () => {
    expect(parsePeerScanProgress(activity)).toEqual(activity)
    for (const value of [
      { ...activity, currentPath: "private/file" },
      { ...activity, scannedFiles: -1 },
      { ...activity, hashedBytes: Infinity },
      { ...activity, scannedFiles: 0.5 },
      { ...activity, scannedFiles: Number.MAX_SAFE_INTEGER + 1 },
      { ...activity, stage: "invented" },
    ]) expect(() => parsePeerScanProgress(value)).toThrow("invalid scan progress")
  })
})

describe("comparison IPC result", () => {
  test("preserves successful payloads and expected error messages through JSON", async () => {
    expect(unwrapFolderComparisonResult(await folderComparisonResult(async () => manifest))).toEqual(manifest)
    const result = await folderComparisonResult(async () => { throw new Error("Office PC stopped reporting scan progress. Retry.") })
    expect(JSON.parse(JSON.stringify(result))).toEqual({ ok: false, error: "Office PC stopped reporting scan progress. Retry." })
    expect(() => unwrapFolderComparisonResult(result)).toThrow("Office PC stopped reporting scan progress. Retry.")
  })
})
