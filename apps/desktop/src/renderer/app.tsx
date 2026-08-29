import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from "react"
import {
  ActivityIcon,
  ArchiveRestoreIcon,
  ArrowRightIcon,
  CheckCircle2Icon,
  ChevronsLeftIcon,
  CircleAlertIcon,
  ComputerIcon,
  ExternalLinkIcon,
  FolderClockIcon,
  FolderIcon,
  FolderOpenIcon,
  HistoryIcon,
  LaptopIcon,
  LayoutDashboardIcon,
  Link2Icon,
  LockKeyholeIcon,
  MonitorIcon,
  MoonIcon,
  PauseIcon,
  PlayIcon,
  RefreshCwIcon,
  DownloadIcon,
  Settings2Icon,
  ShieldCheckIcon,
  SunIcon,
  Trash2Icon,
} from "lucide-react"
import type {
  ActivityEvent,
  AppSettings,
  AppSnapshot,
  ConnectionRoute,
  DeviceSummary,
  FolderSummary,
  MappingStoreState,
  OverallStatus,
  UpdateState,
} from "@shared/contracts"
import tetheraLogo from "@/assets/tethera-logo-flat.png"
import { AddFolderDialog } from "@/components/add-folder-dialog"
import { FolderPickerDialog } from "@/components/folder-picker-dialog"
import { FolderMappingApprovalDialog } from "@/components/folder-mapping-approval-dialog"
import { MappingStoreBanner } from "@/components/mapping-store-banner"
import { PairDeviceDialog } from "@/components/pair-device-dialog"
import { RevokeDeviceDialog } from "@/components/revoke-device-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Meter } from "@/components/ui/meter"
import { StatusPill, type Tone } from "@/components/ui/status-pill"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"

const emptySnapshot: AppSnapshot = {
  status: "offline",
  route: "offline",
  engineStatus: "starting",
  engineMessage: "Connecting…",
  mappingStore: {
    status: "loading",
    mutationsEnabled: false,
    pendingDeliveryCount: 0,
  },
  paused: false,
  folders: [],
  devices: [],
  pairing: {
    localFingerprint: "Loading…",
    acceptingPairing: false,
    discoveredDevices: [],
    incomingRequests: [],
  },
  mappings: { incoming: [], outgoing: [] },
  activity: [],
  settings: {
    closeToTray: true,
    launchAtLogin: false,
    startMinimised: false,
    pauseOnMetered: true,
    theme: "system",
  },
  update: { status: "idle" },
}

type View = "overview" | "folders" | "activity" | "devices" | "history" | "settings"

interface NavItem {
  id: View
  label: string
  icon: typeof LayoutDashboardIcon
}

const navItems: NavItem[] = [
  { id: "overview", label: "Overview", icon: LayoutDashboardIcon },
  { id: "folders", label: "Folders", icon: FolderIcon },
  { id: "activity", label: "Activity", icon: ActivityIcon },
  { id: "history", label: "Recovery", icon: ArchiveRestoreIcon },
  { id: "devices", label: "Devices", icon: ComputerIcon },
  { id: "settings", label: "Settings", icon: Settings2Icon },
]

