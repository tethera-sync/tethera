import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react"
import { ArchiveRestoreIcon, CircleAlertIcon, RefreshCwIcon } from "lucide-react"
import type { AppSnapshot, ArchiveHistory, ArchivedVersion, FolderSummary } from "@shared/contracts"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { formatBytes, formatDateTime, formatRelative } from "@/lib/format"
import { cn } from "@/lib/utils"

export type ArchiveHistoryRequestState =
  | { status: "loading" }
  | { status: "ready"; data: ArchiveHistory; refreshError?: string }
  | { status: "error"; message: string }

export type RestoreVersionOutcome = { status: "restored" } | { status: "failed"; message: string }

export type ArchiveHistoryLoadOutcome =
  | { status: "ready"; data: ArchiveHistory }
  | { status: "error"; message: string }

/**
 * Loads one folder's archive history and reports the outcome only when the
 * caller is still current. A result that arrives after the selection moved on
 * resolves to `undefined` so a stale response can never overwrite fresh state.
 */
export async function loadArchiveHistory(
  folderId: string,
  isCurrent: () => boolean,
  list: (folderId: string) => Promise<ArchiveHistory>,
): Promise<ArchiveHistoryLoadOutcome | undefined> {
  try {
    const data = await list(folderId)
    if (!isCurrent()) return undefined
    return { status: "ready", data }
  } catch (error) {
    if (!isCurrent()) return undefined
    return { status: "error", message: errorMessage(error, "Archive history could not be loaded.") }
  }
}

