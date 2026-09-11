import { EventEmitter } from "node:events"
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  randomUUID,
  type KeyObject,
} from "node:crypto"
import net, { type Server, type Socket } from "node:net"
import type { PairingService } from "./pairing-service"
import {
  PEER_SCAN_IDLE_TIMEOUT_MS,
  PEER_SCAN_MAX_DURATION_MS,
  type PeerScanProgress,
  parsePeerScanProgress,
} from "./peer-scan-progress"

const DEFAULT_SESSION_PORT = 47_656
// Version 4 adds conflict-scoped inspection and explicit winner selection.
const PROTOCOL_VERSION = 4
const CONNECT_TIMEOUT_MS = 10_000
const REQUEST_TIMEOUT_MS = 45_000
const RESPONSE_FLUSH_TIMEOUT_MS = 15_000
const CLOCK_SKEW_MS = 2 * 60_000
const MAX_LINE_BYTES = 16 * 1024 * 1024
const MAX_QUEUED_MESSAGES = 32
const MAX_QUEUED_BYTES = 4 * 1024 * 1024
const MAX_AUTHENTICATED_SESSIONS = 16
const MAX_AUTHENTICATED_SESSIONS_PER_PEER = 4
const MAX_PEER_SCAN_PROGRESS_BYTES = 4_096
const MAX_PEER_SCAN_PROGRESS_MESSAGES = 8_000
const PEER_SCAN_PROGRESS_INTERVAL_MS = 250
/** Advertised by peers that accept requests and responses split across several authenticated frames. */
export const CHUNKED_FRAMES_CAPABILITY = "chunked-frames-v1"
// 1 MiB of plaintext (~1.4 MiB per frame), so a frame parked while its reader
// is busy stays within the parked-message byte bound.
const CHUNK_PLAINTEXT_BYTES = 1024 * 1024
/** Largest message, in plaintext JSON bytes, sent or reassembled as chunks in one exchange. */
const MAX_CHUNKED_MESSAGE_BYTES = 256 * 1024 * 1024

type SessionHello = {
  type: "session-hello"
  protocol: number
  sessionId: string
  deviceId: string
  targetDeviceId: string
  nonce: string
  ephemeralPublicKey: string
  sentAt: number
  signature: string
}

type SessionWelcome = {
  type: "session-welcome"
  protocol: number
  sessionId: string
  deviceId: string
  targetDeviceId: string
  initiatorNonce: string
  responderNonce: string
  ephemeralPublicKey: string
  sentAt: number
  signature: string
}

type SessionError = {
  type: "session-error"
  protocol: number
  reason: string
}

type SecureFrame = {
  type: "secure-frame"
  requestId: string
  iv: string
  ciphertext: string
  tag: string
}

/** One authenticated piece of a message too large for a single frame; see `encryptChunks`. */
type SecureChunk = {
  type: "secure-chunk"
  requestId: string
  index: number
  count: number
  totalBytes: number
  iv: string
  ciphertext: string
  tag: string
}

type WireMessage = SessionHello | SessionWelcome | SessionError | SecureFrame | SecureChunk

export type PeerRequest = { type: string; [key: string]: unknown }
export type PeerResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: string }

export interface PeerRequestContext {
  peerId: string
  peerName: string
  remoteAddress: string
  requestId: string
  /** Aborts when the peer socket closes or the request deadline fires. Handlers must thread it into scan work. */
  signal: AbortSignal
  /** True when the request arrived in chunks, so the response may exceed one frame too. */
  chunkedResponse: boolean
  /**
   * Sends bounded advisory scan activity for a `scan-manifest` request that
   * explicitly opted into it. It is absent for every other peer operation.
   */
  reportProgress?: (progress: PeerScanProgress) => void
}

export interface PeerRequestOptions {
  signal?: AbortSignal | null
  /** Receives bounded advisory activity for an opted-in `scan-manifest` request. */
  onProgress?: (progress: PeerScanProgress) => void
  /**
   * Sends the request, and accepts the response, as authenticated chunks so
   * either may exceed one frame. Only for a peer advertising
   * `CHUNKED_FRAMES_CAPABILITY`: an older peer rejects chunk frames.
   */
  chunked?: boolean
}

interface PeerSessionTimingOptions {
  scanMaximumDurationMs?: number
  scanIdleTimeoutMs?: number
  responseFlushTimeoutMs?: number
  scanProgressIntervalMs?: number
}

export interface PeerSessionServiceOptions {
  pairing: Pick<
    PairingService,
    "getLocalSessionIdentity" | "getTrustedSessionPeer" | "signSessionPayload" | "verifyTrustedSessionPayload"
  >
  onRequest: (context: PeerRequestContext, request: PeerRequest) => Promise<unknown>
  port?: number
  /** Test-only timing overrides for deadline and flush behavior. */
  testTiming?: PeerSessionTimingOptions
}

export class PeerSessionService extends EventEmitter {
  readonly #options: PeerSessionServiceOptions
  #server: Server | null = null
  #port = 0
  #stopped = false
  #recentSessions = new Map<string, number>()
  #authenticatedSessions = 0
  #authenticatedSessionsByPeer = new Map<string, number>()

  constructor(options: PeerSessionServiceOptions) {
    super()
    this.#options = options
  }

