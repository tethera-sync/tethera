import { describe, expect, test } from "bun:test"
import { fingerprintObservation, isObservationFingerprint } from "../src/main/observation-fingerprint"

const digest = (character: string) => character.repeat(64)
const files = [
  { path: "a.txt", size: 1, digest: digest("a") },
  { path: "dir/b.txt", size: 2, digest: digest("b") },
  { path: "dir/c.txt", size: 3, digest: digest("c") },
]

describe("observation fingerprint", () => {
  test("is independent of the order files were observed in", () => {
    const expected = fingerprintObservation(files)
    expect(fingerprintObservation([...files].reverse())).toBe(expected)
    expect(fingerprintObservation([files[1], files[2], files[0]].flatMap((file) => (file ? [file] : [])))).toBe(expected)
  })

  test("changes with any path, size or digest, and with an added or removed file", () => {
    const expected = fingerprintObservation(files)
    const variants = [
      files.map((file, index) => (index === 0 ? { ...file, path: "renamed.txt" } : file)),
      files.map((file, index) => (index === 0 ? { ...file, size: 9 } : file)),
      files.map((file, index) => (index === 0 ? { ...file, digest: digest("f") } : file)),
      [...files, { path: "new.txt", size: 4, digest: digest("d") }],
      files.slice(1),
    ]
    for (const variant of variants) expect(fingerprintObservation(variant)).not.toBe(expected)
  })

  test("recognises only its own format", () => {
    expect(isObservationFingerprint(fingerprintObservation(files))).toBe(true)
    expect(isObservationFingerprint(fingerprintObservation([]))).toBe(true)
    for (const value of ["3:" + "a".repeat(63), "x:" + "a".repeat(64), "3:" + "A".repeat(64), 3, null]) {
      expect(isObservationFingerprint(value)).toBe(false)
    }
  })
})
