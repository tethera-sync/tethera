import { describe, expect, test } from "bun:test"
import {
  canDownloadUpdate,
  canInstallUpdate,
  clampProgressPercent,
  formatUpdateError,
  isUpdateBusy,
  normalizeReleaseNotes,
  runUpdateDownload,
  shouldBroadcastProgress,
  shouldPreserveDownloadedOnError,
  toOptionalFiniteNumber,
} from "../src/main/update-manager"
import type { UpdateState } from "../src/shared/contracts"

describe("normalizeReleaseNotes", () => {
  test("passes plain strings through with a length cap", () => {
    expect(normalizeReleaseNotes("Fixed sync retries")).toBe("Fixed sync retries")
    expect(normalizeReleaseNotes("  ")).toBeUndefined()
    expect(normalizeReleaseNotes(null)).toBeUndefined()
    expect(normalizeReleaseNotes({ html: "<b>hi</b>" })).toBeUndefined()
  })

  test("flattens electron-updater note arrays without HTML", () => {
    expect(normalizeReleaseNotes([{ version: "1.2.0", note: "Faster startup" }])).toBe("Faster startup")
    expect(normalizeReleaseNotes(["a", " ", "b"])).toBe("a\n\nb")
  })
})

describe("formatUpdateError", () => {
  test("maps network failures to a human retry message", () => {
    expect(formatUpdateError(new Error("getaddrinfo ENOTFOUND github.com"))).toContain("Check your connection")
  })

  test("falls back for unknown shapes", () => {
    expect(formatUpdateError(null)).toContain("retry automatically")
    expect(formatUpdateError(new Error(""))).toContain("retry automatically")
    expect(formatUpdateError(new Error("Cannot find latest.yml at https://updates.example/cache/latest.yml"))).toBe(
      "The update check failed. We'll retry automatically.",
    )
  })
})

describe("update state guards", () => {
  test("busy only while checking or downloading", () => {
    expect(isUpdateBusy({ status: "checking" })).toBe(true)
    expect(
      isUpdateBusy({ status: "downloading", version: "1.2.0", progressPercent: 10 }),
    ).toBe(true)
    expect(isUpdateBusy({ status: "available", version: "1.2.0" })).toBe(false)
    expect(isUpdateBusy({ status: "downloaded", version: "1.2.0" })).toBe(false)
  })

  test("downloads start only from available, installs only when downloaded", () => {
    expect(canDownloadUpdate({ status: "available", version: "1.2.0" })).toBe(true)
    expect(canDownloadUpdate({ status: "error", message: "nope" })).toBe(false)
    expect(canInstallUpdate({ status: "downloaded", version: "1.2.0" })).toBe(true)
    expect(canInstallUpdate({ status: "available", version: "1.2.0" })).toBe(false)
  })

  test("claims a download before awaiting it and rejects a concurrent request", async () => {
    let state: UpdateState = { status: "available", version: "1.2.0", currentVersion: "1.1.0" }
    let resolveDownload: (() => void) | undefined
    const download = () => new Promise<void>((resolve) => { resolveDownload = resolve })
    const setState = (next: Extract<UpdateState, { status: "downloading" }>) => { state = next }

    const first = runUpdateDownload(state, download, setState)
    await Promise.resolve()
    expect(state.status).toBe("downloading")
    expect(isUpdateBusy(state)).toBe(true)
    await expect(runUpdateDownload(state, download, setState)).rejects.toThrow("Check for updates")
    if (!resolveDownload) throw new Error("download was not invoked")
    resolveDownload()
    await first
  })

  test("a staged download survives later feed errors", () => {
    expect(shouldPreserveDownloadedOnError({ status: "downloaded", version: "1.2.0" })).toBe(true)
    expect(shouldPreserveDownloadedOnError({ status: "downloading", version: "1.2.0", progressPercent: 5 })).toBe(
      false,
    )
  })
})

describe("download progress", () => {
  test("clamps percentages into range", () => {
    expect(clampProgressPercent(42.4)).toBe(42)
    expect(clampProgressPercent(-3)).toBe(0)
    expect(clampProgressPercent(104)).toBe(100)
    expect(clampProgressPercent(Number.NaN)).toBe(0)
    expect(clampProgressPercent("50")).toBe(0)
  })

  test("throttles broadcasts until percent moves or time passes", () => {
    expect(shouldBroadcastProgress(null, null, 1, 1000)).toBe(true)
    expect(shouldBroadcastProgress(10, 1000, 10, 1200)).toBe(false)
    expect(shouldBroadcastProgress(10, 1000, 11, 1200)).toBe(true)
    expect(shouldBroadcastProgress(10, 1000, 10, 2000)).toBe(true)
  })

  test("drops non-finite byte counters", () => {
    expect(toOptionalFiniteNumber(12)).toBe(12)
    expect(toOptionalFiniteNumber(-1)).toBeUndefined()
    expect(toOptionalFiniteNumber(Number.NaN)).toBeUndefined()
    expect(toOptionalFiniteNumber("12")).toBeUndefined()
  })
})
