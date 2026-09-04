import { describe, expect, test } from "bun:test"
import path from "node:path"
import { isTetheraStagingPath, resolveWithinRoot } from "../src/main/path-safety"

describe("isTetheraStagingPath", () => {
  test("handles every valid POSIX basename character", () => {
    const suffix = ".tethera-tmp-0123456789abcdef0123456789abcdef"
    expect(isTetheraStagingPath(`.line\nbreak${suffix}`)).toBe(true)
    expect(isTetheraStagingPath(`.back\\slash${suffix}`)).toBe(true)
  })
})

describe("resolveWithinRoot", () => {
  test("resolves a plain relative path under the root", () => {
    expect(resolveWithinRoot("/tmp/root", "sub/file.txt")).toBe(path.resolve("/tmp/root", "sub/file.txt"))
  })

  test.each(["../escape.txt", "/etc/passwd", "sub/../../escape.txt", "sub/../..", ""])("rejects unsafe path %p", (unsafe) => {
    expect(() => resolveWithinRoot("/tmp/root", unsafe)).toThrow()
  })
})
