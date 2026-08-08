import { useEffect, useState } from "react"
import {
  CheckCircle2Icon,
  ComputerIcon,
  FileWarningIcon,
  FolderOpenIcon,
  ShieldCheckIcon,
  XIcon,
} from "lucide-react"
import type { DeviceSummary, IncomingMappingRequest } from "@shared/contracts"
import { FolderPickerDialog } from "@/components/folder-picker-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

export function FolderMappingApprovalDialog({
  request,
  localDevice,
  mutationsEnabled,
  disabledReason,
  open,
  onOpenChange,
}: {
  request?: IncomingMappingRequest
  localDevice: DeviceSummary
  mutationsEnabled: boolean
  disabledReason: string
  open: boolean
  onOpenChange(open: boolean): void
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [destinationPath, setDestinationPath] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setDestinationPath(request?.selectedDestinationPath ?? "")
    setError(null)
  }, [request?.id, request?.selectedDestinationPath])

  if (!request || request.status !== "pending") return null
  const proposal = request.proposal
  const blockingWarnings = proposal.preview.invalidWindowsNames.length + proposal.preview.caseCollisions.length

  async function refreshDestination(nextPath: string) {
    if (!request || busy) return
    setDestinationPath(nextPath)
    setBusy(true)
    setError(null)
    try {
      await window.folderSync.refreshIncomingMappingPreview({ requestId: request.id, destinationPath: nextPath })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to compare the new destination.")
    } finally {
      setBusy(false)
    }
  }

  async function approve() {
    if (!request || !destinationPath || busy || blockingWarnings > 0) return
    setBusy(true)
    setError(null)
    try {
      await window.folderSync.approveFolderMapping({ requestId: request.id, destinationPath })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to approve this folder mapping.")
    } finally {
      setBusy(false)
    }
  }

  async function reject() {
    if (!request || busy) return
    setBusy(true)
    setError(null)
    try {
      await window.folderSync.rejectFolderMapping(request.id)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to reject this folder mapping.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="mapping-approval-dialog" showCloseButton={false}>
          <DialogHeader>
            <div className="mapping-approval-heading">
              <div className="mapping-approval-icon"><ShieldCheckIcon /></div>
              <div>
                <DialogTitle>Approve folder access</DialogTitle>
                <DialogDescription>
                  {request.fromDeviceName} wants to create this folder mapping. Nothing can transfer until you approve it.
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <div className="approval-device-row">
            <div><ComputerIcon /><span><small>From</small><strong>{request.fromDeviceName}</strong></span></div>
            <span>→</span>
            <div><ComputerIcon /><span><small>To</small><strong>{localDevice.name}</strong></span></div>
          </div>

          <div className="approval-paths">
            <div><span>Folder on {request.fromDeviceName}</span><code title={proposal.initiatorPath}>{proposal.initiatorPath}</code></div>
            <div>
              <span>Folder on this computer</span>
              <div className="approval-destination-row">
                <code title={destinationPath}>{destinationPath}</code>
                <Button variant="outline" size="sm" disabled={busy} onClick={() => setPickerOpen(true)}><FolderOpenIcon data-icon="inline-start" />Change</Button>
              </div>
            </div>
          </div>

          <div className="approval-summary-grid">
            <div><span>Sync direction</span><strong>{prettyMode(proposal.mode)}</strong></div>
            <div><span>Ignore rules</span><strong>{proposal.ignorePatterns.length}</strong></div>
            <div><span>Version history</span><strong>{proposal.historyDays} days</strong></div>
            <div><span>Storage cap</span><strong>{formatBytes(proposal.historyMaxBytes)}</strong></div>
          </div>

          <div className="approval-preview-line">
            <div><span>Only on their computer</span><strong>{proposal.preview.localOnlyFiles}</strong></div>
            <div><span>Only on this computer</span><strong>{proposal.preview.remoteOnlyFiles}</strong></div>
            <div><span>Different versions</span><strong>{proposal.preview.differentFiles}</strong></div>
            <div><span>Already identical</span><strong>{proposal.preview.identicalFiles}</strong></div>
          </div>

          {blockingWarnings > 0 ? (
            <div className="mapping-warning danger"><FileWarningIcon /><div><strong>Approval blocked</strong><span>Rename {blockingWarnings} Windows-invalid or case-colliding paths first.</span></div></div>
          ) : (
            <div className="approval-safety"><CheckCircle2Icon /><span>Approval only commits configuration. One computer must then start the initial merge; Tethera coordinates both directions without overwriting same-path differences.</span></div>
          )}

          {!mutationsEnabled ? <p className="mapping-error">{disabledReason}</p> : null}
          {request.message ? <p className="approval-status-note">{request.message}</p> : null}

          {error ? <p className="mapping-error">{error}</p> : null}

          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => void reject()}><XIcon data-icon="inline-start" />Reject</Button>
            <Button
              disabled={!mutationsEnabled || busy || !destinationPath || blockingWarnings > 0}
              title={!mutationsEnabled ? disabledReason : undefined}
              onClick={() => void approve()}
            >
              <ShieldCheckIcon data-icon="inline-start" />{busy ? "Comparing…" : "Approve mapping"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <FolderPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        device={localDevice}
        initialPath={destinationPath || undefined}
        title="Choose the local destination"
        description="You are choosing where this mapping will live on this computer."
        onSelect={(nextPath) => void refreshDestination(nextPath)}
      />
    </>
  )
}

function prettyMode(mode: string): string {
  if (mode === "two-way") return "Two-way"
  if (mode === "send-only") return "Receive from them"
  return "Send to them"
}

function formatBytes(value: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"]
  const index = value > 0 ? Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1) : 0
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}
