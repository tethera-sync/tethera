import { useMemo, useRef, useState } from "react"
import {
  ArrowRightIcon,
  CircleAlertIcon,
  ExternalLinkIcon,
  FolderClockIcon,
  FolderIcon,
  Link2Icon,
  LockKeyholeIcon,
  PauseIcon,
  PlayIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from "lucide-react"
import type { AppSnapshot, FolderSummary } from "@shared/contracts"
import type { View } from "@/lib/navigation"
import { AddFolderDialog } from "@/components/add-folder-dialog"
import { CompactEmptyState } from "@/components/compact-empty-state"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Meter } from "@/components/ui/meter"
import { StatusPill } from "@/components/ui/status-pill"
import { formatRate, formatRelative, pretty, prettyMode, statusTone } from "@/lib/format"
import { folderStatusLabel, getLocalDevice, getPairedDevices, mappingMutationAvailability } from "@/lib/snapshot"

type FolderFilter = "all" | "active" | "paused" | "attention"

const folderFilters: Array<{ id: FolderFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "paused", label: "Paused" },
  { id: "attention", label: "Attention" },
]

export function FoldersView({ snapshot, onNavigate }: { snapshot: AppSnapshot; onNavigate: (view: View) => void }) {
  const [filter, setFilter] = useState<FolderFilter>("all")
  const localDevice = getLocalDevice(snapshot)
  const pairedDevice = getPairedDevices(snapshot)[0]
  const { enabled: mappingMutationsEnabled, reason: mappingMutationReason } = mappingMutationAvailability(
    snapshot.mappingStore,
  )

  const folders = useMemo(() => {
    if (filter === "active") return snapshot.folders.filter((folder) => !folder.paused && folder.status !== "paused")
    if (filter === "paused") return snapshot.folders.filter((folder) => folder.paused || folder.status === "paused")
    if (filter === "attention") return snapshot.folders.filter((folder) => folder.status === "needs-attention")
    return snapshot.folders
  }, [snapshot.folders, filter])

  return (
    <div className="page-stack [display:grid] [gap:16px] [width:100%] [max-width:1180px] [margin:0_auto]">
      <section className="section-intro [display:flex] [align-items:center] [justify-content:space-between] [gap:24px] [&_h2]:[margin:0] [&_h2]:[font-size:17px] [&_h2]:[font-weight:650] [&_h2]:[letter-spacing:-0.03em] [&_p]:[margin:3px_0_0] [&_p]:[max-width:80ch] [&_p]:[color:var(--muted-foreground)] [&_p]:[font-size:11.5px] [&_p]:[line-height:1.5]">
        <div>
          <h2>Folder mappings</h2>
          <p>Each mapping connects one folder here with one folder on the paired computer.</p>
        </div>
        {snapshot.folders.length > 0 ? (
          <div className="segmented [display:inline-flex] [gap:2px] [border:1px_solid_var(--border)] [border-radius:10px] [background:var(--surface-sunken)] [padding:3px] [&_button]:[height:28px] [&_button]:[border:0] [&_button]:[border-radius:7px] [&_button]:[background:transparent] [&_button]:[padding:0_12px] [&_button]:[color:var(--muted-foreground)] [&_button]:[font-size:11.5px] [&_button]:[font-weight:600] [&_button]:[transition:140ms_ease] [&_button:hover]:[color:var(--foreground)] [&_button[data-active='true']]:[background:var(--surface-strong)] [&_button[data-active='true']]:[color:var(--foreground)] [&_button[data-active='true']]:[box-shadow:0_1px_3px_oklch(0_0_0_/_0.2)]" role="group" aria-label="Filter folders">
            {folderFilters.map((option) => (
              <button
                key={option.id}
                type="button"
                data-active={filter === option.id}
                aria-pressed={filter === option.id}
                onClick={() => setFilter(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
        ) : (
          <Badge variant={pairedDevice ? "neutral" : "warning"}>{pairedDevice ? "Ready" : "Pairing required"}</Badge>
        )}
      </section>

      {!pairedDevice ? (
        <section className="pairing-gate-card [display:grid] [grid-template-columns:auto_minmax(0,_1fr)_auto] [align-items:center] [gap:16px] [border:1px_solid_var(--border)] [border-radius:var(--radius-card)] [background:var(--surface)] [padding:18px] max-[1100px]:[grid-template-columns:auto_minmax(0,_1fr)] max-[1100px]:[&>button]:[grid-column:2] max-[1100px]:[&>button]:[justify-self:start]">
          <div className="pairing-gate-icon [display:grid] [width:40px] [height:40px] [place-items:center] [border-radius:10px] [background:var(--secondary)] [color:var(--muted-foreground)] [&_svg]:[width:18px] [&_svg]:[height:18px]">
            <LockKeyholeIcon />
          </div>
          <div className="pairing-gate-copy [&_h2]:[margin:0_0_4px] [&_h2]:[font-size:14px] [&_h2]:[font-weight:640] [&>p]:[max-width:80ch] [&>p]:[margin:0] [&>p]:[color:var(--muted-foreground)] [&>p]:[font-size:11px] [&>p]:[line-height:1.5]">
            <h2>Pair a computer before adding folders</h2>
            <p>
              Tethera needs an approved device identity before it can browse a destination or create a mapping.
            </p>
          </div>
          <Button onClick={() => onNavigate("devices")}>
            <Link2Icon data-icon="inline-start" />
            Go to pairing
          </Button>
        </section>
      ) : null}

      {snapshot.mappings.outgoing.length > 0 ? (
        <section className="mapping-request-list [display:grid] [gap:8px]">
          {snapshot.mappings.outgoing.map((request) => (
            <div key={request.id} data-status={request.status} className="mapping-request-row [display:flex] [align-items:center] [justify-content:space-between] [gap:14px] [border:1px_solid_var(--border)] [border-radius:var(--radius-tile)] [padding:11px_13px] [background:var(--surface)] data-[status=failed]:[border-color:color-mix(in_oklab,var(--danger)_30%,var(--border))] data-[status=rejected]:[border-color:color-mix(in_oklab,var(--danger)_30%,var(--border))] [&>div]:[display:flex] [&>div]:[align-items:center] [&>div]:[gap:10px] [&>div]:[min-width:0] [&_svg]:[width:17px] [&_svg]:[color:var(--primary)] [&_span]:[display:grid] [&_span]:[gap:2px] [&_span]:[min-width:0] [&_strong]:[font-size:11px] [&_small]:[overflow:hidden] [&_small]:[text-overflow:ellipsis] [&_small]:[white-space:nowrap] [&_small]:[color:var(--muted-foreground)] [&_small]:[font-size:9.5px]">
              <div>
                <RefreshCwIcon className={request.status === "pending" ? "animate-spin" : undefined} />
                <span>
                  <strong>{request.proposal.name}</strong>
                  <small>{request.message ?? pretty(request.status)}</small>
                </span>
              </div>
              <Badge
                variant={
                  request.status === "approved" ? "success" : request.status === "rejected" || request.status === "failed" ? "danger" : "info"
                }
              >
                {pretty(request.status)}
              </Badge>
            </div>
          ))}
        </section>
      ) : null}

      {snapshot.mappingStore.status === "loading" ? (
        <section className="card [position:relative] [display:flex] [min-width:0] [flex-direction:column] [overflow:hidden] [border:1px_solid_var(--border)] [border-radius:var(--radius-card)] [background:var(--card-sheen)] [box-shadow:var(--elevation-card)]">
          <CompactEmptyState
            icon={RefreshCwIcon}
            title="Loading folder mappings"
            description="Tethera is reading the authoritative mapping database. No legacy snapshot is being shown while it loads."
          />
        </section>
      ) : snapshot.mappingStore.status !== "ready" ? null : snapshot.folders.length === 0 && pairedDevice ? (
        <section className="large-empty-state [display:grid] [min-height:220px] [place-items:center] [align-content:center] [border:1px_solid_var(--border)] [border-radius:var(--radius-card)] [background:var(--surface)] [padding:32px] [text-align:center] [&_h2]:[margin:13px_0_5px] [&_h2]:[font-size:15px] [&_h2]:[font-weight:640] [&_p]:[max-width:52ch] [&_p]:[margin:0_0_16px] [&_p]:[color:var(--muted-foreground)] [&_p]:[font-size:11px] [&_p]:[line-height:1.55]">
          <div className="large-empty-icon [display:grid] [width:40px] [height:40px] [place-items:center] [border-radius:10px] [background:var(--secondary)] [color:var(--muted-foreground)] [&_svg]:[width:18px] [&_svg]:[height:18px]">
            <FolderIcon />
          </div>
          <h2>No folders configured</h2>
          <p>
            {pairedDevice.status === "online"
              ? `Choose a folder on this computer and its destination on ${pairedDevice.name}.`
              : `${pairedDevice.name} must be online before you can add the first folder.`}
          </p>
          <AddFolderDialog
            localDevice={localDevice}
            pairedDevice={pairedDevice}
            onAdded={() => undefined}
            disabled={pairedDevice.status !== "online" || !mappingMutationsEnabled}
            disabledReason={
              !mappingMutationsEnabled
                ? mappingMutationReason
                : `${pairedDevice.name} must be online to browse and approve a mapping.`
            }
          />
        </section>
      ) : snapshot.folders.length > 0 ? (
        <>
          {!pairedDevice ? (
            <div className="attention-banner [display:flex] [align-items:center] [gap:12px] [border:1px_solid_color-mix(in_oklab,_var(--warning)_28%,_var(--border))] [border-radius:var(--radius-tile)] [background:color-mix(in_oklab,_var(--warning)_9%,_var(--surface))] [padding:12px_14px] [&>svg]:[width:17px] [&>svg]:[height:17px] [&>svg]:[flex:0_0_auto] [&>svg]:[color:var(--warning)] [&_strong]:[display:block] [&_span]:[display:block] [&_strong]:[font-size:12px] [&_span]:[margin-top:2px] [&_span]:[color:var(--muted-foreground)] [&_span]:[font-size:10.5px]">
              <CircleAlertIcon />
              <div>
                <strong>Existing mappings are inactive</strong>
                <span>These were created before pairing became mandatory. Pair a device before they can be used.</span>
              </div>
            </div>
          ) : null}
          {folders.length === 0 ? (
            <section className="card [position:relative] [display:flex] [min-width:0] [flex-direction:column] [overflow:hidden] [border:1px_solid_var(--border)] [border-radius:var(--radius-card)] [background:var(--card-sheen)] [box-shadow:var(--elevation-card)]">
              <CompactEmptyState
                icon={FolderClockIcon}
                title="No folders in this filter"
                description="Switch back to All to see every configured mapping."
              />
            </section>
          ) : (
            <section className="folder-grid [display:grid] [grid-template-columns:repeat(2,_minmax(0,_1fr))] [align-items:start] [gap:14px] max-[1100px]:[grid-template-columns:1fr]">
              {folders.map((folder) => (
                <FolderCard
                  key={folder.id}
                  folder={folder}
                  globallyPaused={snapshot.paused}
                  remoteDevice={folder.remoteDeviceId ? snapshot.devices.find((device) => device.id === folder.remoteDeviceId) : undefined}
                  mutationsEnabled={mappingMutationsEnabled}
                  disabledReason={mappingMutationReason}
                  onReviewRecovery={() => onNavigate("history")}
                />
              ))}
            </section>
          )}
        </>
      ) : null}
    </div>
  )
}

function FolderCard({
  folder,
  globallyPaused,
  remoteDevice,
  mutationsEnabled,
  disabledReason,
  onReviewRecovery,
}: {
  folder: FolderSummary
  globallyPaused: boolean
  remoteDevice?: AppSnapshot["devices"][number]
  mutationsEnabled: boolean
  disabledReason: string
  onReviewRecovery: () => void
}) {
  type PendingAction = "pause" | "resume" | "remove" | "sync" | "reveal"
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const pendingActionRef = useRef<PendingAction | null>(null)
  const paused = folder.paused || folder.status === "paused"

  async function runAction(action: PendingAction, operation: () => Promise<unknown>, fallback: string) {
    if (pendingActionRef.current) return
    pendingActionRef.current = action
    setPendingAction(action)
    setActionError(null)
    try {
      await operation()
    } catch (caught) {
      setActionError(caught instanceof Error && caught.message ? caught.message : fallback)
    } finally {
      pendingActionRef.current = null
      setPendingAction(null)
    }
  }

  async function setPaused() {
    await runAction(paused ? "resume" : "pause", () => window.folderSync.setFolderPaused(folder.id, !paused), `Unable to ${paused ? "resume" : "pause"} this folder.`)
  }

  async function remove() {
    if (pendingActionRef.current) return
    const confirmed = window.confirm(
      `Remove “${folder.name}” from Tethera? Files on both computers will be left untouched.`,
    )
    if (confirmed) {
      await runAction("remove", () => window.folderSync.removeFolder(folder.id), "Unable to remove this folder mapping.")
    }
  }

  async function startSync() {
    await runAction("sync", () => window.folderSync.startInitialSync(folder.id), "Unable to start the initial merge.")
  }

  const pending = pendingAction !== null
  const initialSyncBlockedReason = paused
    ? "Resume this folder before starting the initial merge."
    : globallyPaused
      ? "Resume all syncing before starting the initial merge."
      : !remoteDevice
        ? "The paired computer for this folder is unavailable."
        : remoteDevice.status !== "online"
          ? `${remoteDevice.name} must be online before starting the initial merge.`
          : undefined

  return (
    <article className="folder-card [position:relative] [overflow:hidden] [border:1px_solid_var(--border)] [border-radius:var(--radius-card)] [background:var(--surface)] [box-shadow:var(--elevation-card)]">
      <div className="folder-card-head [display:flex] [align-items:center] [gap:11px] [padding:15px_15px_13px] [&_h3]:[margin:0] [&_h3]:[font-size:14.5px] [&_h3]:[font-weight:640] [&_h3]:[letter-spacing:-0.02em]">
        <div className="icon-tile [display:grid] [width:36px] [height:36px] [flex:0_0_auto] [place-items:center] [border-radius:11px] [background:color-mix(in_oklab,_var(--primary)_12%,_var(--surface-strong))] [color:var(--primary)] [box-shadow:inset_0_0_0_1px_color-mix(in_oklab,_var(--primary)_16%,_transparent)] [&_svg]:[width:17px] [&_svg]:[height:17px] [&[data-size='lg']]:[width:46px] [&[data-size='lg']]:[height:46px] [&[data-size='lg']]:[border-radius:14px] [&[data-size='lg']_svg]:[width:21px] [&[data-size='lg']_svg]:[height:21px] [&[data-tone='neutral']]:[background:var(--secondary)] [&[data-tone='neutral']]:[color:var(--muted-foreground)] [&[data-tone='neutral']]:[box-shadow:none] [&[data-tone='warning']]:[background:color-mix(in_oklab,_var(--warning)_14%,_var(--surface-strong))] [&[data-tone='warning']]:[color:var(--warning)] [&[data-tone='warning']]:[box-shadow:inset_0_0_0_1px_color-mix(in_oklab,_var(--warning)_20%,_transparent)] [&[data-tone='danger']]:[background:color-mix(in_oklab,_var(--danger)_14%,_var(--surface-strong))] [&[data-tone='danger']]:[color:var(--danger)] [&[data-tone='danger']]:[box-shadow:inset_0_0_0_1px_color-mix(in_oklab,_var(--danger)_20%,_transparent)] [&[data-size='sm']]:[width:30px] [&[data-size='sm']]:[height:30px] [&[data-size='sm']]:[border-radius:9px] [&[data-size='sm']_svg]:[width:15px] [&[data-size='sm']_svg]:[height:15px]" data-tone={paused ? "neutral" : undefined}>
          <FolderIcon />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate">{folder.name}</h3>
            <StatusPill tone={statusTone(folder.status)} pulse={folder.status === "syncing"}>
              {folderStatusLabel(folder)}
            </StatusPill>
          </div>
          <p className="mt-1 truncate text-[11px] text-[var(--muted-foreground)]">{prettyMode(folder.mode)}</p>
        </div>
      </div>

      <div className="path-map [display:grid] [grid-template-columns:minmax(0,_1fr)_24px_minmax(0,_1fr)] [align-items:center] [gap:8px] [border-block:1px_solid_color-mix(in_oklab,_var(--border)_70%,_transparent)] [background:var(--surface-sunken)] [padding:12px_15px]">
        <PathBlock
          label="This computer"
          path={folder.localPath}
          onReveal={() => runAction("reveal", () => window.folderSync.revealPath(folder.localPath), "Unable to reveal this folder.")}
          revealDisabled={pending}
        />
        <div className="path-arrow [display:grid] [place-items:center] [color:var(--primary)] [&_svg]:[width:14px] [&_svg]:[height:14px]">
          <ArrowRightIcon />
        </div>
        <PathBlock label="Paired computer" path={folder.remotePath} />
      </div>

      {folder.progress !== undefined ? (
        <div className="folder-progress [padding:13px_15px_0]">
          <Meter
            label={folder.currentAction ?? "Transferring"}
            value={folder.progress}
            readout={folder.bytesPerSecond ? formatRate(folder.bytesPerSecond) : `${Math.round(folder.progress * 100)}%`}
          />
        </div>
      ) : null}

      {folder.currentAction && folder.progress === undefined ? (
        <div className="folder-action-note [display:flex] [align-items:center] [gap:8px] [margin:12px_15px_0] [border-radius:8px] [background:color-mix(in_oklab,_var(--primary)_9%,_var(--surface))] [padding:8px_10px] [color:var(--muted-foreground)] [font-size:10px] [&_svg]:[width:14px] [&_svg]:[height:14px] [&_svg]:[color:var(--primary)]" role={folder.status === "needs-attention" ? "alert" : undefined}>
          {folder.status === "needs-attention" ? <CircleAlertIcon /> : <ShieldCheckIcon />}
          <span>{folder.currentAction}</span>
        </div>
      ) : null}

      {actionError ? (
        <div className="folder-action-error [margin:12px_15px_0] [border-radius:8px] [background:color-mix(in_oklab,_var(--danger)_10%,_var(--surface))] [padding:8px_10px] [color:var(--danger)] [font-size:10px]" role="alert">
          {actionError} Try the action again.
        </div>
      ) : null}

      <div className="folder-stats [display:grid] [grid-template-columns:repeat(3,_1fr)] [gap:1px] [margin-top:13px] [background:color-mix(in_oklab,_var(--border)_70%,_transparent)] [&>div]:[background:var(--surface)] [&>div]:[padding:12px_15px] [&_span]:[display:block] [&_span]:[color:var(--muted-foreground)] [&_span]:[font-size:9.5px] [&_span]:[font-weight:550] [&_strong]:[display:block] [&_strong]:[margin-top:3px] [&_strong]:[font-size:11.5px] [&_strong]:[font-weight:620] [&_strong]:[font-variant-numeric:tabular-nums]">
        <div>
          <span>Files</span>
          <strong>{folder.fileCount?.toLocaleString("en-GB") ?? "Not scanned"}</strong>
        </div>
        <div>
          <span>Ignored rules</span>
          <strong>{folder.ignorePatterns.length}</strong>
        </div>
        <div>
          <span>Last sync</span>
          <strong>{folder.lastSyncedAt ? formatRelative(folder.lastSyncedAt) : "Never"}</strong>
        </div>
      </div>
      {folder.setupStatus === "ready-for-initial-sync" && initialSyncBlockedReason ? (
        <div className="folder-sync-blocked [padding:0_15px_10px] [color:var(--muted-foreground)] [font-size:10px]" role="status">
          {initialSyncBlockedReason}
        </div>
      ) : null}

      <div className="folder-card-footer [display:flex] [align-items:center] [gap:6px] [border-top:1px_solid_color-mix(in_oklab,_var(--border)_70%,_transparent)] [padding:10px_12px]">
        {folder.setupStatus === "ready-for-initial-sync" ? (
          <Button
            size="sm"
            onClick={startSync}
            disabled={!mutationsEnabled || pending || paused || folder.status === "syncing" || initialSyncBlockedReason !== undefined}
            title={!mutationsEnabled ? disabledReason : initialSyncBlockedReason}
          >
            <RefreshCwIcon data-icon="inline-start" />
            {pendingAction === "sync" ? "Starting…" : folder.status === "syncing" ? "Merging…" : "Start initial merge"}
          </Button>
        ) : null}
        {(folder.conflictCount ?? 0) + (folder.recoveryIssueCount ?? 0) > 0 ? (
          <Button size="sm" variant="outline" onClick={onReviewRecovery}>
            <CircleAlertIcon data-icon="inline-start" />Review recovery
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          onClick={setPaused}
          disabled={!mutationsEnabled || pending}
          title={!mutationsEnabled ? disabledReason : undefined}
        >
          {paused ? <PlayIcon data-icon="inline-start" /> : <PauseIcon data-icon="inline-start" />}
          {pendingAction === "resume" ? "Resuming…" : pendingAction === "pause" ? "Pausing…" : paused ? "Resume" : "Pause"}
        </Button>
        <Button
          className="ml-auto"
          size="icon-sm"
          variant="ghost"
          aria-label={pendingAction === "remove" ? `Removing ${folder.name}` : `Remove ${folder.name}`}
          onClick={remove}
          disabled={!mutationsEnabled || pending}
          title={!mutationsEnabled ? disabledReason : undefined}
        >
          <Trash2Icon />
        </Button>
      </div>
    </article>
  )
}

function PathBlock({ label, path, onReveal, revealDisabled }: { label: string; path: string; onReveal?: () => void; revealDisabled?: boolean }) {
  return (
    <div className="path-block [min-width:0] [&>span]:[display:block] [&>span]:[margin-bottom:4px] [&>span]:[color:var(--muted-foreground)] [&>span]:[font-size:9px] [&>span]:[font-weight:700] [&>span]:[letter-spacing:0.07em] [&>span]:[text-transform:uppercase] [&>div]:[display:flex] [&>div]:[min-width:0] [&>div]:[align-items:center] [&>div]:[gap:5px] [&_code]:[overflow:hidden] [&_code]:[min-width:0] [&_code]:[color:var(--foreground)] [&_code]:[font-family:ui-monospace,_SFMono-Regular,_Menlo,_monospace] [&_code]:[font-size:10.5px] [&_code]:[text-overflow:ellipsis] [&_code]:[white-space:nowrap] [&_button]:[display:grid] [&_button]:[width:20px] [&_button]:[height:20px] [&_button]:[flex:0_0_auto] [&_button]:[place-items:center] [&_button]:[border:0] [&_button]:[border-radius:5px] [&_button]:[background:transparent] [&_button]:[color:var(--muted-foreground)] [&_button:hover]:[background:var(--accent)] [&_button:hover]:[color:var(--foreground)] [&_button_svg]:[width:11px] [&_button_svg]:[height:11px]">
      <span>{label}</span>
      <div>
        <code title={path}>{path}</code>
        {onReveal ? (
          <button type="button" aria-label={`Reveal ${path}`} onClick={onReveal} disabled={revealDisabled}>
            <ExternalLinkIcon />
          </button>
        ) : null}
      </div>
    </div>
  )
}
