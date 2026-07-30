import dgram from "node:dgram"
import { EventEmitter } from "node:events"
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  verify,
  type KeyObject,
} from "node:crypto"
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import net, { type Server, type Socket } from "node:net"
import path from "node:path"
import type {
  DeviceSummary,
  IncomingPairingRequest,
  OutgoingPairingSession,
  PairingCandidate,
  PairingState,
} from "../shared/contracts"

const DISCOVERY_PORT = 47_654
const DEFAULT_PAIRING_PORT = 47_655
const DEFAULT_SESSION_PORT = 47_656
const DISCOVERY_ADDRESS = "255.255.255.255"
const DISCOVERY_INTERVAL_MS = 2_000
const DISCOVERY_STALE_MS = 9_000
const PAIRING_WINDOW_MS = 5 * 60_000
const HANDSHAKE_TIMEOUT_MS = 5 * 60_000
const MAX_PENDING_INCOMING = 5
const PROTOCOL_VERSION = 1

type Platform = "linux" | "windows" | "unknown"

type IdentityRecord = {
  id: string
  name: string
  platform: Platform
  publicKey: string
  privateKey: string
  fingerprint: string
}

type TrustedPeerRecord = {
  id: string
  name: string
  platform: Platform
  publicKey: string
  fingerprint: string
  pairedAt: string
  lastKnownAddress?: string
  pairingPort?: number
  sessionPort?: number
}

type PersistedPairingState = {
  identity: IdentityRecord
  peers: TrustedPeerRecord[]
}

type WireDevice = {
  id: string
  name: string
  platform: Platform
  publicKey: string
  fingerprint: string
}

type DiscoveryBeacon = {
  type: "foldersync-discovery"
  protocol: number
  device: WireDevice
  pairingPort: number
  sessionPort: number
  acceptingPairing: boolean
  sentAt: number
  signature: string
}

type PairRequestMessage = {
  type: "pair-request"
  protocol: number
  sessionId: string
  targetDeviceId: string
  initiatorNonce: string
  device: WireDevice
  signature: string
}

type PairChallengeMessage = {
  type: "pair-challenge"
  protocol: number
  sessionId: string
  requestId: string
  initiatorNonce: string
  responderNonce: string
  device: WireDevice
  signature: string
}

type PairConfirmMessage = {
  type: "pair-confirm"
  protocol: number
  sessionId: string
  requestId: string
  transcriptHash: string
  signature: string
}

type PairApprovedMessage = {
  type: "pair-approved"
  protocol: number
  sessionId: string
  requestId: string
  transcriptHash: string
  device: WireDevice
  signature: string
}

type PairRejectedMessage = {
  type: "pair-rejected"
  protocol: number
  sessionId: string
  requestId?: string
  reason: string
}

type PairErrorMessage = {
  type: "pair-error"
  protocol: number
  reason: string
}

type WireMessage =
  | PairRequestMessage
  | PairChallengeMessage
  | PairConfirmMessage
  | PairApprovedMessage
  | PairRejectedMessage
  | PairErrorMessage

type DiscoveredRuntime = PairingCandidate & {
  publicKey: string
  pairingPort: number
  sessionPort: number
  lastSeenAtMs: number
}

type IncomingRuntime = {
  summary: IncomingPairingRequest
  socket: Socket
  decide: (approved: boolean) => void
}

type OutgoingRuntime = {
  summary: OutgoingPairingSession
  socket: Socket
  confirm: (confirmed: boolean) => void
}


export interface LocalSessionIdentity {
  id: string
  name: string
  platform: Platform
  publicKey: string
  fingerprint: string
}

export interface TrustedPeerSessionInfo {
  id: string
  name: string
  platform: Platform
  publicKey: string
  fingerprint: string
  address?: string
  sessionPort: number
}

export interface PairingServiceOptions {
  dataDirectory: string
  deviceName: string
  platform: Platform
  /** Use 0 for an ephemeral test port; production defaults to TCP 47655. */
  pairingPort?: number
  sessionPort?: number
}

export class PairingService extends EventEmitter {
  readonly #options: PairingServiceOptions
  readonly #storePath: string
  #identity!: IdentityRecord
  #privateKey!: KeyObject
  #peers = new Map<string, TrustedPeerRecord>()
  #discovered = new Map<string, DiscoveredRuntime>()
  #incoming = new Map<string, IncomingRuntime>()
  #outgoing: OutgoingRuntime | null = null
  #udp: dgram.Socket | null = null
  #server: Server | null = null
  #pairingPort = 0
  #acceptingUntil = 0
  #beaconTimer: NodeJS.Timeout | null = null
  #pruneTimer: NodeJS.Timeout | null = null
  #persistQueue: Promise<void> = Promise.resolve()
  #stopped = false

