import { useEffect, useState } from "react"
import type { FolderPreviewProgress } from "@shared/contracts"
import { formatBytes } from "./format"

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
  activity?: FolderPreviewProgress["activity"]
  elapsed: string
  /** True when the comparison reused saved scans instead of walking the folders again. */
  reused?: boolean
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
  const { thisComputer, otherComputer, scannedFiles, activity, elapsed, reused } = options
  const elapsedSuffix = ` · ${elapsed} elapsed`
  if ((phase === "scan-local" || phase === "scan-remote") && activity) {
    const computer = phase === "scan-local" ? thisComputer : otherComputer
    const action = { listing: "Listing folders", inspecting: "Checking file metadata", hashing: "Reading file contents to compare", complete: "Scan finished" }[activity.stage]
    const reusedCount = activity.reusedFiles ?? 0
    const reusedNote = reusedCount > 0
      ? ` · ${reusedCount.toLocaleString("en-GB")} unchanged files reused without re-reading`
      : ""
    return {
      headline: `${action} on ${computer}${activity.stage === "complete" ? "." : "…"}`,
      detail: `${activity.scannedFiles.toLocaleString("en-GB")} files checked${reusedNote} · ${formatBytes(activity.hashedBytes)} hashed · ${activity.ignoredEntries.toLocaleString("en-GB")} excluded entries · ${activity.unreadableEntries.toLocaleString("en-GB")} unreadable. Nothing is copied${elapsedSuffix}.`,
    }
  }
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
      detail: `They are listing files, applying ignore rules and checking contents over the encrypted peer session. Live file counts are unavailable from the other computer${elapsedSuffix}.`,
    }
  }
  if (phase === "compare") {
    if (reused) {
      return {
        headline: "Reusing the comparison you reviewed…",
        detail: `No folders were re-scanned. The saved file lists are being matched up${elapsedSuffix}.`,
      }
    }
    return {
      headline: "Comparing the two file lists…",
      detail: `Both scans are in; matching them up${elapsedSuffix}.`,
    }
  }
  return {
    headline: "Starting the comparison…",
    detail: `Preparing a read-only comparison: list each folder, apply ignore rules, read file sizes and check contents. Large folders can take a few minutes${elapsedSuffix}.`,
  }
}
