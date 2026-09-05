import { describe, expect, test } from "bun:test"
import { downloadReadout, formatBytes, formatLastChecked } from "../src/renderer/lib/update-format"

describe("formatBytes", () => {
  test("formats byte counts compactly", () => {
    expect(formatBytes(0)).toBe("0 B")
    expect(formatBytes(512)).toBe("512 B")
    expect(formatBytes(2048)).toBe("2.0 KB")
    expect(formatBytes(96.4 * 1024 * 1024)).toBe("96.4 MB")
  })

  test("returns undefined for unknown values", () => {
    expect(formatBytes(undefined)).toBeUndefined()
    expect(formatBytes(Number.NaN)).toBeUndefined()
    expect(formatBytes(-1)).toBeUndefined()
  })
})

describe("formatLastChecked", () => {
  test("explains recent checks relatively", () => {
    const now = Date.parse("2026-09-05T12:00:00Z")
    expect(formatLastChecked("2026-09-05T11:59:40Z", now)).toBe("just now")
    expect(formatLastChecked("2026-09-05T11:48:00Z", now)).toBe("12 min ago")
    expect(formatLastChecked("2026-09-05T09:00:00Z", now)).toBe("3 hr ago")
    expect(formatLastChecked(undefined, now)).toBeUndefined()
    expect(formatLastChecked("not-a-date", now)).toBeUndefined()
  })
})

describe("downloadReadout", () => {
  test("combines percent, sizes, and speed while omitting unknowns", () => {
    expect(
      downloadReadout({
        progressPercent: 42.4,
        transferredBytes: 18 * 1024 * 1024,
        totalBytes: 96 * 1024 * 1024,
        bytesPerSecond: 2 * 1024 * 1024,
      }),
    ).toBe("42% · 18.0 MB of 96.0 MB · 2.0 MB/s")
    expect(downloadReadout({ progressPercent: 7 })).toBe("7%")
    expect(downloadReadout({ progressPercent: 7, transferredBytes: 4 * 1024 * 1024 })).toBe("7% · 4.0 MB")
  })
})
