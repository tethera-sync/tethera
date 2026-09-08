import { describe, expect, test } from "bun:test"
import { BYTE_UNIT_MULTIPLIERS, splitBytes, toBytes } from "../src/renderer/lib/byte-size"

describe("toBytes", () => {
  test("converts each unit to whole bytes", () => {
    expect(toBytes(1, "KB")).toBe(1024)
    expect(toBytes(50, "MB")).toBe(50 * 1024 ** 2)
    expect(toBytes(2, "GB")).toBe(2 * 1024 ** 3)
    expect(toBytes(1, "TB")).toBe(1024 ** 4)
  })

  test("rounds fractional amounts to whole bytes", () => {
    expect(toBytes(1.5, "KB")).toBe(Math.round(1.5 * 1024))
  })
})

describe("splitBytes", () => {
  test("round-trips typical values entered as MB, GB, and KB", () => {
    expect(splitBytes(toBytes(50, "MB"))).toEqual({ amount: 50, unit: "MB" })
    expect(splitBytes(toBytes(2, "GB"))).toEqual({ amount: 2, unit: "GB" })
    expect(splitBytes(toBytes(500, "KB"))).toEqual({ amount: 500, unit: "KB" })
  })

  test("picks the largest unit that represents the value exactly", () => {
    // 1024 KB is exactly 1 MB, so the larger unit wins even though the
    // caller thought in KB.
    expect(splitBytes(1024 * 1024)).toEqual({ amount: 1, unit: "MB" })
    // 2048 MB is exactly 2 GB.
    expect(splitBytes(2048 * 1024 ** 2)).toEqual({ amount: 2, unit: "GB" })
  })

  test("handles the 1 KB and 1 TB boundary values", () => {
    expect(splitBytes(BYTE_UNIT_MULTIPLIERS.KB)).toEqual({ amount: 1, unit: "KB" })
    expect(splitBytes(BYTE_UNIT_MULTIPLIERS.TB)).toEqual({ amount: 1, unit: "TB" })
  })

  test("falls back to the largest unit with amount >= 1, rounded to 2dp, when not an exact multiple", () => {
    // 1500 bytes is not an exact multiple of KB/MB/GB/TB; the only unit
    // that keeps the amount >= 1 is KB.
    const result = splitBytes(1500)
    expect(result.unit).toBe("KB")
    expect(result.amount).toBeCloseTo(1.46, 2)

    // 1.5 MB expressed in bytes is not an exact KB/MB/GB/TB multiple either
    // (1.5 * 1024^2 = 1,572,864, which is divisible by KB but not by a
    // whole MB) -- wait, 1,572,864 / 1024 = 1536 exactly, so this *is* an
    // exact KB multiple and should report as KB, not MB, confirming the
    // "largest exact unit" rule takes priority over "closest to the
    // original unit".
    expect(splitBytes(1_572_864)).toEqual({ amount: 1536, unit: "KB" })
  })

  test("treats non-finite or non-positive byte counts as zero", () => {
    expect(splitBytes(0)).toEqual({ amount: 0, unit: "KB" })
    expect(splitBytes(-5)).toEqual({ amount: 0, unit: "KB" })
    expect(splitBytes(Number.NaN)).toEqual({ amount: 0, unit: "KB" })
  })
})
