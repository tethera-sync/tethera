import type { ScanMetrics } from "./folder-manifest"

/**
 * A process-lifetime record of folder walks, so duplicate scans are visible
 * during development and integration testing instead of only as elapsed time.
 *
 * One entry is recorded per admitted local walk (never per file and never for
 * a peer's own bookkeeping). The ledger holds no paths, only the scan key and
 * counters, and is capped so a long-running session cannot grow unboundedly.
 */
export type ScanStage = "preview" | "incoming" | "initial" | "verify" | "inbound" | "continuous" | "other"

export interface ScanLedgerEntry {
  stage: ScanStage
  key: string
  files: number
  reusedFiles: number
  hashedFiles: number
  recordedAt: number
}

const MAX_LEDGER_ENTRIES = 500

/** The part of a scan key before its first colon names the workflow stage. */
export function scanStageForKey(key: string): ScanStage {
  const stage = key.slice(0, key.indexOf(":") === -1 ? key.length : key.indexOf(":"))
  switch (stage) {
    case "preview":
    case "incoming":
    case "initial":
    case "verify":
    case "inbound":
    case "continuous":
      return stage
    default:
      return "other"
  }
}

export class ScanLedger {
  #entries: ScanLedgerEntry[] = []

  constructor(private readonly now: () => number = Date.now) {}

  record(stage: ScanStage, key: string, metrics: ScanMetrics): void {
    this.#entries.push({
      stage,
      key,
      files: metrics.files,
      reusedFiles: metrics.reusedFiles,
      hashedFiles: metrics.hashedFiles,
      recordedAt: this.now(),
    })
    if (this.#entries.length > MAX_LEDGER_ENTRIES) {
      this.#entries.splice(0, this.#entries.length - MAX_LEDGER_ENTRIES)
    }
  }

  snapshot(): readonly ScanLedgerEntry[] {
    return [...this.#entries]
  }

  reset(): void {
    this.#entries = []
  }
}
