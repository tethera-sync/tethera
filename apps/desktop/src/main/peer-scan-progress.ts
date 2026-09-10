import { z } from "zod"

export const PEER_SCAN_PROGRESS_CAPABILITY = "scan-progress-v1"
export const PEER_SCAN_IDLE_TIMEOUT_MS = 5 * 60_000
// Progress extends the idle wait, never this receiver-owned resource budget.
export const PEER_SCAN_MAX_DURATION_MS = 30 * 60_000

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const peerScanProgressSchema = z.object({
  stage: z.enum(["listing", "inspecting", "hashing", "complete"]),
  scannedFiles: count,
  ignoredEntries: count,
  unreadableEntries: count,
  hashedBytes: count,
}).strict()

/** Advisory counters only: remote paths and file contents are never progress data. */
export type PeerScanProgress = z.infer<typeof peerScanProgressSchema>

export function parsePeerScanProgress(value: unknown): PeerScanProgress {
  const parsed = peerScanProgressSchema.safeParse(value)
  if (!parsed.success) throw new Error("The peer returned invalid scan progress.")
  return parsed.data
}
