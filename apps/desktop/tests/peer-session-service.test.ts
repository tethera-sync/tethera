import { describe, expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { peerSessionTestHelpers } from "../src/main/peer-session-service"

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
})
