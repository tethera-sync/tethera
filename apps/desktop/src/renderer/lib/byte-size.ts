/**
 * Unit conversion for byte counts, matching the 1024-based KB/MB/GB/TB
 * convention used by `formatBytes` in `./format.ts`. This module is about
 * splitting a byte count into an {amount, unit} pair a user can edit (and
 * back), not about formatting a byte count as display text.
 *
 * Byte-level granularity is not useful for a sync size cap, so the smallest
 * unit here is KB.
 */
export type ByteUnit = "KB" | "MB" | "GB" | "TB"

/** Ordered smallest to largest, for rendering the unit dropdown. */
export const BYTE_UNITS: readonly ByteUnit[] = ["KB", "MB", "GB", "TB"]

/** Narrows a value chosen from the unit dropdown back to a `ByteUnit`. */
export function isByteUnit(value: unknown): value is ByteUnit {
  return typeof value === "string" && (BYTE_UNITS as readonly string[]).includes(value)
}

/** 1024-based multiplier for each unit, matching `formatBytes`. */
export const BYTE_UNIT_MULTIPLIERS: Record<ByteUnit, number> = {
  KB: 1024,
  MB: 1024 ** 2,
  GB: 1024 ** 3,
  TB: 1024 ** 4,
}

/** Converts an amount in the given unit to whole bytes. */
export function toBytes(amount: number, unit: ByteUnit): number {
  return Math.round(amount * BYTE_UNIT_MULTIPLIERS[unit])
}

/**
 * Splits a byte count into the largest unit that represents it exactly
 * (e.g. 52,428,800 bytes -> { amount: 50, unit: "MB" }, not 0.05 GB or
 * 51200 KB). This is what makes the round trip clean: a user who types
 * "50 MB" sees "50 MB" again when the dialog reopens, because 50 MB is an
 * exact multiple of the MB unit and no other supported unit divides it
 * evenly at an amount >= 1.
 *
 * When `bytes` is not an exact multiple of any supported unit, falls back
 * to the largest unit whose amount is still >= 1 (so "1.46 MB" rather than
 * "1495.04 KB" or "0.001 GB"), rounded to 2 decimal places. That rounding
 * is a display convenience for the rare non-exact case; it is not expected
 * to round-trip byte-for-byte, only to stay readable.
 */
export function splitBytes(bytes: number): { amount: number; unit: ByteUnit } {
  if (!Number.isFinite(bytes) || bytes <= 0) return { amount: 0, unit: "KB" }

  for (let index = BYTE_UNITS.length - 1; index >= 0; index -= 1) {
    const unit = BYTE_UNITS[index]
    const multiplier = BYTE_UNIT_MULTIPLIERS[unit]
    if (bytes % multiplier === 0) return { amount: bytes / multiplier, unit }
  }

  for (let index = BYTE_UNITS.length - 1; index >= 0; index -= 1) {
    const unit = BYTE_UNITS[index]
    const amount = bytes / BYTE_UNIT_MULTIPLIERS[unit]
    if (amount >= 1) return { amount: Math.round(amount * 100) / 100, unit }
  }

  return { amount: Math.round((bytes / BYTE_UNIT_MULTIPLIERS.KB) * 100) / 100, unit: "KB" }
}
