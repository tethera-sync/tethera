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
const PROTOCOL_VERSION = 1
const CONNECT_TIMEOUT_MS = 10_000
const REQUEST_TIMEOUT_MS = 45_000
const CLOCK_SKEW_MS = 2 * 60_000
const MAX_LINE_BYTES = 16 * 1024 * 1024

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
}

export interface PeerSessionServiceOptions {
  pairing: PairingService
  onRequest: (context: PeerRequestContext, request: PeerRequest) => Promise<unknown>
  port?: number
}

export class PeerSessionService extends EventEmitter {
  readonly #options: PeerSessionServiceOptions
  #server: Server | null = null
  #port = 0
  #stopped = false
  #recentSessions = new Map<string, number>()

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

  async stop(): Promise<void> {
    this.#stopped = true
    await new Promise<void>((resolve) => {
      if (!this.#server) return resolve()
      this.#server.close(() => resolve())
      this.#server = null
    })
  }

  async request<T = unknown>(deviceId: string, request: PeerRequest, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    const peer = this.#options.pairing.getTrustedSessionPeer(deviceId)
    if (!peer) throw new Error("This computer is not trusted.")
    if (!peer.address) throw new Error(`${peer.name} is offline or has no known LAN address.`)

    const local = this.#options.pairing.getLocalSessionIdentity()
    const socket = net.createConnection({ host: peer.address, port: peer.sessionPort })
    const connection = new JsonLineConnection(socket)

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
      const response = decryptFrame<PeerResponse>(key, sessionId, "response", responseFrame)
      if (!response.ok) throw new Error(response.error)
      return response.result as T
    } finally {
      connection.close()
    }
  }

  async #handleIncoming(socket: Socket): Promise<void> {
    const connection = new JsonLineConnection(socket)
    try {
      const first = await connection.read(CONNECT_TIMEOUT_MS)
      if (first.type !== "session-hello") {
        connection.write({ type: "session-error", protocol: PROTOCOL_VERSION, reason: "Expected a secure-session hello." })
        return
      }
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
      const frame = await connection.read(REQUEST_TIMEOUT_MS)
      if (frame.type !== "secure-frame") throw new Error("Expected an encrypted peer request.")
      const request = decryptFrame<PeerRequest>(key, first.sessionId, "request", frame)
      const context: PeerRequestContext = {
        peerId: peer.id,
        peerName: peer.name,
        remoteAddress: normalizeRemoteAddress(socket.remoteAddress),
      }

      let response: PeerResponse
      try {
        response = { ok: true, result: await this.#options.onRequest(context, request) }
      } catch (error) {
        response = { ok: false, error: error instanceof Error ? error.message : "The peer request failed." }
      }
      connection.write(encryptFrame(key, first.sessionId, frame.requestId, "response", response))
    } catch (error) {
      try {
        connection.write({
          type: "session-error",
          protocol: PROTOCOL_VERSION,
          reason: error instanceof Error ? error.message : "The secure peer session failed.",
        })
      } catch {
        // The connection may already be closed.
      }
    } finally {
      connection.close()
    }
  }

  #pruneRecentSessions(): void {
    const cutoff = Date.now() - CLOCK_SKEW_MS
    for (const [sessionId, seenAt] of this.#recentSessions) {
      if (seenAt < cutoff) this.#recentSessions.delete(sessionId)
    }
  }
}

class JsonLineConnection {
  readonly #socket: Socket
  #buffer = ""
  #queue: WireMessage[] = []
  #waiters: Array<{ resolve: (message: WireMessage) => void; reject: (error: Error) => void }> = []
  #closedError: Error | null = null

  constructor(socket: Socket) {
    this.#socket = socket
    socket.setEncoding("utf8")
    socket.on("data", (chunk: Buffer | string) => this.#onData(typeof chunk === "string" ? chunk : chunk.toString("utf8")))
    socket.on("error", (error) => this.#closeWithError(error))
    socket.on("close", () => this.#closeWithError(new Error("The secure peer connection closed.")))
  }

  write(message: WireMessage): void {
    if (this.#socket.destroyed) throw new Error("The secure peer connection is closed.")
    this.#socket.write(`${JSON.stringify(message)}\n`)
  }

  async read(timeoutMs: number): Promise<WireMessage> {
    if (this.#queue.length > 0) return this.#queue.shift() as WireMessage
    if (this.#closedError) throw this.#closedError
    return await new Promise<WireMessage>((resolve, reject) => {
      const waiter = { resolve, reject }
      this.#waiters.push(waiter)
      const timeout = setTimeout(() => {
        const index = this.#waiters.indexOf(waiter)
        if (index >= 0) this.#waiters.splice(index, 1)
        reject(new Error("The secure peer request timed out."))
      }, timeoutMs)
      waiter.resolve = (message) => {
        clearTimeout(timeout)
        resolve(message)
      }
      waiter.reject = (error) => {
        clearTimeout(timeout)
        reject(error)
      }
    })
  }

  close(): void {
    if (!this.#socket.destroyed) this.#socket.destroy()
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
        else this.#queue.push(message)
      } catch {
        this.#closeWithError(new Error("The peer sent invalid session data."))
      }
    }
  }

  #closeWithError(error: Error): void {
    if (this.#closedError) return
    this.#closedError = error
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error)
  }
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
}
