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

  test("describes reported hashing activity and skipped entries", () => {
    const text = comparePhaseText("scan-local", { ...options, activity: {
      stage: "hashing", currentPath: "src/archive.zip", scannedFiles: 3,
      ignoredEntries: 2, unreadableEntries: 1, hashedBytes: 2048,
    } })
    expect(text.headline).toContain("Reading file contents")
    expect(text.detail).toContain("3 files checked")
    expect(text.detail).toContain("2.0 KB hashed")
    expect(text.detail).toContain("2 excluded entries")
    expect(text.detail).toContain("1 unreadable")
    expect(text.detail).not.toContain("%")
  })

  test("shows reported remote activity without exposing its path", () => {
    const text = comparePhaseText("scan-remote", { ...options, activity: {
      stage: "inspecting", currentPath: "private/remote-secret.txt", scannedFiles: 12,
      ignoredEntries: 4, unreadableEntries: 0, hashedBytes: 4096,
    } })
    expect(text.headline).toContain("Checking file metadata on Laptop")
    expect(text.detail).toContain("12 files checked")
    expect(text.detail).toContain("4.0 KB hashed")
    expect(text.detail).not.toContain("remote-secret")
  })

  test("covers the final compare and the pre-event state", () => {
    expect(comparePhaseText("compare", options).headline).toContain("Comparing")
    const starting = comparePhaseText(null, options)
    expect(starting.headline).toContain("Starting")
    expect(starting.detail.toLowerCase()).toContain("large folders")
  })

  test("reports reused files instead of claiming every file was read", () => {
    const text = comparePhaseText("scan-local", { ...options, activity: {
      stage: "hashing", currentPath: "src/app.ts", scannedFiles: 100,
      ignoredEntries: 0, unreadableEntries: 0, hashedBytes: 0, reusedFiles: 97,
    } })
    expect(text.detail).toContain("97 unchanged files reused without re-reading")
    expect(text.detail).toContain("0 B hashed")
  })

  test("a cache-backed compare never reads as a fresh scan", () => {
    const text = comparePhaseText("compare", { ...options, reused: true })
    expect(text.headline).toContain("Reusing the comparison you reviewed")
    expect(text.detail).toContain("No folders were re-scanned")
    expect(comparePhaseText("compare", options).headline).not.toContain("Reusing")
  })
})
