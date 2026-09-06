import {
  ActivityIcon,
  ArrowRightIcon,
  CheckCircle2Icon,
  FolderIcon,
} from "lucide-react"
import type { AppSnapshot, FolderSummary } from "@shared/contracts"
import type { View } from "@/lib/navigation"
import { CompactEmptyState } from "@/components/compact-empty-state"
import { StatusPill } from "@/components/ui/status-pill"
import { Button } from "@/components/ui/button"
import { pretty, prettyRoute, statusTone } from "@/lib/format"
import { formatRelative } from "@/lib/format"
import { folderStatusLabel, getPairedDevices, overallDescription, overallHeadline } from "@/lib/snapshot"
import { ActivityRow } from "./activity"

export function Overview({ snapshot, onNavigate }: { snapshot: AppSnapshot; onNavigate: (view: View) => void }) {
  const pairedDevices = getPairedDevices(snapshot)
  const pairedDevice = pairedDevices[0]
  const totalFolders = snapshot.folders.length
  const healthyFolders = snapshot.folders.filter((folder) => folder.status === "up-to-date").length
  const attentionCount = snapshot.folders.filter((folder) => folder.status === "needs-attention").length
  const latestActivity = snapshot.activity.slice(0, 5)
  const paired = pairedDevices.length > 0
  const needsInitialMerge = snapshot.folders.some((folder) => folder.setupStatus === "ready-for-initial-sync")
  const awaitingApproval = snapshot.mappings.outgoing.some((request) => request.status === "pending" || request.status === "approved-awaiting-delivery")
    || snapshot.mappings.incoming.some((request) => request.status === "pending")
    || snapshot.folders.some((folder) => folder.setupStatus === "pending-approval")
  const setupComplete = paired && totalFolders > 0 && !needsInitialMerge && !awaitingApproval
  const currentSetupStep = paired ? (totalFolders > 0 ? 3 : 2) : 1

  return (
    <div className="page-stack [display:grid] [gap:16px] [width:100%] [max-width:1180px] [margin:0_auto]">
      <section className="overview-status [border:1px_solid_var(--border)] [border-radius:var(--radius-card)] [background:var(--surface)] [padding:20px]">
        <div className="min-w-0">
          <StatusPill
            tone={
              snapshot.engineStatus !== "ready"
                ? "warning"
                : snapshot.paused
                  ? "warning"
                  : statusTone(snapshot.status)
            }
            pulse={snapshot.engineStatus === "starting" || snapshot.status === "syncing"}
          >
            {snapshot.engineStatus !== "ready" ? pretty(snapshot.engineStatus) : snapshot.paused ? "Paused" : pretty(snapshot.status)}
          </StatusPill>
          <h2 className="mt-3 text-[20px] leading-tight font-[660] tracking-[-0.035em]">{overallHeadline(snapshot)}</h2>
          <p className="mt-1.5 max-w-[72ch] text-xs leading-5 text-[var(--muted-foreground)]">
            {overallDescription(snapshot)}
          </p>
          <dl className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
            <div className="flex min-w-0 items-center gap-2">
              <dt className="text-[var(--muted-foreground)]">Engine</dt>
              <dd className="m-0 max-w-[34ch] truncate font-medium">{snapshot.engineMessage ?? pretty(snapshot.engineStatus)}</dd>
            </div>
            <div className="flex min-w-0 items-center gap-2">
              <dt className="text-[var(--muted-foreground)]">Connection</dt>
              <dd className="m-0 max-w-[34ch] truncate font-medium">
                {snapshot.route === "offline"
                  ? pairedDevice
                    ? pairedDevice.name + " is offline"
                    : "No paired device"
                  : prettyRoute(snapshot.route)}
              </dd>
            </div>
            <div className="flex items-center gap-2">
              <dt className="text-[var(--muted-foreground)]">Folders</dt>
              <dd className="m-0 font-medium">
                {totalFolders === 0 ? "None configured" : healthyFolders + " of " + totalFolders + " up to date"}
              </dd>
            </div>
          </dl>
        </div>
      </section>

      {setupComplete ? null : (
        <section className="setup-panel [overflow:hidden] [border:1px_solid_var(--border)] [border-radius:var(--radius-card)] [background:var(--surface)]">
          <div className="flex items-start justify-between gap-6 border-b border-[var(--border)] px-4 py-3.5">
            <div>
              <h2 className="m-0 text-sm font-semibold">Set up folder sync</h2>
              <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                Tethera waits for approval before it changes files on either computer.
              </p>
            </div>
            <span className="shrink-0 text-xs font-medium text-[var(--muted-foreground)]">
              Step {currentSetupStep} of 3
            </span>
          </div>
          <ol className="m-0 grid list-none grid-cols-3 p-0 max-[1100px]:grid-cols-1">
            <SetupStep
              index={1}
              state={paired ? "done" : "active"}
              title="Pair a computer"
              detail={paired ? pairedDevices.length + " trusted device" + (pairedDevices.length === 1 ? "" : "s") : "Compare and approve the same code on both devices"}
            />
            <SetupStep
              index={2}
              state={totalFolders > 0 ? "done" : paired ? "active" : "todo"}
              title="Choose folders"
              detail={totalFolders > 0 ? totalFolders + " mapping" + (totalFolders === 1 ? "" : "s") + " configured" : "Select one local path and one destination path"}
            />
            <SetupStep
              index={3}
              state={setupComplete ? "done" : totalFolders > 0 ? "active" : "todo"}
              title="Review the first merge"
              detail={needsInitialMerge ? "Review and start the merge when both devices are ready" : "Nothing is copied before you approve the preview"}
            />
          </ol>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] px-4 py-3.5">
            <p className="text-xs text-[var(--muted-foreground)]">
              {!paired
                ? "Open Tethera on both computers, then allow pairing on the other computer."
                : awaitingApproval
                  ? "The folder request needs approval and delivery before the first merge can begin."
                  : needsInitialMerge
                    ? "Open the folder and start its initial merge. Both computers need to be online."
                    : "Choose the folders you want to keep in sync."}
            </p>
            <Button size="sm" onClick={() => onNavigate(!paired || awaitingApproval ? "devices" : "folders")}>
              {!paired ? "Set up pairing" : awaitingApproval ? "Review requests" : needsInitialMerge ? "Open initial merge" : "Choose folders"}
              <ArrowRightIcon data-icon="inline-end" />
            </Button>
          </div>
        </section>
      )}

      {totalFolders > 0 ? <div className="overview-grid [display:grid] [grid-template-columns:minmax(0,_1.35fr)_minmax(300px,_0.65fr)] [align-items:start] [gap:16px] max-[1100px]:[grid-template-columns:1fr]">
        <section className="overview-panel [overflow:hidden] [border:1px_solid_var(--border)] [border-radius:var(--radius-card)] [background:var(--surface)]">
          <div className="flex items-start justify-between gap-4 border-b border-[var(--border)] px-4 py-3.5">
            <div>
              <h2 className="m-0 text-sm font-semibold">Folders</h2>
              <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                {totalFolders === 0
                  ? "No folder mappings are active."
                  : attentionCount > 0
                    ? attentionCount + " need" + (attentionCount === 1 ? "s" : "") + " attention."
                    : "All configured folders are accounted for."}
              </p>
            </div>
            <button
              type="button"
              className="card-link [display:inline-flex] [align-items:center] [gap:5px] [border:0] [border-radius:7px] [background:transparent] [padding:4px_6px] [color:var(--muted-foreground)] [font-size:11px] [font-weight:600] [&:hover]:[background:var(--accent)] [&:hover]:[color:var(--foreground)] [&_svg]:[width:13px] [&_svg]:[height:13px]"
              onClick={() => onNavigate("folders")}
            >
              Open folders
              <ArrowRightIcon />
            </button>
          </div>
          {totalFolders === 0 ? (
            <div className="flex min-h-32 items-center gap-3 px-4 py-5">
              <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-[var(--secondary)] text-[var(--muted-foreground)]">
                <FolderIcon className="size-4" />
              </div>
              <div>
                <p className="m-0 text-xs font-semibold">No folders configured</p>
                <p className="mt-1 text-xs leading-[1.5] text-[var(--muted-foreground)]">
                  {pairedDevice
                    ? pairedDevice.status === "online"
                      ? "Choose a folder here and its destination on " + pairedDevice.name + "."
                      : "Bring " + pairedDevice.name + " online before adding the first folder."
                    : "Pair a second computer before choosing folders."}
                </p>
              </div>
            </div>
          ) : (
            <div className="divide-y divide-[var(--border)]">
              {snapshot.folders.slice(0, 4).map((folder) => (
                <OverviewFolderRow key={folder.id} folder={folder} />
              ))}
              {snapshot.folders.length > 4 ? (
                <p className="m-0 px-4 py-3 text-xs text-[var(--muted-foreground)]">
                  {snapshot.folders.length - 4} more folder{snapshot.folders.length - 4 === 1 ? "" : "s"}
                </p>
              ) : null}
            </div>
          )}
        </section>

        <section className="overview-panel [overflow:hidden] [border:1px_solid_var(--border)] [border-radius:var(--radius-card)] [background:var(--surface)]">
          <div className="flex items-start justify-between gap-4 border-b border-[var(--border)] px-4 py-3.5">
            <div>
              <h2 className="m-0 text-sm font-semibold">Recent activity</h2>
              <p className="mt-1 text-xs text-[var(--muted-foreground)]">Stored locally on this computer.</p>
            </div>
            {latestActivity.length > 0 ? (
              <button
                type="button"
                className="card-link [display:inline-flex] [align-items:center] [gap:5px] [border:0] [border-radius:7px] [background:transparent] [padding:4px_6px] [color:var(--muted-foreground)] [font-size:11px] [font-weight:600] [&:hover]:[background:var(--accent)] [&:hover]:[color:var(--foreground)] [&_svg]:[width:13px] [&_svg]:[height:13px]"
                onClick={() => onNavigate("activity")}
              >
                View all
                <ArrowRightIcon />
              </button>
            ) : null}
          </div>
          {latestActivity.length === 0 ? (
            <CompactEmptyState
              icon={ActivityIcon}
              title="No activity yet"
              description="Pairing, folder configuration and transfer events will appear here."
            />
          ) : (
            <div className="activity-list compact [position:relative] [&.compact_.activity-row]:[padding:11px_16px]">
              {latestActivity.map((event) => (
                <ActivityRow key={event.id} event={event} />
              ))}
            </div>
          )}
        </section>
      </div> : null}
    </div>
  )
}