export function App() {
  const [snapshot, setSnapshot] = useState(emptySnapshot)
  const [view, setView] = useState<View>("overview")
  const [loading, setLoading] = useState(true)
  const [rail, setRail] = useState(false)
  const [mappingApprovalOpen, setMappingApprovalOpen] = useState(false)

  useEffect(() => {
    void window.folderSync
      .getSnapshot()
      .then(setSnapshot)
      .finally(() => setLoading(false))
    return window.folderSync.subscribe(setSnapshot)
  }, [])

  useEffect(() => {
    const root = document.documentElement
    root.classList.remove("light", "dark")
    if (snapshot.settings.theme === "system") {
      root.classList.toggle("dark", window.matchMedia("(prefers-color-scheme: dark)").matches)
    } else {
      root.classList.add(snapshot.settings.theme)
    }
  }, [snapshot.settings.theme])

  async function togglePause() {
    setSnapshot(snapshot.paused ? await window.folderSync.resumeAll() : await window.folderSync.pauseAll())
  }

  const localDevice = getLocalDevice(snapshot)
  const pairedDevice = getPairedDevices(snapshot)[0]
  const pendingMapping = snapshot.mappings.incoming.find((request) => request.status === "pending")
  const attentionCount = snapshot.folders.filter((folder) => folder.status === "needs-attention").length
  const pendingApprovals = snapshot.pairing.incomingRequests.length + snapshot.mappings.incoming.filter((request) => request.status === "pending").length
  const { enabled: mappingMutationsEnabled, reason: mappingMutationReason } = mappingMutationAvailability(
    snapshot.mappingStore,
  )

  useEffect(() => {
    setMappingApprovalOpen(Boolean(pendingMapping))
  }, [pendingMapping?.id])

  return (
    <div className="app-shell [display:grid] [grid-template-columns:232px_minmax(0,_1fr)] [height:100vh] [background:var(--background)] [transition:grid-template-columns_180ms_ease] [&[data-rail='true']]:[grid-template-columns:72px_minmax(0,_1fr)] [&[data-rail='true']_.rail-toggle_svg]:[transform:rotate(180deg)] [&[data-rail='true']_.brand-text]:[display:none] [&[data-rail='true']_.nav-item>span:first-of-type]:[display:none] [&[data-rail='true']_.theme-switcher>span]:[display:none] [&[data-rail='true']_.device-chip>div:last-child]:[display:none] [&[data-rail='true']_.brand]:[justify-content:center] [&[data-rail='true']_.brand]:[padding:0] [&[data-rail='true']_.sidebar]:[align-items:stretch] [&[data-rail='true']_.sidebar]:[padding-inline:10px] [&[data-rail='true']_.nav-item]:[justify-content:center] [&[data-rail='true']_.nav-item]:[padding:0] [&[data-rail='true']_.nav-count]:[position:absolute] [&[data-rail='true']_.nav-count]:[top:3px] [&[data-rail='true']_.nav-count]:[right:3px] [&[data-rail='true']_.nav-count]:[min-width:0] [&[data-rail='true']_.nav-count]:[padding:2px_4px] [&[data-rail='true']_.nav-count]:[font-size:8px] [&[data-rail='true']_.theme-options]:[grid-template-columns:1fr] [&[data-rail='true']_.device-chip]:[justify-content:center] [&[data-rail='true']_.device-chip]:[padding-inline:0] max-[900px]:[grid-template-columns:72px_minmax(0,_1fr)]" data-rail={rail}>
      <FolderMappingApprovalDialog
        request={pendingMapping}
        localDevice={localDevice}
        mutationsEnabled={mappingMutationsEnabled}
        disabledReason={mappingMutationReason}
        open={mappingApprovalOpen}
        onOpenChange={setMappingApprovalOpen}
      />

      <aside className="sidebar [display:flex] [min-height:0] [flex-direction:column] [gap:14px] [border-right:1px_solid_var(--border)] [background:var(--surface-sunken)] [padding:16px_12px_14px]">
        <div className="brand [display:flex] [align-items:center] [gap:10px] [padding:4px_4px_0]">
          <div className="brand-mark grid size-[34px] shrink-0 place-items-center" aria-hidden="true">
            <img className="h-auto w-[30px] max-w-none translate-y-[6px] object-contain" src={tetheraLogo} alt="" />
          </div>
          <div className="brand-text [display:flex] [min-width:0] [flex:1] [align-items:center]">
            <p className="brand-name [margin:0] [font-size:15px] [font-weight:680] [letter-spacing:-0.025em]">Tethera</p>
          </div>
          <button
            type="button"
            className="rail-toggle [display:grid] [width:26px] [height:26px] [flex:0_0_auto] [place-items:center] [border:0] [border-radius:7px] [background:transparent] [color:var(--muted-foreground)] [transition:140ms_ease] [&:hover]:[background:var(--accent)] [&:hover]:[color:var(--foreground)] [&_svg]:[width:15px] [&_svg]:[height:15px] [&_svg]:[transition:transform_220ms_cubic-bezier(0.32,_0.72,_0,_1)]"
            onClick={() => setRail((previous) => !previous)}
            aria-label={rail ? "Expand sidebar" : "Collapse sidebar"}
            aria-pressed={rail}
          >
            <ChevronsLeftIcon />
          </button>
        </div>

        <div className="nav-scroll [min-height:0] [flex:1] [overflow-y:auto] [scrollbar-width:none] [&::-webkit-scrollbar]:[display:none]">
          <nav aria-label="Primary navigation">
            <div className="nav-list [display:grid] [gap:3px]">
                {navItems.map((item) => {
                  const Icon = item.icon
                  const active = view === item.id
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={cn("nav-item [position:relative] [display:flex] [width:100%] [height:38px] [align-items:center] [gap:10px] [border:0] [border-radius:8px] [background:transparent] [padding:0_10px] [color:var(--muted-foreground)] [font-size:12.5px] [font-weight:550] [text-align:left] [transition:background_140ms_ease,_color_140ms_ease] [&:hover]:[background:var(--accent)] [&:hover]:[color:var(--foreground)] [&_svg]:[width:16px] [&_svg]:[height:16px] [&_svg]:[flex:0_0_auto] [&>span:first-of-type]:[overflow:hidden] [&>span:first-of-type]:[flex:1] [&>span:first-of-type]:[text-overflow:ellipsis] [&>span:first-of-type]:[white-space:nowrap]", active && "nav-item-active [background:color-mix(in_oklab,_var(--primary)_11%,_var(--surface))] [color:var(--foreground)] [&::before]:[content:''] [&::before]:[position:absolute] [&::before]:[inset-block:9px] [&::before]:[left:-12px] [&::before]:[width:3px] [&::before]:[border-radius:0_3px_3px_0] [&::before]:[background:var(--primary)] [&_svg]:[color:var(--primary)]")}
                      onClick={() => setView(item.id)}
                      aria-current={active ? "page" : undefined}
                      title={rail ? item.label : undefined}
                    >
                      <Icon />
                      <span>{item.label}</span>
                      {item.id === "activity" && snapshot.activity.length > 0 ? (
                        <span className="nav-count [min-width:19px] [border-radius:999px] [background:color-mix(in_oklab,_var(--primary)_20%,_transparent)] [padding:2px_6px] [color:var(--primary)] [font-size:9.5px] [font-weight:700] [text-align:center]">{Math.min(snapshot.activity.length, 99)}</span>
                      ) : null}
                      {item.id === "folders" && attentionCount > 0 ? (
                        <span className="nav-dot [width:6px] [height:6px] [border-radius:999px] [background:var(--warning)] [box-shadow:0_0_0_3px_color-mix(in_oklab,_var(--warning)_22%,_transparent)]" role="img" aria-label={`${attentionCount} folders need attention`} />
                      ) : null}
                      {item.id === "devices" && pendingApprovals > 0 ? (
                        <span className="nav-dot [width:6px] [height:6px] [border-radius:999px] [background:var(--warning)] [box-shadow:0_0_0_3px_color-mix(in_oklab,_var(--warning)_22%,_transparent)]" role="img" aria-label={`${pendingApprovals} approvals waiting`} />
                      ) : null}
                    </button>
                  )
                })}
            </div>
          </nav>
        </div>

        <div className="sidebar-footer [display:grid] [gap:8px] [margin-top:auto]">
          <ThemeSwitcher theme={snapshot.settings.theme} />
          <div className="device-chip [display:flex] [align-items:center] [gap:9px] [border:1px_solid_var(--border)] [border-radius:var(--radius-tile)] [background:var(--surface)] [padding:8px_10px]">
            <div className="device-icon [display:grid] [width:29px] [height:29px] [flex:0_0_auto] [place-items:center] [border-radius:9px] [background:var(--secondary)] [color:var(--muted-foreground)] [&_svg]:[width:14px] [&_svg]:[height:14px]">
              <LaptopIcon />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-semibold">{localDevice.name}</p>
              <p className="truncate text-[10px] text-[var(--muted-foreground)]">{prettyPlatform(localDevice.platform)}</p>
            </div>
          </div>
        </div>
      </aside>

      <main className="main-panel [display:grid] [min-width:0] [min-height:0] [grid-template-rows:auto_minmax(0,_1fr)]">
        <header className="topbar [display:flex] [min-height:70px] [align-items:center] [justify-content:space-between] [gap:20px] [border-bottom:1px_solid_var(--border)] [padding:14px_24px] [background:var(--background)] [&_h1]:[margin:0] [&_h1]:[font-size:21px] [&_h1]:[font-weight:660] [&_h1]:[letter-spacing:-0.032em] max-[900px]:[padding-inline:16px]">
          <h1>{viewTitle(view)}</h1>
          <div className="topbar-actions [display:flex] [align-items:center] [gap:8px]">
            <ConnectionPill route={snapshot.route} paused={snapshot.paused} />
            <Button
              variant="outline"
              onClick={togglePause}
              disabled={snapshot.folders.length === 0 || !mappingMutationsEnabled}
              title={!mappingMutationsEnabled ? mappingMutationReason : undefined}
            >
              {snapshot.paused ? <PlayIcon data-icon="inline-start" /> : <PauseIcon data-icon="inline-start" />}
              {snapshot.paused ? "Resume all" : "Pause all"}
            </Button>
            {pairedDevice ? (
              <AddFolderDialog
                localDevice={localDevice}
                pairedDevice={pairedDevice}
                onAdded={() => setView("folders")}
                disabled={pairedDevice.status !== "online" || !mappingMutationsEnabled}
                disabledReason={
                  !mappingMutationsEnabled
                    ? mappingMutationReason
                    : `${pairedDevice.name} must be online to browse and approve a mapping.`
                }
              />
            ) : (
              <Button onClick={() => setView("devices")}>
                <Link2Icon data-icon="inline-start" />
                Pair device
              </Button>
            )}
          </div>
        </header>

        <div className="main-body [display:flex] [min-width:0] [min-height:0] [flex-direction:column]">
          <UpdateBanner update={snapshot.update} />
          <MappingStoreBanner state={snapshot.mappingStore} />

          <div className="content-scroll [min-height:0] [flex:1] [overflow:auto] [padding:22px_24px_44px] max-[900px]:[padding-inline:16px]">
            {loading ? <LoadingScreen /> : null}
            {!loading && view === "overview" ? <Overview snapshot={snapshot} onNavigate={setView} /> : null}
            {!loading && view === "folders" ? <FoldersView snapshot={snapshot} onNavigate={setView} /> : null}
            {!loading && view === "activity" ? <ActivityView activity={snapshot.activity} /> : null}
            {!loading && view === "devices" ? (
              <DevicesView snapshot={snapshot} onReviewMapping={() => setMappingApprovalOpen(true)} />
            ) : null}
            {!loading && view === "history" ? <HistoryView /> : null}
            {!loading && view === "settings" ? <SettingsView snapshot={snapshot} /> : null}
          </div>
        </div>
      </main>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Overview                                                                    */
/* -------------------------------------------------------------------------- */

function Overview({ snapshot, onNavigate }: { snapshot: AppSnapshot; onNavigate: (view: View) => void }) {
  const pairedDevices = getPairedDevices(snapshot)
  const pairedDevice = pairedDevices[0]
  const totalFolders = snapshot.folders.length
  const healthyFolders = snapshot.folders.filter((folder) => folder.status === "up-to-date").length
  const attentionCount = snapshot.folders.filter((folder) => folder.status === "needs-attention").length
  const latestActivity = snapshot.activity.slice(0, 5)
  const paired = pairedDevices.length > 0
  const needsInitialMerge = snapshot.folders.some((folder) => folder.setupStatus === "ready-for-initial-sync")
  const setupComplete = paired && totalFolders > 0 && !needsInitialMerge
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
          <dl className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-[10.5px]">
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
              <p className="mt-1 text-[10.5px] text-[var(--muted-foreground)]">
                Tethera waits for approval before it changes files on either computer.
              </p>
            </div>
            <span className="shrink-0 text-[10.5px] font-medium text-[var(--muted-foreground)]">
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
        </section>
      )}

      <div className="overview-grid [display:grid] [grid-template-columns:minmax(0,_1.35fr)_minmax(300px,_0.65fr)] [align-items:start] [gap:16px] max-[1100px]:[grid-template-columns:1fr]">
        <section className="overview-panel [overflow:hidden] [border:1px_solid_var(--border)] [border-radius:var(--radius-card)] [background:var(--surface)]">
          <div className="flex items-start justify-between gap-4 border-b border-[var(--border)] px-4 py-3.5">
            <div>
              <h2 className="m-0 text-sm font-semibold">Folders</h2>
              <p className="mt-1 text-[10.5px] text-[var(--muted-foreground)]">
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
                <p className="mt-1 text-[10.5px] leading-[1.5] text-[var(--muted-foreground)]">
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
                <p className="m-0 px-4 py-3 text-[10.5px] text-[var(--muted-foreground)]">
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
              <p className="mt-1 text-[10.5px] text-[var(--muted-foreground)]">Stored locally on this computer.</p>
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
      </div>
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
        <span className="mt-1 block text-[10.5px] leading-[1.45] text-[var(--muted-foreground)]">{detail}</span>
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
        <p className="mt-1 truncate text-[10px] text-[var(--muted-foreground)]" title={folder.localPath}>
          {folder.currentAction ?? folder.localPath}
        </p>
      </div>
      <span className="shrink-0 text-[10px] text-[var(--muted-foreground)]">
        {folder.lastSyncedAt ? formatRelative(folder.lastSyncedAt) : "Never synced"}
      </span>
    </article>
  )
}

