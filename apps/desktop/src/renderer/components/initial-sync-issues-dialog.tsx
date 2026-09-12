import type { FolderSummary } from "@shared/contracts"
import { formatScanIssueCount, scanIssueTotal } from "@shared/folder-scan-issues"
import { ScanIssuesDetail } from "@/components/scan-issues-alert"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

/**
 * Shown when the initial merge's fresh scan found inaccessible items the
 * approved comparison did not already cover. The scan is held in the main
 * process, so "Continue anyway" merges with the exact data the user reviewed.
 */
export function InitialSyncIssuesDialog({
  folder,
  localName,
  remoteName,
  working,
  error,
  onContinue,
  onDismiss,
}: {
  folder: FolderSummary
  localName: string
  remoteName: string
  working: boolean
  error?: string | null
  onContinue: () => void
  onDismiss: () => void
}) {
  const report = folder.scanIssues
  if (!report) return null
  const total = scanIssueTotal(report)
  return (
    <Dialog
      open
      disablePointerDismissal={working}
      onOpenChange={(nextOpen: boolean) => {
        if (!nextOpen && !working) onDismiss()
      }}
    >
      <DialogContent className="max-w-[min(640px,calc(100%-2rem))]" showCloseButton={!working}>
        <DialogHeader>
          <DialogTitle>Some items could not be read</DialogTitle>
          <DialogDescription>
            Tethera can merge everything else and skip these items, or stop so you can fix access first. No readable file is changed until you continue.
          </DialogDescription>
        </DialogHeader>
        <ScanIssuesDetail report={report} localName={localName} remoteName={remoteName} />
        {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
        <DialogFooter>
          <Button variant="outline" disabled={working} onClick={onDismiss}>
            Cancel and fix access
          </Button>
          <Button disabled={working} onClick={onContinue}>
            {working ? "Starting…" : `Continue anyway and skip ${formatScanIssueCount(total)}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