  async start(): Promise<void> {
    this.#server = net.createServer((socket) => {
      socket.setNoDelay(true)
      void this.#handleIncoming(socket)
    })
    this.#server.on("error", (error) => this.emit("error-state", error))

    await new Promise<void>((resolve, reject) => {
      const server = this.#server
      if (!server) return reject(new Error("Peer session server was not created."))
      server.once("error", reject)
      server.listen(this.#options.port ?? DEFAULT_SESSION_PORT, "0.0.0.0", () => {
        server.off("error", reject)
        const address = server.address()
        if (!address || typeof address === "string") return reject(new Error("Unable to determine peer session port."))
        this.#port = address.port
        resolve()
      })
    })
  }

  get port(): number {
    return this.#port
  }

  async stop(): Promise<void> {
    this.#stopped = true
    await new Promise<void>((resolve) => {
      if (!this.#server) return resolve()
      this.#server.close(() => resolve())
      this.#server = null
    })
  }

  async request<T = unknown>(deviceId: string, request: PeerRequest, timeoutMs = REQUEST_TIMEOUT_MS, options: PeerRequestOptions = {}): Promise<T> {
    const peer = this.#options.pairing.getTrustedSessionPeer(deviceId)
    if (!peer) throw new Error("This computer is not trusted.")
    if (!peer.address) throw new Error(`${peer.name} is offline or has no known LAN address.`)
    if (options.signal?.aborted) throw new Error("The peer request was cancelled before it started.")
    const isScanManifest = request.type === "scan-manifest"
    const acceptsProgress = options.onProgress !== undefined
    const requestsProgress = isScanManifest && request.reportProgress === true
    if (acceptsProgress !== requestsProgress) {
      throw peerSessionError(
        "Scan progress can only be requested for an opted-in scan-manifest request.",
        "PEER_SCAN_PROGRESS_OPTIONS",
      )
    }

    const local = this.#options.pairing.getLocalSessionIdentity()
    const socket = net.createConnection({ host: peer.address, port: peer.sessionPort })
    const connection = new JsonLineConnection(socket)
    const abortOnCancel = (): void => {
      connection.close()
    }
    options.signal?.addEventListener("abort", abortOnCancel, { once: true })

    try {
      try {
        await waitForConnect(socket, CONNECT_TIMEOUT_MS)
      } catch {
        throw new Error(
          `Could not open a secure session to ${peer.address}:${peer.sessionPort}. ` +
            `Allow TCP ${peer.sessionPort} on private/LAN networks.`,
        )
      }

      const ephemeral = generateKeyPairSync("x25519")
      const sessionId = randomUUID()
      const nonce = randomBytes(32).toString("base64url")
      const helloBody = {
        protocol: PROTOCOL_VERSION,
        sessionId,
        deviceId: local.id,
        targetDeviceId: peer.id,
        nonce,
        ephemeralPublicKey: exportX25519PublicKey(ephemeral.publicKey),
        sentAt: Date.now(),
      }
      const hello: SessionHello = {
        type: "session-hello",
        ...helloBody,
        signature: this.#options.pairing.signSessionPayload("session-hello", helloBody),
      }
      connection.write(hello)

      let welcome: WireMessage
      try {
        welcome = await connection.read(CONNECT_TIMEOUT_MS, options.signal)
      } catch (error) {
        throw asPeerPhaseTimeout(error, "The secure peer welcome timed out.", "PEER_HANDSHAKE_TIMEOUT")
      }
      if (welcome.type === "session-error") throw new Error(welcome.reason)
      if (welcome.type !== "session-welcome") throw new Error("The peer sent an invalid secure-session response.")
      const welcomeBody = {
        protocol: welcome.protocol,
        sessionId: welcome.sessionId,
        deviceId: welcome.deviceId,
        targetDeviceId: welcome.targetDeviceId,
        initiatorNonce: welcome.initiatorNonce,
        responderNonce: welcome.responderNonce,
        ephemeralPublicKey: welcome.ephemeralPublicKey,
        sentAt: welcome.sentAt,
      }
      if (
        welcome.protocol !== PROTOCOL_VERSION ||
        welcome.sessionId !== sessionId ||
        welcome.deviceId !== peer.id ||
        welcome.targetDeviceId !== local.id ||
        welcome.initiatorNonce !== nonce ||
        Math.abs(Date.now() - welcome.sentAt) > CLOCK_SKEW_MS ||
        !this.#options.pairing.verifyTrustedSessionPayload(peer.id, "session-welcome", welcomeBody, welcome.signature)
      ) {
        throw new Error("The peer session identity check failed.")
      }

      const key = deriveSessionKey(
        ephemeral.privateKey,
        welcome.ephemeralPublicKey,
        buildSessionTranscript(helloBody, welcomeBody),
      )
      const requestId = randomUUID()
      if (options.chunked) await connection.writeAll(encryptChunks(key, sessionId, requestId, "request", request))
      else connection.write(encryptFrame(key, sessionId, requestId, "request", request))
      if (isScanManifest) {
        return await this.#readScanResponse<T>(connection, key, sessionId, requestId, timeoutMs, options)
      }
      const readResponse = async (): Promise<WireMessage> => {
        try {
          return await connection.read(timeoutMs, options.signal)
        } catch (error) {
          throw asPeerPhaseTimeout(error, "The secure peer operation timed out.", "PEER_RESPONSE_TIMEOUT")
        }
      }
      const responseFrame = await readResponse()
      return options.chunked
        ? await parseChunkedTerminalResponse<T>(responseFrame, readResponse, key, sessionId, requestId)
        : parseTerminalResponse<T>(key, sessionId, requestId, responseFrame)
    } catch (error) {
      if (options.signal?.aborted) throw new Error("The peer request was cancelled.")
      throw error
    } finally {
      options.signal?.removeEventListener("abort", abortOnCancel)
      connection.close()
    }
  }

  async #readScanResponse<T>(
    connection: JsonLineConnection,
    key: Buffer,
    sessionId: string,
    requestId: string,
    timeoutMs: number,
    options: PeerRequestOptions,
  ): Promise<T> {
    const timing = this.#timing()
    const deadline = performance.now() + timing.scanMaximumDurationMs + timing.responseFlushTimeoutMs
    let expectedSequence = 1
    while (true) {
      const remaining = deadline - performance.now()
      if (remaining <= 0) {
        throw peerSessionError("The secure peer scan exceeded its maximum duration.", "PEER_SCAN_DEADLINE")
      }
      const readTimeout = Math.min(timeoutMs, timing.scanIdleTimeoutMs, remaining)
      let responseFrame: WireMessage
      try {
        responseFrame = await connection.read(readTimeout, options.signal)
      } catch (error) {
        if (performance.now() >= deadline) {
          throw peerSessionError("The secure peer scan exceeded its maximum duration.", "PEER_SCAN_DEADLINE")
        }
        throw asPeerPhaseTimeout(error, "The secure peer scan stopped reporting progress.", "PEER_SCAN_IDLE_TIMEOUT")
      }
      if (performance.now() >= deadline) {
        throw peerSessionError("The secure peer scan exceeded its maximum duration.", "PEER_SCAN_DEADLINE")
      }
      if (responseFrame.type === "session-error") throw new Error(responseFrame.reason)
      if (options.chunked && responseFrame.type === "secure-chunk") {
        const readChunk = async (): Promise<WireMessage> => {
          try {
            return await connection.read(readTimeout, options.signal)
          } catch (error) {
            throw asPeerPhaseTimeout(error, "The secure peer scan stopped reporting progress.", "PEER_SCAN_IDLE_TIMEOUT")
          }
        }
        return await parseChunkedTerminalResponse<T>(responseFrame, readChunk, key, sessionId, requestId)
      }
      if (responseFrame.type !== "secure-frame" || responseFrame.requestId !== requestId) {
        throw new Error("The peer returned an invalid encrypted response.")
      }
      const value = decryptFrame<unknown>(key, sessionId, "response", responseFrame)
      if (isPeerResponse(value)) {
        // In chunked mode the terminal response always arrives as chunks.
        if (options.chunked) throw new Error("The peer returned an invalid encrypted response.")
        const response = parsePeerResponse(value)
        if (!response.ok) throw new Error(response.error)
        return response.result as T
      }
      if (!options.onProgress || expectedSequence > MAX_PEER_SCAN_PROGRESS_MESSAGES) {
        throw new Error("The peer returned invalid scan progress.")
      }
      const progress = parsePeerScanProgressEnvelope(value, expectedSequence)
      expectedSequence += 1
      try {
        options.onProgress?.(progress)
      } catch {
        // Activity is advisory. A renderer teardown must not fail a scan.
      }
    }
  }

  async #handleIncoming(socket: Socket): Promise<void> {
    const connection = new JsonLineConnection(socket)
    const handlerController = new AbortController()
    const abortHandler = (): void => {
      handlerController.abort()
      connection.close()
    }
    socket.once("close", abortHandler)
    let sessionId: string | undefined
    let requestId: string | undefined
    let peerIdForLog: string | undefined
    let authenticatedPeerId: string | undefined
    let scanDeadline: ReturnType<typeof setTimeout> | undefined
    let scanCloseDeadline: ReturnType<typeof setTimeout> | undefined
    let scanDeadlineExpired = false
    try {
      const first = await connection.read(CONNECT_TIMEOUT_MS, handlerController.signal)
      if (first.type !== "session-hello") {
        await connection.end({ type: "session-error", protocol: PROTOCOL_VERSION, reason: "Expected a secure-session hello." })
        return
      }
      sessionId = safeCorrelationId(first.sessionId)
      const local = this.#options.pairing.getLocalSessionIdentity()
      const helloBody = {
        protocol: first.protocol,
        sessionId: first.sessionId,
        deviceId: first.deviceId,
        targetDeviceId: first.targetDeviceId,
        nonce: first.nonce,
        ephemeralPublicKey: first.ephemeralPublicKey,
        sentAt: first.sentAt,
      }
      if (
        first.protocol !== PROTOCOL_VERSION ||
        first.targetDeviceId !== local.id ||
        Math.abs(Date.now() - first.sentAt) > CLOCK_SKEW_MS ||
        !this.#options.pairing.verifyTrustedSessionPayload(first.deviceId, "session-hello", helloBody, first.signature)
      ) {
        throw new Error("The connecting computer is not a trusted Tethera device.")
      }
      if (this.#recentSessions.has(first.sessionId)) throw new Error("This secure session has already been used.")
      this.#recentSessions.set(first.sessionId, Date.now())
      this.#pruneRecentSessions()

      const peer = this.#options.pairing.getTrustedSessionPeer(first.deviceId)
      if (!peer) throw new Error("The connecting computer is no longer trusted.")
      peerIdForLog = safePeerId(peer.id)
      this.#beginAuthenticatedSession(peer.id)
      authenticatedPeerId = peer.id
      const ephemeral = generateKeyPairSync("x25519")
      const responderNonce = randomBytes(32).toString("base64url")
      const welcomeBody = {
        protocol: PROTOCOL_VERSION,
        sessionId: first.sessionId,
        deviceId: local.id,
        targetDeviceId: first.deviceId,
        initiatorNonce: first.nonce,
        responderNonce,
        ephemeralPublicKey: exportX25519PublicKey(ephemeral.publicKey),
        sentAt: Date.now(),
      }
      const welcome: SessionWelcome = {
        type: "session-welcome",
        ...welcomeBody,
        signature: this.#options.pairing.signSessionPayload("session-welcome", welcomeBody),
      }
      connection.write(welcome)

      const key = deriveSessionKey(
        ephemeral.privateKey,
        first.ephemeralPublicKey,
        buildSessionTranscript(helloBody, welcomeBody),
      )
      const frame = await connection.read(REQUEST_TIMEOUT_MS, handlerController.signal)
      if (frame.type !== "secure-frame" && frame.type !== "secure-chunk") throw new Error("Expected an encrypted peer request.")
      requestId = safeCorrelationId(frame.requestId)
      // A requester that sends chunks can also reassemble a chunked response.
      const chunkedResponse = frame.type === "secure-chunk"
      const request = frame.type === "secure-chunk"
        ? await readChunkedMessage<PeerRequest>(frame, () => connection.read(REQUEST_TIMEOUT_MS, handlerController.signal), key, first.sessionId, frame.requestId, "request")
        : decryptFrame<PeerRequest>(key, first.sessionId, "request", frame)
      const isScanManifest = request.type === "scan-manifest"
      const canReportProgress = isScanManifest && request.reportProgress === true
      if (isScanManifest) {
        const timing = this.#timing()
        scanDeadline = setTimeout(() => {
          scanDeadlineExpired = true
          handlerController.abort()
          // Give a cooperative scan a bounded chance to return its terminal
          // deadline error. An uncooperative handler cannot keep the socket
          // or buffered frames alive beyond the existing flush budget.
          scanCloseDeadline = setTimeout(() => connection.close(), timing.responseFlushTimeoutMs)
        }, timing.scanMaximumDurationMs)
      }
      const context: PeerRequestContext = {
        peerId: peer.id,
        peerName: peer.name,
        remoteAddress: normalizeRemoteAddress(socket.remoteAddress),
        requestId,
        signal: handlerController.signal,
        chunkedResponse,
        ...(canReportProgress ? { reportProgress: this.#createProgressReporter(connection, key, first.sessionId, frame.requestId, handlerController.signal) } : {}),
      }

      let response: PeerResponse
      try {
        const result = await this.#options.onRequest(context, request)
        if (scanDeadlineExpired) {
          throw peerSessionError(
            "The remote scan took too long. Try a smaller folder or add ignore rules, then try again.",
            "PEER_SCAN_DEADLINE",
          )
        }
        if (handlerController.signal.aborted) throw new Error("The secure peer request was cancelled.")
        response = { ok: true, result }
      } catch (error) {
        const responseError = scanDeadlineExpired
          ? peerSessionError(
              "The remote scan took too long. Try a smaller folder or add ignore rules, then try again.",
              "PEER_SCAN_DEADLINE",
            )
          : error
        const detail = boundedPeerError(responseError, "The peer request failed.")
        const diagnostic = safeErrorDiagnostic(responseError)
        console.warn("[peer-session] peer request failed", {
          operation: safeOperationName(request.type),
          requestId: context.requestId,
          ...(isPeerTimeoutDiagnostic(diagnostic) ? {} : { peerId: context.peerId }),
          error: diagnostic,
        })
        response = { ok: false, error: detail }
      }
      if (chunkedResponse) await connection.endChunked(encryptChunks(key, first.sessionId, frame.requestId, "response", response))
      else await connection.end(encryptFrame(key, first.sessionId, frame.requestId, "response", response))
    } catch (error) {
      const detail = boundedPeerError(error, "The secure peer session failed.")
      console.warn("[peer-session] secure session failed", {
        sessionId,
        requestId,
        peerId: peerIdForLog,
        error: safeErrorDiagnostic(error),
      })
      try {
        await connection.end({
          type: "session-error",
          protocol: PROTOCOL_VERSION,
          reason: detail,
        })
      } catch (sendError) {
        console.warn("[peer-session] unable to flush terminal response", {
          sessionId,
          requestId,
          peerId: peerIdForLog,
          error: safeErrorDiagnostic(sendError),
        })
      }
    } finally {
      if (scanDeadline) clearTimeout(scanDeadline)
      if (scanCloseDeadline) clearTimeout(scanCloseDeadline)
      handlerController.abort()
      socket.off("close", abortHandler)
      if (authenticatedPeerId) this.#endAuthenticatedSession(authenticatedPeerId)
      connection.close()
    }
  }

  #createProgressReporter(
    connection: JsonLineConnection,
    key: Buffer,
    sessionId: string,
    requestId: string,
    signal: AbortSignal,
  ): (progress: PeerScanProgress) => void {
    let lastSentAt = Number.NEGATIVE_INFINITY
    let sequence = 0
    const progressIntervalMs = this.#timing().scanProgressIntervalMs
    return (candidate) => {
      if (signal.aborted || sequence >= MAX_PEER_SCAN_PROGRESS_MESSAGES) return
      const now = performance.now()
      if (now - lastSentAt < progressIntervalMs) return
      try {
        const progress = parsePeerScanProgress(candidate)
        const envelope = { progress, sequence: sequence + 1 }
        if (Buffer.byteLength(JSON.stringify(envelope), "utf8") > MAX_PEER_SCAN_PROGRESS_BYTES) return
        if (!connection.writeAdvisory(encryptFrame(key, sessionId, requestId, "response", envelope))) return
        sequence += 1
        lastSentAt = now
      } catch {
        // Scan activity must never fail or expose a scan because its advisory
        // transport was unavailable or its producer supplied invalid values.
      }
    }
  }

  #timing(): Required<PeerSessionTimingOptions> {
    return {
      scanMaximumDurationMs: this.#options.testTiming?.scanMaximumDurationMs ?? PEER_SCAN_MAX_DURATION_MS,
      scanIdleTimeoutMs: this.#options.testTiming?.scanIdleTimeoutMs ?? PEER_SCAN_IDLE_TIMEOUT_MS,
      responseFlushTimeoutMs: this.#options.testTiming?.responseFlushTimeoutMs ?? RESPONSE_FLUSH_TIMEOUT_MS,
      scanProgressIntervalMs: this.#options.testTiming?.scanProgressIntervalMs ?? PEER_SCAN_PROGRESS_INTERVAL_MS,
    }
  }

  #beginAuthenticatedSession(peerId: string): void {
    const peerSessions = this.#authenticatedSessionsByPeer.get(peerId) ?? 0
    if (
      this.#authenticatedSessions >= MAX_AUTHENTICATED_SESSIONS ||
      peerSessions >= MAX_AUTHENTICATED_SESSIONS_PER_PEER
    ) {
      throw peerSessionError("This computer is already handling its maximum number of secure sessions.", "PEER_SESSION_CAPACITY")
    }
    this.#authenticatedSessions += 1
    this.#authenticatedSessionsByPeer.set(peerId, peerSessions + 1)
  }

  #endAuthenticatedSession(peerId: string): void {
    const peerSessions = this.#authenticatedSessionsByPeer.get(peerId) ?? 0
    this.#authenticatedSessions = Math.max(0, this.#authenticatedSessions - 1)
    if (peerSessions <= 1) this.#authenticatedSessionsByPeer.delete(peerId)
    else this.#authenticatedSessionsByPeer.set(peerId, peerSessions - 1)
  }

  #pruneRecentSessions(): void {
    const cutoff = Date.now() - CLOCK_SKEW_MS
    for (const [sessionId, seenAt] of this.#recentSessions) {
      if (seenAt < cutoff) this.#recentSessions.delete(sessionId)
    }
  }
}

