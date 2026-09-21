import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { createTextDigestHasher, lineEndingOnlyDirection } from "../src/main/line-endings"

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex")
}

function textDigest(...chunks: Array<string | Buffer>): string | undefined {
  const hasher = createTextDigestHasher()
  for (const chunk of chunks) hasher.update(Buffer.from(chunk))
  return hasher.digest()
}

describe("line-ending-insensitive text digest", () => {
  test("reads CRLF as LF, so both line-ending styles share one digest", () => {
    expect(textDigest("one\r\ntwo\r\n")).toBe(sha256("one\ntwo\n"))
    expect(textDigest("one\ntwo\n")).toBe(sha256("one\ntwo\n"))
    expect(textDigest("mixed\r\nendings\n")).toBe(sha256("mixed\nendings\n"))
  })

  test("recognises a CRLF split across two chunks", () => {
    expect(textDigest("one\r", "\ntwo")).toBe(sha256("one\ntwo"))
    expect(textDigest("one\r", "", "\ntwo")).toBe(sha256("one\ntwo"))
  })

  test("keeps a lone CR, including one at a chunk or file end", () => {
    expect(textDigest("old\rmac")).toBe(sha256("old\rmac"))
    expect(textDigest("one\r", "two")).toBe(sha256("one\rtwo"))
    expect(textDigest("one\r", "\r\ntwo")).toBe(sha256("one\r\ntwo"))
    expect(textDigest("ends\r")).toBe(sha256("ends\r"))
  })

  test("treats content with a NUL byte as binary", () => {
    expect(textDigest("text\r\n", Buffer.from([0x00, 0x0d, 0x0a]))).toBeUndefined()
    expect(textDigest("")).toBe(sha256(""))
  })
})

describe("line-ending-only conflicts", () => {
  const lf = sha256("a\nb\n")
  const crlf = sha256("a\r\nb\r\n")

  test("keeps the copy that already uses LF throughout", () => {
    expect(lineEndingOnlyDirection({ digest: lf, textDigest: lf }, { digest: crlf, textDigest: lf })).toBe("push-local")
    expect(lineEndingOnlyDirection({ digest: crlf, textDigest: lf }, { digest: lf, textDigest: lf })).toBe("pull-remote")
  })

  test("leaves every other difference to the user", () => {
    const other = sha256("a\nc\n")
    const mixed = sha256("a\r\nb\n")
    // Different text.
    expect(lineEndingOnlyDirection({ digest: lf, textDigest: lf }, { digest: other, textDigest: other })).toBeUndefined()
    // Binary on either side, or a peer that did not report a text digest.
    expect(lineEndingOnlyDirection({ digest: lf }, { digest: crlf, textDigest: lf })).toBeUndefined()
    expect(lineEndingOnlyDirection({ digest: lf, textDigest: lf }, { digest: crlf })).toBeUndefined()
    // Neither copy is LF throughout, so there is no copy to prefer.
    expect(lineEndingOnlyDirection({ digest: crlf, textDigest: lf }, { digest: mixed, textDigest: lf })).toBeUndefined()
    // Identical copies are not a conflict.
    expect(lineEndingOnlyDirection({ digest: lf, textDigest: lf }, { digest: lf, textDigest: lf })).toBeUndefined()
  })
})
