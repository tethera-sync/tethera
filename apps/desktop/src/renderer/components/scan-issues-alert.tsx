import { useState } from "react"
import { FileWarningIcon } from "lucide-react"
import type { FolderScanIssue, FolderScanIssueReport } from "@shared/contracts"
import { formatScanIssueCount, scanIssueTotal } from "@shared/folder-scan-issues"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Checkbox } from "@/components/ui/checkbox"

/** Bounded, scrollable list of inaccessible paths with their reasons. */
export function ScanIssuesDetail({
  report,
  localName,
  remoteName,
}: {
  report: FolderScanIssueReport
  localName: string
  remoteName: string
}) {
  const [expanded, setExpanded] = useState(() => scanIssueTotal(report) <= 3)
  const groups = [
    { key: "local", label: `On ${localName}`, issues: report.local, count: report.localCount },
    { key: "remote", label: `On ${remoteName}`, issues: report.remote, count: report.remoteCount },
  ].filter((group) => group.count > 0)
  return (
    <details
      className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2.5 text-xs"
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary className="cursor-pointer font-medium focus-visible:outline-2 focus-visible:outline-[var(--ring)]">
        Show inaccessible paths
      </summary>
      <div className="mt-2 max-h-44 space-y-2 overflow-auto">
        {groups.map((group) => (
          <div key={group.key}>
            <p className="font-medium">{group.label} · {formatScanIssueCount(group.count)}</p>
            <ul className="mt-1 space-y-1">
              {group.issues.map((issue) => <IssueRow key={`${issue.kind}:${issue.path}`} issue={issue} />)}
            </ul>
            {group.count > group.issues.length ? (
              <p className="mt-1 text-[var(--muted-foreground)]">
                Showing the first {group.issues.length.toLocaleString("en-GB")} of {group.count.toLocaleString("en-GB")}.
              </p>
            ) : null}
          </div>
        ))}
      </div>
    </details>
  )
}

function IssueRow({ issue }: { issue: FolderScanIssue }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-1.5">
      <code className="[overflow-wrap:anywhere]">{issue.path || "(folder root)"}</code>
      <span className="text-[var(--muted-foreground)]">— {issue.reason}</span>
    </li>
  )
}

/**
 * Prominent report shown before a comparison is approved or an initial merge
 * continues. The acknowledgement checkbox is required so the skip is explicit.
 */
export function ScanIssuesAlert({
  report,
  localName,
  remoteName,
  acknowledged,
  onAcknowledgedChange,
  continueLabel,
}: {
  report: FolderScanIssueReport
  localName: string
  remoteName: string
  acknowledged: boolean
  onAcknowledgedChange: (value: boolean) => void
  continueLabel?: string
}) {
  const total = scanIssueTotal(report)
  if (total === 0) return null
  return (
    <Alert variant="destructive" className="mt-[14px]">
      <FileWarningIcon />
      <AlertTitle>{formatScanIssueCount(total)} could not be read</AlertTitle>
      <AlertDescription>
        <p>Skipping them may leave files out of sync. Fix access and try again, or continue and sync everything else.</p>
        <div className="mt-2">
          <ScanIssuesDetail report={report} localName={localName} remoteName={remoteName} />
        </div>
        <label className="mt-2 flex cursor-pointer items-start gap-2">
          <Checkbox
            className="mt-0.5"
            checked={acknowledged}
            onCheckedChange={(checked: boolean) => onAcknowledgedChange(checked === true)}
          />
          <span>{continueLabel ?? `Continue anyway and skip ${formatScanIssueCount(total)}`}</span>
        </label>
      </AlertDescription>
    </Alert>
  )
}
