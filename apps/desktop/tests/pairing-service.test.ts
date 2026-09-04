import { describe, expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { pairingTestHelpers } from "../src/main/pairing-service"

function publicKey(): string {
  return generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64")
}

describe("pairing identity helpers", () => {
  test("a public key has a stable device id and fingerprint", () => {
    const key = publicKey()
    expect(pairingTestHelpers.deviceId(key)).toHaveLength(32)
    expect(pairingTestHelpers.deviceId(key)).toBe(pairingTestHelpers.deviceId(key))
    expect(pairingTestHelpers.fingerprint(key)).toMatch(/^[0-9A-F]{4}( [0-9A-F]{4}){4}$/)
  })

  test("the transcript binds identities, nonces, and roles to the comparison code", () => {
    const initiator = publicKey()
    const responder = publicKey()
    const baseline = pairingTestHelpers.buildTranscriptHash(
      "session-1",
      initiator,
      responder,
      "initiator-nonce",
      "responder-nonce",
    )
    expect(pairingTestHelpers.comparisonCode(baseline)).toMatch(/^\d{3} \d{3}$/)

    // Any change to the bound inputs must change what both computers display.
    const variants = [
      pairingTestHelpers.buildTranscriptHash("session-1", publicKey(), responder, "initiator-nonce", "responder-nonce"),
      pairingTestHelpers.buildTranscriptHash("session-1", initiator, publicKey(), "initiator-nonce", "responder-nonce"),
      pairingTestHelpers.buildTranscriptHash("session-1", initiator, responder, "other-nonce", "responder-nonce"),
      pairingTestHelpers.buildTranscriptHash("session-1", responder, initiator, "initiator-nonce", "responder-nonce"),
    ]
    for (const variant of variants) {
      expect(variant).not.toBe(baseline)
    }
  })

  test("presence beacons are also sent directly to known peer addresses", () => {
    expect(
      pairingTestHelpers.discoveryTargets(
        "192.168.0.123",
        "::ffff:192.168.0.123",
        "192.168.0.210",
        undefined,
        "Unknown address",
      ),
    ).toEqual(["255.255.255.255", "192.168.0.123", "192.168.0.210"])
  })

  test("rejects pairing messages from an incompatible protocol", () => {
    expect(() => pairingTestHelpers.assertPairingProtocol(2)).toThrow("protocol 3")
    expect(() => pairingTestHelpers.assertPairingProtocol(3)).not.toThrow()
  })
})
