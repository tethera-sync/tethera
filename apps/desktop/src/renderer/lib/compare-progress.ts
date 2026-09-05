import { useEffect, useState } from "react"
import type { FolderPreviewProgress } from "@shared/contracts"

export type ComparePhase = FolderPreviewProgress["phase"]

/** Whole seconds since `active` became true. Resets when the operation ends. */
export function useElapsedSeconds(active: boolean): number {
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!active) {
      setStartedAt(null)
      return
    }
    const start = Date.now()
    setStartedAt(start)
    setNow(start)
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])

  if (!active || startedAt === null) return 0
  return Math.max(0, Math.floor((now - startedAt) / 1000))
}

/** Short elapsed label: "8s", "2m 05s". */
export function formatElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`
}

export interface CompareTextOptions {
  /** "Scanning folders on Office-PC…" */
  thisComputer: string
  /** "Waiting for Laptop…" */
  otherComputer: string
  scannedFiles?: number
  elapsed: string
}

/**
 * Truthful status copy for a folder comparison. Only describes what the main
 * process actually reported: local scan counts, waiting on the peer, or the
 * final in-memory compare. `phase: null` means no event arrived yet.
 */
export function comparePhaseText(
  phase: ComparePhase | null,
  options: CompareTextOptions,
): { headline: string; detail: string } {
  const { thisComputer, otherComputer, scannedFiles, elapsed } = options
  const elapsedSuffix = ` · ${elapsed} elapsed`
  if (phase === "scan-local") {
    const count = scannedFiles === undefined ? "" : ` · ${scannedFiles.toLocaleString("en-GB")} files so far`
    return {
      headline: `Scanning folders on ${thisComputer}…`,
      detail: `Reading file lists; nothing is copied${count}${elapsedSuffix}.`,
    }
  }
  if (phase === "scan-remote") {
    return {
      headline: `Waiting for ${otherComputer}…`,
      detail: `They are scanning their folder over the encrypted peer session${elapsedSuffix}.`,
    }
  }
  if (phase === "compare") {
    return {
      headline: "Comparing the two file lists…",
      detail: `Both scans are in; matching them up${elapsedSuffix}.`,
    }
  }
  return {
    headline: "Starting the comparison…",
    detail: `Scanning both computers; large folders can take a few minutes${elapsedSuffix}.`,
  }
}
