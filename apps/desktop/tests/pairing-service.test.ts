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

  test("both computers derive the same six-digit comparison code", () => {
    const initiator = publicKey()
    const responder = publicKey()
    const transcript = pairingTestHelpers.buildTranscriptHash(
      "session-1",
      initiator,
      responder,
      "initiator-nonce",
      "responder-nonce",
    )

    expect(pairingTestHelpers.comparisonCode(transcript)).toMatch(/^\d{3} \d{3}$/)
    expect(pairingTestHelpers.comparisonCode(transcript)).toBe(pairingTestHelpers.comparisonCode(transcript))
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

  test("changing either identity changes the transcript", () => {
    const initiator = publicKey()
    const responder = publicKey()
    const otherResponder = publicKey()
    const first = pairingTestHelpers.buildTranscriptHash("session-1", initiator, responder, "a", "b")
    const second = pairingTestHelpers.buildTranscriptHash("session-1", initiator, otherResponder, "a", "b")
    expect(first).not.toBe(second)
  })
})
