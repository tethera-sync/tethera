import { describe, expect, test } from "bun:test"
import { jsonByteLength, jsonPieces } from "../src/main/json-stream"

const samples: unknown[] = [
  { type: "continuous-sync-observe", folderId: "f", local: [{ path: "a/b.txt", size: 1, digest: "a".repeat(64) }], remote: [] },
  [1, "two", null, true, undefined, () => 1, Symbol("s"), Number.NaN, Number.POSITIVE_INFINITY, -0],
  { omitted: undefined, fn: () => 1, nested: { deeper: [{ list: [1, [2, [3]]] }] }, empty: {}, none: [] },
  { when: new Date(Date.UTC(2026, 8, 16)), custom: { toJSON: (key: string) => `custom:${key}` } },
  { text: "quote \" backslash \\ newline \n tab \t control  wide 界 emoji 😀 lone \ud800" },
  [{ flat: 1, withUndefined: undefined }, { toJSON: () => ({ replaced: true }) }],
  "just a string",
  42,
  null,
]

describe("jsonPieces", () => {
  test("joins to exactly JSON.stringify for the data Tethera sends", () => {
    for (const value of samples) {
      expect([...jsonPieces(value)].join("")).toBe(JSON.stringify(value))
      expect([...jsonPieces(value, 3)].join("")).toBe(JSON.stringify(value))
    }
  })

  test("keeps each piece near the requested size", () => {
    const files = Array.from({ length: 5_000 }, (_, index) => ({ path: `dir/file-${index}.txt`, size: index, digest: "f".repeat(64) }))
    const pieces = [...jsonPieces({ files }, 4_096)]
    expect(pieces.length).toBeGreaterThan(10)
    expect(Math.max(...pieces.map((piece) => piece.length))).toBeLessThan(4_096 + 200)
    expect(pieces.join("")).toBe(JSON.stringify({ files }))
  })

  test("refuses a value that has no JSON representation", () => {
    expect(() => [...jsonPieces(undefined)]).toThrow("no JSON representation")
  })
})

describe("jsonByteLength", () => {
  test("counts UTF-8 bytes rather than characters", () => {
    const value = { name: "界😀", list: ["é"] }
    expect(jsonByteLength(value)).toBe(Buffer.byteLength(JSON.stringify(value), "utf8"))
  })
})
