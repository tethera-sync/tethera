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

type WireMessage = SessionHello | SessionWelcome | SessionError | SecureFrame

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
}

export interface PeerRequestOptions {
  signal?: AbortSignal | null
}

export interface PeerSessionServiceOptions {
  pairing: Pick<
    PairingService,
    "getLocalSessionIdentity" | "getTrustedSessionPeer" | "signSessionPayload" | "verifyTrustedSessionPayload"
  >
  onRequest: (context: PeerRequestContext, request: PeerRequest) => Promise<unknown>
  port?: number
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

      const welcome = await connection.read(timeoutMs)
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
      connection.write(encryptFrame(key, sessionId, requestId, "request", request))
      const responseFrame = await connection.read(timeoutMs)
      if (responseFrame.type === "session-error") throw new Error(responseFrame.reason)
      if (responseFrame.type !== "secure-frame" || responseFrame.requestId !== requestId) {
        throw new Error("The peer returned an invalid encrypted response.")
      }
      const response = parsePeerResponse(decryptFrame<unknown>(key, sessionId, "response", responseFrame))
      if (!response.ok) throw new Error(response.error)
      return response.result as T
    } catch (error) {
      if (options.signal?.aborted) throw new Error("The peer request was cancelled.")
      throw error
    } finally {
      options.signal?.removeEventListener("abort", abortOnCancel)
      connection.close()
    }
  }

  async #handleIncoming(socket: Socket): Promise<void> {
    const connection = new JsonLineConnection(socket)
    const handlerController = new AbortController()
    const abortHandler = (): void => {
      connection.close()
    }
    socket.once("close", abortHandler)
    let sessionId: string | undefined
    let requestId: string | undefined
    let peerIdForLog: string | undefined
    let authenticatedPeerId: string | undefined
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
      if (frame.type !== "secure-frame") throw new Error("Expected an encrypted peer request.")
      requestId = safeCorrelationId(frame.requestId)
      const request = decryptFrame<PeerRequest>(key, first.sessionId, "request", frame)
      const context: PeerRequestContext = {
        peerId: peer.id,
        peerName: peer.name,
        remoteAddress: normalizeRemoteAddress(socket.remoteAddress),
        requestId,
        signal: handlerController.signal,
      }

      let response: PeerResponse
      try {
        response = { ok: true, result: await this.#options.onRequest(context, request) }
      } catch (error) {
        const detail = boundedPeerError(error, "The peer request failed.")
        console.warn("[peer-session] peer request failed", {
          operation: safeOperationName(request.type),
          peerId: context.peerId,
          requestId: context.requestId,
          error: safeErrorDiagnostic(error),
        })
        response = { ok: false, error: detail }
      }
      await connection.end(encryptFrame(key, first.sessionId, frame.requestId, "response", response))
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
      handlerController.abort()
      socket.off("close", abortHandler)
      if (authenticatedPeerId) this.#endAuthenticatedSession(authenticatedPeerId)
      connection.close()
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
  if (response.ok === true) return { ok: true, result: response.result }
  if (response.ok === false && typeof response.error === "string" && response.error.length <= 512) {
    return { ok: false, error: response.error.replaceAll("\0", "") }
  }
  throw new Error("The peer returned an invalid response.")
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
    socket.on("error", (error) => this.#closeWithError(error))
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

function decryptFrame<T>(
  key: Buffer,
  sessionId: string,
  direction: "request" | "response",
  frame: SecureFrame,
): T {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(frame.iv, "base64"))
  decipher.setAAD(Buffer.from(`${sessionId}\0${frame.requestId}\0${direction}`))
  decipher.setAuthTag(Buffer.from(frame.tag, "base64"))
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(frame.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8")
  return JSON.parse(plaintext) as T
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
  encryptFrame,
  exportX25519PublicKey,
  parsePeerResponse,
}
