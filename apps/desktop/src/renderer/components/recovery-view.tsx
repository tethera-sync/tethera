import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react"
import {
  ArchiveRestoreIcon,
  CheckCircle2Icon,
  CircleAlertIcon,
  FileWarningIcon,
  FolderOpenIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
} from "lucide-react"
import type {
  AppSnapshot,
  ConflictCopyInspection,
  ConflictInspection,
  RecoveryConflict,
  RecoveryState,
  SyncMode,
} from "@shared/contracts"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { formatBytes, formatDateTime } from "@/lib/format"
import { cn } from "@/lib/utils"

type RecoveryRequestState =
  | { status: "loading" }
  | { status: "ready"; data: RecoveryState; refreshError?: string }
  | { status: "error"; message: string }

type InspectionState =
  | { status: "loading"; conflictKey: string }
  | { status: "ready"; conflictKey: string; data: ConflictInspection }
  | { status: "error"; conflictKey: string; message: string }

export function RecoveryView({ snapshot }: { snapshot: AppSnapshot }) {
  const [request, setRequest] = useState<RecoveryRequestState>({ status: "loading" })
  const [refreshing, setRefreshing] = useState(false)
  const [selected, setSelected] = useState<RecoveryConflict>()
  const refreshGeneration = useRef(0)
  const recoveryToken = snapshot.folders
    .map((folder) => `${folder.id}:${folder.conflictCount ?? 0}:${folder.recoveryIssueCount ?? 0}`)
    .sort()
    .join("\0")

  const refresh = useCallback(async () => {
    const generation = refreshGeneration.current + 1
    refreshGeneration.current = generation
    if (snapshot.mappingStore.status !== "ready") {
      setRequest({
        status: "error",
        message: snapshot.mappingStore.detail ?? "Recovery information is unavailable until the mapping database is ready.",
      })
      setRefreshing(false)
      return
    }
    setRequest((current) => current.status === "ready" ? { ...current, refreshError: undefined } : { status: "loading" })
    setRefreshing(true)
    try {
      const data = await window.folderSync.getRecoveryState()
      if (generation === refreshGeneration.current) setRequest({ status: "ready", data })
    } catch (error) {
      if (generation === refreshGeneration.current) {
        const message = errorMessage(error, "Recovery information could not be loaded.")
        setRequest((current) => current.status === "ready"
          ? { ...current, refreshError: message }
          : { status: "error", message })
      }
    } finally {
      if (generation === refreshGeneration.current) setRefreshing(false)
    }
  }, [recoveryToken, snapshot.mappingStore.detail, snapshot.mappingStore.status])

  useEffect(() => {
    void refresh()
    return () => {
      refreshGeneration.current += 1
    }
  }, [refresh])

  const selectedFolder = selected
    ? snapshot.folders.find((folder) => folder.id === selected.mappingId)
    : undefined

  return (
    <div className="grid w-full max-w-[1180px] gap-4 self-center">
      <section className="flex items-center justify-between gap-6 max-[760px]:items-start">
        <div>
          <h2 className="m-0 text-[17px] font-semibold tracking-[-0.03em]">Conflicts and recovery</h2>
          <p className="mt-1 max-w-[80ch] text-[11.5px] leading-5 text-[var(--muted-foreground)]">
            Tethera leaves uncertain files untouched. Review both copies before choosing a version.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={refreshing}>
          <RefreshCwIcon className={refreshing ? "animate-spin" : undefined} data-icon="inline-start" />
          Refresh
        </Button>
      </section>

      {request.status === "loading" ? (
        <RecoveryMessage
          announcement="status"
          icon={<RefreshCwIcon className="animate-spin" />}
          title="Loading recovery state"
          detail="Reading durable conflicts and replacement-journal issues from the sync engine."
        />
      ) : null}

      {request.status === "error" ? (
        <RecoveryMessage
          announcement="alert"
          tone="danger"
          icon={<CircleAlertIcon />}
          title="Recovery state unavailable"
          detail={request.message}
          action={<Button size="sm" variant="outline" onClick={() => void refresh()}>Try again</Button>}
        />
      ) : null}

      {request.status === "ready" && request.refreshError ? (
        <Alert variant="destructive" className="flex items-center justify-between gap-4 rounded-lg border border-[color-mix(in_oklab,var(--danger)_34%,var(--border))] bg-[color-mix(in_oklab,var(--danger)_9%,var(--surface))] px-4 py-3 text-xs text-[var(--danger)]">
          <AlertDescription>{request.refreshError} The last loaded recovery state remains visible.</AlertDescription>
          <Button size="sm" variant="outline" onClick={() => void refresh()}>Try again</Button>
        </Alert>
      ) : null}

      {request.status === "ready" && request.data.issues.length > 0 ? (
        <section className="overflow-hidden rounded-[var(--radius-card)] border border-[color-mix(in_oklab,var(--danger)_30%,var(--border))] bg-[var(--surface)]">
          <div className="flex items-start gap-3 border-b border-[var(--border)] bg-[color-mix(in_oklab,var(--danger)_8%,var(--surface))] px-4 py-3">
            <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-[var(--danger)]" />
            <div>
              <h3 className="m-0 text-xs font-semibold">Replacement recovery needs attention</h3>
              <p className="mt-1 text-[10.5px] leading-4 text-[var(--muted-foreground)]">These paths remain blocked; Tethera will not resolve another conflict over uncertain journal evidence.</p>
            </div>
          </div>
          <div className="divide-y divide-[var(--border)]">
            {request.data.issues.map((issue) => (
              <div key={issue.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-4 px-4 py-3 max-[760px]:grid-cols-1">
                <div className="min-w-0">
                  <strong className="block truncate text-xs" title={issue.path}>{issue.path}</strong>
                  <span className="mt-1 block text-[10.5px] text-[var(--muted-foreground)]">{issue.folderName} · {issue.detail}</span>
                </div>
                <Badge variant="danger">{issue.state === "integrity-failed" ? "Integrity failed" : "Recovery required"}</Badge>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {request.status === "ready" && request.data.conflicts.length > 0 ? (
        <section className="overflow-hidden rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--elevation-card)]">
          <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
            <div>
              <h3 className="m-0 text-xs font-semibold">File conflicts</h3>
              <p className="mt-1 text-[10.5px] text-[var(--muted-foreground)]">No copy changes until an exact version is selected and verified.</p>
            </div>
            <Badge variant="warning">{request.data.conflicts.length} waiting</Badge>
          </div>
          <div className="divide-y divide-[var(--border)]">
            {request.data.conflicts.map((conflict) => (
              <article key={`${conflict.mappingId}:${conflict.path}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 py-3 max-[760px]:grid-cols-1">
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <FileWarningIcon className="size-4 shrink-0 text-[var(--warning)]" />
                    <strong className="truncate text-xs" title={conflict.path}>{conflict.path}</strong>
                    {conflict.resolutionQueued ? <Badge variant="info">Queued</Badge> : null}
                  </div>
                  <p className="ml-6 mt-1 text-[10.5px] leading-4 text-[var(--muted-foreground)]">
                    {conflict.folderName} · {conflictLabel(conflict)}
                    {conflict.detectedAt ? ` · ${formatDateTime(conflict.detectedAt)}` : ""}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setSelected(conflict)}
                  disabled={conflict.resolutionQueued}
                >
                  {conflict.resolutionQueued ? <RefreshCwIcon className="animate-spin" data-icon="inline-start" /> : null}
                  {conflict.resolutionQueued ? "Resolving…" : "Review copies"}
                </Button>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {request.status === "ready" && request.data.conflicts.length === 0 && request.data.issues.length === 0 ? (
        <RecoveryMessage
          icon={<ShieldCheckIcon />}
          title="Nothing needs recovery"
          detail="Tethera has no unresolved file conflicts or replacement-journal issues on this computer."
        />
      ) : null}

      <ConflictResolutionDialog
        conflict={selected}
        mode={selectedFolder?.mode ?? "two-way"}
        open={selected !== undefined}
        onOpenChange={(open) => { if (!open) setSelected(undefined) }}
        onResolved={async () => {
          setSelected(undefined)
          await refresh()
        }}
      />
    </div>
  )
}

function ConflictResolutionDialog({
  conflict,
  mode,
  open,
  onOpenChange,
  onResolved,
}: {
  conflict?: RecoveryConflict
  mode: SyncMode
  open: boolean
  onOpenChange: (open: boolean) => void
  onResolved: () => Promise<void>
}) {
  const [inspection, setInspection] = useState<InspectionState>({ status: "loading", conflictKey: "" })
  const [winnerDeviceId, setWinnerDeviceId] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string>()
  const inspectionGeneration = useRef(0)
  const conflictKey = conflict ? `${conflict.mappingId}\0${conflict.path}` : ""

  const inspect = useCallback(async () => {
    if (!conflict) return
    const generation = inspectionGeneration.current + 1
    inspectionGeneration.current = generation
    const inspectedKey = `${conflict.mappingId}\0${conflict.path}`
    setInspection({ status: "loading", conflictKey: inspectedKey })
    setWinnerDeviceId("")
    setSubmitError(undefined)
    try {
      const data = await window.folderSync.inspectFileConflict(conflict)
      if (generation === inspectionGeneration.current) {
        setInspection({ status: "ready", conflictKey: inspectedKey, data })
      }
    } catch (error) {
      if (generation === inspectionGeneration.current) {
        setInspection({
          status: "error",
          conflictKey: inspectedKey,
          message: errorMessage(error, "The conflict copies could not be inspected."),
        })
      }
    }
  }, [conflict])

  useEffect(() => {
    if (open) {
      void inspect()
    } else {
      inspectionGeneration.current += 1
      setInspection({ status: "loading", conflictKey: "" })
      setWinnerDeviceId("")
      setSubmitError(undefined)
    }
  }, [inspect, open])

  const activeInspection = inspection.status === "ready" && inspection.conflictKey === conflictKey
    ? inspection.data
    : undefined
  const activeInspectionError = inspection.status === "error" && inspection.conflictKey === conflictKey
    ? inspection.message
    : undefined
  const selectedCopy = activeInspection
    ? [activeInspection.local, activeInspection.remote].find((copy) => copy.deviceId === winnerDeviceId)
    : undefined

  async function resolve() {
    if (
      !conflict ||
      !selectedCopy ||
      !activeInspection ||
      activeInspection.local.digest === undefined ||
      activeInspection.local.size === undefined ||
      activeInspection.remote.digest === undefined ||
      activeInspection.remote.size === undefined
    ) return
    setSubmitting(true)
    setSubmitError(undefined)
    try {
      await window.folderSync.resolveFileConflict({
        mappingId: conflict.mappingId,
        path: conflict.path,
        winnerDeviceId: selectedCopy.deviceId,
        inspectedCopies: [
          {
            deviceId: activeInspection.local.deviceId,
            digest: activeInspection.local.digest,
            size: activeInspection.local.size,
          },
          {
            deviceId: activeInspection.remote.deviceId,
            digest: activeInspection.remote.digest,
            size: activeInspection.remote.size,
          },
        ],
      })
      await onResolved()
    } catch (error) {
      setSubmitError(errorMessage(error, "The selected version could not be queued."))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!submitting) onOpenChange(nextOpen) }}>
      <DialogContent className="max-w-[min(760px,calc(100%-2rem))]" showCloseButton={!submitting}>
        <DialogHeader>
          <DialogTitle>Choose the version to keep</DialogTitle>
          <DialogDescription className="break-all">
            {conflict ? `${conflict.folderName} · ${conflict.path}` : "Inspecting conflict"}
          </DialogDescription>
        </DialogHeader>

        {!activeInspection && !activeInspectionError ? (
          <div className="my-8 grid place-items-center gap-3 text-center text-sm text-[var(--muted-foreground)]" role="status" aria-live="polite">
            <RefreshCwIcon className="size-5 animate-spin" />
            <span>Hashing the current files on both computers…</span>
          </div>
        ) : null}

        {activeInspectionError ? (
          <Alert variant="destructive" className="mt-5 rounded-lg border border-[color-mix(in_oklab,var(--danger)_34%,var(--border))] bg-[color-mix(in_oklab,var(--danger)_9%,var(--surface))] p-3 text-xs text-[var(--danger)]">
            <AlertDescription className="m-0 leading-5">{activeInspectionError}</AlertDescription>
            <Button className="mt-3" variant="outline" size="sm" onClick={() => void inspect()}>Try again</Button>
          </Alert>
        ) : null}

        {activeInspection ? (
          <>
            <RadioGroup
              value={winnerDeviceId ?? ""}
              onValueChange={(value: unknown) => setWinnerDeviceId(String(value))}
              className="mt-5 grid grid-cols-2 gap-3 max-[760px]:grid-cols-1"
              aria-label="Version to keep"
            >
              <ConflictCopyCard
                copy={activeInspection.local}
                selected={winnerDeviceId === activeInspection.local.deviceId}
                disabled={!copyAllowed(activeInspection.local, "local", mode) || submitting}
                reason={copyDisabledReason(activeInspection.local, "local", mode)}
                onReveal={async () => {
                  try {
                    await window.folderSync.revealConflictFile(activeInspection.conflict)
                  } catch (error) {
                    setSubmitError(errorMessage(error, "The file could not be shown in its folder."))
                  }
                }}
              />
              <ConflictCopyCard
                copy={activeInspection.remote}
                selected={winnerDeviceId === activeInspection.remote.deviceId}
                disabled={!copyAllowed(activeInspection.remote, "remote", mode) || submitting}
                reason={copyDisabledReason(activeInspection.remote, "remote", mode)}
              />
            </RadioGroup>
            <div className="mt-4 flex items-start gap-2 rounded-lg bg-[var(--secondary)] p-3 text-[10.5px] leading-4 text-[var(--muted-foreground)]">
              <ArchiveRestoreIcon className="mt-0.5 size-4 shrink-0" />
              <span>The other copy is verified and archived on the computer being changed before the selected version is installed.</span>
            </div>
          </>
        ) : null}

        {submitError ? (
          <Alert variant="destructive" className="mt-4 rounded-lg border border-[color-mix(in_oklab,var(--danger)_34%,var(--border))] bg-[color-mix(in_oklab,var(--danger)_9%,var(--surface))] p-3 text-xs text-[var(--danger)]">
            <AlertDescription>{submitError}</AlertDescription>
          </Alert>
        ) : null}

        <DialogFooter>
          <Button variant="outline" disabled={submitting} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!selectedCopy || submitting || !activeInspection} onClick={() => void resolve()}>
            {submitting ? <RefreshCwIcon className="animate-spin" data-icon="inline-start" /> : <CheckCircle2Icon data-icon="inline-start" />}
            {submitting ? "Queuing…" : "Use selected version"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ConflictCopyCard({
  copy,
  selected,
  disabled,
  reason,
  onReveal,
}: {
  copy: ConflictCopyInspection
  selected: boolean
  disabled: boolean
  reason?: string
  onReveal?: () => Promise<void>
}) {
  const reasonId = useId()
  const [revealing, setRevealing] = useState(false)

  async function reveal() {
    if (!onReveal || revealing) return
    setRevealing(true)
    try {
      await onReveal()
    } finally {
      setRevealing(false)
    }
  }

  return (
    <div className={cn(
      "rounded-xl border bg-[var(--surface)] p-4 transition-[border-color,box-shadow,opacity]",
      selected ? "border-[var(--primary)] shadow-[0_0_0_2px_color-mix(in_oklab,var(--primary)_18%,transparent)]" : "border-[var(--border)]",
      disabled && "opacity-55",
    )}>
      <label className={cn("block", disabled ? "cursor-not-allowed" : "cursor-pointer")}>
        <span className="flex items-start gap-3">
          <RadioGroupItem
            value={copy.deviceId}
            disabled={disabled}
            aria-describedby={reason ? reasonId : undefined}
            className="mt-0.5"
          />
          <span className="min-w-0 flex-1">
            <strong className="block truncate text-xs">{copy.deviceName}</strong>
            <span className="mt-1 block text-[10px] text-[var(--muted-foreground)]">
              {copy.location === "this-computer" ? "This computer" : "Paired computer"}
            </span>
          </span>
          <Badge variant={copy.present ? "success" : "warning"}>{copy.present ? "Available" : "Missing"}</Badge>
        </span>
      </label>
      {copy.present ? (
        <dl className="mt-4 grid gap-2 border-t border-[var(--border)] pt-3 text-[10.5px] [&>div]:grid [&>div]:grid-cols-[72px_minmax(0,1fr)] [&>div]:gap-2 [&_dd]:m-0 [&_dt]:text-[var(--muted-foreground)]">
          <div><dt>Size</dt><dd>{formatBytes(copy.size ?? 0)}</dd></div>
          <div><dt>Modified</dt><dd className="truncate">{copy.modifiedAt ? formatDateTime(copy.modifiedAt) : "Unknown"}</dd></div>
          <div><dt>SHA-256</dt><dd className="break-all font-mono select-all">{copy.digest}</dd></div>
        </dl>
      ) : null}
      {reason ? <p id={reasonId} className="mt-3 text-[10px] leading-4 text-[var(--muted-foreground)]">{reason}</p> : null}
      {onReveal && copy.present ? (
        <Button className="mt-3" variant="outline" size="sm" disabled={revealing} onClick={() => void reveal()}>
          {revealing ? <RefreshCwIcon className="animate-spin" data-icon="inline-start" /> : <FolderOpenIcon data-icon="inline-start" />}
          {revealing ? "Showing…" : "Show in folder"}
        </Button>
      ) : null}
    </div>
  )
}

function RecoveryMessage({
  icon,
  title,
  detail,
  tone = "neutral",
  announcement,
  action,
}: {
  icon: ReactNode
  title: string
  detail: string
  tone?: "neutral" | "danger"
  announcement?: "status" | "alert"
  action?: ReactNode
}) {
  return (
    <section className={cn(
      "grid min-h-[220px] place-items-center content-center rounded-[var(--radius-card)] border bg-[var(--surface)] p-8 text-center",
      tone === "danger" ? "border-[color-mix(in_oklab,var(--danger)_30%,var(--border))]" : "border-[var(--border)]",
    )} role={announcement} aria-live={announcement === "status" ? "polite" : undefined}>
      <div className={cn(
        "grid size-10 place-items-center rounded-[10px] bg-[var(--secondary)] [&_svg]:size-[18px]",
        tone === "danger" ? "text-[var(--danger)]" : "text-[var(--muted-foreground)]",
      )}>{icon}</div>
      <h3 className="mb-1 mt-3 text-[15px] font-semibold">{title}</h3>
      <p className="m-0 max-w-[52ch] text-[11px] leading-5 text-[var(--muted-foreground)]">{detail}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </section>
  )
}

function conflictLabel(conflict: RecoveryConflict): string {
  if (conflict.kind === "simultaneous-modification") return "Edited on both computers"
  if (conflict.kind === "deletion-not-propagated") return "Missing on one computer"
  if (conflict.kind === "direction-blocked") return "Conflicts with the one-way direction"
  if (conflict.kind === "initial-merge") return "Different during the initial merge"
  return "No verified common baseline"
}

function copyAllowed(copy: ConflictCopyInspection, side: "local" | "remote", mode: SyncMode): boolean {
  if (!copy.present) return false
  if (side === "local" && mode === "receive-only") return false
  return side !== "remote" || mode !== "send-only"
}

function copyDisabledReason(copy: ConflictCopyInspection, side: "local" | "remote", mode: SyncMode): string | undefined {
  if (!copy.present) return "Deletion propagation is not enabled, so a missing copy cannot be selected."
  if (side === "local" && mode === "receive-only") return "This folder receives from the paired computer; the local copy cannot override that direction."
  if (side === "remote" && mode === "send-only") return "This folder sends from this computer; the paired copy cannot override that direction."
  return undefined
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}