export function ArchiveHistoryView({ snapshot }: { snapshot: AppSnapshot }) {
  const activeFolders = snapshot.folders.filter((folder) => folder.setupStatus === "active")
  const activeFolderToken = activeFolders.map((folder) => folder.id).join("\0")
  const [selectedFolderId, setSelectedFolderId] = useState<string | undefined>(() => activeFolders[0]?.id)
  const [request, setRequest] = useState<ArchiveHistoryRequestState>({ status: "loading" })
  const [refreshing, setRefreshing] = useState(false)
  const [selectedEntryId, setSelectedEntryId] = useState<string>()
  const refreshGeneration = useRef(0)
  const folderSelectId = useId()
  const folderHelpId = useId()

  useEffect(() => {
    if (activeFolders.length === 0) {
      setSelectedFolderId(undefined)
      setSelectedEntryId(undefined)
      return
    }

    setSelectedFolderId((current) => (
      current && activeFolders.some((folder) => folder.id === current)
        ? current
        : activeFolders[0]?.id
    ))
  }, [activeFolderToken])

  useEffect(() => {
    setSelectedEntryId(undefined)
    setRequest({ status: "loading" })
  }, [selectedFolderId])

  const refresh = useCallback(async (options?: { replace?: boolean }) => {
    const folderId = selectedFolderId
    if (!folderId) return
    const generation = refreshGeneration.current + 1
    refreshGeneration.current = generation
    const isCurrent = (): boolean => generation === refreshGeneration.current
    setRefreshing(true)
    setRequest((current) => {
      if (options?.replace || current.status !== "ready") return { status: "loading" }
      return { ...current, refreshError: undefined }
    })
    const outcome = await loadArchiveHistory(folderId, isCurrent, (id) => window.folderSync.listArchivedVersions(id))
    if (!isCurrent() || !outcome) return
    if (outcome.status === "ready") {
      setRequest({ status: "ready", data: outcome.data })
    } else {
      setRequest((current) => (
        current.status === "ready"
          ? { ...current, refreshError: outcome.message }
          : { status: "error", message: outcome.message }
      ))
    }
    setRefreshing(false)
  }, [selectedFolderId])

  useEffect(() => {
    if (!selectedFolderId) return
    void refresh({ replace: true })
    return () => {
      refreshGeneration.current += 1
    }
  }, [refresh, selectedFolderId])

  const selectedFolder = activeFolders.find((folder) => folder.id === selectedFolderId)
  const readyVersions = request.status === "ready" ? request.data.versions : []
  const selectedVersion = selectedEntryId
    ? readyVersions.find((version) => version.entryId === selectedEntryId)
    : undefined

  return (
    <div className="grid w-full max-w-[1180px] gap-4 self-center">
      <section className="flex items-center justify-between gap-6 max-[760px]:items-start">
        <div>
          <h2 className="m-0 text-[17px] font-semibold tracking-[-0.03em]">Archived versions</h2>
          <p className="mt-1 max-w-[80ch] text-[11.5px] leading-5 text-[var(--muted-foreground)]">
            Browse the archived versions kept for each active folder and restore one when needed.
          </p>
        </div>
        {activeFolders.length > 0 ? (
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={refreshing || request.status === "loading"}>
            <RefreshCwIcon className={refreshing ? "animate-spin" : undefined} data-icon="inline-start" />
            Refresh
          </Button>
        ) : null}
      </section>

      {activeFolders.length === 0 ? (
        <ArchiveMessage
          announcement="status"
          icon={<ArchiveRestoreIcon />}
          title="No active folders"
          detail="Activate a folder first, then its archived versions will appear here for review and restore."
        />
      ) : (
        <>
          <section className="flex items-end justify-between gap-4 rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--surface)] p-4 max-[760px]:flex-col max-[760px]:items-stretch">
            <Field className="min-w-0 gap-0">
              <FieldLabel className="block text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--muted-foreground)]" htmlFor={folderSelectId}>
                Folder
              </FieldLabel>
              <NativeSelect
                id={folderSelectId}
                className="mt-2 min-w-[240px] max-[760px]:w-full"
                value={selectedFolderId ?? ""}
                onChange={(event) => setSelectedFolderId(event.target.value)}
                aria-describedby={folderHelpId}
              >
                {activeFolders.map((folder) => (
                  <NativeSelectOption key={folder.id} value={folder.id}>
                    {folder.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <FieldDescription id={folderHelpId} className="mt-2 text-[10.5px] leading-4 text-[var(--muted-foreground)]">
                {selectedFolder ? `${selectedFolder.name} is active and ready for history browsing.` : "Choose one of the active folders."}
              </FieldDescription>
            </Field>
          </section>
          <ArchiveHistoryContent
            request={request}
            isRefreshing={refreshing}
            selectedEntryId={selectedEntryId}
            onRetry={() => void refresh()}
            onSelectVersion={setSelectedEntryId}
          />
        </>
      )}

      <ArchiveRestoreDialog
        version={selectedVersion}
        folderName={request.status === "ready" ? request.data.folderName : selectedFolder?.name}
        open={selectedEntryId !== undefined}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setSelectedEntryId(undefined)
        }}
        onRestored={async () => {
          setSelectedEntryId(undefined)
          await refresh({ replace: true })
        }}
      />
    </div>
  )
}

export function ArchiveHistoryContent({
  request,
  isRefreshing = false,
  selectedEntryId,
  onRetry,
  onSelectVersion,
}: {
  request: ArchiveHistoryRequestState
  isRefreshing?: boolean
  selectedEntryId?: string
  onRetry: () => void
  onSelectVersion: (entryId: string) => void
}) {
  if (request.status === "loading") {
    return (
      <ArchiveMessage
        announcement="status"
        icon={<RefreshCwIcon className="animate-spin" />}
        title="Loading archived versions"
        detail="Reading the latest archive history for the selected folder."
      />
    )
  }

  if (request.status === "error") {
    return (
      <ArchiveMessage
        announcement="alert"
        tone="danger"
        icon={<CircleAlertIcon />}
        title="Archive history unavailable"
        detail={request.message}
        action={<Button size="sm" variant="outline" onClick={onRetry} disabled={isRefreshing}>Try again</Button>}
      />
    )
  }

  return (
    <>
      <p className="max-w-[42ch] text-right text-[10.5px] leading-4 text-[var(--muted-foreground)] max-[760px]:text-left">
        Showing history for {request.data.folderName}. Restoring a version archives the current content first so the change remains reversible.
      </p>

      {request.refreshError ? (
        <Alert variant="destructive"
          className="flex items-center justify-between gap-4 rounded-lg border border-[color-mix(in_oklab,var(--danger)_34%,var(--border))] bg-[color-mix(in_oklab,var(--danger)_9%,var(--surface))] px-4 py-3 text-xs text-[var(--danger)]"
        >
          <AlertDescription>{request.refreshError} The last loaded archive history remains visible.</AlertDescription>
          <Button size="sm" variant="outline" onClick={onRetry} disabled={isRefreshing}>
            Try again
          </Button>
        </Alert>
      ) : null}

      {request.data.truncated ? (
        <div
          className="flex items-start gap-3 rounded-lg border border-[color-mix(in_oklab,var(--info)_26%,var(--border))] bg-[color-mix(in_oklab,var(--info)_9%,var(--surface))] px-4 py-3 text-xs text-[var(--muted-foreground)]"
          role="note"
        >
          <Badge variant="info">Recent versions only</Badge>
          <span>Only the most recent archived versions are shown here. Older history still exists beyond this list.</span>
        </div>
      ) : null}

      {request.data.versions.length === 0 ? (
        <ArchiveMessage
          icon={<ArchiveRestoreIcon />}
          title="No archived versions yet"
          detail={`${request.data.folderName} has not produced any archived versions that can be restored yet.`}
          action={<Button size="sm" variant="outline" onClick={onRetry} disabled={isRefreshing}>Refresh</Button>}
        />
      ) : (
        <section className="overflow-hidden rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--elevation-card)]">
          <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
            <div>
              <h3 className="m-0 text-xs font-semibold">Version history</h3>
              <p className="mt-1 text-[10.5px] text-[var(--muted-foreground)]">
                Select a version to restore the file and archive the current content first.
              </p>
            </div>
            <Badge variant="neutral">{request.data.versions.length} shown</Badge>
          </div>

          <ul className="divide-y divide-[var(--border)]">
            {request.data.versions.map((version) => (
              <ArchiveVersionRow
                key={version.entryId}
                version={version}
                selected={selectedEntryId === version.entryId}
                onRestore={() => onSelectVersion(version.entryId)}
              />
            ))}
          </ul>
        </section>
      )}
    </>
  )
}

export function ArchiveVersionRow({
  version,
  selected,
  onRestore,
}: {
  version: ArchivedVersion
  selected: boolean
  onRestore: () => void
}) {
  const reasonId = useId()
  const archivedDateTime = formatDateTime(version.archivedAt)
  const originLabel = version.origin === "sync" ? "Replaced by sync" : "Replaced by a restore"
  const availabilityLabel = version.availability === "available"
    ? "Available"
    : version.availability === "missing"
      ? "Missing"
      : "Corrupt"

  return (
    <li className={cn(
      "grid grid-cols-[minmax(0,1fr)_auto] items-start gap-4 px-4 py-3 max-[760px]:grid-cols-1",
      selected && "bg-[color-mix(in_oklab,var(--primary)_5%,var(--surface))]",
    )}>
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <strong className="truncate text-xs" title={version.path}>{version.path}</strong>
          <Badge
            variant={version.availability === "available" ? "success" : version.availability === "missing" ? "warning" : "danger"}
          >
            {availabilityLabel}
          </Badge>
        </div>
        <dl className="mt-2 grid gap-2 text-[10.5px] sm:grid-cols-3 [&>div]:grid [&>div]:grid-cols-[68px_minmax(0,1fr)] [&>div]:gap-2 [&_dd]:m-0 [&_dt]:text-[var(--muted-foreground)]">
          <div>
            <dt>Archived</dt>
            <dd>
              <time dateTime={version.archivedAt} title={archivedDateTime}>
                {formatRelative(version.archivedAt)}
              </time>
              <span className="text-[var(--muted-foreground)]"> · {archivedDateTime}</span>
            </dd>
          </div>
          <div>
            <dt>Size</dt>
            <dd>{formatBytes(version.replacedSize)}</dd>
          </div>
          <div>
            <dt>Origin</dt>
            <dd>{originLabel}</dd>
          </div>
        </dl>
        {version.restorable ? null : (
          <p id={reasonId} className="mt-3 text-[10.5px] leading-4 text-[var(--muted-foreground)]">
            {version.unavailableReason ?? "This archived version cannot currently be restored."}
          </p>
        )}
      </div>

      <Button
        variant="outline"
        size="sm"
        disabled={!version.restorable}
        aria-describedby={!version.restorable ? reasonId : undefined}
        onClick={onRestore}
      >
        Restore
      </Button>
    </li>
  )
}

export function ArchiveRestoreDialogBody({
  version,
}: {
  version?: ArchivedVersion
}) {
  return (
    <>
      <p className="mt-4 text-sm leading-6 text-[var(--foreground)]">
        The file at this path will be replaced with the archived version you selected. The current content will be archived first so the restore remains reversible.
      </p>

      {version ? (
        <dl className="mt-4 grid gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 text-[10.5px] [&>div]:grid [&>div]:grid-cols-[82px_minmax(0,1fr)] [&>div]:gap-2 [&_dd]:m-0 [&_dt]:text-[var(--muted-foreground)]">
          <div>
            <dt>Availability</dt>
            <dd>
              <Badge
                variant={version.availability === "available" ? "success" : version.availability === "missing" ? "warning" : "danger"}
              >
                {version.availability === "available" ? "Available" : version.availability === "missing" ? "Missing" : "Corrupt"}
              </Badge>
            </dd>
          </div>
          <div>
            <dt>Size</dt>
            <dd>{formatBytes(version.replacedSize)}</dd>
          </div>
          <div>
            <dt>Archived</dt>
            <dd>{formatDateTime(version.archivedAt)}</dd>
          </div>
        </dl>
      ) : null}
    </>
  )
}

function ArchiveRestoreDialog({
  version,
  folderName,
  open,
  onOpenChange,
  onRestored,
}: {
  version?: ArchivedVersion
  folderName?: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onRestored: () => Promise<void>
}) {
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string>()

  useEffect(() => {
    if (open) return
    setSubmitting(false)
    setSubmitError(undefined)
  }, [open])

  async function restore() {
    if (!version) return
    setSubmitting(true)
    setSubmitError(undefined)
    try {
      const outcome = await submitVersionRestore((entryId) => window.folderSync.restoreArchivedVersion(entryId), version.entryId)
      if (outcome.status === "failed") {
        setSubmitError(outcome.message)
        return
      }
      await onRestored()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!submitting) onOpenChange(nextOpen) }}>
      <DialogContent className="max-w-[760px]" showCloseButton={!submitting}>
        <DialogHeader>
          <DialogTitle>Restore this archived version?</DialogTitle>
          <DialogDescription className="break-all">
            {version ? `${folderName ?? "Selected folder"} · ${version.path}` : "Preparing restore"}
          </DialogDescription>
        </DialogHeader>

        <ArchiveRestoreDialogBody version={version} />

        {submitting ? (
          <div className="mt-4 flex items-start gap-2 rounded-lg bg-[var(--secondary)] p-3 text-[10.5px] leading-4 text-[var(--muted-foreground)]" role="status" aria-live="polite">
            <RefreshCwIcon className="mt-0.5 size-4 shrink-0 animate-spin" />
            <span>Restoring the file and archiving the current content first…</span>
          </div>
        ) : null}

        {submitError ? (
          <Alert variant="destructive" className="mt-4 rounded-lg border border-[color-mix(in_oklab,var(--danger)_34%,var(--border))] bg-[color-mix(in_oklab,var(--danger)_9%,var(--surface))] p-3 text-xs text-[var(--danger)]">
            <AlertDescription>
            {submitError}
            </AlertDescription>
          </Alert>
        ) : null}

        <DialogFooter>
          <Button variant="outline" disabled={submitting} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!version || submitting || !version.restorable} onClick={() => void restore()}>
            {submitting ? <RefreshCwIcon className="animate-spin" data-icon="inline-start" /> : <ArchiveRestoreIcon data-icon="inline-start" />}
            {submitting ? "Restoring…" : "Restore version"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export async function submitVersionRestore(
  restore: (entryId: string) => Promise<unknown>,
  entryId: string,
): Promise<RestoreVersionOutcome> {
  try {
    await restore(entryId)
    return { status: "restored" }
  } catch (error) {
    return { status: "failed", message: errorMessage(error, "The archived version could not be restored.") }
  }
}

export function ArchiveMessage({
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
  announcement?: "status" | "alert" | "note"
  action?: ReactNode
}) {
  return (
    <section
      className={cn(
        "grid min-h-[200px] place-items-center content-center rounded-[var(--radius-card)] border bg-[var(--surface)] p-8 text-center",
        tone === "danger" ? "border-[color-mix(in_oklab,var(--danger)_30%,var(--border))]" : "border-[var(--border)]",
      )}
      role={announcement}
      aria-live={announcement === "status" ? "polite" : undefined}
    >
      <div
        className={cn(
          "grid size-10 place-items-center rounded-[10px] bg-[var(--secondary)] [&_svg]:size-[18px]",
          tone === "danger" ? "text-[var(--danger)]" : "text-[var(--muted-foreground)]",
        )}
      >
        {icon}
      </div>
      <h3 className="mb-1 mt-3 text-[15px] font-semibold">{title}</h3>
      <p className="m-0 max-w-[54ch] text-[11px] leading-5 text-[var(--muted-foreground)]">{detail}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </section>
  )
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}