function SetupStep({
  index,
  state,
  title,
  detail,
}: {
  index: number
  state: "done" | "active" | "todo"
  title: string
  detail: string
}) {
  return (
    <li
      className="setup-step [display:flex] [align-items:flex-start] [gap:11px] [border-right:1px_solid_var(--border)] [padding:14px_16px] [&:last-child]:[border-right:0] [&[data-state='active']]:[background:color-mix(in_oklab,_var(--primary)_6%,_var(--surface))] [&[data-state='todo']]:[opacity:0.58] max-[1100px]:[border-right:0] max-[1100px]:[border-bottom:1px_solid_var(--border)] max-[1100px]:[&:last-child]:[border-bottom:0]"
      data-state={state}
    >
      <span
        className="setup-step-index [display:grid] [width:24px] [height:24px] [flex:0_0_auto] [place-items:center] [border:1px_solid_var(--border)] [border-radius:999px] [background:var(--secondary)] [color:var(--muted-foreground)] [font-size:10.5px] [font-weight:700] [&_svg]:[width:13px] [&_svg]:[height:13px] data-[state=done]:[border-color:color-mix(in_oklab,var(--success)_30%,var(--border))] data-[state=done]:[background:color-mix(in_oklab,var(--success)_12%,var(--surface))] data-[state=done]:[color:var(--success)] data-[state=active]:[border-color:var(--primary)] data-[state=active]:[background:var(--primary)] data-[state=active]:[color:var(--primary-foreground)]"
        data-state={state}
      >
        {state === "done" ? <CheckCircle2Icon /> : index}
      </span>
      <div className="min-w-0">
        <strong className="block text-xs font-semibold">{title}</strong>
        <span className="mt-1 block text-xs leading-[1.45] text-[var(--muted-foreground)]">{detail}</span>
      </div>
    </li>
  )
}

function OverviewFolderRow({ folder }: { folder: FolderSummary }) {
  return (
    <article className="flex min-w-0 items-center gap-3 px-4 py-3">
      <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-[var(--secondary)] text-[var(--muted-foreground)]">
        <FolderIcon className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="m-0 truncate text-xs font-semibold">{folder.name}</h3>
          <StatusPill tone={statusTone(folder.status)} bare pulse={folder.status === "syncing"}>
            {folderStatusLabel(folder)}
          </StatusPill>
        </div>
        <p className="mt-1 truncate text-xs text-[var(--muted-foreground)]" title={folder.localPath}>
          {folder.currentAction ?? folder.localPath}
        </p>
      </div>
      <span className="shrink-0 text-xs text-[var(--muted-foreground)]">
        {folder.lastSyncedAt ? formatRelative(folder.lastSyncedAt) : "Never synced"}
      </span>
    </article>
  )
}
