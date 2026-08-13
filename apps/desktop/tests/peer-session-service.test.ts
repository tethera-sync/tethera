import { describe, expect, test } from "bun:test"
import { createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto"
import type { PairingService } from "../src/main/pairing-service"
import { PeerSessionService, peerSessionTestHelpers } from "../src/main/peer-session-service"

const LARGE_RESPONSE_BYTES = 8 * 1024 * 1024

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

  test("bounds and validates peer error responses", () => {
    expect(peerSessionTestHelpers.parsePeerResponse({ ok: false, error: "retry" })).toEqual({ ok: false, error: "retry" })
    expect(() => peerSessionTestHelpers.parsePeerResponse({ ok: false, error: "x".repeat(513) })).toThrow("invalid")
    expect(() => peerSessionTestHelpers.parsePeerResponse({ ok: "yes", result: true })).toThrow("invalid")
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
})
