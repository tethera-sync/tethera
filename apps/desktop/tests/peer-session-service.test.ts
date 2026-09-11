import { describe, expect, test } from "bun:test"
import { createPublicKey, generateKeyPairSync, randomUUID, sign, verify, type KeyObject } from "node:crypto"
import type { PairingService } from "../src/main/pairing-service"
import { measurePeerRequest, PeerSessionService, peerSessionTestHelpers } from "../src/main/peer-session-service"
import { MAX_ACTIVE_SCANS, ScanCoordinator } from "../src/main/scan-coordinator"

const LARGE_RESPONSE_BYTES = 8 * 1024 * 1024
const TEST_PROGRESS = {
  stage: "inspecting" as const,
  scannedFiles: 1,
  ignoredEntries: 0,
  unreadableEntries: 0,
  hashedBytes: 128,
}

interface TestIdentity {
  id: string
  name: string
  publicKey: string
  privateKey: KeyObject
}

function testIdentity(id: string): TestIdentity {
  const keys = generateKeyPairSync("ed25519")
  return {
    id,
    name: id,
    publicKey: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    privateKey: keys.privateKey,
  }
}

function fakePairing(
  local: TestIdentity,
  remote: TestIdentity,
  remotePort: number,
): Pick<
  PairingService,
  "getLocalSessionIdentity" | "getTrustedSessionPeer" | "signSessionPayload" | "verifyTrustedSessionPayload"