function boundedPeerError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : fallback
  const bounded = message
    .replaceAll("\0", "")
    .replace(/[A-Za-z]:\\[^\r\n]*/g, "[local path]")
    .replace(/\/(?:[^/\s]+\/)*[^/\s]*/g, "[local path]")
    .slice(0, 512)
    .trim()
  return bounded || fallback
}

function safeOperationName(value: unknown): string {
  if (typeof value !== "string") return "unknown"
  return value.replace(/[^a-z0-9-]/gi, "").slice(0, 64) || "unknown"
}

function safeCorrelationId(value: unknown): string {
  return typeof value === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value)
    ? value
    : "invalid"
}

function safePeerId(value: unknown): string {
  return typeof value === "string" && /^[a-f0-9]{32}$/i.test(value) ? value : "invalid"
}

function safeErrorDiagnostic(error: unknown): { name: string; code?: string } {
  if (!(error instanceof Error)) return { name: "UnknownError" }
  const candidateCode = (error as NodeJS.ErrnoException).code
  return {
    name: error.name.replace(/[^a-z0-9]/gi, "").slice(0, 64) || "Error",
    ...(typeof candidateCode === "string" && /^[A-Z0-9_]{1,32}$/.test(candidateCode)
      ? { code: candidateCode }
      : {}),
  }
}

