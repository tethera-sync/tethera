import { describe, expect, test } from "bun:test"
import { comparePhaseText, formatElapsed } from "../src/renderer/lib/compare-progress"

describe("formatElapsed", () => {
  test("formats seconds and minutes compactly", () => {
    expect(formatElapsed(0)).toBe("0s")
    expect(formatElapsed(8)).toBe("8s")
    expect(formatElapsed(65)).toBe("1m 05s")
    expect(formatElapsed(125)).toBe("2m 05s")
    expect(formatElapsed(-3)).toBe("0s")
  })
})

describe("comparePhaseText", () => {
  const options = { thisComputer: "Office-PC", otherComputer: "Laptop", elapsed: "12s" }

  test("names the computer being scanned with its file count", () => {
    const text = comparePhaseText("scan-local", { ...options, scannedFiles: 1500 })
    expect(text.headline).toContain("Office-PC")
    expect(text.detail).toContain("1,500")
    expect(text.detail).toContain("nothing is copied")
  })

  test("explains the peer wait without inventing counts", () => {
    const text = comparePhaseText("scan-remote", options)
    expect(text.headline).toContain("Laptop")
    expect(text.detail).toContain("encrypted peer session")
    expect(text.detail).not.toContain("files so far")
  })

  test("covers the final compare and the pre-event state", () => {
    expect(comparePhaseText("compare", options).headline).toContain("Comparing")
    const starting = comparePhaseText(null, options)
    expect(starting.headline).toContain("Starting")
    expect(starting.detail).toContain("large folders")
  })
})
