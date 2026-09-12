import type { FolderMappingPreview, FolderScanIssue, FolderScanIssueReport } from "./contracts"

/** Display label for an issue whose path is the scanned root itself. */
export const FOLDER_ROOT_ISSUE_PATH = "(folder root)"

export function formatScanIssuePath(path: string): string {
  return path || FOLDER_ROOT_ISSUE_PATH
}

export function emptyScanIssueReport(): FolderScanIssueReport {
  return { local: [], remote: [], localCount: 0, remoteCount: 0 }
}

/**
 * Normalises a preview produced by any app version into a complete per-side
 * issue report. Older previews carry no issue fields at all, which means the
 * same value as "nothing was reported", never "unknown".
 */
export function scanIssueReportFromPreview(preview: FolderMappingPreview): FolderScanIssueReport {
  const local = preview.unreadableLocal ?? []
  const remote = preview.unreadableRemote ?? []
  return {
    local,
    remote,
    localCount: preview.unreadableLocalCount ?? local.length,
    remoteCount: preview.unreadableRemoteCount ?? remote.length,
  }
}

export function scanIssueTotal(report: FolderScanIssueReport): number {
  return report.localCount + report.remoteCount
}

export function hasScanIssues(report: FolderScanIssueReport): boolean {
  return scanIssueTotal(report) > 0
}

export function formatScanIssueCount(count: number): string {
  return count === 1 ? "1 item" : `${count.toLocaleString("en-GB")} items`
}

function issueKey(issue: FolderScanIssue): string {
  return `${issue.kind}\0${issue.path}`
}

/**
 * Whether a fresh scan only found issues an earlier approved comparison had
 * already reported. Both lists are bounded, so a smaller earlier total can
 * hide new paths and must be treated as a new, unacknowledged report.
 */
export function scanIssueReportCovers(approved: readonly FolderScanIssue[], fresh: readonly FolderScanIssue[], approvedCount: number, freshCount: number): boolean {
  if (freshCount === 0) return true
  if (approvedCount < freshCount) return false
  const approvedKeys = new Set(approved.map(issueKey))
  return fresh.every((issue) => approvedKeys.has(issueKey(issue)))
}