function parsePeerResponse(value: unknown): PeerResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The peer returned an invalid response.")
  }
  const response = value as { ok?: unknown; result?: unknown; error?: unknown }
  const keys = Object.keys(response)
  if (response.ok === true && keys.every((key) => key === "ok" || key === "result") && !("error" in response)) {
    return { ok: true, result: response.result }
  }
  if (
    response.ok === false &&
    keys.length === 2 &&
    "error" in response &&
    typeof response.error === "string" &&
    response.error.length <= 512
  ) {
    return { ok: false, error: response.error.replaceAll("\0", "") }
  }
  throw new Error("The peer returned an invalid response.")
}

function isPeerResponse(value: unknown): value is PeerResponse {
  return value !== null && typeof value === "object" && !Array.isArray(value) && "ok" in value
}

function parseTerminalResponse<T>(key: Buffer, sessionId: string, requestId: string, responseFrame: WireMessage): T {
  if (responseFrame.type === "session-error") throw new Error(responseFrame.reason)
  if (responseFrame.type !== "secure-frame" || responseFrame.requestId !== requestId) {
    throw new Error("The peer returned an invalid encrypted response.")
  }
  const response = parsePeerResponse(decryptFrame<unknown>(key, sessionId, "response", responseFrame))
  if (!response.ok) throw new Error(response.error)
  return response.result as T
}

