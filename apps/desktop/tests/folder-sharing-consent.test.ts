import { describe, expect, test } from "bun:test"
import { invertMode, sharingWidening } from "../src/shared/folder-sharing-consent"

describe("invertMode", () => {
  test("inverts one-way modes without changing two-way", () => {
    expect(invertMode("send-only")).toBe("receive-only")
    expect(invertMode("receive-only")).toBe("send-only")
    expect(invertMode("two-way")).toBe("two-way")
  })
})

describe("sharingWidening", () => {
  const rules = ["node_modules/", "*.tmp"]

  test("allows changes that keep or narrow what a computer sends", () => {
    expect(sharingWidening({ mode: "two-way", ignorePatterns: rules }, { mode: "receive-only", ignorePatterns: [] })).toBeUndefined()
    expect(sharingWidening({ mode: "two-way", ignorePatterns: rules }, { mode: "send-only", ignorePatterns: [...rules, "target/"] })).toBeUndefined()
    expect(sharingWidening({ mode: "send-only", ignorePatterns: rules }, { mode: "two-way", ignorePatterns: [" *.tmp ", "node_modules/"] })).toBeUndefined()
    expect(sharingWidening({ mode: "receive-only", ignorePatterns: rules }, { mode: "receive-only", ignorePatterns: [] })).toBeUndefined()
  })

  test("reports a computer that would start sending", () => {
    expect(sharingWidening({ mode: "receive-only", ignorePatterns: rules }, { mode: "two-way", ignorePatterns: rules })).toBe("starts-sending")
    expect(sharingWidening({ mode: "receive-only", ignorePatterns: [] }, { mode: "send-only", ignorePatterns: [] })).toBe("starts-sending")
  })

  test("reports removed or rewritten ignore rules while the computer sends", () => {
    expect(sharingWidening({ mode: "two-way", ignorePatterns: rules }, { mode: "two-way", ignorePatterns: ["*.tmp"] })).toBe("stops-ignoring")
    expect(sharingWidening({ mode: "send-only", ignorePatterns: rules }, { mode: "two-way", ignorePatterns: ["node_modules/", "*.temp"] })).toBe("stops-ignoring")
  })

  test("ignores blank rules", () => {
    expect(sharingWidening({ mode: "two-way", ignorePatterns: ["", "*.tmp"] }, { mode: "two-way", ignorePatterns: ["*.tmp"] })).toBeUndefined()
  })
})
