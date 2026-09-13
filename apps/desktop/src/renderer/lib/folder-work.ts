import { useEffect, useState } from "react"
import type { FolderScanCounts, FolderWorkActivity, InitialMergeStep } from "@shared/contracts"
import { formatElapsed } from "./compare-progress"
import { formatBytes, formatRate } from "./format"
import { clamp01 } from "./utils"

export interface ComputerNames {
  thisComputer: string
  otherComputer: string
}

type CopyingActivity = Extract<FolderWorkActivity, { kind: "copying" }>

/** Whole seconds since `startedAt`, re-rendering once a second. */
export function useSecondsSince(startedAt: string): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const started = Date.parse(startedAt)
  return Number.isFinite(started) ? Math.max(0, Math.floor((now - started) / 1000)) : 0
}

/** One short line saying what the folder is doing now. */
export function folderWorkHeadline(activity: FolderWorkActivity, names: ComputerNames): string {
  switch (activity.kind) {
    case "preparing":
      return "Getting both computers ready…"
    case "scanning":
      if (activity.purpose === "verify") return "Verifying that both folders match…"
      if (activity.purpose === "changes") return "Looking for changes on both computers…"
      return "Scanning both folders…"
    case "copying":
      return `Copying files to ${activity.destination === "this-computer" ? names.thisComputer : names.otherComputer}…`
    case "waiting-for-peer":
      return `Waiting for ${names.otherComputer}…`
    case "finishing":
      return "Recording the finished merge on both computers…"
  }
}

/** Supporting sentence under the headline. Waiting states reuse main's own description of the request. */
export function folderWorkDetail(activity: FolderWorkActivity, currentAction: string | undefined): string | undefined {
  if (activity.kind === "copying") return undefined
  if (activity.kind === "finishing") return "Both computers confirm the result before the folder starts syncing changes."
  if (activity.kind !== "scanning") return currentAction
  if (activity.purpose === "verify") return "Both folders are read again to confirm nothing changed while files were copied."
  if (activity.purpose === "changes") return "Both folders are compared with the last verified sync."
  return "Listing files, applying ignore rules and reading contents on both computers. Nothing is copied until both scans finish."
}

export interface InitialMergeStepView {
  label: string
  state: "done" | "active" | "todo"
}

/** The three merge steps in the order this computer experiences them. */
export function initialMergeSteps(position: InitialMergeStep, names: ComputerNames): InitialMergeStepView[] {
  const [first, second] = position.firstPassUpdates === "this-computer"
    ? [names.thisComputer, names.otherComputer]
    : [names.otherComputer, names.thisComputer]
  return [`Update ${first}`, `Update ${second}`, "Verify both folders"].map((label, index) => {
    const step = index + 1
    return { label, state: step < position.step ? "done" : step === position.step ? "active" : "todo" }
  })
}

/** Counters for one side of a scan: "1,204 files checked · 38 MB read". */
export function scanCountsText(counts: FolderScanCounts): string {
  return `${counts.scannedFiles.toLocaleString("en-GB")} files checked · ${formatBytes(counts.hashedBytes)} read`
}

/** Progress bar value and readouts for a running copy. */
export function copyProgress(activity: CopyingActivity): { fraction: number; readout: string; detail: string } {
  const { completedFiles, totalFiles, transferredBytes, totalBytes, bytesPerSecond } = activity
  const fraction = clamp01(totalBytes > 0 ? transferredBytes / totalBytes : totalFiles > 0 ? completedFiles / totalFiles : 1)
  const remainingBytes = Math.max(0, totalBytes - transferredBytes)
  const readout = bytesPerSecond > 0 && remainingBytes > 0
    ? `${formatRate(bytesPerSecond)} · about ${formatElapsed(Math.ceil(remainingBytes / bytesPerSecond))} left`
    : `${Math.round(fraction * 100)}%`
  const currentFile = Math.min(completedFiles + 1, totalFiles)
  return {
    fraction,
    readout,
    detail: `File ${currentFile.toLocaleString("en-GB")} of ${totalFiles.toLocaleString("en-GB")} · ${formatBytes(transferredBytes)} of ${formatBytes(totalBytes)}`,
  }
}