async function parseChunkedTerminalResponse<T>(
  first: WireMessage,
  next: () => Promise<WireMessage>,
  key: Buffer,
  sessionId: string,
  requestId: string,
): Promise<T> {
  if (first.type === "session-error") throw new Error(first.reason)
  if (first.type !== "secure-chunk" || first.requestId !== requestId) {
    throw new Error("The peer returned an invalid encrypted response.")
  }
  const response = parsePeerResponse(await readChunkedMessage<unknown>(first, next, key, sessionId, requestId, "response"))
  if (!response.ok) throw new Error(response.error)
  return response.result as T
}

function parsePeerScanProgressEnvelope(value: unknown, expectedSequence: number): PeerScanProgress {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The peer returned invalid scan progress.")
  }
  const envelope = value as { progress?: unknown; sequence?: unknown }
  if (
    Object.keys(envelope).length !== 2 ||
    !("progress" in envelope) ||
    !("sequence" in envelope) ||
    !Number.isSafeInteger(envelope.sequence) ||
    envelope.sequence !== expectedSequence ||
    Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_PEER_SCAN_PROGRESS_BYTES
  ) {
    throw new Error("The peer returned invalid scan progress.")
  }
  try {
    return parsePeerScanProgress(envelope.progress)
  } catch {
    throw new Error("The peer returned invalid scan progress.")
  }
}

function asPeerPhaseTimeout(error: unknown, message: string, code: string): Error {
  return error instanceof Error && error.message === "The secure peer request timed out."
    ? peerSessionError(message, code)
    : error instanceof Error
      ? error
      : new Error(message)
}

function isPeerTimeoutDiagnostic(diagnostic: { code?: string }): boolean {
  return diagnostic.code === "PEER_SCAN_DEADLINE"
}

