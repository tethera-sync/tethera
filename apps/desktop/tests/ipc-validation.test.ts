import { describe, expect, test } from "bun:test"
import {
  applySettingUpdate,
  MAX_IGNORE_PATTERN_LENGTH,
  MAX_IGNORE_PATTERNS,
  parsePeerScanManifest,
  parseRevealPath,
  parseSettingUpdate,
  validateMappingInput,
} from "../src/main/ipc-validation"
import type { AddFolderInput, AppSettings } from "../src/shared/contracts"

const settings: AppSettings = {
  closeToTray: true,
  launchAtLogin: false,
  startMinimised: false,
  pauseOnMetered: true,
  theme: "system",
}

describe("reveal-path validation", () => {
  test("accepts the mapping roots the renderer reveals", () => {
    expect(parseRevealPath("/home/tommy/Projects")).toBe("/home/tommy/Projects")
    expect(parseRevealPath("C:\\Users\\tommy\\Projects")).toBe("C:\\Users\\tommy\\Projects")
  })

  test("rejects empty, unbounded, and NUL-carrying paths", () => {
    expect(() => parseRevealPath("")).toThrow("The selected path is invalid.")
    expect(() => parseRevealPath(42)).toThrow("The selected path is invalid.")
    expect(() => parseRevealPath("a".repeat(4097))).toThrow("The selected path is invalid.")
    expect(() => parseRevealPath("/tmp/bad\0path")).toThrow("The selected path is invalid.")
  })
})

describe("settings-update validation", () => {
  test("accepts every supported key with a correctly typed value", () => {
    expect(parseSettingUpdate("closeToTray", false)).toEqual({ key: "closeToTray", value: false })
    expect(parseSettingUpdate("launchAtLogin", true)).toEqual({ key: "launchAtLogin", value: true })
    expect(parseSettingUpdate("startMinimised", true)).toEqual({ key: "startMinimised", value: true })
    expect(parseSettingUpdate("pauseOnMetered", false)).toEqual({ key: "pauseOnMetered", value: false })
    expect(parseSettingUpdate("theme", "dark")).toEqual({ key: "theme", value: "dark" })
  })

  test("rejects unknown keys and mistyped values", () => {
    expect(() => parseSettingUpdate("theme", "neon")).toThrow("The requested setting change is invalid.")
    expect(() => parseSettingUpdate("closeToTray", "yes")).toThrow("The requested setting change is invalid.")
    expect(() => parseSettingUpdate("launchAtLogin", 1)).toThrow("The requested setting change is invalid.")
    expect(() => parseSettingUpdate("preferences", {})).toThrow("The requested setting change is invalid.")
    expect(() => parseSettingUpdate(undefined, true)).toThrow("The requested setting change is invalid.")
  })

  test("applies validated updates without touching unrelated settings", () => {
    expect(applySettingUpdate(settings, { key: "theme", value: "dark" })).toEqual({ ...settings, theme: "dark" })
    expect(applySettingUpdate(settings, { key: "launchAtLogin", value: true })).toEqual({
      ...settings,
      launchAtLogin: true,
    })
  })
})

describe("mapping-input validation", () => {
  const draft: AddFolderInput = {
    name: "Projects",
    localPath: "/home/tommy/Projects",
    remotePath: "C:\\Users\\tommy\\Projects",
    remoteDeviceId: "win-box",
    mode: "two-way",
    ignorePatterns: ["node_modules/"],
    historyDays: 30,
    historyMaxBytes: 5_000_000_000,
  }

  test("accepts a well-formed draft", () => {
    expect(() => validateMappingInput(draft)).not.toThrow()
  })

  test("rejects drafts outside the shared envelope with the existing user-facing messages", () => {
    expect(() => validateMappingInput({ ...draft, ignorePatterns: new Array(MAX_IGNORE_PATTERNS + 1).fill("*.log") })).toThrow(
      "Use no more than 256 ignore patterns.",
    )
    expect(() =>
      validateMappingInput({ ...draft, ignorePatterns: ["a".repeat(MAX_IGNORE_PATTERN_LENGTH + 1)] }),
    ).toThrow("An ignore pattern is invalid or too long.")
    expect(() => validateMappingInput({ ...draft, mode: "one-way" as AddFolderInput["mode"] })).toThrow(
      "The sync direction is invalid.",
    )
  })
})

describe("peer scan-manifest envelope", () => {
  test("accepts the scans our own UI sends", () => {
    const parsed = parsePeerScanManifest({ path: "/home/tommy/Projects", ignorePatterns: ["node_modules/"] })
    expect(parsed).toEqual({ path: "/home/tommy/Projects", ignorePatterns: ["node_modules/"] })
  })

  test("rejects pattern counts, lengths, and paths our UI could never send", () => {
    expect(() => parsePeerScanManifest({ path: "/data", ignorePatterns: new Array(257).fill("*.log") })).toThrow(
      "The manifest request is invalid.",
    )
    expect(() => parsePeerScanManifest({ path: "/data", ignorePatterns: ["a".repeat(513)] })).toThrow(
      "The manifest request is invalid.",
    )
    expect(() => parsePeerScanManifest({ path: "/data", ignorePatterns: ["ok", 7] })).toThrow(
      "The manifest request is invalid.",
    )
    expect(() => parsePeerScanManifest({ path: "", ignorePatterns: [] })).toThrow("The manifest request is invalid.")
    expect(() => parsePeerScanManifest({ path: "a".repeat(4097), ignorePatterns: [] })).toThrow(
      "The manifest request is invalid.",
    )
    expect(() => parsePeerScanManifest({ path: "/data\0x", ignorePatterns: [] })).toThrow(
      "The manifest request is invalid.",
    )
  })
})
