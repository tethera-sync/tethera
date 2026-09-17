import type { SyncMode } from "./contracts"

/**
 * What one computer agreed to share through a mapping: its own sync
 * direction and the ignore rules applied to its folder.
 */
export interface SharingRules {
  mode: SyncMode
  ignorePatterns: readonly string[]
}

/** A settings change that would make a computer share more than it approved. */
export type SharingWidening = "starts-sending" | "stops-ignoring"

/** The same mapping seen from the other participant. */
export function invertMode(mode: SyncMode): SyncMode {
  if (mode === "send-only") return "receive-only"
  if (mode === "receive-only") return "send-only"
  return "two-way"
}

function sends(mode: SyncMode): boolean {
  return mode !== "receive-only"
}

/**
 * Whether a settings change widens what a computer shares, with both rule
 * sets given from that computer's own point of view.
 *
 * Approval is each computer's consent to what leaves its folder, so a paired
 * computer may narrow that (pause, receive only, ignore more) but never widen
 * it. Ignore rules only ever exclude paths, so only a removed or rewritten
 * rule can widen; adding rules is always safe.
 */
export function sharingWidening(before: SharingRules, after: SharingRules): SharingWidening | undefined {
  if (!sends(after.mode)) return undefined
  if (!sends(before.mode)) return "starts-sending"
  const kept = new Set(after.ignorePatterns.map((pattern) => pattern.trim()))
  const removed = before.ignorePatterns.some((pattern) => pattern.trim() !== "" && !kept.has(pattern.trim()))
  return removed ? "stops-ignoring" : undefined
}