  constructor(options: PairingServiceOptions) {
    super()
    this.#options = options
    this.#storePath = path.join(options.dataDirectory, "pairing-state.json")
  }

  async start(): Promise<void> {
    await this.#loadOrCreateIdentity()
    await this.#startPairingServer()
    await this.#startDiscovery()
    this.#beaconTimer = setInterval(() => this.#sendBeacon(), DISCOVERY_INTERVAL_MS)
    this.#pruneTimer = setInterval(() => this.#pruneDiscovery(), 1_000)
    this.#sendBeacon()
    this.emit("change")
  }

  async stop(): Promise<void> {
    this.#stopped = true
    if (this.#beaconTimer) clearInterval(this.#beaconTimer)
    if (this.#pruneTimer) clearInterval(this.#pruneTimer)
    this.#beaconTimer = null
    this.#pruneTimer = null

    for (const request of this.#incoming.values()) {
      request.decide(false)
      request.socket.destroy()
    }
    this.#incoming.clear()

    if (this.#outgoing) {
      this.#outgoing.confirm(false)
      this.#outgoing.socket.destroy()
      this.#outgoing = null
    }

    this.#udp?.close()
    this.#udp = null
    await new Promise<void>((resolve) => {
      if (!this.#server) {
        resolve()
        return
      }
      this.#server.close(() => resolve())
      this.#server = null
    })
  }

  getState(): PairingState {
    const now = Date.now()
    const outgoingSession = this.#outgoing ? { ...this.#outgoing.summary } : undefined
    return {
      localFingerprint: this.#identity.fingerprint,
      acceptingPairing: this.#acceptingUntil > now,
      acceptingPairingUntil: this.#acceptingUntil > now ? new Date(this.#acceptingUntil).toISOString() : undefined,
      discoveredDevices: [...this.#discovered.values()]
        .filter((device) => device.acceptingPairing && !this.#peers.has(device.id))
        .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))
        .map(({ publicKey: _publicKey, pairingPort: _pairingPort, sessionPort: _sessionPort, lastSeenAtMs: _lastSeenAtMs, ...device }) => device),
      incomingRequests: [...this.#incoming.values()].map((request) => ({ ...request.summary })),
      outgoingSession,
    }
  }

  getTrustedDevices(): DeviceSummary[] {
    const now = Date.now()
    return [...this.#peers.values()].map((peer) => {
      const discovered = this.#discovered.get(peer.id)
      const online = Boolean(discovered && now - discovered.lastSeenAtMs <= DISCOVERY_STALE_MS)
      return {
        id: peer.id,
        name: peer.name,
        platform: peer.platform,
        status: online ? "online" : "offline",
        route: online ? "lan-direct" : "offline",
        address: online ? discovered?.address : undefined,
        lastSeenAt: discovered?.lastSeenAt,
        fingerprint: peer.fingerprint,
        pairedAt: peer.pairedAt,
      }
    })
  }

  getLocalSessionIdentity(): LocalSessionIdentity {
    return { ...this.#wireDevice() }
  }

  getTrustedSessionPeer(deviceId: string): TrustedPeerSessionInfo | undefined {
    const peer = this.#peers.get(deviceId)
    if (!peer) return undefined
    const discovered = this.#discovered.get(deviceId)
    return {
      id: peer.id,
      name: peer.name,
      platform: peer.platform,
      publicKey: peer.publicKey,
      fingerprint: peer.fingerprint,
      address: discovered?.address ?? peer.lastKnownAddress,
      sessionPort: discovered?.sessionPort ?? peer.sessionPort ?? this.#options.sessionPort ?? DEFAULT_SESSION_PORT,
    }
  }

  isTrustedDevice(deviceId: string): boolean {
    return this.#peers.has(deviceId)
  }

  signSessionPayload(kind: string, body: unknown): string {
    return sign(null, Buffer.from(canonicalSessionPayload(kind, body)), this.#privateKey).toString("base64")
  }

  verifyTrustedSessionPayload(deviceId: string, kind: string, body: unknown, signature: string): boolean {
    const peer = this.#peers.get(deviceId)
    if (!peer) return false
    try {
      return verify(
        null,
        Buffer.from(canonicalSessionPayload(kind, body)),
        importPublicKey(peer.publicKey),
        Buffer.from(signature, "base64"),
      )
    } catch {
      return false
    }
  }

  setPairingAvailable(enabled: boolean): void {
    this.#acceptingUntil = enabled ? Date.now() + PAIRING_WINDOW_MS : 0
    this.#sendBeacon()
    this.emit("change")
  }

  startPairing(deviceId: string): void {
    if (this.#outgoing) throw new Error("Another pairing attempt is already active.")
    if (this.#peers.has(deviceId)) throw new Error("This device is already paired.")

    const candidate = this.#discovered.get(deviceId)
    if (!candidate || !candidate.acceptingPairing || Date.now() - candidate.lastSeenAtMs > DISCOVERY_STALE_MS) {
      throw new Error("That computer is no longer available for pairing.")
    }

    const socket = net.createConnection({ host: candidate.address, port: candidate.pairingPort })
    const summary: OutgoingPairingSession = {
      id: randomUUID(),
      device: publicCandidate(candidate),
      status: "connecting",
      createdAt: new Date().toISOString(),
    }

    let confirmPairing!: (confirmed: boolean) => void
    const confirmation = new Promise<boolean>((resolve) => {
      confirmPairing = resolve
    })

    this.#outgoing = { summary, socket, confirm: confirmPairing }
    socket.once("close", () => {
      if (this.#outgoing?.summary.id !== summary.id || summary.status !== "confirm-code") return
      summary.status = "rejected"
      summary.message = "The other computer declined the request or closed the pairing connection."
      this.#outgoing.confirm(false)
      this.emit("change")
    })
    this.emit("change")
    void this.#runOutgoingPairing(candidate, socket, confirmation)
  }

  confirmPairing(sessionId: string): void {
    if (!this.#outgoing || this.#outgoing.summary.id !== sessionId) {
      throw new Error("The pairing session is no longer active.")
    }
    if (this.#outgoing.summary.status !== "confirm-code") {
      throw new Error("The comparison code is not ready to confirm.")
    }
    this.#outgoing.confirm(true)
  }

  cancelPairing(sessionId: string): void {
    if (!this.#outgoing || this.#outgoing.summary.id !== sessionId) return
    this.#outgoing.confirm(false)
    this.#outgoing.socket.destroy()
    this.#outgoing = null
    this.emit("change")
  }

  approvePairing(requestId: string): void {
    const request = this.#incoming.get(requestId)
    if (!request) throw new Error("The pairing request is no longer active.")
    if (request.summary.status !== "ready-for-approval") {
      throw new Error("Wait for the other computer to confirm the comparison code.")
    }
    request.decide(true)
  }

  rejectPairing(requestId: string): void {
    const request = this.#incoming.get(requestId)
    if (!request) return
    request.decide(false)
    const rejection: PairRejectedMessage = {
      type: "pair-rejected",
      protocol: PROTOCOL_VERSION,
      sessionId: request.summary.sessionId,
      requestId,
      reason: "Pairing was declined on the other computer.",
    }
    if (!request.socket.destroyed) request.socket.end(`${JSON.stringify(rejection)}
`)
    this.#incoming.delete(requestId)
    this.emit("change")
  }

  async revokeDevice(deviceId: string): Promise<void> {
    const peer = this.#peers.get(deviceId)
    if (!peer) return
    this.#peers.delete(deviceId)
    await this.#persist()
    this.emit("revoked", peer)
    this.emit("change")
  }

  async #runOutgoingPairing(
    candidate: DiscoveredRuntime,
    socket: Socket,
    confirmation: Promise<boolean>,
  ): Promise<void> {
    const connection = new JsonLineConnection(socket)
    const session = this.#outgoing?.summary
    if (!session) return

    try {
      try {
        await waitForConnect(socket, 10_000)
      } catch {
        throw new Error(
          `Could not connect to ${candidate.address}:${candidate.pairingPort}. ` +
            `Make sure FolderSync is open on the other computer and allow TCP ${candidate.pairingPort} on private/LAN networks.`,
        )
      }
      const initiatorNonce = randomBytes(32).toString("base64url")
      const requestBody = {
        protocol: PROTOCOL_VERSION,
        sessionId: session.id,
        targetDeviceId: candidate.id,
        initiatorNonce,
        device: this.#wireDevice(),
      }
      const request: PairRequestMessage = {
        type: "pair-request",
        ...requestBody,
        signature: this.#sign("pair-request", requestBody),
      }
      connection.write(request)

      const challenge = await connection.read(HANDSHAKE_TIMEOUT_MS)
      if (challenge.type === "pair-error" || challenge.type === "pair-rejected") {
        throw new Error(challenge.reason)
      }
      if (challenge.type !== "pair-challenge") throw new Error("The other computer sent an invalid pairing response.")
      if (challenge.device.id !== candidate.id || challenge.device.publicKey !== candidate.publicKey) {
        throw new Error("The discovered device identity changed during pairing.")
      }
      verifyWireDevice(challenge.device)
      const challengeBody = {
        protocol: challenge.protocol,
        sessionId: challenge.sessionId,
        requestId: challenge.requestId,
        initiatorNonce: challenge.initiatorNonce,
        responderNonce: challenge.responderNonce,
        device: challenge.device,
      }
      if (!verifyPayload(challenge.device.publicKey, "pair-challenge", challengeBody, challenge.signature)) {
        throw new Error("The pairing challenge signature is invalid.")
      }
      if (challenge.sessionId !== session.id || challenge.initiatorNonce !== initiatorNonce) {
        throw new Error("The pairing challenge did not match this session.")
      }

      const transcriptHash = buildTranscriptHash(
        session.id,
        this.#identity.publicKey,
        candidate.publicKey,
        initiatorNonce,
        challenge.responderNonce,
      )
      session.comparisonCode = comparisonCode(transcriptHash)
      session.status = "confirm-code"
      session.message = "Compare this code on both computers before continuing."
      this.emit("change")

      const confirmed = await confirmation
      if (!confirmed) {
        if ((session.status as string) !== "rejected" && (session.status as string) !== "failed") {
          session.status = "cancelled"
          session.message = "Pairing was cancelled on this computer."
        }
        connection.close()
        this.emit("change")
        return
      }

      const confirmBody = {
        protocol: PROTOCOL_VERSION,
        sessionId: session.id,
        requestId: challenge.requestId,
        transcriptHash,
      }
      const confirm: PairConfirmMessage = {
        type: "pair-confirm",
        ...confirmBody,
        signature: this.#sign("pair-confirm", confirmBody),
      }
      connection.write(confirm)
      session.status = "waiting-for-approval"
      session.message = `Waiting for approval on ${candidate.name}.`
      this.emit("change")

      const response = await connection.read(HANDSHAKE_TIMEOUT_MS)
      if (response.type === "pair-rejected" || response.type === "pair-error") {
        session.status = "rejected"
        session.message = response.reason
        this.emit("change")
        return
      }
      if (response.type !== "pair-approved") throw new Error("The other computer sent an invalid approval response.")
      if (response.sessionId !== session.id || response.transcriptHash !== transcriptHash) {
        throw new Error("The approval response did not match this pairing session.")
      }
      verifyWireDevice(response.device)
      const approvedBody = {
        protocol: response.protocol,
        sessionId: response.sessionId,
        requestId: response.requestId,
        transcriptHash: response.transcriptHash,
        device: response.device,
      }
      if (!verifyPayload(response.device.publicKey, "pair-approved", approvedBody, response.signature)) {
        throw new Error("The pairing approval signature is invalid.")
      }

      await this.#trustPeer(response.device, {
        address: candidate.address,
        pairingPort: candidate.pairingPort,
        sessionPort: candidate.sessionPort,
      })
      this.#rememberDiscoveredDevice(response.device, candidate.address, candidate.pairingPort, candidate.sessionPort, false)
      this.#sendBeacon()
      session.status = "paired"
      session.message = `${response.device.name} is now trusted.`
      this.#acceptingUntil = 0
      this.emit("paired", response.device)
      this.emit("change")
    } catch (error) {
      if (this.#outgoing?.summary.id === session.id) {
        session.status = "failed"
        session.message = error instanceof Error ? error.message : "Pairing failed."
        this.emit("change")
      }
    } finally {
      connection.close()
    }
  }

  async #handleIncomingSocket(socket: Socket): Promise<void> {
    const connection = new JsonLineConnection(socket)
    let requestId: string | undefined

    try {
      const first = await connection.read(10_000)
      if (first.type !== "pair-request") {
        connection.write({ type: "pair-error", protocol: PROTOCOL_VERSION, reason: "Expected a pairing request." })
        return
      }
      if (!this.#isAcceptingPairing()) {
        connection.write({ type: "pair-rejected", protocol: PROTOCOL_VERSION, sessionId: first.sessionId, reason: "This computer is not currently accepting pairing requests." })
        return
      }
      if (this.#incoming.size >= MAX_PENDING_INCOMING) {
        connection.write({ type: "pair-rejected", protocol: PROTOCOL_VERSION, sessionId: first.sessionId, reason: "Too many pairing requests are pending." })
        return
      }
      if (first.targetDeviceId !== this.#identity.id) throw new Error("The pairing request was addressed to another device.")
      verifyWireDevice(first.device)
      const requestBody = {
        protocol: first.protocol,
        sessionId: first.sessionId,
        targetDeviceId: first.targetDeviceId,
        initiatorNonce: first.initiatorNonce,
        device: first.device,
      }
      if (!verifyPayload(first.device.publicKey, "pair-request", requestBody, first.signature)) {
        throw new Error("The pairing request signature is invalid.")
      }
      if (this.#peers.has(first.device.id)) {
        connection.write({ type: "pair-rejected", protocol: PROTOCOL_VERSION, sessionId: first.sessionId, reason: "These computers are already paired." })
        return
      }

      const responderNonce = randomBytes(32).toString("base64url")
      const generatedRequestId = randomUUID()
      requestId = generatedRequestId
      const transcriptHash = buildTranscriptHash(
        first.sessionId,
        first.device.publicKey,
        this.#identity.publicKey,
        first.initiatorNonce,
        responderNonce,
      )
      const candidate: PairingCandidate = {
        id: first.device.id,
        name: first.device.name,
        platform: first.device.platform,
        address: normalizeRemoteAddress(socket.remoteAddress),
        fingerprint: first.device.fingerprint,
        lastSeenAt: new Date().toISOString(),
        acceptingPairing: true,
      }
      const summary: IncomingPairingRequest = {
        id: generatedRequestId,
        sessionId: first.sessionId,
        device: candidate,
        comparisonCode: comparisonCode(transcriptHash),
        status: "waiting-for-peer",
        createdAt: new Date().toISOString(),
      }

      let decide!: (approved: boolean) => void
      const decision = new Promise<boolean>((resolve) => {
        decide = resolve
      })
      this.#incoming.set(generatedRequestId, { summary, socket, decide })

      const challengeBody = {
        protocol: PROTOCOL_VERSION,
        sessionId: first.sessionId,
        requestId: generatedRequestId,
        initiatorNonce: first.initiatorNonce,
        responderNonce,
        device: this.#wireDevice(),
      }
      const challenge: PairChallengeMessage = {
        type: "pair-challenge",
        ...challengeBody,
        signature: this.#sign("pair-challenge", challengeBody),
      }
      connection.write(challenge)
      this.emit("incoming", summary)
      this.emit("change")

      const confirm = await connection.read(HANDSHAKE_TIMEOUT_MS)
      if (confirm.type !== "pair-confirm") throw new Error("The other computer did not confirm the comparison code.")
      if (
        confirm.sessionId !== first.sessionId ||
        confirm.requestId !== generatedRequestId ||
        confirm.transcriptHash !== transcriptHash
      ) {
        throw new Error("The pairing confirmation did not match this session.")
      }
      const confirmBody = {
        protocol: confirm.protocol,
        sessionId: confirm.sessionId,
        requestId: confirm.requestId,
        transcriptHash: confirm.transcriptHash,
      }
      if (!verifyPayload(first.device.publicKey, "pair-confirm", confirmBody, confirm.signature)) {
        throw new Error("The pairing confirmation signature is invalid.")
      }

      summary.status = "ready-for-approval"
      this.emit("change")
      const approved = await withTimeout(decision, HANDSHAKE_TIMEOUT_MS, false)
      if (!approved) {
        connection.write({
          type: "pair-rejected",
          protocol: PROTOCOL_VERSION,
          sessionId: first.sessionId,
          requestId: generatedRequestId,
          reason: "Pairing was declined on the other computer.",
        })
        return
      }

      const remoteAddress = normalizeRemoteAddress(socket.remoteAddress)
      await this.#trustPeer(first.device, {
        address: remoteAddress,
        pairingPort: DEFAULT_PAIRING_PORT,
        sessionPort: DEFAULT_SESSION_PORT,
      })
      this.#rememberDiscoveredDevice(first.device, remoteAddress, DEFAULT_PAIRING_PORT, DEFAULT_SESSION_PORT, false)
      this.#sendBeacon()
      const approvedBody = {
        protocol: PROTOCOL_VERSION,
        sessionId: first.sessionId,
        requestId: generatedRequestId,
        transcriptHash,
        device: this.#wireDevice(),
      }
      const response: PairApprovedMessage = {
        type: "pair-approved",
        ...approvedBody,
        signature: this.#sign("pair-approved", approvedBody),
      }
      connection.write(response)
      this.#acceptingUntil = 0
      this.emit("paired", first.device)
      this.emit("change")
    } catch (error) {
      try {
        connection.write({
          type: "pair-error",
          protocol: PROTOCOL_VERSION,
          reason: error instanceof Error ? error.message : "Pairing failed.",
        })
      } catch {
        // The connection may already be closed.
      }
    } finally {
      if (requestId) this.#incoming.delete(requestId)
      connection.close()
      this.emit("change")
    }
  }

  async #loadOrCreateIdentity(): Promise<void> {
    await mkdir(this.#options.dataDirectory, { recursive: true })
    try {
      const parsed = JSON.parse(await readFile(this.#storePath, "utf8")) as PersistedPairingState
      validateIdentity(parsed.identity)
      this.#identity = {
        ...parsed.identity,
        name: this.#options.deviceName,
        platform: this.#options.platform,
      }
      this.#privateKey = importPrivateKey(this.#identity.privateKey)
      this.#peers = new Map((parsed.peers ?? []).map((peer) => [peer.id, peer]))
      await this.#persist()
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(
          `Unable to load the saved device identity: ${error instanceof Error ? error.message : "invalid identity file"}`,
        )
      }
    }

    const { publicKey, privateKey } = generateKeyPairSync("ed25519")
    const publicKeyDer = publicKey.export({ format: "der", type: "spki" }).toString("base64")
    const privateKeyDer = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")
    this.#identity = {
      id: deviceId(publicKeyDer),
      name: this.#options.deviceName,
      platform: this.#options.platform,
      publicKey: publicKeyDer,
      privateKey: privateKeyDer,
      fingerprint: fingerprint(publicKeyDer),
    }
    this.#privateKey = privateKey
    this.#peers.clear()
    await this.#persist()
  }

  async #persist(): Promise<void> {
    const data: PersistedPairingState = {
      identity: this.#identity,
      peers: [...this.#peers.values()],
    }
    const serialized = `${JSON.stringify(data, null, 2)}\n`
    const previous = this.#persistQueue.catch(() => undefined)
    const next = previous.then(async () => {
      await writeFile(this.#storePath, serialized, { encoding: "utf8", mode: 0o600 })
      if (process.platform !== "win32") await chmod(this.#storePath, 0o600)
    })
    this.#persistQueue = next
    await next
  }

  async #trustPeer(
    device: WireDevice,
    route?: { address?: string; pairingPort?: number; sessionPort?: number },
  ): Promise<void> {
    verifyWireDevice(device)
    const existing = this.#peers.get(device.id)
    if (existing && existing.publicKey !== device.publicKey) {
      throw new Error("A trusted device with this ID has a different public key.")
    }
    const routeAddress = usableIPv4Address(route?.address) ?? existing?.lastKnownAddress
    this.#peers.set(device.id, {
      id: device.id,
      name: device.name,
      platform: device.platform,
      publicKey: device.publicKey,
      fingerprint: device.fingerprint,
      pairedAt: existing?.pairedAt ?? new Date().toISOString(),
      lastKnownAddress: routeAddress,
      pairingPort: route?.pairingPort ?? existing?.pairingPort,
      sessionPort: route?.sessionPort ?? existing?.sessionPort ?? this.#options.sessionPort ?? DEFAULT_SESSION_PORT,
    })
    await this.#persist()
  }

  async #startPairingServer(): Promise<void> {
    this.#server = net.createServer((socket) => {
      socket.setNoDelay(true)
      void this.#handleIncomingSocket(socket)
    })
    this.#server.on("error", (error) => {
      console.error("Pairing server error", error)
      this.emit("error-state", error)
    })
    await new Promise<void>((resolve, reject) => {
      const server = this.#server
      if (!server) return reject(new Error("Pairing server was not created."))
      server.once("error", reject)
      const requestedPort = this.#options.pairingPort ?? DEFAULT_PAIRING_PORT
      server.listen(requestedPort, "0.0.0.0", () => {
        server.off("error", reject)
        const address = server.address()
        if (!address || typeof address === "string") return reject(new Error("Unable to determine pairing port."))
        this.#pairingPort = address.port
        resolve()
      })
    })
  }

  async #startDiscovery(): Promise<void> {
    this.#udp = dgram.createSocket({ type: "udp4", reuseAddr: true })
    this.#udp.on("message", (message, remote) => this.#handleBeacon(message, remote.address))
    this.#udp.on("error", (error) => {
      console.error("LAN discovery error", error)
      this.emit("error-state", error)
    })
    await new Promise<void>((resolve, reject) => {
      const udp = this.#udp
      if (!udp) return reject(new Error("Discovery socket was not created."))
      udp.once("error", reject)
      udp.bind(DISCOVERY_PORT, "0.0.0.0", () => {
        udp.off("error", reject)
        udp.setBroadcast(true)
        resolve()
      })
    })
  }

  #sendBeacon(): void {
    if (!this.#udp || this.#stopped || this.#pairingPort === 0) return
    const acceptingPairing = this.#isAcceptingPairing()
    const device = this.#wireDevice(acceptingPairing)
    const body = {
      protocol: PROTOCOL_VERSION,
      device,
      pairingPort: this.#pairingPort,
      sessionPort: this.#options.sessionPort ?? DEFAULT_SESSION_PORT,
      acceptingPairing,
      sentAt: Date.now(),
    }
    const beacon: DiscoveryBeacon = {
      type: "foldersync-discovery",
      ...body,
      signature: this.#sign("foldersync-discovery", body),
    }
    const payload = Buffer.from(JSON.stringify(beacon), "utf8")
    const targets = discoveryTargets(
      ...[...this.#discovered.values()].map((device) => device.address),
      ...[...this.#peers.values()].map((peer) => peer.lastKnownAddress),
    )
    for (const target of targets) {
      this.#udp.send(payload, DISCOVERY_PORT, target, (error) => {
        if (error && !this.#stopped) {
          console.warn(`Unable to send LAN discovery beacon to ${target}`, error.message)
        }
      })
    }
  }

  #handleBeacon(message: Buffer, address: string): void {
    let beacon: DiscoveryBeacon
    try {
      beacon = JSON.parse(message.toString("utf8")) as DiscoveryBeacon
      if (beacon.type !== "foldersync-discovery" || beacon.protocol !== PROTOCOL_VERSION) return
      if (beacon.device.id === this.#identity.id) return
      if (Math.abs(Date.now() - beacon.sentAt) > 60_000) return
      verifyWireDevice(beacon.device)
      const body = {
        protocol: beacon.protocol,
        device: beacon.device,
        pairingPort: beacon.pairingPort,
        sessionPort: beacon.sessionPort ?? DEFAULT_SESSION_PORT,
        acceptingPairing: beacon.acceptingPairing,
        sentAt: beacon.sentAt,
      }
      if (!verifyPayload(beacon.device.publicKey, "foldersync-discovery", body, beacon.signature)) return
    } catch {
      return
    }

    const trustedPeer = this.#peers.get(beacon.device.id)
    if (trustedPeer && trustedPeer.publicKey !== beacon.device.publicKey) return

    this.#rememberDiscoveredDevice(
      beacon.device,
      address,
      beacon.pairingPort,
      beacon.sessionPort ?? DEFAULT_SESSION_PORT,
      beacon.acceptingPairing,
    )
    this.emit("change")
  }

  #rememberDiscoveredDevice(
    device: WireDevice,
    address: string | undefined,
    pairingPort: number,
    sessionPort: number,
    acceptingPairing: boolean,
  ): void {
    const normalizedAddress = usableIPv4Address(address)
    if (!normalizedAddress) return

    const now = Date.now()
    const existing = this.#discovered.get(device.id)
    this.#discovered.set(device.id, {
      id: device.id,
      name: device.name || this.#peers.get(device.id)?.name || existing?.name || "Nearby computer",
      platform: device.platform,
      address: normalizedAddress,
      fingerprint: device.fingerprint,
      lastSeenAt: new Date(now).toISOString(),
      acceptingPairing,
      publicKey: device.publicKey,
      pairingPort,
      sessionPort,
      lastSeenAtMs: now,
    })

    const trustedPeer = this.#peers.get(device.id)
    if (
      trustedPeer &&
      trustedPeer.publicKey === device.publicKey &&
      (trustedPeer.lastKnownAddress !== normalizedAddress || trustedPeer.pairingPort !== pairingPort || trustedPeer.sessionPort !== sessionPort)
    ) {
      trustedPeer.lastKnownAddress = normalizedAddress
      trustedPeer.pairingPort = pairingPort
      trustedPeer.sessionPort = sessionPort
      void this.#persist().catch((error) => {
        console.warn("Unable to persist the trusted device LAN route", error)
      })
    }
  }

  #pruneDiscovery(): void {
    const now = Date.now()
    let changed = false
    for (const [id, device] of this.#discovered) {
      if (now - device.lastSeenAtMs > DISCOVERY_STALE_MS) {
        this.#discovered.delete(id)
        changed = true
      }
    }
    if (this.#acceptingUntil > 0 && this.#acceptingUntil <= now) {
      this.#acceptingUntil = 0
      changed = true
      this.#sendBeacon()
    }
    if (changed) this.emit("change")
  }

  #isAcceptingPairing(): boolean {
    return this.#acceptingUntil > Date.now()
  }

  #wireDevice(includeName = true): WireDevice {
    return {
      id: this.#identity.id,
      name: includeName ? this.#identity.name : "",
      platform: this.#identity.platform,
      publicKey: this.#identity.publicKey,
      fingerprint: this.#identity.fingerprint,
    }
  }

  #sign(kind: string, body: unknown): string {
    return sign(null, Buffer.from(canonicalPayload(kind, body)), this.#privateKey).toString("base64")
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
    socket.on("close", () => this.#closeWithError(new Error("The pairing connection closed.")))
  }

  write(message: WireMessage): void {
    if (this.#socket.destroyed) throw new Error("The pairing connection is closed.")
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
        reject(new Error("The pairing request timed out."))
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
        this.#closeWithError(new Error("The other computer sent invalid pairing data."))
      }
    }
  }

  #closeWithError(error: Error): void {
    if (this.#closedError) return
    this.#closedError = error
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error)
  }
}

