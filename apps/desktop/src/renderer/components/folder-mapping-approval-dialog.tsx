import { useEffect, useState } from "react"
import {
  CheckCircle2Icon,
  ComputerIcon,
  FileWarningIcon,
  FolderOpenIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  XIcon,
} from "lucide-react"
import type { DeviceSummary, IncomingMappingRequest } from "@shared/contracts"
import { CompareStatus } from "@/components/compare-status"
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
import { formatBytes } from "@/lib/format"
import { formatElapsed, useElapsedSeconds, type ComparePhase } from "@/lib/compare-progress"

export function FolderMappingApprovalDialog({
  request,
  localDevice,
  scanLimit,
  mutationsEnabled,
  disabledReason,
  open,
  onOpenChange,
}: {
  request?: IncomingMappingRequest
  localDevice: DeviceSummary
  scanLimit: number | null
  mutationsEnabled: boolean
  disabledReason: string
  open: boolean
  onOpenChange(open: boolean): void
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [destinationPath, setDestinationPath] = useState("")
  const [compare, setCompare] = useState<{
    operationId: string
    kind: "refresh" | "verify"
    phase: ComparePhase | null
    scannedFiles?: number
  } | null>(null)
  const [action, setAction] = useState<"approve" | "reject" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const working = compare !== null || action !== null
  const elapsed = formatElapsed(useElapsedSeconds(compare !== null))

  useEffect(() => {
    setDestinationPath(request?.selectedDestinationPath ?? "")
    setError(null)
  }, [request?.id, request?.selectedDestinationPath])

  if (!request || request.status !== "pending") return null
  const proposal = request.proposal
  const blockingWarnings = proposal.preview.invalidWindowsNames.length + proposal.preview.caseCollisions.length

  function trackCompareProgress(operationId: string): () => void {
    return window.folderSync.onPreviewProgress((progress) => {
      if (progress.operationId !== operationId) return
      setCompare((current) =>
        current?.operationId === operationId
          ? { ...current, phase: progress.phase, scannedFiles: progress.scannedFiles }
          : current,
      )
    })
  }

  async function refreshDestination(nextPath: string) {
    if (!request || working) return
    const operationId = crypto.randomUUID()
    setDestinationPath(nextPath)
    setCompare({ operationId, kind: "refresh", phase: null })
    setError(null)
    const stopTracking = trackCompareProgress(operationId)
    try {
      await window.folderSync.refreshIncomingMappingPreview({ requestId: request.id, destinationPath: nextPath }, operationId)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to compare the new destination.")
    } finally {
      stopTracking()
      setCompare(null)
    }
  }

  async function approve() {
    if (!request || !destinationPath || working || blockingWarnings > 0) return
    const operationId = crypto.randomUUID()
    setAction("approve")
    setCompare({ operationId, kind: "verify", phase: null })
    setError(null)
    const stopTracking = trackCompareProgress(operationId)
    try {
      await window.folderSync.approveFolderMapping({ requestId: request.id, destinationPath }, operationId)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to approve this folder mapping.")
    } finally {
      stopTracking()
      setCompare(null)
      setAction(null)
    }
  }

  async function reject() {
    if (!request || working) return
    setAction("reject")
    setError(null)
    try {
      await window.folderSync.rejectFolderMapping(request.id)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to reject this folder mapping.")
    } finally {
      setAction(null)
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="mapping-approval-dialog [max-width:720px]" showCloseButton={false}>
          <DialogHeader>
            <div className="mapping-approval-heading [display:flex] [align-items:flex-start] [gap:12px]">
              <div className="mapping-approval-icon [display:grid] [place-items:center] [width:42px] [height:42px] [flex:0_0_auto] [border:1px_solid_color-mix(in_oklab,_var(--primary)_33%,_var(--border))] [border-radius:12px] [background:color-mix(in_oklab,_var(--primary)_10%,_var(--surface))] [color:var(--primary)] [&_svg]:[width:20px] [&_svg]:[height:20px]"><ShieldCheckIcon /></div>
              <div>
                <DialogTitle>Approve folder access</DialogTitle>
                <DialogDescription>
                  {request.fromDeviceName} wants to create this folder mapping. Nothing can transfer until you approve it.
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <div className="approval-device-row [display:grid] [grid-template-columns:1fr_auto_1fr] [align-items:center] [gap:12px] [margin-top:20px] [&>div]:[display:flex] [&>div]:[align-items:center] [&>div]:[gap:9px] [&>div]:[border:1px_solid_var(--border)] [&>div]:[border-radius:10px] [&>div]:[padding:10px_12px] [&>div]:[background:var(--surface)] [&>div:last-child]:[justify-content:flex-end] [&_svg]:[width:18px] [&_svg]:[color:var(--primary)] [&_span]:[display:grid] [&_small]:[color:var(--muted-foreground)] [&_small]:[font-size:9px] [&_strong]:[font-size:11px]">
            <div><ComputerIcon /><span><small>From</small><strong>{request.fromDeviceName}</strong></span></div>
            <span>→</span>
            <div><ComputerIcon /><span><small>To</small><strong>{localDevice.name}</strong></span></div>
          </div>

          <div className="approval-paths [display:grid] [gap:10px] [margin-top:14px] [&>div]:[display:grid] [&>div]:[gap:5px] [&>div>span]:[color:var(--muted-foreground)] [&>div>span]:[font-size:9.5px] [&_code]:[min-width:0] [&_code]:[overflow:hidden] [&_code]:[text-overflow:ellipsis] [&_code]:[white-space:nowrap] [&_code]:[border:1px_solid_var(--border)] [&_code]:[border-radius:8px] [&_code]:[background:var(--surface-sunken)] [&_code]:[padding:9px_10px] [&_code]:[font-size:10px]">
            <div><span>Folder on {request.fromDeviceName}</span><code title={proposal.initiatorPath}>{proposal.initiatorPath}</code></div>
            <div>
              <span>Folder on this computer</span>
              <div className="approval-destination-row [display:flex] [gap:8px] [&_code]:[flex:1]">
                <code title={destinationPath}>{destinationPath}</code>
                <Button variant="outline" size="sm" disabled={working} onClick={() => setPickerOpen(true)}><FolderOpenIcon data-icon="inline-start" />Change</Button>
              </div>
            </div>
          </div>

          <div className="approval-summary-grid [display:grid] [grid-template-columns:repeat(4,_minmax(0,_1fr))] [gap:8px] [margin-top:14px] [&>div]:[display:grid] [&>div]:[gap:2px] [&>div]:[border:1px_solid_var(--border)] [&>div]:[border-radius:9px] [&>div]:[padding:9px_10px] [&_span]:[color:var(--muted-foreground)] [&_span]:[font-size:9px] [&_strong]:[overflow:hidden] [&_strong]:[text-overflow:ellipsis] [&_strong]:[font-size:10.5px] max-[760px]:[grid-template-columns:repeat(2,_minmax(0,_1fr))]">
            <div><span>Sync direction</span><strong>{prettyMode(proposal.mode)}</strong></div>
            <div><span>Ignore rules</span><strong>{proposal.ignorePatterns.length}</strong></div>
            <div><span>Version history</span><strong>{proposal.historyDays} days</strong></div>
            <div><span>Storage cap</span><strong>{formatBytes(proposal.historyMaxBytes)}</strong></div>
          </div>

          <div className="approval-preview-line [display:grid] [grid-template-columns:repeat(4,_1fr)] [gap:1px] [overflow:hidden] [margin-top:10px] [border:1px_solid_var(--border)] [border-radius:9px] [background:var(--border)] [&>div]:[display:grid] [&>div]:[gap:2px] [&>div]:[background:var(--surface)] [&>div]:[padding:9px_10px] [&_span]:[color:var(--muted-foreground)] [&_span]:[font-size:8.5px] [&_strong]:[font-size:13px] [&_strong]:[font-variant-numeric:tabular-nums] max-[760px]:[grid-template-columns:repeat(2,_minmax(0,_1fr))]">
            <div><span>Only on their computer</span><strong>{proposal.preview.localOnlyFiles}</strong></div>
            <div><span>Only on this computer</span><strong>{proposal.preview.remoteOnlyFiles}</strong></div>
            <div><span>Different versions</span><strong>{proposal.preview.differentFiles}</strong></div>
            <div><span>Already identical</span><strong>{proposal.preview.identicalFiles}</strong></div>
          </div>

          {proposal.preview.truncated ? (
            <div className="mapping-warning [display:flex] [align-items:flex-start] [gap:10px] [margin-top:10px] [border:1px_solid_color-mix(in_oklab,_var(--warning)_32%,_var(--border))] [border-radius:10px] [background:color-mix(in_oklab,_var(--warning)_9%,_var(--surface))] [padding:11px_12px] [&>svg]:[width:18px] [&>svg]:[height:18px] [&>svg]:[flex:0_0_auto] [&>svg]:[color:var(--warning)] [&_div]:[display:grid] [&_div]:[gap:2px] [&_strong]:[font-size:11px] [&_span]:[color:var(--muted-foreground)] [&_span]:[font-size:10px] [&_span]:[line-height:1.5]"><FileWarningIcon /><div><strong>Preview limit reached</strong><span>{approvalTruncatedDetail(scanLimit)}</span></div></div>
          ) : null}

          {blockingWarnings > 0 ? (
            <div className="mapping-warning [display:flex] [align-items:flex-start] [gap:10px] [border:1px_solid_color-mix(in_oklab,_var(--warning)_32%,_var(--border))] [border-radius:10px] [background:color-mix(in_oklab,_var(--warning)_9%,_var(--surface))] [padding:11px_12px] [&.danger]:[border-color:color-mix(in_oklab,_var(--danger)_36%,_var(--border))] [&.danger]:[background:color-mix(in_oklab,_var(--danger)_9%,_var(--surface))] [&>svg]:[width:18px] [&>svg]:[height:18px] [&>svg]:[flex:0_0_auto] [&>svg]:[color:var(--warning)] [&.danger>svg]:[color:var(--danger)] [&_div]:[display:grid] [&_div]:[gap:2px] [&_strong]:[font-size:11px] [&_span]:[color:var(--muted-foreground)] [&_span]:[font-size:10px] [&_span]:[line-height:1.5] danger"><FileWarningIcon /><div><strong>Approval blocked</strong><span>Rename {blockingWarnings} Windows-invalid or case-colliding paths first.</span></div></div>
          ) : (
            <div className="approval-safety [display:flex] [align-items:flex-start] [gap:8px] [margin-top:12px] [color:var(--muted-foreground)] [font-size:10px] [line-height:1.5] [&_svg]:[width:15px] [&_svg]:[height:15px] [&_svg]:[flex:0_0_auto] [&_svg]:[color:var(--success)]"><CheckCircle2Icon /><span>Approval only commits configuration. One computer must then start the initial merge; Tethera coordinates both directions without overwriting same-path differences.</span></div>
          )}

          {!mutationsEnabled ? <p className="mapping-error [margin-top:14px] [border:1px_solid_color-mix(in_oklab,_var(--destructive)_34%,_var(--border))] [border-radius:10px] [background:color-mix(in_oklab,_var(--destructive)_10%,_var(--surface))] [padding:10px_12px] [color:var(--destructive)] [font-size:12px]">{disabledReason}</p> : null}
          {request.message ? <p className="approval-status-note [margin:0] [border:1px_solid_var(--border)] [border-radius:10px] [background:color-mix(in_oklab,_var(--surface-sunken)_80%,_transparent)] [padding:10px_12px] [color:var(--muted-foreground)] [font-size:11.5px] [line-height:1.45]">{request.message}</p> : null}

          {compare ? (
            <CompareStatus
              phase={compare.phase}
              purpose={compare.kind === "verify" ? "verify" : "review"}
              thisComputer={localDevice.name}
              otherComputer={request.fromDeviceName}
              scannedFiles={compare.scannedFiles}
              elapsed={elapsed}
            />
          ) : null}

          {error ? <p className="mapping-error [margin-top:14px] [border:1px_solid_color-mix(in_oklab,_var(--destructive)_34%,_var(--border))] [border-radius:10px] [background:color-mix(in_oklab,_var(--destructive)_10%,_var(--surface))] [padding:10px_12px] [color:var(--destructive)] [font-size:12px]">{error}</p> : null}

          <DialogFooter>
            <Button variant="outline" disabled={working} onClick={() => void reject()}>
              {action === "reject" ? <RefreshCwIcon className="animate-spin" data-icon="inline-start" /> : <XIcon data-icon="inline-start" />}
              {action === "reject" ? "Rejecting…" : "Reject"}
            </Button>
            <Button
              disabled={!mutationsEnabled || working || !destinationPath || blockingWarnings > 0}
              title={!mutationsEnabled ? disabledReason : undefined}
              onClick={() => void approve()}
            >
              {working ? <RefreshCwIcon className="animate-spin" data-icon="inline-start" /> : <ShieldCheckIcon data-icon="inline-start" />}
              {action === "approve" ? "Approving…" : compare ? "Comparing…" : "Approve mapping"}
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

function approvalTruncatedDetail(scanLimit: number | null): string {
  if (scanLimit === null) {
    return "The comparison sampled only part of one or both folders. Ask the sender to add ignore rules, then refresh the comparison."
  }
  return `The comparison sampled the first ${scanLimit.toLocaleString("en-GB")} files on one or both computers. Ask the sender to raise the scan limit or add ignore rules, then refresh the comparison.`
}

function prettyMode(mode: string): string {
  if (mode === "two-way") return "Two-way"
  if (mode === "send-only") return "Receive from them"
  return "Send to them"
}