class JsonLineConnection {
  readonly #socket: Socket
  #buffer = ""
  #queue: WireMessage[] = []
  #queuedBytes = 0
  #waiters: Array<{ resolve: (message: WireMessage) => void; reject: (error: Error) => void }> = []
  #closedError: Error | null = null

  constructor(socket: Socket) {
    this.#socket = socket
    socket.setEncoding("utf8")
    socket.on("data", (chunk: Buffer | string) => this.#onData(typeof chunk === "string" ? chunk : chunk.toString("utf8")))
    socket.on("error", (error) => {
      this.#closeWithError(error)
      this.close()
    })
    socket.on("close", () => this.#closeWithError(new Error("The secure peer connection closed.")))
  }

  get queuedMessages(): number {
    return this.#queue.length
  }

  get queuedBytes(): number {
    return this.#queuedBytes
  }

  write(message: WireMessage): void {
    if (this.#socket.destroyed) throw new Error("The secure peer connection is closed.")
    this.#socket.write(serializeWireMessage(message))
  }

  /** Writes frames one at a time, waiting for the socket to drain so a large message is never buffered whole. */
  async writeAll(messages: Iterable<WireMessage>): Promise<void> {
    for (const message of messages) {
      if (this.#socket.destroyed || this.#socket.writableEnded) {
        throw peerSessionError("The secure peer connection is closed.", "PEER_CONNECTION_CLOSED")
      }
      if (!this.#socket.write(serializeWireMessage(message))) await this.#drain()
    }
  }

  /** Writes every frame but the last with backpressure, then ends the socket with the last. */
  async endChunked(messages: Iterable<WireMessage>): Promise<void> {
    let previous: WireMessage | undefined
    for (const message of messages) {
      if (previous) await this.writeAll([previous])
      previous = message
    }
    if (!previous) throw new Error("A chunked message needs at least one frame.")
    await this.end(previous)
  }

  #drain(): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = (error?: Error): void => {
        clearTimeout(timeout)
        this.#socket.off("drain", onDrain)
        this.#socket.off("close", onClose)
        this.#socket.off("error", onError)
        if (error) reject(error)
        else resolve()
      }
      const onDrain = (): void => finish()
      const onClose = (): void => finish(peerSessionError("The secure peer connection is closed.", "PEER_CONNECTION_CLOSED"))
      const onError = (error: Error): void => finish(error)
      const timeout = setTimeout(
        () => finish(peerSessionError("The secure peer stopped reading.", "PEER_RESPONSE_FLUSH_TIMEOUT")),
        RESPONSE_FLUSH_TIMEOUT_MS,
      )
      this.#socket.once("drain", onDrain)
      this.#socket.once("close", onClose)
      this.#socket.once("error", onError)
    })
  }

  /**
   * Progress is advisory. Do not queue it in Node when the socket has applied
   * backpressure; a later activity report may resume after `drain`.
   */
  writeAdvisory(message: WireMessage): boolean {
    if (this.#socket.destroyed || this.#socket.writableEnded || this.#socket.writableNeedDrain) return false
    try {
      this.#socket.write(serializeWireMessage(message))
      return true
    } catch {
      return false
    }
  }

  async end(message: WireMessage): Promise<void> {
    if (this.#socket.destroyed || this.#socket.writableEnded) {
      throw peerSessionError("The secure peer connection is closed.", "PEER_CONNECTION_CLOSED")
    }
    const serialized = serializeWireMessage(message)
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        this.#socket.off("error", onError)
        if (error) reject(error)
        else resolve()
      }
      const onError = (error: Error) => finish(error)
      const timeout = setTimeout(
        () => finish(peerSessionError("The secure peer response timed out.", "PEER_RESPONSE_FLUSH_TIMEOUT")),
        RESPONSE_FLUSH_TIMEOUT_MS,
      )
      this.#socket.once("error", onError)
      this.#socket.end(serialized, () => finish())
    })
  }

  async read(timeoutMs: number, signal?: AbortSignal | null): Promise<WireMessage> {
    if (signal?.aborted) throw new Error("The secure peer request was cancelled.")
    if (this.#queue.length > 0) {
      const queued = this.#queue.shift() as WireMessage
      this.#queuedBytes = Math.max(0, this.#queuedBytes - Buffer.byteLength(JSON.stringify(queued), "utf8"))
      return queued
    }
    if (this.#closedError) throw this.#closedError
    return await new Promise<WireMessage>((resolve, reject) => {
      const waiter = { resolve, reject }
      this.#waiters.push(waiter)
      const cleanup = (): void => {
        clearTimeout(timeout)
        signal?.removeEventListener("abort", onAbort)
      }
      const onAbort = (): void => {
        const index = this.#waiters.indexOf(waiter)
        if (index >= 0) this.#waiters.splice(index, 1)
        cleanup()
        reject(new Error("The secure peer request was cancelled."))
      }
      const timeout = setTimeout(() => {
        const index = this.#waiters.indexOf(waiter)
        if (index >= 0) this.#waiters.splice(index, 1)
        cleanup()
        reject(new Error("The secure peer request timed out."))
      }, timeoutMs)
      signal?.addEventListener("abort", onAbort, { once: true })
      waiter.resolve = (message) => {
        cleanup()
        resolve(message)
      }
      waiter.reject = (error) => {
        cleanup()
        reject(error)
      }
    })
  }

  close(): void {
    this.#clearRetained()
    if (!this.#socket.destroyed) this.#socket.destroy()
  }

  #clearRetained(): void {
    // Terminal state must not retain parsed peer objects or partial line data.
    this.#queue = []
    this.#queuedBytes = 0
    this.#buffer = ""
  }

  #onData(chunk: string): void {
    this.#buffer += chunk
    if (Buffer.byteLength(this.#buffer, "utf8") > MAX_LINE_BYTES) {
      this.#closeWithError(new Error("The peer message exceeded the safe size limit."))
      this.close()
      return
    }
    while (true) {
      const newline = this.#buffer.indexOf("\n")
      if (newline < 0) break
      const line = this.#buffer.slice(0, newline).trim()
      this.#buffer = this.#buffer.slice(newline + 1)
      if (!line) continue
      try {
        const message = JSON.parse(line) as WireMessage
        const waiter = this.#waiters.shift()
        if (waiter) waiter.resolve(message)
        else {
          // A stream of individually bounded frames can still exhaust memory
          // while a long handler runs, so bound the parked queue as well.
          const messageBytes = Buffer.byteLength(line, "utf8")
          if (
            this.#queue.length >= MAX_QUEUED_MESSAGES ||
            this.#queuedBytes + messageBytes > MAX_QUEUED_BYTES
          ) {
            this.#closeWithError(new Error("The peer queued more messages than the safe limit."))
            this.close()
            return
          }
          this.#queue.push(message)
          this.#queuedBytes += messageBytes
        }
      } catch {
        this.#closeWithError(new Error("The peer sent invalid session data."))
        this.close()
        return
      }
    }
  }

  #closeWithError(error: Error): void {
    if (this.#closedError) return
    this.#closedError = error
    this.#clearRetained()
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error)
  }
}