function waitForConnect(socket: Socket, timeoutMs: number): Promise<void> {
  if (!socket.connecting) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      socket.destroy()
      reject(new Error("Could not connect to the other computer."))
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

function publicCandidate(device: DiscoveredRuntime): PairingCandidate {
  return {
    id: device.id,
    name: device.name,
    platform: device.platform,
    address: device.address,
    fingerprint: device.fingerprint,
    lastSeenAt: device.lastSeenAt,
    acceptingPairing: device.acceptingPairing,
  }
}

function canonicalPayload(kind: string, body: unknown): string {
  return JSON.stringify(["foldersync-pairing-v1", kind, body])
}

function canonicalSessionPayload(kind: string, body: unknown): string {
  return JSON.stringify(["foldersync-session-auth-v1", kind, body])
}

function verifyPayload(publicKey: string, kind: string, body: unknown, signature: string): boolean {
  try {
    return verify(
      null,
      Buffer.from(canonicalPayload(kind, body)),
      importPublicKey(publicKey),
      Buffer.from(signature, "base64"),
    )
  } catch {
    return false
  }
}

function importPublicKey(publicKey: string): KeyObject {
  return createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" })
}

function importPrivateKey(privateKey: string): KeyObject {
  return createPrivateKey({ key: Buffer.from(privateKey, "base64"), format: "der", type: "pkcs8" })
}

function deviceId(publicKey: string): string {
  return createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("hex").slice(0, 32)
}

function fingerprint(publicKey: string): string {
  const digest = createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("hex").slice(0, 20).toUpperCase()
  return digest.match(/.{1,4}/g)?.join(" ") ?? digest
}

function verifyWireDevice(device: WireDevice): void {
  if (!device.id || !device.publicKey || !device.fingerprint) throw new Error("The device identity is incomplete.")
  if (deviceId(device.publicKey) !== device.id || fingerprint(device.publicKey) !== device.fingerprint) {
    throw new Error("The device identity fingerprint is invalid.")
  }
  importPublicKey(device.publicKey)
}

function validateIdentity(identity: IdentityRecord): void {
  verifyWireDevice(identity)
  importPrivateKey(identity.privateKey)
}

function buildTranscriptHash(
  sessionId: string,
  initiatorPublicKey: string,
  responderPublicKey: string,
  initiatorNonce: string,
  responderNonce: string,
): string {
  return createHash("sha256")
    .update("foldersync-pairing-transcript-v1\0")
    .update(sessionId)
    .update("\0")
    .update(initiatorPublicKey)
    .update("\0")
    .update(responderPublicKey)
    .update("\0")
    .update(initiatorNonce)
    .update("\0")
    .update(responderNonce)
    .digest("hex")
}

function comparisonCode(transcriptHash: string): string {
  const value = Number.parseInt(transcriptHash.slice(0, 12), 16) % 1_000_000
  const code = value.toString().padStart(6, "0")
  return `${code.slice(0, 3)} ${code.slice(3)}`
}

function usableIPv4Address(address?: string): string | undefined {
  if (!address) return undefined
  const normalized = normalizeRemoteAddress(address)
  if (net.isIP(normalized) !== 4 || normalized === "0.0.0.0" || normalized === DISCOVERY_ADDRESS) {
    return undefined
  }
  return normalized
}

function discoveryTargets(...addresses: Array<string | undefined>): string[] {
  const targets = new Set<string>([DISCOVERY_ADDRESS])
  for (const address of addresses) {
    const normalized = usableIPv4Address(address)
    if (normalized) targets.add(normalized)
  }
  return [...targets]
}

function normalizeRemoteAddress(address?: string): string {
  if (!address) return "Unknown address"
  return address.startsWith("::ffff:") ? address.slice(7) : address
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => resolve(fallback), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timeout)
        resolve(value)
      },
      (error) => {
        clearTimeout(timeout)
        reject(error)
      },
    )
  })
}

export const pairingTestHelpers = {
  buildTranscriptHash,
  comparisonCode,
  deviceId,
  discoveryTargets,
  fingerprint,
}