> {
  const canonical = (kind: string, body: unknown) => Buffer.from(JSON.stringify(["tethera-session-auth-v1", kind, body]))
  return {
    getLocalSessionIdentity: () => ({
      id: local.id,
      name: local.name,
      platform: "linux" as const,
      publicKey: local.publicKey,
      fingerprint: local.id,
    }),
    getTrustedSessionPeer: (deviceId: string) => deviceId === remote.id
      ? {
          id: remote.id,
          name: remote.name,
          platform: "windows" as const,
          publicKey: remote.publicKey,
          fingerprint: remote.id,
          address: "127.0.0.1",
          sessionPort: remotePort,
        }
      : undefined,
    signSessionPayload: (kind: string, body: unknown) =>
      sign(null, canonical(kind, body), local.privateKey).toString("base64"),
    verifyTrustedSessionPayload: (deviceId: string, kind: string, body: unknown, signature: string) =>
      deviceId === remote.id && verify(
        null,
        canonical(kind, body),
        createPublicKey({ key: Buffer.from(remote.publicKey, "base64"), format: "der", type: "spki" }),
        Buffer.from(signature, "base64"),
      ),
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

describe("secure peer-session crypto", () => {
  test("both peers derive the same session key", () => {
    const left = generateKeyPairSync("x25519")
    const right = generateKeyPairSync("x25519")
    const transcript = peerSessionTestHelpers.buildSessionTranscript({ hello: 1 }, { welcome: 2 })
    const leftKey = peerSessionTestHelpers.deriveSessionKey(
      left.privateKey,
      peerSessionTestHelpers.exportX25519PublicKey(right.publicKey),
      transcript,
    )
    const rightKey = peerSessionTestHelpers.deriveSessionKey(
      right.privateKey,
      peerSessionTestHelpers.exportX25519PublicKey(left.publicKey),
      transcript,
    )
    expect(leftKey.equals(rightKey)).toBe(true)
  })

  test("encrypted frames authenticate their direction and request id", () => {
    const key = Buffer.alloc(32, 7)
    const frame = peerSessionTestHelpers.encryptFrame(key, "session", "request", "request", { type: "ping" })
    expect(peerSessionTestHelpers.decryptFrame(key, "session", "request", frame)).toEqual({ type: "ping" })
    expect(() => peerSessionTestHelpers.decryptFrame(key, "session", "response", frame)).toThrow()
  })

  test("measures a request's exact encrypted line size without a session key", () => {
    const key = Buffer.alloc(32, 7)
    const requests = [
      { type: "ping" },
      // JSON escaping of quotes, backslashes and control characters is counted exactly.
      { type: "continuous-sync-observe", local: [{ path: 'a"b\\c\u0001d', size: 1, digest: "a".repeat(64) }], remote: [] },
      { type: "multibyte", text: "é漢😀".repeat(1_000) },
    ]
    for (const request of requests) {
      const frame = peerSessionTestHelpers.encryptFrame(key, "session", randomUUID(), "request", request)
      const line = peerSessionTestHelpers.serializeWireMessage(frame)
      expect(measurePeerRequest(request).bytes).toBe(Buffer.byteLength(line, "utf8"))
    }
  })

  test("reports a request above the peer line cap as not fitting", () => {
    expect(measurePeerRequest({ type: "ping" }).fits).toBe(true)
    const oversized = measurePeerRequest({ type: "continuous-sync-observe", payload: "x".repeat(13 * 1024 * 1024) })
    expect(oversized.fits).toBe(false)
    expect(oversized.bytes).toBeGreaterThan(oversized.limit)
  })

  test("rejects truncated tags, wrong-size IVs and non-string sealed fields", () => {
    const key = Buffer.alloc(32, 7)
    const frame = peerSessionTestHelpers.encryptFrame(key, "session", "request", "request", { type: "ping" })
    expect(peerSessionTestHelpers.decryptFrame(key, "session", "request", frame)).toEqual({ type: "ping" })
    // Node verifies a 4-byte prefix of the genuine tag unless the tag length is pinned.
    const truncatedTag = Buffer.from(frame.tag, "base64").subarray(0, 4).toString("base64")
    expect(() => peerSessionTestHelpers.decryptFrame(key, "session", "request", { ...frame, tag: truncatedTag })).toThrow("invalid encrypted frame")
    const shortIv = Buffer.from(frame.iv, "base64").subarray(0, 8).toString("base64")
    expect(() => peerSessionTestHelpers.decryptFrame(key, "session", "request", { ...frame, iv: shortIv })).toThrow("invalid encrypted frame")
    // As it would arrive off the wire: an array-like IV must never reach Buffer.from.
    const arrayLikeIv: Parameters<typeof peerSessionTestHelpers.decryptFrame>[3] = JSON.parse(JSON.stringify({ ...frame, iv: { length: 1_000_000_000 } }))
    expect(() => peerSessionTestHelpers.decryptFrame(key, "session", "request", arrayLikeIv)).toThrow("invalid encrypted frame")
  })

  test("bounds and validates peer error responses", () => {
    expect(peerSessionTestHelpers.parsePeerResponse({ ok: false, error: "retry" })).toEqual({ ok: false, error: "retry" })
    expect(() => peerSessionTestHelpers.parsePeerResponse({ ok: false, error: "x".repeat(513) })).toThrow("invalid")
    expect(() => peerSessionTestHelpers.parsePeerResponse({ ok: "yes", result: true })).toThrow("invalid")
    expect(() => peerSessionTestHelpers.parsePeerResponse({ ok: true, error: "unexpected" })).toThrow("invalid")
  })

  test("rejects progress that was not negotiated by both request fields and options", async () => {
    const requesterIdentity = testIdentity("requester-options")
    const responderIdentity = testIdentity("responder-options")
    const requester = new PeerSessionService({
      pairing: fakePairing(requesterIdentity, responderIdentity, 0),
      onRequest: async () => undefined,
    })
    await expect(requester.request(
      responderIdentity.id,
      { type: "scan-manifest", reportProgress: true },
      20,
    )).rejects.toMatchObject({ code: "PEER_SCAN_PROGRESS_OPTIONS" })
    await expect(requester.request(
      responderIdentity.id,
      { type: "scan-manifest" },
      20,
      { onProgress: () => undefined },
    )).rejects.toMatchObject({ code: "PEER_SCAN_PROGRESS_OPTIONS" })
  })

  test("validates progress envelopes and rejects replayed or malformed activity", () => {
    expect(peerSessionTestHelpers.parsePeerScanProgressEnvelope({ progress: TEST_PROGRESS, sequence: 1 }, 1)).toEqual(TEST_PROGRESS)
    expect(() => peerSessionTestHelpers.parsePeerScanProgressEnvelope({ progress: TEST_PROGRESS, sequence: 1 }, 2)).toThrow("invalid")
    expect(() => peerSessionTestHelpers.parsePeerScanProgressEnvelope({ progress: { ...TEST_PROGRESS, path: "/private" }, sequence: 1 }, 1)).toThrow("invalid")
  })

  test("flushes a large encrypted response before closing the peer socket", async () => {
    const requesterIdentity = testIdentity("requester")
    const responderIdentity = testIdentity("responder")
    const responder = new PeerSessionService({
      pairing: fakePairing(responderIdentity, requesterIdentity, 0),
      port: 0,
      onRequest: async () => ({ content: "x".repeat(LARGE_RESPONSE_BYTES) }),
    })

    await responder.start()
    const requester = new PeerSessionService({
      pairing: fakePairing(requesterIdentity, responderIdentity, responder.port),
      port: 0,
      onRequest: async () => undefined,
    })
    try {
      const response = await requester.request<{ content: string }>(responderIdentity.id, { type: "large-response" }, 5_000)
      expect(response.content).toHaveLength(LARGE_RESPONSE_BYTES)
    } finally {
      await requester.stop()
      await responder.stop()
    }
  })

  test("keeps an opted-in scan alive when valid progress arrives before each read timeout", async () => {
    const requesterIdentity = testIdentity("requester-progress")
    const responderIdentity = testIdentity("responder-progress")
    const responder = new PeerSessionService({
      pairing: fakePairing(responderIdentity, requesterIdentity, 0),
      port: 0,
      testTiming: { scanProgressIntervalMs: 5 },
      onRequest: async (context) => {
        context.reportProgress?.(TEST_PROGRESS)
        await delay(12)
        context.reportProgress?.({ ...TEST_PROGRESS, scannedFiles: 2 })
        await delay(12)
        context.reportProgress?.({ ...TEST_PROGRESS, scannedFiles: 3 })
        await delay(12)
        return { complete: true }
      },
    })
    await responder.start()
    const requester = new PeerSessionService({
      pairing: fakePairing(requesterIdentity, responderIdentity, responder.port),
      port: 0,
      onRequest: async () => undefined,
    })
    const activity: number[] = []
    try {
      await expect(requester.request<{ complete: boolean }>(
        responderIdentity.id,
        { type: "scan-manifest", reportProgress: true },
        20,
        { onProgress: (progress) => activity.push(progress.scannedFiles) },
      )).resolves.toEqual({ complete: true })
      expect(activity).toEqual([1, 2, 3])
    } finally {
      await requester.stop()
      await responder.stop()
    }
  })

  test("aborts an active scan handler immediately when its requester cancels", async () => {
    const requesterIdentity = testIdentity("requester-cancel")
    const responderIdentity = testIdentity("responder-cancel")
    const started = deferred()
    const aborted = deferred()
    const responder = new PeerSessionService({
      pairing: fakePairing(responderIdentity, requesterIdentity, 0),
      port: 0,
      onRequest: async (context) => {
        started.resolve()
        await new Promise<void>((resolve) => context.signal.addEventListener("abort", resolve, { once: true }))
        aborted.resolve()
        throw new Error("scan cancelled")
      },
    })
    await responder.start()
    const requester = new PeerSessionService({
      pairing: fakePairing(requesterIdentity, responderIdentity, responder.port),
      port: 0,
      onRequest: async () => undefined,
    })
    const controller = new AbortController()
    try {
      const request = requester.request(
        responderIdentity.id,
        { type: "scan-manifest", reportProgress: true },
        100,
        { signal: controller.signal, onProgress: () => undefined },
      )
      await started.promise
      controller.abort()
      await expect(request).rejects.toThrow("cancelled")
      await aborted.promise
    } finally {
      await requester.stop()
      await responder.stop()
    }
  })

  test("aborts the receiver when a scan caller becomes idle while its handler is active", async () => {
    const requesterIdentity = testIdentity("requester-idle")
    const responderIdentity = testIdentity("responder-idle")
    const started = deferred()
    const aborted = deferred()
    const responder = new PeerSessionService({
      pairing: fakePairing(responderIdentity, requesterIdentity, 0),
      port: 0,
      onRequest: async (context) => {
        started.resolve()
        await new Promise<void>((resolve) => context.signal.addEventListener("abort", resolve, { once: true }))
        aborted.resolve()
        throw new Error("scan cancelled")
      },
    })
    await responder.start()
    const requester = new PeerSessionService({
      pairing: fakePairing(requesterIdentity, responderIdentity, responder.port),
      port: 0,
      testTiming: { scanIdleTimeoutMs: 15 },
      onRequest: async () => undefined,
    })
    try {
      const request = requester.request(
        responderIdentity.id,
        { type: "scan-manifest" },
        15,
      )
      await started.promise
      await expect(request).rejects.toThrow("stopped reporting progress")
      await aborted.promise
    } finally {
      await requester.stop()
      await responder.stop()
    }
  })

  test("does not let scan progress extend the receiver deadline", async () => {
    const requesterIdentity = testIdentity("requester-deadline")
    const responderIdentity = testIdentity("responder-deadline")
    const deadlineAborted = deferred()
    const responder = new PeerSessionService({
      pairing: fakePairing(responderIdentity, requesterIdentity, 0),
      port: 0,
      testTiming: { scanMaximumDurationMs: 35, scanProgressIntervalMs: 5, responseFlushTimeoutMs: 20 },
      onRequest: async (context) => {
        const interval = setInterval(() => context.reportProgress?.(TEST_PROGRESS), 5)
        try {
          await new Promise<void>((resolve) => context.signal.addEventListener("abort", resolve, { once: true }))
          deadlineAborted.resolve()
          throw new Error("scan cancelled")
        } finally {
          clearInterval(interval)
        }
      },
    })
    await responder.start()
    const requester = new PeerSessionService({
      pairing: fakePairing(requesterIdentity, responderIdentity, responder.port),
      port: 0,
      testTiming: { scanMaximumDurationMs: 35, scanIdleTimeoutMs: 20, responseFlushTimeoutMs: 20 },
      onRequest: async () => undefined,
    })
    try {
      await expect(requester.request(
        responderIdentity.id,
        { type: "scan-manifest", reportProgress: true },
        20,
        { onProgress: () => undefined },
      )).rejects.toThrow("remote scan took too long")
      await deadlineAborted.promise
    } finally {
      await requester.stop()
      await responder.stop()
    }
  })

  test("cancelling a queued peer scan releases its queue entry and permits retry", async () => {
    const requesterIdentity = testIdentity("requester-queued")
    const responderIdentity = testIdentity("responder-queued")
    const coordinator = new ScanCoordinator()
    const release = deferred()
    const queued = deferred()
    const settled = deferred()
    const blockers = Array.from({ length: MAX_ACTIVE_SCANS }, (_, index) => coordinator.run(`blocker-${index}`, () => release.promise))
    const responder = new PeerSessionService({
      pairing: fakePairing(responderIdentity, requesterIdentity, 0),
      port: 0,
      onRequest: async (context) => {
        const work = coordinator.run("peer", async () => ({ complete: true }), context.signal)
        queued.resolve()
        try { return await work } finally { settled.resolve() }
      },
    })
    await responder.start()
    const requester = new PeerSessionService({
      pairing: fakePairing(requesterIdentity, responderIdentity, responder.port),
      onRequest: async () => undefined,
    })
    const controller = new AbortController()
    try {
      const request = requester.request(responderIdentity.id, { type: "scan-manifest" }, 1_000, { signal: controller.signal })
      await queued.promise
      expect(coordinator.queuedScans).toBe(1)
      controller.abort()
      await expect(request).rejects.toThrow("cancelled")
      await settled.promise
      expect(coordinator.queuedScans).toBe(0)
      expect(coordinator.activeScans).toBe(MAX_ACTIVE_SCANS)
      release.resolve()
      await Promise.all(blockers)
      await expect(requester.request(responderIdentity.id, { type: "scan-manifest" }, 1_000)).resolves.toEqual({ complete: true })
      expect(coordinator.activeScans).toBe(0)
    } finally {
      controller.abort()
      release.resolve()
      await Promise.all(blockers)
      await requester.stop()
      await responder.stop()
    }
  })
})

type ChunkFrame = Awaited<ReturnType<Parameters<typeof peerSessionTestHelpers.readChunkedMessage>[1]>>

describe("chunked secure frames", () => {
  const key = Buffer.alloc(32, 9)
  // Four chunks: three full 1 MiB slices and a short remainder.
  const message = { type: "bulk", text: "x".repeat(3 * 1024 * 1024 + 123) }

  function encrypt(value: unknown, requestId: string, direction: "request" | "response" = "response"): ChunkFrame[] {
    return [...peerSessionTestHelpers.encryptChunks(key, "session", requestId, direction, value)]
  }

  function pick(chunks: ChunkFrame[], ...indexes: number[]): ChunkFrame[] {
    return indexes.map((index) => {
      const chunk = chunks[index]
      if (!chunk) throw new Error(`missing chunk ${index}`)
      return chunk
    })
  }

  function reassemble(frames: ChunkFrame[], requestId: string, direction: "request" | "response" = "response"): Promise<unknown> {
    const [first, ...rest] = frames
    if (!first || first.type !== "secure-chunk") throw new Error("expected a first chunk")
    let position = 0
    const next = async (): Promise<ChunkFrame> => {
      const frame = rest[position]
      position += 1
      if (!frame) throw new Error("The secure peer connection closed.")
      return frame
    }
    return peerSessionTestHelpers.readChunkedMessage(first, next, key, "session", requestId, direction)
  }

  test("reassembles an authenticated multi-chunk message", async () => {
    const requestId = randomUUID()
    const chunks = encrypt(message, requestId)
    expect(chunks).toHaveLength(4)
    expect(await reassemble(chunks, requestId)).toEqual(message)
  })

  test("rejects reordered, repeated, dropped and truncated chunks", async () => {
    const requestId = randomUUID()
    const chunks = encrypt(message, requestId)
    for (const order of [[0, 2, 1, 3], [0, 1, 1, 2, 3], [0, 1, 3], [0, 1, 2]]) {
      await expect(reassemble(pick(chunks, ...order), requestId)).rejects.toThrow()
    }
  })

  test("rejects a header rewritten consistently across every chunk", async () => {
    const requestId = randomUUID()
    // The forged total keeps the same chunk count, so only authentication can catch it.
    const forged = encrypt(message, requestId).map((chunk) => (chunk.type === "secure-chunk" ? { ...chunk, totalBytes: chunk.totalBytes - 1 } : chunk))
    await expect(reassemble(forged, requestId)).rejects.toThrow()
  })

  test("rejects a chunk spliced from another request or sealed for the other direction", async () => {
    const requestId = randomUUID()
    const chunks = encrypt(message, requestId)
    const other = encrypt(message, randomUUID())
    await expect(reassemble([...pick(chunks, 0), ...pick(other, 1), ...pick(chunks, 2, 3)], requestId)).rejects.toThrow("invalid chunked message")
    await expect(reassemble(encrypt(message, requestId, "request"), requestId, "response")).rejects.toThrow()
  })

  test("surfaces a session error that interrupts the chunk stream", async () => {
    const requestId = randomUUID()
    const frames: ChunkFrame[] = [...pick(encrypt(message, requestId), 0, 1), { type: "session-error", protocol: 4, reason: "The peer request failed." }]
    await expect(reassemble(frames, requestId)).rejects.toThrow("The peer request failed.")
  })

  test("refuses a total above the exchange limit before sizing any buffer", async () => {
    const requestId = randomUUID()
    const [first] = pick(encrypt({ type: "small" }, requestId), 0)
    if (!first || first.type !== "secure-chunk") throw new Error("expected a chunk")
    await expect(reassemble([{ ...first, totalBytes: 300 * 1024 * 1024, count: 300 }], requestId)).rejects.toThrow("invalid chunked message")
  })

  test("measures a chunked request as plaintext against the exchange limit", () => {
    const request = { type: "continuous-sync-observe", payload: "x".repeat(20 * 1024 * 1024) }
    expect(measurePeerRequest(request).fits).toBe(false)
    const chunked = measurePeerRequest(request, { chunked: true })
    expect(chunked.fits).toBe(true)
    expect(chunked.bytes).toBe(Buffer.byteLength(JSON.stringify(request), "utf8"))
  })

  test("carries a request and a response larger than one frame between chunk-capable peers", async () => {
    const requesterIdentity = testIdentity("requester-chunked")
    const responderIdentity = testIdentity("responder-chunked")
    const bulk = "y".repeat(20 * 1024 * 1024)
    let responderSawChunks: boolean | undefined
    const responder = new PeerSessionService({
      pairing: fakePairing(responderIdentity, requesterIdentity, 0),
      port: 0,
      onRequest: async (context, request) => {
        responderSawChunks = context.chunkedResponse
        return { received: typeof request.bulk === "string" ? request.bulk.length : -1, bulk }
      },
    })
    await responder.start()
    const requester = new PeerSessionService({
      pairing: fakePairing(requesterIdentity, responderIdentity, responder.port),
      port: 0,
      onRequest: async () => undefined,
    })
    try {
      const response = await requester.request<{ received: number; bulk: string }>(responderIdentity.id, { type: "bulk", bulk }, 30_000, { chunked: true })
      expect(response.received).toBe(bulk.length)
      expect(response.bulk === bulk).toBe(true)
      expect(responderSawChunks).toBe(true)
    } finally {
      await requester.stop()
      await responder.stop()
    }
  })

  test("a single-frame exchange still fails closed above the frame cap", async () => {
    const requesterIdentity = testIdentity("requester-single")
    const responderIdentity = testIdentity("responder-single")
    const responder = new PeerSessionService({
      pairing: fakePairing(responderIdentity, requesterIdentity, 0),
      port: 0,
      onRequest: async () => ({ bulk: "z".repeat(17 * 1024 * 1024) }),
    })
    await responder.start()
    const requester = new PeerSessionService({
      pairing: fakePairing(requesterIdentity, responderIdentity, responder.port),
      port: 0,
      onRequest: async () => undefined,
    })
    try {
      await expect(requester.request(responderIdentity.id, { type: "bulk" }, 10_000)).rejects.toThrow()
    } finally {
      await requester.stop()
      await responder.stop()
    }
  })

  test("delivers scan progress before a chunked terminal manifest", async () => {
    const requesterIdentity = testIdentity("requester-chunked-scan")
    const responderIdentity = testIdentity("responder-chunked-scan")
    const files = "f".repeat(2 * 1024 * 1024 + 7)
    const responder = new PeerSessionService({
      pairing: fakePairing(responderIdentity, requesterIdentity, 0),
      port: 0,
      testTiming: { scanProgressIntervalMs: 5 },
      onRequest: async (context) => {
        context.reportProgress?.(TEST_PROGRESS)
        await delay(12)
        context.reportProgress?.({ ...TEST_PROGRESS, scannedFiles: 2 })
        return { files }
      },
    })
    await responder.start()
    const requester = new PeerSessionService({
      pairing: fakePairing(requesterIdentity, responderIdentity, responder.port),
      port: 0,
      onRequest: async () => undefined,
    })
    const activity: number[] = []
    try {
      const response = await requester.request<{ files: string }>(
        responderIdentity.id,
        { type: "scan-manifest", reportProgress: true },
        5_000,
        { chunked: true, onProgress: (progress) => activity.push(progress.scannedFiles) },
      )
      expect(response.files === files).toBe(true)
      expect(activity.length).toBeGreaterThan(0)
    } finally {
      await requester.stop()
      await responder.stop()
    }
  })
})