/**
 * Exact size of a request against the limit it will be sent under, computed
 * without a session key, so a caller can refuse an oversized request before
 * committing any local work. A single frame is measured as its encrypted line:
 * AES-GCM ciphertext is exactly as long as its plaintext, and the rest is
 * fixed-width base64 around a random UUID request id. A chunked request is
 * measured as plaintext against the chunked-exchange limit.
 */
export function measurePeerRequest(request: PeerRequest, options: { chunked?: boolean } = {}): { bytes: number; limit: number; fits: boolean } {
  const plaintextBytes = Buffer.byteLength(JSON.stringify(request), "utf8")
  if (options.chunked) {
    return { bytes: plaintextBytes, limit: MAX_CHUNKED_MESSAGE_BYTES, fits: plaintextBytes <= MAX_CHUNKED_MESSAGE_BYTES }
  }
  const envelope: SecureFrame = {
    type: "secure-frame",
    requestId: randomUUID(),
    iv: Buffer.alloc(12).toString("base64"),
    ciphertext: "",
    tag: Buffer.alloc(16).toString("base64"),
  }
  const bytes = Buffer.byteLength(`${JSON.stringify(envelope)}\n`, "utf8") + Math.ceil(plaintextBytes / 3) * 4
  return { bytes, limit: MAX_LINE_BYTES, fits: bytes <= MAX_LINE_BYTES }
}

function serializeWireMessage(message: WireMessage): string {
  const serialized = `${JSON.stringify(message)}\n`
  if (Buffer.byteLength(serialized, "utf8") > MAX_LINE_BYTES) {
    throw peerSessionError("The peer message exceeded the safe size limit.", "PEER_MESSAGE_TOO_LARGE")
  }
  return serialized
}

function peerSessionError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

function exportX25519PublicKey(key: KeyObject): string {
  return key.export({ format: "der", type: "spki" }).toString("base64")
}

function importX25519PublicKey(encoded: string): KeyObject {
  return createPublicKey({ key: Buffer.from(encoded, "base64"), format: "der", type: "spki" })
}

function buildSessionTranscript(hello: object, welcome: object): Buffer {
  return createHash("sha256")
    .update(JSON.stringify(["tethera-secure-session-v1", hello, welcome]))
    .digest()
}

function deriveSessionKey(privateKey: KeyObject, remotePublicKey: string, transcript: Buffer): Buffer {
  const sharedSecret = diffieHellman({ privateKey, publicKey: importX25519PublicKey(remotePublicKey) })
  return Buffer.from(hkdfSync("sha256", sharedSecret, transcript, Buffer.from("tethera-peer-rpc-v1"), 32))
}

function encryptFrame(
  key: Buffer,
  sessionId: string,
  requestId: string,
  direction: "request" | "response",
  value: unknown,
): SecureFrame {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  cipher.setAAD(Buffer.from(`${sessionId}\0${requestId}\0${direction}`))
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()])
  return {
    type: "secure-frame",
    requestId,
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  }
}

const GCM_IV_BYTES = 12
const GCM_TAG_BYTES = 16

/**
 * Decodes a frame's sealed fields from the wire. Each must be a base64 string:
 * any other JSON value could make `Buffer.from` allocate an arbitrary length.
 * The IV and tag must be exactly GCM's sizes, because Node otherwise verifies
 * a truncated tag prefix and authentication drops to as little as 32 bits.
 */
function decodeSealedFields(frame: { iv: unknown; tag: unknown; ciphertext: unknown }): { iv: Buffer; tag: Buffer; ciphertext: Buffer } {
  if (typeof frame.iv !== "string" || typeof frame.tag !== "string" || typeof frame.ciphertext !== "string") {
    throw new Error("The peer sent an invalid encrypted frame.")
  }
  const iv = Buffer.from(frame.iv, "base64")
  const tag = Buffer.from(frame.tag, "base64")
  if (iv.length !== GCM_IV_BYTES || tag.length !== GCM_TAG_BYTES) throw new Error("The peer sent an invalid encrypted frame.")
  return { iv, tag, ciphertext: Buffer.from(frame.ciphertext, "base64") }
}

function decryptFrame<T>(
  key: Buffer,
  sessionId: string,
  direction: "request" | "response",
  frame: SecureFrame,
): T {
  const { iv, tag, ciphertext } = decodeSealedFields(frame)
  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: GCM_TAG_BYTES })
  decipher.setAAD(Buffer.from(`${sessionId}\0${frame.requestId}\0${direction}`))
  decipher.setAuthTag(tag)
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8")
  return JSON.parse(plaintext) as T
}