type FolderFilter = "all" | "active" | "paused" | "attention"

const folderFilters: Array<{ id: FolderFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "paused", label: "Paused" },
  { id: "attention", label: "Attention" },
]

function FoldersView({ snapshot, onNavigate }: { snapshot: AppSnapshot; onNavigate: (view: View) => void }) {
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
                  mutationsEnabled={mappingMutationsEnabled}
                  disabledReason={mappingMutationReason}
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
  mutationsEnabled,
  disabledReason,
}: {
  folder: FolderSummary
  mutationsEnabled: boolean
  disabledReason: string
}) {
  const [busy, setBusy] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const paused = folder.paused || folder.status === "paused"

  async function setPaused() {
    setBusy(true)
    try {
      await window.folderSync.setFolderPaused(folder.id, !paused)
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    const confirmed = window.confirm(
      `Remove “${folder.name}” from Tethera? Files on both computers will be left untouched.`,
    )
    if (confirmed) await window.folderSync.removeFolder(folder.id)
  }

  async function startSync() {
    setSyncing(true)
    try {
      await window.folderSync.startInitialSync(folder.id)
    } finally {
      setSyncing(false)
    }
  }

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
        <PathBlock label="This computer" path={folder.localPath} onReveal={() => window.folderSync.revealPath(folder.localPath)} />
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

      <div className="folder-card-footer [display:flex] [align-items:center] [gap:6px] [border-top:1px_solid_color-mix(in_oklab,_var(--border)_70%,_transparent)] [padding:10px_12px]">
        {folder.setupStatus === "ready-for-initial-sync" ? (
          <Button
            size="sm"
            onClick={startSync}
            disabled={!mutationsEnabled || syncing || paused || folder.status === "syncing"}
            title={!mutationsEnabled ? disabledReason : undefined}
          >
            <RefreshCwIcon data-icon="inline-start" />
            {folder.status === "syncing" ? "Merging…" : "Start initial merge"}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          onClick={setPaused}
          disabled={!mutationsEnabled || busy}
          title={!mutationsEnabled ? disabledReason : undefined}
        >
          {paused ? <PlayIcon data-icon="inline-start" /> : <PauseIcon data-icon="inline-start" />}
          {paused ? "Resume" : "Pause"}
        </Button>
        <Button
          className="ml-auto"
          size="icon-sm"
          variant="ghost"
          aria-label={`Remove ${folder.name}`}
          onClick={remove}
          disabled={!mutationsEnabled}
          title={!mutationsEnabled ? disabledReason : undefined}
        >
          <Trash2Icon />
        </Button>
      </div>
    </article>
  )
}

/* -------------------------------------------------------------------------- */
/* Activity                                                                    */
/* -------------------------------------------------------------------------- */

function ActivityView({ activity }: { activity: ActivityEvent[] }) {
  return (
    <div className="page-stack [display:grid] [gap:16px] [width:100%] [max-width:1180px] [margin:0_auto]">
      <section className="section-intro [display:flex] [align-items:center] [justify-content:space-between] [gap:24px] [&_h2]:[margin:0] [&_h2]:[font-size:17px] [&_h2]:[font-weight:650] [&_h2]:[letter-spacing:-0.03em] [&_p]:[margin:3px_0_0] [&_p]:[max-width:80ch] [&_p]:[color:var(--muted-foreground)] [&_p]:[font-size:11.5px] [&_p]:[line-height:1.5]">
        <div>
          <h2>Activity log</h2>
          <p>Configuration, connections, transfers, conflicts and recovery operations are recorded locally.</p>
        </div>
      </section>

      <section className="card [position:relative] [display:flex] [min-width:0] [flex-direction:column] [overflow:hidden] [border:1px_solid_var(--border)] [border-radius:var(--radius-card)] [background:var(--card-sheen)] [box-shadow:var(--elevation-card)]">
        {activity.length === 0 ? (
          <CompactEmptyState icon={ActivityIcon} title="No activity yet" description="Events appear when you configure or sync folders." />
        ) : (
          <div className="activity-list [position:relative] [&.compact_.activity-row]:[padding:11px_16px]">
            {activity.map((event) => (
              <ActivityRow key={event.id} event={event} showDate />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function ActivityRow({ event, showDate = false }: { event: ActivityEvent; showDate?: boolean }) {
  const Icon = event.level === "success" ? CheckCircle2Icon : event.level === "warning" || event.level === "error" ? CircleAlertIcon : ActivityIcon
  return (
    <div className="activity-row [position:relative] [display:flex] [align-items:flex-start] [gap:12px] [border-bottom:1px_solid_color-mix(in_oklab,_var(--border)_55%,_transparent)] [padding:14px_16px] [&:last-child]:[border-bottom:0] [&:hover]:[background:color-mix(in_oklab,_var(--accent)_40%,_transparent)]">
      <div className={cn("activity-icon [display:grid] [width:28px] [height:28px] [flex:0_0_auto] [place-items:center] [border-radius:9px] [&_svg]:[width:14px] [&_svg]:[height:14px]", {
        "[background:color-mix(in_oklab,var(--info)_12%,var(--surface))] [color:var(--info)]": event.level === "info",
        "[background:color-mix(in_oklab,var(--success)_12%,var(--surface))] [color:var(--success)]": event.level === "success",
        "[background:color-mix(in_oklab,var(--warning)_12%,var(--surface))] [color:var(--warning)]": event.level === "warning",
        "[background:color-mix(in_oklab,var(--danger)_12%,var(--surface))] [color:var(--danger)]": event.level === "error",
      })}>
        <Icon />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[12.5px] font-semibold">{event.title}</p>
        <p className="mt-0.5 text-[11px] leading-relaxed text-[var(--muted-foreground)]">{event.detail}</p>
      </div>
      <time className="shrink-0 text-[10px] tabular-nums text-[var(--muted-foreground)]" dateTime={event.occurredAt}>
        {showDate ? formatDateTime(event.occurredAt) : formatRelative(event.occurredAt)}
      </time>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Devices                                                                     */
/* -------------------------------------------------------------------------- */

function DevicesView({
  snapshot,
  onReviewMapping,
}: {
  snapshot: AppSnapshot
  onReviewMapping(): void
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const localDevice = getLocalDevice(snapshot)
  const pairedDevices = getPairedDevices(snapshot)

  return (
    <div className="page-stack [display:grid] [gap:16px] [width:100%] [max-width:1180px] [margin:0_auto]">
      <section className="section-intro [display:flex] [align-items:center] [justify-content:space-between] [gap:24px] [&_h2]:[margin:0] [&_h2]:[font-size:17px] [&_h2]:[font-weight:650] [&_h2]:[letter-spacing:-0.03em] [&_p]:[margin:3px_0_0] [&_p]:[max-width:80ch] [&_p]:[color:var(--muted-foreground)] [&_p]:[font-size:11.5px] [&_p]:[line-height:1.5]">
        <div>
          <h2>Trusted devices</h2>
          <p>Pairing completes only after the same one-time code is approved on both computers.</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={pairedDevices.length > 0 ? "success" : "warning"}>
            {pairedDevices.length > 0 ? `${pairedDevices.length} paired` : "Not paired"}
          </Badge>
          {pairedDevices.length === 0 ? <PairDeviceDialog snapshot={snapshot} /> : null}
        </div>
      </section>

      {snapshot.pairing.incomingRequests.length > 0 ? (
        <section className="incoming-pairing-banner [display:flex] [align-items:center] [justify-content:space-between] [gap:16px] [border:1px_solid_color-mix(in_oklab,_var(--primary)_30%,_var(--border))] [border-radius:var(--radius-tile)] [background:color-mix(in_oklab,_var(--primary)_9%,_var(--surface))] [padding:12px_14px] [&>div:first-child]:[display:flex] [&>div:first-child]:[align-items:center] [&>div:first-child]:[gap:10px] [&_svg]:[width:18px] [&_svg]:[height:18px] [&_svg]:[color:var(--primary)] [&_span]:[display:grid] [&_span]:[gap:2px] [&_strong]:[font-size:11.5px] [&_small]:[color:var(--muted-foreground)] [&_small]:[font-size:10px] max-[760px]:[align-items:stretch] max-[760px]:[flex-direction:column]">
          <div>
            <ShieldCheckIcon />
            <span>
              <strong>Pairing approval needed</strong>
              <small>Open “Start pairing” to compare the code and approve the request.</small>
            </span>
          </div>
          <PairDeviceDialog snapshot={snapshot} />
        </section>
      ) : null}

      {snapshot.mappings.incoming.some((request) => request.status === "pending") ? (
        <section className="incoming-pairing-banner [display:flex] [align-items:center] [justify-content:space-between] [gap:16px] [border:1px_solid_color-mix(in_oklab,_var(--primary)_30%,_var(--border))] [border-radius:var(--radius-tile)] [background:color-mix(in_oklab,_var(--primary)_9%,_var(--surface))] [padding:12px_14px] [&>div:first-child]:[display:flex] [&>div:first-child]:[align-items:center] [&>div:first-child]:[gap:10px] [&_svg]:[width:18px] [&_svg]:[height:18px] [&_svg]:[color:var(--primary)] [&_span]:[display:grid] [&_span]:[gap:2px] [&_strong]:[font-size:11.5px] [&_small]:[color:var(--muted-foreground)] [&_small]:[font-size:10px] max-[760px]:[align-items:stretch] max-[760px]:[flex-direction:column]">
          <div>
            <FolderOpenIcon />
            <span>
              <strong>Folder approval needed</strong>
              <small>Review the requested local destination before the mapping is created.</small>
            </span>
          </div>
          <Button variant="outline" onClick={onReviewMapping}>Review request</Button>
        </section>
      ) : null}

      <section className="device-grid [display:grid] [grid-template-columns:repeat(3,_minmax(0,_1fr))] [align-items:start] [gap:14px] max-[1360px]:[grid-template-columns:repeat(2,_minmax(0,_1fr))] max-[900px]:[grid-template-columns:1fr]">
        {snapshot.devices.map((device) => (
          <article className="device-card [position:relative] [overflow:hidden] [border:1px_solid_var(--border)] [border-radius:var(--radius-card)] [background:var(--surface)] [padding:18px] [box-shadow:var(--elevation-card)] [&_h3]:[margin:0] [&_h3]:[font-size:14.5px] [&_h3]:[font-weight:640] [&_h3]:[letter-spacing:-0.02em]" key={device.id}>
            <div className="device-illustration [position:relative] [display:grid] [width:42px] [height:42px] [place-items:center] [margin-bottom:14px] [border-radius:10px] [background:var(--secondary)] [color:var(--muted-foreground)] [&_svg]:[width:19px] [&_svg]:[height:19px]">
              {device.platform === "windows" ? <ComputerIcon /> : <LaptopIcon />}
              <span className={cn("presence-dot [position:absolute] [right:1px] [bottom:1px] [width:11px] [height:11px] [border:2px_solid_var(--surface)] [border-radius:999px] [&.online]:[background:var(--success)] [&.offline]:[background:var(--muted-foreground)]", device.status === "online" || device.status === "this-device" ? "online" : "offline")} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3>{device.name}</h3>
                {device.status === "this-device" ? <Badge variant="info">This device</Badge> : null}
              </div>
              <p className="mt-1 text-[11px] text-[var(--muted-foreground)]">{prettyPlatform(device.platform)}</p>
            </div>
            <dl className="device-details [display:grid] [gap:9px] [margin:18px_0_0] [border-top:1px_solid_color-mix(in_oklab,_var(--border)_70%,_transparent)] [padding-top:14px] [&>div]:[display:flex] [&>div]:[justify-content:space-between] [&>div]:[gap:12px] [&_dt]:[color:var(--muted-foreground)] [&_dt]:[font-size:10.5px] [&_dd]:[overflow:hidden] [&_dd]:[margin:0] [&_dd]:[font-size:10.5px] [&_dd]:[font-weight:550] [&_dd]:[text-overflow:ellipsis] [&_dd]:[white-space:nowrap]">
              <div>
                <dt>Status</dt>
                <dd>
                  <StatusPill tone={device.status === "offline" ? "neutral" : "success"} bare>
                    {pretty(device.status)}
                  </StatusPill>
                </dd>
              </div>
              <div>
                <dt>Connection</dt>
                <dd>{prettyRoute(device.route)}</dd>
              </div>
              <div>
                <dt>Address</dt>
                <dd>{device.address ?? "Not connected"}</dd>
              </div>
              <div>
                <dt>Identity</dt>
                <dd className="device-fingerprint [max-width:180px] [overflow:hidden] [font-family:ui-monospace,_SFMono-Regular,_Menlo,_Monaco,_Consolas,_monospace] [font-size:9px] [text-overflow:ellipsis] [white-space:nowrap]">{device.fingerprint ?? "Loading…"}</dd>
              </div>
            </dl>
            {device.status !== "this-device" ? <RevokeDeviceDialog device={device} /> : null}
          </article>
        ))}

        {pairedDevices.length === 0 ? (
          <article className="pair-device-card [display:flex] [min-height:220px] [flex-direction:column] [align-items:center] [justify-content:center] [gap:9px] [border:1px_dashed_var(--border)] [border-radius:var(--radius-card)] [background:var(--surface)] [padding:24px] [text-align:center] [&>strong]:[font-size:14px] [&>strong]:[font-weight:640] [&>span]:[max-width:46ch] [&>span]:[color:var(--muted-foreground)] [&>span]:[font-size:11px] [&>span]:[line-height:1.5]">
            <div className="large-empty-icon [display:grid] [width:40px] [height:40px] [place-items:center] [border-radius:10px] [background:var(--secondary)] [color:var(--muted-foreground)] [&_svg]:[width:18px] [&_svg]:[height:18px]">
              <Link2Icon />
            </div>
            <strong>No paired computer</strong>
            <span>Keep Tethera open on both computers, then compare and approve the one-time code.</span>
            <div className="pair-device-actions [display:flex] [flex-wrap:wrap] [justify-content:center] [gap:8px] [margin-top:8px]">
              <PairDeviceDialog snapshot={snapshot} />
              <Button variant="outline" onClick={() => setPickerOpen(true)}>
                <FolderOpenIcon data-icon="inline-start" />
                Preview folder browser
              </Button>
            </div>
          </article>
        ) : null}
      </section>

      <FolderPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        device={localDevice}
        title="Preview the folder browser"
        description="This preview only browses this computer and does not create a sync mapping."
        onSelect={() => setPickerOpen(false)}
      />
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Recovery + settings                                                         */
/* -------------------------------------------------------------------------- */

function HistoryView() {
  return (
    <div className="page-stack [display:grid] [gap:16px] [width:100%] [max-width:1180px] [margin:0_auto]">
      <section className="section-intro [display:flex] [align-items:center] [justify-content:space-between] [gap:24px] [&_h2]:[margin:0] [&_h2]:[font-size:17px] [&_h2]:[font-weight:650] [&_h2]:[letter-spacing:-0.03em] [&_p]:[margin:3px_0_0] [&_p]:[max-width:80ch] [&_p]:[color:var(--muted-foreground)] [&_p]:[font-size:11.5px] [&_p]:[line-height:1.5]">
        <div>
          <h2>Version history and deleted files</h2>
          <p>Versions protected during replacement and deletion stay on this computer.</p>
        </div>
      </section>
      <section className="large-empty-state [display:grid] [min-height:220px] [place-items:center] [align-content:center] [border:1px_solid_var(--border)] [border-radius:var(--radius-card)] [background:var(--surface)] [padding:32px] [text-align:center] [&_h2]:[margin:13px_0_5px] [&_h2]:[font-size:15px] [&_h2]:[font-weight:640] [&_p]:[max-width:52ch] [&_p]:[margin:0] [&_p]:[color:var(--muted-foreground)] [&_p]:[font-size:11px] [&_p]:[line-height:1.55]">
        <div className="large-empty-icon [display:grid] [width:40px] [height:40px] [place-items:center] [border-radius:10px] [background:var(--secondary)] [color:var(--muted-foreground)] [&_svg]:[width:18px] [&_svg]:[height:18px]">
          <HistoryIcon />
        </div>
        <h2>No archived versions</h2>
        <p>Replaced or deleted files will appear here after a folder has synced.</p>
      </section>
    </div>
  )
}

function SettingsView({ snapshot }: { snapshot: AppSnapshot }) {
  const { settings, mappingStore } = snapshot
  async function update<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    await window.folderSync.updateSetting(key, value)
  }

  return (
    <div className="page-stack [display:grid] [gap:16px] [width:100%] [max-width:1520px] [margin:0_auto] max-w-4xl">
      <SettingsSection
        title="Mapping database"
        description="SQLite is the authoritative owner of folder configuration and removal history."
      >
        <SettingRow
          title={mappingStore.status === "ready" ? "Ready" : pretty(mappingStore.status)}
          description={
            mappingStore.status === "ready"
              ? `Schema ${mappingStore.schemaVersion ?? "unknown"} · legacy migration ${mappingStore.migrationState ?? "unknown"} · ${mappingStore.pendingDeliveryCount} pending configuration deliveries.`
              : mappingStore.detail ?? "Mapping changes stay disabled until the database is available."
          }
        >
          {mappingStore.status === "ready" ? (
            <StatusPill tone="success"><CheckCircle2Icon className="size-3" /> Ready</StatusPill>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={mappingStore.status === "loading"}
              onClick={() => void window.folderSync.retryMappingStore()}
            >
              <RefreshCwIcon className={mappingStore.status === "loading" ? "animate-spin" : undefined} data-icon="inline-start" />
              {mappingStore.status === "loading" ? "Restarting…" : "Retry"}
            </Button>
          )}
        </SettingRow>
        <div className="mapping-diagnostics [padding:10px_18px_14px] [color:var(--muted-foreground)] [font-size:10.5px] [&_summary]:[cursor:pointer] [&_summary]:[font-weight:600] [&_dl]:[display:grid] [&_dl]:[gap:6px] [&_dl]:[margin:10px_0_0] [&_dl>div]:[display:flex] [&_dl>div]:[justify-content:space-between] [&_dl>div]:[gap:20px] [&_dt]:[margin:0] [&_dd]:[margin:0] [&_dd]:[color:var(--foreground)] [&_dd]:[font-family:ui-monospace,_SFMono-Regular,_Menlo,_Monaco,_Consolas,_monospace]">
          <details>
            <summary>Advanced database details</summary>
            <dl>
              <div><dt>Schema version</dt><dd>{mappingStore.schemaVersion ?? "Unavailable"}</dd></div>
              <div><dt>Migration</dt><dd>{mappingStore.migrationState ?? "Unavailable"}</dd></div>
              <div><dt>Journal mode</dt><dd>{mappingStore.journalMode ?? "Unavailable"}</dd></div>
              <div><dt>Mutations</dt><dd>{mappingStore.mutationsEnabled ? "Enabled" : "Disabled"}</dd></div>
            </dl>
          </details>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Application"
        description="Choose how Tethera behaves when the desktop window is closed or the computer starts."
      >
        <SettingRow title="Keep syncing in the tray" description="Closing the window hides Tethera instead of quitting it.">
          <Switch
            aria-label="Keep syncing in the tray"
            checked={settings.closeToTray}
            onCheckedChange={(checked: boolean) => update("closeToTray", checked)}
          />
        </SettingRow>
        <SettingRow title="Launch after sign-in" description="Start Tethera when you sign into Windows or Linux.">
          <Switch
            aria-label="Launch after sign-in"
            checked={settings.launchAtLogin}
            onCheckedChange={(checked: boolean) => update("launchAtLogin", checked)}
          />
        </SettingRow>
        <SettingRow title="Start minimised" description="Open directly into the system tray when launched automatically.">
          <Switch
            aria-label="Start minimised"
            checked={settings.startMinimised}
            onCheckedChange={(checked: boolean) => update("startMinimised", checked)}
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection
        title="Network"
        description="Connection safeguards for automatic transfers."
      >
        <SettingRow title="Pause on metered networks" description="Avoid large transfers on connections marked as metered.">
          <Switch
            aria-label="Pause on metered networks"
            checked={settings.pauseOnMetered}
            onCheckedChange={(checked: boolean) => update("pauseOnMetered", checked)}
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Appearance" description="The interface follows your system theme by default.">
        <SettingRow title="Theme" description="Change the desktop interface without affecting sync behaviour.">
          <select
            className="field-control [width:100%] [height:38px] [border:1px_solid_var(--input)] [border-radius:9px] [outline:none] [background:var(--surface-sunken)] [padding:0_11px] [color:var(--foreground)] [font-size:12.5px] [transition:140ms_ease] [&:focus]:[border-color:color-mix(in_oklab,_var(--ring)_65%,_var(--border))] [&:focus]:[box-shadow:0_0_0_3px_color-mix(in_oklab,_var(--ring)_16%,_transparent)] [textarea&]:[height:auto] [textarea&]:[padding-block:10px] [textarea&]:[line-height:1.55] w-40"
            value={settings.theme}
            onChange={(event: ChangeEvent<HTMLSelectElement>) => update("theme", event.target.value as AppSettings["theme"])}
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </SettingRow>
      </SettingsSection>
    </div>
  )
}

function SettingsSection({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="settings-section [overflow:hidden] [border:1px_solid_var(--border)] [border-radius:var(--radius-card)] [background:var(--card-sheen)] [box-shadow:var(--elevation-card)]">
      <div className="settings-heading [border-bottom:1px_solid_color-mix(in_oklab,_var(--border)_70%,_transparent)] [padding:15px_18px] [&_h2]:[margin:0] [&_h2]:[font-size:14px] [&_h2]:[font-weight:640] [&_h2]:[letter-spacing:-0.02em] [&_p]:[margin:3px_0_0] [&_p]:[color:var(--muted-foreground)] [&_p]:[font-size:11px] [&_p]:[line-height:1.5]">
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      <div className="settings-list [display:grid]">{children}</div>
    </section>
  )
}

function SettingRow({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <div className="setting-row [display:flex] [min-height:66px] [align-items:center] [justify-content:space-between] [gap:26px] [border-bottom:1px_solid_color-mix(in_oklab,_var(--border)_55%,_transparent)] [padding:13px_18px] [&:last-child]:[border-bottom:0] [&_h3]:[margin:0] [&_h3]:[font-size:12px] [&_h3]:[font-weight:600] [&_p]:[margin:3px_0_0] [&_p]:[color:var(--muted-foreground)] [&_p]:[font-size:10.5px] [&_p]:[line-height:1.45]">
      <div>
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Shared pieces                                                               */
/* -------------------------------------------------------------------------- */

function ThemeSwitcher({ theme }: { theme: AppSettings["theme"] }) {
  const options = [
    { id: "system", label: "System theme", icon: MonitorIcon },
    { id: "light", label: "Light theme", icon: SunIcon },
    { id: "dark", label: "Dark theme", icon: MoonIcon },
  ] as const

  return (
    <div className="theme-switcher [display:grid] [gap:8px] [border:1px_solid_var(--border)] [border-radius:var(--radius-tile)] [background:var(--surface)] [padding:9px_10px] [&>span]:[color:var(--muted-foreground)] [&>span]:[font-size:9px] [&>span]:[font-weight:700] [&>span]:[letter-spacing:0.1em] [&>span]:[text-transform:uppercase]">
      <span>Appearance</span>
      <div className="theme-options [display:grid] [grid-template-columns:repeat(3,_1fr)] [gap:3px] [border-radius:8px] [background:var(--surface-sunken)] [padding:3px]" role="group" aria-label="Theme">
        {options.map((option) => {
          const Icon = option.icon
          return (
            <button
              key={option.id}
              type="button"
              className="theme-option [display:grid] [height:26px] [place-items:center] [border:0] [border-radius:6px] [background:transparent] [color:var(--muted-foreground)] [transition:140ms_ease] [&_svg]:[width:14px] [&_svg]:[height:14px] [&:hover]:[color:var(--foreground)] [&[data-active='true']]:[background:var(--surface-strong)] [&[data-active='true']]:[color:var(--primary)] [&[data-active='true']]:[box-shadow:0_1px_3px_oklch(0_0_0_/_0.18)]"
              data-active={theme === option.id}
              aria-label={option.label}
              aria-pressed={theme === option.id}
              title={option.label}
              onClick={() => void window.folderSync.updateSetting("theme", option.id)}
            >
              <Icon />
            </button>
          )
        })}
      </div>
    </div>
  )
}

function PathBlock({ label, path, onReveal }: { label: string; path: string; onReveal?: () => void }) {
  return (
    <div className="path-block [min-width:0] [&>span]:[display:block] [&>span]:[margin-bottom:4px] [&>span]:[color:var(--muted-foreground)] [&>span]:[font-size:9px] [&>span]:[font-weight:700] [&>span]:[letter-spacing:0.07em] [&>span]:[text-transform:uppercase] [&>div]:[display:flex] [&>div]:[min-width:0] [&>div]:[align-items:center] [&>div]:[gap:5px] [&_code]:[overflow:hidden] [&_code]:[min-width:0] [&_code]:[color:var(--foreground)] [&_code]:[font-family:ui-monospace,_SFMono-Regular,_Menlo,_monospace] [&_code]:[font-size:10.5px] [&_code]:[text-overflow:ellipsis] [&_code]:[white-space:nowrap] [&_button]:[display:grid] [&_button]:[width:20px] [&_button]:[height:20px] [&_button]:[flex:0_0_auto] [&_button]:[place-items:center] [&_button]:[border:0] [&_button]:[border-radius:5px] [&_button]:[background:transparent] [&_button]:[color:var(--muted-foreground)] [&_button:hover]:[background:var(--accent)] [&_button:hover]:[color:var(--foreground)] [&_button_svg]:[width:11px] [&_button_svg]:[height:11px]">
      <span>{label}</span>
      <div>
        <code title={path}>{path}</code>
        {onReveal ? (
          <button type="button" aria-label={`Reveal ${path}`} onClick={onReveal}>
            <ExternalLinkIcon />
          </button>
        ) : null}
      </div>
    </div>
  )
}

function ConnectionPill({ route, paused }: { route: ConnectionRoute; paused: boolean }) {
  if (paused) {
    return (
      <StatusPill tone="warning">
        <PauseIcon className="size-3" />
        Paused
      </StatusPill>
    )
  }
  return (
    <StatusPill tone={route === "offline" ? "neutral" : "success"} pulse={route === "connecting"}>
      {prettyRoute(route)}
    </StatusPill>
  )
}

function UpdateBanner({ update }: { update: UpdateState }) {
  if (update.status === "idle" || update.status === "checking" || update.status === "not-available") return null

  if (update.status === "error") {
    return (
      <div className="update-banner [display:flex] [align-items:center] [gap:10px] [margin:0_24px] [padding:10px_14px] [border-radius:10px] [border:1px_solid_var(--border)] [background:var(--accent)] [font-size:12.5px] [font-weight:560] [&_svg]:[width:16px] [&_svg]:[height:16px] [&_svg]:[flex-shrink:0] [&_span]:[flex:1] [&_span]:[min-width:0] update-banner-error [border-color:color-mix(in_srgb,_var(--destructive)_45%,_var(--border))] [color:var(--destructive)]">
        <CircleAlertIcon />
        <span>Update check failed: {update.message ?? "Unknown error."}</span>
      </div>
    )
  }

  if (update.status === "available") {
    return (
      <div className="update-banner [display:flex] [align-items:center] [gap:10px] [margin:0_24px] [padding:10px_14px] [border-radius:10px] [border:1px_solid_var(--border)] [background:var(--accent)] [font-size:12.5px] [font-weight:560] [&_svg]:[width:16px] [&_svg]:[height:16px] [&_svg]:[flex-shrink:0] [&_span]:[flex:1] [&_span]:[min-width:0]">
        <DownloadIcon />
        <span>Tethera {update.version} is available.</span>
        <Button size="sm" onClick={() => void window.folderSync.downloadUpdate()}>
          Download
        </Button>
      </div>
    )
  }

  if (update.status === "downloading") {
    return (
      <div className="update-banner [display:flex] [align-items:center] [gap:10px] [margin:0_24px] [padding:10px_14px] [border-radius:10px] [border:1px_solid_var(--border)] [background:var(--accent)] [font-size:12.5px] [font-weight:560] [&_svg]:[width:16px] [&_svg]:[height:16px] [&_svg]:[flex-shrink:0] [&_span]:[flex:1] [&_span]:[min-width:0]">
        <DownloadIcon />
        <span>Downloading update… {update.progressPercent ?? 0}%</span>
      </div>
    )
  }

  return (
    <div className="update-banner [display:flex] [align-items:center] [gap:10px] [margin:0_24px] [padding:10px_14px] [border-radius:10px] [border:1px_solid_var(--border)] [background:var(--accent)] [font-size:12.5px] [font-weight:560] [&_svg]:[width:16px] [&_svg]:[height:16px] [&_svg]:[flex-shrink:0] [&_span]:[flex:1] [&_span]:[min-width:0]">
      <CheckCircle2Icon />
      <span>Tethera {update.version} is ready to install.</span>
      <Button size="sm" onClick={() => void window.folderSync.quitAndInstall()}>
        Restart & Update
      </Button>
    </div>
  )
}

function CompactEmptyState({ icon: Icon, title, description }: { icon: typeof FolderIcon; title: string; description: string }) {
  return (
    <div className="compact-empty [display:flex] [min-height:112px] [align-items:center] [justify-content:center] [gap:12px] [padding:22px] [color:var(--muted-foreground)] [&>svg]:[width:20px] [&>svg]:[height:20px] [&_p]:[margin:0] [&_p]:[color:var(--foreground)] [&_p]:[font-size:12.5px] [&_p]:[font-weight:600] [&_span]:[display:block] [&_span]:[max-width:38ch] [&_span]:[margin-top:2px] [&_span]:[font-size:10.5px] [&_span]:[line-height:1.45]">
      <Icon />
      <div>
        <p>{title}</p>
        <span>{description}</span>
      </div>
    </div>
  )
}

function LoadingScreen() {
  return (
    <div className="loading-screen [display:grid] [min-height:400px] [place-items:center] [align-content:center] [gap:12px] [color:var(--muted-foreground)] [&_svg]:[width:21px] [&_svg]:[height:21px] [&_p]:[margin:0] [&_p]:[font-size:12px]">
      <RefreshCwIcon className="animate-spin" />
      <p>Loading Tethera…</p>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

function viewTitle(view: View): string {
  if (view === "overview") return "Overview"
  if (view === "folders") return "Folders"
  if (view === "activity") return "Activity"
  if (view === "devices") return "Devices"
  if (view === "history") return "Recovery"
  return "Settings"
}

function overallHeadline(snapshot: AppSnapshot): string {
  if (snapshot.paused) return "Everything is safely paused"
  if (getPairedDevices(snapshot).length === 0) return "Pair your second computer first"
  if (snapshot.route === "offline") return `${getPairedDevices(snapshot)[0]?.name ?? "The paired computer"} is offline`
  if (snapshot.folders.some((folder) => folder.setupStatus === "ready-for-initial-sync")) return "Ready for the initial merge"
  if (snapshot.status === "needs-attention") return "A folder needs your attention"
  if (snapshot.status === "syncing") return "Synchronizing folder changes"
  if (snapshot.folders.length === 0) return "Ready for your first folder"
  return "Everything is up to date"
}

function overallDescription(snapshot: AppSnapshot): string {
  if (snapshot.paused) return "Folder changes will remain local until you resume syncing."
  if (getPairedDevices(snapshot).length === 0) return "Folder selection stays locked until both computers approve a secure pairing."
  if (snapshot.engineStatus !== "ready") return "Your folder mappings are saved, but live scanning waits for the Rust engine."
  if (snapshot.route === "offline") {
    return snapshot.folders.length === 0
      ? "Bring the paired computer online before choosing the first folder."
      : "Your folder mappings are saved. Syncing will resume when the paired computer reconnects."
  }
  if (snapshot.folders.length === 0) return "Choose one folder on this computer and its destination on the paired device."
  if (snapshot.folders.some((folder) => folder.setupStatus === "ready-for-initial-sync")) {
    return "Start the merge on either computer to copy missing files safely in the configured direction."
  }
  if (snapshot.status === "syncing") return "Tethera is verifying and transferring changed files over the secure peer connection."
  if (snapshot.status === "needs-attention") return "Review the affected folder. Tethera leaves ambiguous versions and deletions untouched."
  return "Tethera is watching each active folder and will synchronize safe changes automatically."
}

function folderStatusLabel(folder: FolderSummary): string {
  if (folder.status === "up-to-date" && folder.setupStatus === "active") return "Up to date"
  if (folder.status === "needs-attention" && folder.setupStatus === "ready-for-initial-sync") return "Ready for initial merge"
  return pretty(folder.status)
}

function pretty(value: string): string {
  return value.replaceAll("-", " ").replace(/^./, (character) => character.toUpperCase())
}

function mappingMutationAvailability(state: MappingStoreState): { enabled: boolean; reason: string } {
  return {
    enabled: state.status === "ready" && state.mutationsEnabled,
    reason: state.detail ?? "The mapping database must be ready before configuration can change.",
  }
}

function prettyMode(value: FolderSummary["mode"]): string {
  if (value === "two-way") return "Two-way sync"
  if (value === "send-only") return "Send only"
  return "Receive only"
}

function prettyRoute(route: ConnectionRoute): string {
  if (route === "lan-direct") return "LAN direct"
  if (route === "tailscale-direct") return "Tailscale direct"
  if (route === "tailscale-relay") return "Tailscale relay"
  return pretty(route)
}

function prettyPlatform(platform?: "linux" | "windows" | "unknown"): string {
  if (platform === "linux") return "Linux"
  if (platform === "windows") return "Windows 11"
  return "Unknown platform"
}

function statusTone(status: OverallStatus): Tone {
  if (status === "needs-attention") return "danger"
  if (status === "paused") return "warning"
  if (status === "offline") return "neutral"
  if (status === "syncing") return "info"
  return "success"
}

function formatRate(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** exponent
  return `${value >= 10 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`
}

function getLocalDevice(snapshot: AppSnapshot): DeviceSummary {
  return (
    snapshot.devices.find((device) => device.status === "this-device") ?? {
      id: "local-device",
      name: "This computer",
      platform: "unknown",
      status: "this-device",
      route: "offline",
    }
  )
}

function getPairedDevices(snapshot: AppSnapshot): DeviceSummary[] {
  return snapshot.devices.filter(
    (device) => device.id !== "local-device" && (device.status === "online" || device.status === "offline"),
  )
}

function formatRelative(iso: string): string {
  const difference = Date.now() - new Date(iso).getTime()
  const minutes = Math.floor(difference / 60_000)
  if (minutes < 1) return "Just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso))
}