function chunkAad(
  sessionId: string,
  requestId: string,
  direction: "request" | "response",
  chunk: { index: number; count: number; totalBytes: number },
): Buffer {
  return Buffer.from(`${sessionId}\0${requestId}\0${direction}\0chunk\0${chunk.index}\0${chunk.count}\0${chunk.totalBytes}`)
}

/**
 * Splits one message into authenticated chunks of `CHUNK_PLAINTEXT_BYTES`.
 * Each chunk's index, the chunk count and the total size are bound into its
 * AAD, so a chunk cannot be reordered, repeated, dropped or moved into another
 * message without failing authentication or layout validation.
 */
function* encryptChunks(
  key: Buffer,
  sessionId: string,
  requestId: string,
  direction: "request" | "response",
  value: unknown,
): Generator<SecureChunk, void, void> {
  const plaintext = Buffer.from(JSON.stringify(value), "utf8")
  if (plaintext.length > MAX_CHUNKED_MESSAGE_BYTES) {
    throw peerSessionError(
      `The secure message is ${(plaintext.length / 1_048_576).toFixed(1)} MiB, above the ${MAX_CHUNKED_MESSAGE_BYTES / 1_048_576} MiB limit for one peer exchange.`,
      "PEER_MESSAGE_TOO_LARGE",
    )
  }
  const count = Math.ceil(plaintext.length / CHUNK_PLAINTEXT_BYTES)
  for (let index = 0; index < count; index += 1) {
    const header = { index, count, totalBytes: plaintext.length }
    const iv = randomBytes(GCM_IV_BYTES)
    const cipher = createCipheriv("aes-256-gcm", key, iv)
    cipher.setAAD(chunkAad(sessionId, requestId, direction, header))
    const slice = plaintext.subarray(index * CHUNK_PLAINTEXT_BYTES, (index + 1) * CHUNK_PLAINTEXT_BYTES)
    const ciphertext = Buffer.concat([cipher.update(slice), cipher.final()])
    yield {
      type: "secure-chunk",
      requestId,
      ...header,
      iv: iv.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    }
  }
}

function decryptChunk(key: Buffer, sessionId: string, direction: "request" | "response", chunk: SecureChunk): Buffer {
  const { iv, tag, ciphertext } = decodeSealedFields(chunk)
  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: GCM_TAG_BYTES })
  decipher.setAAD(chunkAad(sessionId, chunk.requestId, direction, chunk))
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

function hasValidChunkLayout(count: unknown, totalBytes: unknown): boolean {
  if (typeof count !== "number" || typeof totalBytes !== "number") return false
  if (!Number.isSafeInteger(count) || !Number.isSafeInteger(totalBytes)) return false
  return totalBytes > 0 && totalBytes <= MAX_CHUNKED_MESSAGE_BYTES && count === Math.ceil(totalBytes / CHUNK_PLAINTEXT_BYTES)
}

/**
 * Reassembles one chunked message. Chunk 0 is authenticated before any buffer
 * is sized from the total its header claims; every later chunk must repeat the
 * same count and total, arrive at the next index, and carry exactly the length
 * the sender's split produces.
 */
async function readChunkedMessage<T>(
  first: SecureChunk,
  next: () => Promise<WireMessage>,
  key: Buffer,
  sessionId: string,
  requestId: string,
  direction: "request" | "response",
): Promise<T> {
  const { count, totalBytes } = first
  if (first.requestId !== requestId || first.index !== 0 || !hasValidChunkLayout(count, totalBytes)) {
    throw new Error("The peer sent an invalid chunked message.")
  }
  let plaintext: Buffer | undefined
  let offset = 0
  let chunk: WireMessage = first
  for (let index = 0; index < count; index += 1) {
    if (index > 0) chunk = await next()
    if (chunk.type === "session-error") throw new Error(chunk.reason)
    if (
      chunk.type !== "secure-chunk" ||
      chunk.requestId !== requestId ||
      chunk.index !== index ||
      chunk.count !== count ||
      chunk.totalBytes !== totalBytes
    ) {
      throw new Error("The peer sent an invalid chunked message.")
    }
    const decrypted = decryptChunk(key, sessionId, direction, chunk)
    if (decrypted.length !== Math.min(CHUNK_PLAINTEXT_BYTES, totalBytes - offset)) {
      throw new Error("The peer sent an invalid chunked message.")
    }
    plaintext ??= Buffer.allocUnsafe(totalBytes)
    decrypted.copy(plaintext, offset)
    offset += decrypted.length
  }
  if (!plaintext || offset !== totalBytes) throw new Error("The peer sent an invalid chunked message.")
  return JSON.parse(plaintext.toString("utf8")) as T
}

function waitForConnect(socket: Socket, timeoutMs: number): Promise<void> {
  if (!socket.connecting) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      socket.destroy()
      reject(new Error("Could not connect to the trusted computer."))
    }, timeoutMs)
    const onConnect = () => {
      cleanup()
      resolve()
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const cleanup = () => {
      clearTimeout(timeout)
      socket.off("connect", onConnect)
      socket.off("error", onError)
    }
    socket.once("connect", onConnect)
    socket.once("error", onError)
  })
}

function normalizeRemoteAddress(address?: string): string {
  if (!address) return "Unknown address"
  return address.startsWith("::ffff:") ? address.slice(7) : address
}

export const peerSessionTestHelpers = {
  buildSessionTranscript,
  decryptFrame,
  deriveSessionKey,
  encryptChunks,
  encryptFrame,
  exportX25519PublicKey,
  parsePeerResponse,
  parsePeerScanProgressEnvelope,
  readChunkedMessage,
  serializeWireMessage,
}
