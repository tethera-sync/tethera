import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from "react"
import {
  ActivityIcon,
  ArchiveRestoreIcon,
  ArrowDownIcon,
  ArrowRightIcon,
  ArrowUpIcon,
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
  MoreHorizontalIcon,
  NetworkIcon,
  PauseIcon,
  PlayIcon,
  RefreshCwIcon,
  DownloadIcon,
  Settings2Icon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  SunIcon,
  Trash2Icon,
  WifiOffIcon,
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
import { Gauge } from "@/components/ui/gauge"
import { Meter } from "@/components/ui/meter"
import { Sparkline } from "@/components/ui/sparkline"
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

const navGroups: Array<{ label: string; items: NavItem[] }> = [
  { label: "Main", items: [{ id: "overview", label: "Dashboard", icon: LayoutDashboardIcon }] },
  {
    label: "Sync",
    items: [
      { id: "folders", label: "Folders", icon: FolderIcon },
      { id: "activity", label: "Activity", icon: ActivityIcon },
      { id: "history", label: "Recovery", icon: ArchiveRestoreIcon },
    ],
  },
  { label: "Network", items: [{ id: "devices", label: "Devices", icon: ComputerIcon }] },
  { label: "System", items: [{ id: "settings", label: "Settings", icon: Settings2Icon }] },
]

const allNavItems = navGroups.flatMap((group) => group.items)

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
    <div className="app-shell [display:grid] [grid-template-columns:244px_minmax(0,_1fr)] [height:100vh] [background:radial-gradient(1100px_520px_at_12%_-12%,_var(--shell-glow),_transparent_70%),_radial-gradient(900px_480px_at_100%_4%,_color-mix(in_oklab,_var(--chart-2)_6%,_transparent),_transparent_65%),_var(--background)] [transition:grid-template-columns_220ms_cubic-bezier(0.32,_0.72,_0,_1)] [&[data-rail='true']]:[grid-template-columns:76px_minmax(0,_1fr)] [&[data-rail='true']_.rail-toggle_svg]:[transform:rotate(180deg)] [&[data-rail='true']_.brand-text]:[display:none] [&[data-rail='true']_.nav-group-label]:[display:none] [&[data-rail='true']_.nav-item>span:first-of-type]:[display:none] [&[data-rail='true']_.theme-switcher>span]:[display:none] [&[data-rail='true']_.device-chip>div:last-child]:[display:none] [&[data-rail='true']_.brand]:[justify-content:center] [&[data-rail='true']_.brand]:[padding:0] [&[data-rail='true']_.sidebar]:[align-items:stretch] [&[data-rail='true']_.sidebar]:[padding-inline:10px] [&[data-rail='true']_.nav-item]:[justify-content:center] [&[data-rail='true']_.nav-item]:[padding:0] [&[data-rail='true']_.nav-count]:[position:absolute] [&[data-rail='true']_.nav-count]:[top:3px] [&[data-rail='true']_.nav-count]:[right:3px] [&[data-rail='true']_.nav-count]:[min-width:0] [&[data-rail='true']_.nav-count]:[padding:2px_4px] [&[data-rail='true']_.nav-count]:[font-size:8px] [&[data-rail='true']_.theme-options]:[grid-template-columns:1fr] [&[data-rail='true']_.device-chip]:[justify-content:center] [&[data-rail='true']_.device-chip]:[padding-inline:0] max-[900px]:[grid-template-columns:76px_minmax(0,_1fr)]" data-rail={rail}>
      <FolderMappingApprovalDialog
        request={pendingMapping}
        localDevice={localDevice}
        mutationsEnabled={mappingMutationsEnabled}
        disabledReason={mappingMutationReason}
        open={mappingApprovalOpen}
        onOpenChange={setMappingApprovalOpen}
      />

      <aside className="sidebar [display:flex] [min-height:0] [flex-direction:column] [gap:18px] [border-right:1px_solid_color-mix(in_oklab,_var(--border)_70%,_transparent)] [background:color-mix(in_oklab,_var(--surface)_55%,_transparent)] [padding:16px_12px_14px]">
        <div className="brand [display:flex] [align-items:center] [gap:10px] [padding:4px_4px_0]">
          <div className="brand-mark grid size-[34px] shrink-0 place-items-center" aria-hidden="true">
            <img className="h-auto w-[30px] max-w-none translate-y-[6px] object-contain" src={tetheraLogo} alt="" />
          </div>
          <div className="brand-text [display:flex] [min-width:0] [flex:1] [align-items:center] [gap:7px]">
            <p className="brand-name [margin:0] [font-size:15px] [font-weight:680] [letter-spacing:-0.025em]">Tethera</p>
            <span className="brand-tag [border-radius:5px] [background:color-mix(in_oklab,_var(--primary)_18%,_transparent)] [padding:2px_5px] [color:var(--primary)] [font-size:8.5px] [font-weight:700] [letter-spacing:0.08em] [text-transform:uppercase]">P2P</span>
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

        <div className="nav-scroll [display:flex] [min-height:0] [flex:1] [flex-direction:column] [gap:14px] [overflow-y:auto] [scrollbar-width:none] [&::-webkit-scrollbar]:[display:none]">
          {navGroups.map((group) => (
            <nav key={group.label} aria-label={group.label}>
              <p className="nav-group-label [margin:0_0_6px_10px] [color:var(--muted-foreground)] [font-size:9px] [font-weight:700] [letter-spacing:0.12em] [text-transform:uppercase] [opacity:0.75]">{group.label}</p>
              <div className="nav-list [display:grid] [gap:2px]">
                {group.items.map((item) => {
                  const Icon = item.icon
                  const active = view === item.id
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={cn("nav-item [position:relative] [display:flex] [width:100%] [height:38px] [align-items:center] [gap:10px] [border:0] [border-radius:10px] [background:transparent] [padding:0_10px] [color:var(--muted-foreground)] [font-size:12.5px] [font-weight:550] [text-align:left] [transition:background_140ms_ease,_color_140ms_ease] [&:hover]:[background:color-mix(in_oklab,_var(--accent)_70%,_transparent)] [&:hover]:[color:var(--foreground)] [&_svg]:[width:16px] [&_svg]:[height:16px] [&_svg]:[flex:0_0_auto] [&>span:first-of-type]:[overflow:hidden] [&>span:first-of-type]:[flex:1] [&>span:first-of-type]:[text-overflow:ellipsis] [&>span:first-of-type]:[white-space:nowrap]", active && "nav-item-active [background:linear-gradient(_100deg,_color-mix(in_oklab,_var(--primary)_16%,_transparent),_color-mix(in_oklab,_var(--primary)_6%,_transparent)_)] [color:var(--foreground)] [box-shadow:inset_0_0_0_1px_color-mix(in_oklab,_var(--primary)_20%,_transparent)] [&::before]:[content:''] [&::before]:[position:absolute] [&::before]:[top:50%] [&::before]:[left:-12px] [&::before]:[width:3px] [&::before]:[height:18px] [&::before]:[transform:translateY(-50%)] [&::before]:[border-radius:0_3px_3px_0] [&::before]:[background:var(--primary)] [&_svg]:[color:var(--primary)]")}
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
          ))}
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
        <header className="topbar [display:flex] [min-height:84px] [align-items:center] [justify-content:space-between] [gap:24px] [border-bottom:1px_solid_color-mix(in_oklab,_var(--border)_60%,_transparent)] [padding:16px_24px] [background:color-mix(in_oklab,_var(--background)_82%,_transparent)] [backdrop-filter:blur(20px)] [&_h1]:[margin:2px_0_0] [&_h1]:[font-size:clamp(19px,_1.9vw,_25px)] [&_h1]:[font-weight:660] [&_h1]:[letter-spacing:-0.038em] max-[900px]:[padding-inline:16px]">
          <div className="min-w-0">
            <p className="eyebrow [margin:0] [color:var(--muted-foreground)] [font-size:10px] [font-weight:700] [letter-spacing:0.11em] [text-transform:uppercase]">{allNavItems.find((item) => item.id === view)?.label}</p>
            <h1>{viewTitle(view, snapshot)}</h1>
          </div>
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
            <div className="topbar-divider [width:1px] [height:26px] [margin-inline:2px] [background:var(--border)]" aria-hidden="true" />
            <div className="identity-chip [display:flex] [height:36px] [align-items:center] [gap:9px] [border:1px_solid_var(--border)] [border-radius:var(--radius-pill)] [background:var(--surface)] [padding:0_12px_0_5px] max-[900px]:[&>div]:[display:none]">
              <span className="identity-avatar [display:grid] [width:28px] [height:28px] [place-items:center] [border-radius:999px] [background:linear-gradient(145deg,_color-mix(in_oklab,_var(--primary)_70%,_white),_var(--primary))] [color:oklch(0.2_0.03_166)] [font-size:10.5px] [font-weight:700] [letter-spacing:0.02em]" aria-hidden="true">
                {initials(localDevice.name)}
              </span>
              <div className="min-w-0">
                <strong className="block max-w-[150px] truncate text-[11.5px] leading-[13px] font-[620]">{localDevice.name}</strong>
                <span className="block text-[9.5px] leading-[11px] text-[var(--muted-foreground)]">{prettyPlatform(localDevice.platform)}</span>
              </div>
            </div>
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
  const onlineDevices = pairedDevices.filter((device) => device.status === "online")
  const totalFolders = snapshot.folders.length
  const healthyFolders = snapshot.folders.filter((folder) => folder.status === "up-to-date").length
  const attentionCount = snapshot.folders.filter((folder) => folder.status === "needs-attention").length
  const throughput = snapshot.folders.reduce((total, folder) => total + (folder.bytesPerSecond ?? 0), 0)
  const history = useThroughputHistory(throughput)
  const hasLiveThroughput = history.length >= 2 && history.some((sample) => sample > 0)
  const latestActivity = snapshot.activity.slice(0, 5)
  const paired = pairedDevices.length > 0
  const setupComplete = paired && totalFolders > 0

  return (
    <div className="page-stack [display:grid] [gap:16px] [width:100%] [max-width:1520px] [margin:0_auto]">
      <section className="card [position:relative] [display:flex] [min-width:0] [flex-direction:column] [overflow:hidden] [border:1px_solid_var(--border)] [border-radius:var(--radius-card)] [background:var(--card-sheen)] [box-shadow:var(--elevation-card)] status-hero [position:relative] [flex-direction:row] [align-items:center] [justify-content:space-between] [gap:28px] [overflow:hidden] [border-color:color-mix(in_oklab,_var(--primary)_20%,_var(--border))] [background:radial-gradient(680px_220px_at_92%_-30%,_color-mix(in_oklab,_var(--primary)_13%,_transparent),_transparent_70%),_var(--card-sheen)] [padding:20px_22px] [&>*:not(.mesh)]:[position:relative] [&>*:not(.mesh)]:[z-index:1] max-[1100px]:[flex-direction:column] max-[1100px]:[align-items:stretch]">
        <div className="mesh [position:absolute] [right:-30px] [bottom:-40px] [width:210px] [height:170px] [background-image:radial-gradient(var(--mesh-dot)_1px,_transparent_1px)] [background-size:9px_9px] [mask-image:radial-gradient(120px_100px_at_70%_80%,_black,_transparent_72%)] [pointer-events:none] [opacity:0.85]" aria-hidden="true" />
        <div className="status-hero-copy [min-width:0] [flex:1] [&_h2]:[margin:6px_0_0] [&_h2]:[font-size:clamp(18px,_1.6vw,_23px)] [&_h2]:[font-weight:660] [&_h2]:[letter-spacing:-0.04em] [&_h2]:[line-height:1.15] [&>p:last-of-type]:[margin:5px_0_0] [&>p:last-of-type]:[max-width:78ch] [&>p:last-of-type]:[color:var(--muted-foreground)] [&>p:last-of-type]:[font-size:12px] [&>p:last-of-type]:[line-height:1.5]">
          <p className="welcome-eyebrow [margin:0] [color:var(--muted-foreground)] [font-size:10px] [font-weight:700] [letter-spacing:0.11em] [text-transform:uppercase]">Current status</p>
          <h2>{overallHeadline(snapshot)}</h2>
          <p>{overallDescription(snapshot)}</p>
          <div className="hero-chips [display:flex] [flex-wrap:wrap] [gap:8px] [margin-top:14px]">
            <span className="hero-chip [display:inline-flex] [min-width:0] [align-items:center] [gap:8px] [border:1px_solid_var(--border)] [border-radius:var(--radius-pill)] [background:color-mix(in_oklab,_var(--surface-sunken)_70%,_transparent)] [padding:4px_11px_4px_9px] [&_strong]:[overflow:hidden] [&_strong]:[max-width:34ch] [&_strong]:[color:var(--muted-foreground)] [&_strong]:[font-size:10.5px] [&_strong]:[font-weight:550] [&_strong]:[text-overflow:ellipsis] [&_strong]:[white-space:nowrap]">
              <StatusPill
                tone={snapshot.engineStatus === "ready" ? "success" : snapshot.engineStatus === "starting" ? "info" : "warning"}
                bare
                pulse={snapshot.engineStatus === "starting"}
              >
                Engine
              </StatusPill>
              <strong>{snapshot.engineMessage ?? pretty(snapshot.engineStatus)}</strong>
            </span>
            <span className="hero-chip [display:inline-flex] [min-width:0] [align-items:center] [gap:8px] [border:1px_solid_var(--border)] [border-radius:var(--radius-pill)] [background:color-mix(in_oklab,_var(--surface-sunken)_70%,_transparent)] [padding:4px_11px_4px_9px] [&_strong]:[overflow:hidden] [&_strong]:[max-width:34ch] [&_strong]:[color:var(--muted-foreground)] [&_strong]:[font-size:10.5px] [&_strong]:[font-weight:550] [&_strong]:[text-overflow:ellipsis] [&_strong]:[white-space:nowrap]">
              <StatusPill tone={snapshot.route === "offline" ? "neutral" : "success"} bare>
                Transport
              </StatusPill>
              <strong>{snapshot.route === "offline" ? "No peer connected" : `Encrypted · ${prettyRoute(snapshot.route)}`}</strong>
            </span>
          </div>
        </div>
        <div className="status-hero-side [display:flex] [flex:0_0_auto] [align-items:center] [gap:22px]">
          {totalFolders > 0 ? (
            <Gauge
              value={healthyFolders / totalFolders}
              label={`${healthyFolders}/${totalFolders}`}
              caption="Up to date"
              size={92}
              thickness={8}
              tone={attentionCount > 0 ? "danger" : "primary"}
              ariaLabel={`${healthyFolders} of ${totalFolders} folders up to date`}
            />
          ) : null}
          <div className="status-hero-actions [display:flex] [flex:0_0_auto] [align-items:center] [gap:8px] max-[1100px]:[justify-content:flex-start]">
            <Button onClick={() => onNavigate(paired ? "folders" : "devices")}>
              {paired ? "Manage folders" : "Pair a computer"}
              <ArrowRightIcon data-icon="inline-end" />
            </Button>
            <Button variant="ghost" onClick={() => onNavigate("activity")}>
              View activity
            </Button>
          </div>
        </div>
      </section>

      {setupComplete ? null : (
        <section className="card [position:relative] [display:flex] [min-width:0] [flex-direction:column] [overflow:hidden] [border:1px_solid_var(--border)] [border-radius:var(--radius-card)] [background:var(--card-sheen)] [box-shadow:var(--elevation-card)] setup-steps [display:grid] [grid-template-columns:repeat(3,_minmax(0,_1fr))] max-[1100px]:[grid-template-columns:1fr]">
          <SetupStep
            index={1}
            state={paired ? "done" : "active"}
            title="Pair a second computer"
            detail={paired ? `${pairedDevices.length} trusted device${pairedDevices.length === 1 ? "" : "s"}` : "Compare a one-time code on both machines"}
            action={paired ? undefined : { label: "Pair", onClick: () => onNavigate("devices") }}
          />
          <SetupStep
            index={2}
            state={totalFolders > 0 ? "done" : paired ? "active" : "todo"}
            title="Choose the folders to sync"
            detail={totalFolders > 0 ? `${totalFolders} mapping${totalFolders === 1 ? "" : "s"} configured` : "Pick a source and a destination path"}
            action={paired && totalFolders === 0 ? { label: "Add folder", onClick: () => onNavigate("folders") } : undefined}
          />
          <SetupStep
            index={3}
            state="todo"
            title="Review the first merge"
            detail="Nothing is copied until you approve the preview"
          />
        </section>
      )}

      {paired || totalFolders > 0 ? (
        <div className="metric-strip [display:grid] [grid-template-columns:repeat(4,_minmax(0,_1fr))] [gap:14px] max-[1360px]:[grid-template-columns:repeat(2,_minmax(0,_1fr))]">
          <MetricTile
            icon={FolderIcon}
            label="Folders up to date"
            value={totalFolders === 0 ? "—" : `${healthyFolders}/${totalFolders}`}
            tone={attentionCount > 0 ? "danger" : totalFolders === 0 ? "neutral" : "success"}
            status={attentionCount > 0 ? "Attention" : totalFolders === 0 ? "None" : "Healthy"}
            meter={{
              label: "Healthy",
              value: totalFolders === 0 ? 0 : healthyFolders / totalFolders,
              readout: `${healthyFolders}/${totalFolders}`,
            }}
          />
          <MetricTile
            icon={ComputerIcon}
            label="Devices reachable"
            value={pairedDevices.length === 0 ? "—" : `${onlineDevices.length}/${pairedDevices.length}`}
            tone={onlineDevices.length > 0 ? "success" : paired ? "warning" : "neutral"}
            status={onlineDevices.length > 0 ? "Online" : paired ? "Offline" : "Unpaired"}
            meter={{
              label: "Online",
              value: pairedDevices.length === 0 ? 0 : onlineDevices.length / pairedDevices.length,
              readout: `${onlineDevices.length}/${pairedDevices.length}`,
              tone: onlineDevices.length > 0 ? "primary" : "neutral",
            }}
          />
          <MetricTile
            icon={CircleAlertIcon}
            label="Needs attention"
            value={String(attentionCount)}
            tone={attentionCount > 0 ? "danger" : "success"}
            status={attentionCount > 0 ? "Review" : "Clear"}
            meter={{
              label: "Clear",
              value: totalFolders === 0 ? 1 : (totalFolders - attentionCount) / totalFolders,
              readout: totalFolders === 0 ? "—" : `${totalFolders - attentionCount}/${totalFolders}`,
              tone: attentionCount > 0 ? "danger" : "primary",
            }}
          />
          <MetricTile
            icon={snapshot.route === "offline" ? WifiOffIcon : NetworkIcon}
            label="Connection"
            value={prettyRoute(snapshot.route)}
            tone={snapshot.route === "offline" ? "neutral" : "success"}
            status={snapshot.peerName ?? pairedDevices[0]?.name ?? "No peer"}
            meter={{
              label: "Transfer rate",
              value: hasLiveThroughput ? Math.min(throughput / Math.max(...history, 1), 1) : 0,
              readout: formatRate(throughput),
              tone: throughput > 0 ? "primary" : "neutral",
            }}
          />
        </div>
      ) : null}

      {totalFolders > 0 ? (
        <section className="card [position:relative] [display:flex] [min-width:0] [flex-direction:column] [overflow:hidden] [border:1px_solid_var(--border)] [border-radius:var(--radius-card)] [background:var(--card-sheen)] [box-shadow:var(--elevation-card)]">
          <div className="card-head [display:flex] [align-items:flex-start] [justify-content:space-between] [gap:14px] [padding:15px_16px_0]">
            <div className="min-w-0">
              <h2 className="card-title [margin:0] [font-size:14.5px] [font-weight:640] [letter-spacing:-0.02em]">Transfer throughput</h2>
              <p className="card-caption [margin:3px_0_0] [color:var(--muted-foreground)] [font-size:10.5px] [line-height:1.45]">Live sample of all folder transfers, taken every 2 seconds.</p>
            </div>
            <div className="network-stats [display:flex] [align-items:center] [gap:14px]">
              <span className="network-stat [display:inline-flex] [align-items:center] [gap:5px] [color:var(--muted-foreground)] [font-size:10.5px] [font-variant-numeric:tabular-nums] [&_svg]:[width:12px] [&_svg]:[height:12px] [&_strong]:[color:var(--foreground)] [&_strong]:[font-weight:620] [&[data-dir='up']_svg]:[color:var(--chart-1)] [&[data-dir='down']_svg]:[color:var(--chart-2)]" data-dir="up">
                <ArrowUpIcon />
                <strong>{formatRate(throughput)}</strong>
              </span>
              <span className="network-stat [display:inline-flex] [align-items:center] [gap:5px] [color:var(--muted-foreground)] [font-size:10.5px] [font-variant-numeric:tabular-nums] [&_svg]:[width:12px] [&_svg]:[height:12px] [&_strong]:[color:var(--foreground)] [&_strong]:[font-weight:620] [&[data-dir='up']_svg]:[color:var(--chart-1)] [&[data-dir='down']_svg]:[color:var(--chart-2)]" data-dir="down">
                <ArrowDownIcon />
                <strong>{formatRate(0)}</strong>
              </span>
            </div>
          </div>
          <div className="card-body [display:flex] [min-width:0] [flex:1] [flex-direction:column] [justify-content:space-between] [padding:14px_16px_16px]">
            <div className="chart-frame [position:relative] [flex:1] [min-height:118px] [margin-top:14px]">
              {hasLiveThroughput ? (
                <Sparkline points={history} height={132} />
              ) : (
                <div className="chart-overlay [position:absolute] [inset:0] [display:grid] [place-items:center] [align-content:center] [gap:4px] [border:1px_dashed_color-mix(in_oklab,_var(--border)_90%,_transparent)] [border-radius:var(--radius-tile)] [background:color-mix(in_oklab,_var(--surface-sunken)_70%,_transparent)] [color:var(--muted-foreground)] [text-align:center] [&_strong]:[color:var(--foreground)] [&_strong]:[font-size:11.5px] [&_span]:[max-width:34ch] [&_span]:[font-size:10px] [&_span]:[line-height:1.45]">
                  <strong>No transfers yet</strong>
                  <span>
                    {snapshot.engineStatus === "ready"
                      ? "The engine is idle. Throughput appears here as soon as files move."
                      : "Live throughput starts once the sync engine is running."}
                  </span>
                </div>
              )}
            </div>
          </div>
        </section>
      ) : null}

      <div className="split-even [display:grid] [grid-template-columns:repeat(2,_minmax(0,_1fr))] [align-items:start] [gap:14px] max-[1100px]:[grid-template-columns:1fr]">
        <section className="card [position:relative] [display:flex] [min-width:0] [flex-direction:column] [overflow:hidden] [border:1px_solid_var(--border)] [border-radius:var(--radius-card)] [background:var(--card-sheen)] [box-shadow:var(--elevation-card)]">
          <div className="card-head [display:flex] [align-items:flex-start] [justify-content:space-between] [gap:14px] [padding:15px_16px_0]">
            <div className="min-w-0">
              <h2 className="card-title [margin:0] [font-size:14.5px] [font-weight:640] [letter-spacing:-0.02em]">Recent activity</h2>
              <p className="card-caption [margin:3px_0_0] [color:var(--muted-foreground)] [font-size:10.5px] [line-height:1.45]">Configuration and connection events.</p>
            </div>
            <button type="button" className="card-link [display:inline-flex] [align-items:center] [gap:5px] [border:0] [border-radius:7px] [background:transparent] [padding:4px_6px] [color:var(--muted-foreground)] [font-size:11px] [font-weight:600] [transition:140ms_ease] [&:hover]:[background:var(--accent)] [&:hover]:[color:var(--foreground)] [&_svg]:[width:13px] [&_svg]:[height:13px]" onClick={() => onNavigate("activity")}>
              View log
              <ArrowRightIcon />
            </button>
          </div>
          {latestActivity.length === 0 ? (
            <CompactEmptyState icon={ActivityIcon} title="Nothing to show" description="Events appear here as you configure and sync." />
          ) : (
            <div className="activity-list [position:relative] [&.compact_.activity-row]:[padding:11px_16px] compact">
              {latestActivity.map((event) => (
                <ActivityRow key={event.id} event={event} />
              ))}
            </div>
          )}
        </section>

        <section className="card [position:relative] [display:flex] [min-width:0] [flex-direction:column] [overflow:hidden] [border:1px_solid_var(--border)] [border-radius:var(--radius-card)] [background:var(--card-sheen)] [box-shadow:var(--elevation-card)]">
          <div className="card-head [display:flex] [align-items:flex-start] [justify-content:space-between] [gap:14px] [padding:15px_16px_0]">
            <div className="min-w-0">
              <h2 className="card-title [margin:0] [font-size:14.5px] [font-weight:640] [letter-spacing:-0.02em]">Platform settings</h2>
              <p className="card-caption [margin:3px_0_0] [color:var(--muted-foreground)] [font-size:10.5px] [line-height:1.45]">The switches you change most often.</p>
            </div>
            <button type="button" className="card-link [display:inline-flex] [align-items:center] [gap:5px] [border:0] [border-radius:7px] [background:transparent] [padding:4px_6px] [color:var(--muted-foreground)] [font-size:11px] [font-weight:600] [transition:140ms_ease] [&:hover]:[background:var(--accent)] [&:hover]:[color:var(--foreground)] [&_svg]:[width:13px] [&_svg]:[height:13px]" onClick={() => onNavigate("settings")}>
              All settings
              <ArrowRightIcon />
            </button>
          </div>
          <div className="card-body [display:flex] [min-width:0] [flex:1] [flex-direction:column] [justify-content:space-between] [padding:14px_16px_16px]">
            <p className="panel-subheading [margin:14px_0_6px] [color:var(--muted-foreground)] [font-size:9px] [font-weight:700] [letter-spacing:0.11em] [text-transform:uppercase] [&:first-child]:[margin-top:0]">General preferences</p>
            <div className="settings-panel-list [display:grid] [gap:2px] [margin-top:4px]">
              <QuickSetting label="Keep syncing in the tray" setting="closeToTray" settings={snapshot.settings} />
              <QuickSetting label="Launch after sign-in" setting="launchAtLogin" settings={snapshot.settings} />
              <QuickSetting label="Start minimised" setting="startMinimised" settings={snapshot.settings} />
            </div>
            <p className="panel-subheading [margin:14px_0_6px] [color:var(--muted-foreground)] [font-size:9px] [font-weight:700] [letter-spacing:0.11em] [text-transform:uppercase] [&:first-child]:[margin-top:0]">Network safeguards</p>
            <div className="settings-panel-list [display:grid] [gap:2px] [margin-top:4px]">
              <QuickSetting label="Pause on metered networks" setting="pauseOnMetered" settings={snapshot.settings} />
            </div>
          </div>
        </section>
      </div>

      <div className="tile-row [display:grid] [grid-template-columns:repeat(3,_minmax(0,_1fr))] [gap:14px] max-[1360px]:[grid-template-columns:repeat(3,_minmax(0,_1fr))] max-[1100px]:[grid-template-columns:1fr]">
        <FeatureTile
          icon={FolderIcon}
          title="Folders"
          description="Paths, direction, exclusions and history per mapping."
          tone={attentionCount > 0 ? "danger" : totalFolders > 0 ? "success" : "neutral"}
          status={attentionCount > 0 ? `${attentionCount} need attention` : totalFolders > 0 ? `${totalFolders} configured` : "None yet"}
          action="Open folders"
          onAction={() => onNavigate("folders")}
        />
        <FeatureTile
          icon={ArchiveRestoreIcon}
          title="Recovery"
          description="Replaced and deleted files kept in the local archive."
          tone="neutral"
          status="Awaiting engine"
          action="Open recovery"
          onAction={() => onNavigate("history")}
        />
        <FeatureTile
          icon={ShieldCheckIcon}
          title="Trusted devices"
          description="Compare a one-time code before identity keys are saved."
          tone={paired ? "success" : "warning"}
          status={paired ? `${pairedDevices.length} paired` : "Pairing required"}
          action="Manage devices"
          onAction={() => onNavigate("devices")}
        />
      </div>
    </div>
  )
}

function SetupStep({
  index,
  state,
  title,
  detail,
  action,
}: {
  index: number
  state: "done" | "active" | "todo"
  title: string
  detail: string
  action?: { label: string; onClick: () => void }
}) {
  return (
    <div className="setup-step [display:flex] [align-items:center] [gap:11px] [border-right:1px_solid_color-mix(in_oklab,_var(--border)_70%,_transparent)] [padding:14px_16px] [&:last-child]:[border-right:0] [&[data-state='done']_.setup-step-index]:[background:color-mix(in_oklab,_var(--success)_16%,_transparent)] [&[data-state='done']_.setup-step-index]:[color:var(--success)] [&[data-state='active']_.setup-step-index]:[background:var(--primary)] [&[data-state='active']_.setup-step-index]:[color:var(--primary-foreground)] [&[data-state='active']]:[background:color-mix(in_oklab,_var(--primary)_5%,_transparent)] [&[data-state='todo']]:[opacity:0.62] max-[1100px]:[border-right:0] max-[1100px]:[border-bottom:1px_solid_color-mix(in_oklab,_var(--border)_70%,_transparent)] max-[1100px]:[&:last-child]:[border-bottom:0]" data-state={state}>
      <span className="setup-step-index [display:grid] [width:26px] [height:26px] [flex:0_0_auto] [place-items:center] [border-radius:999px] [background:var(--secondary)] [color:var(--muted-foreground)] [font-size:11px] [font-weight:700] [&_svg]:[width:15px] [&_svg]:[height:15px]">{state === "done" ? <CheckCircle2Icon /> : index}</span>
      <div className="min-w-0 flex-1">
        <strong className="block text-xs font-[620]">{title}</strong>
        <span className="mt-0.5 block truncate text-[10.5px] text-[var(--muted-foreground)]">{detail}</span>
      </div>
      {action ? (
        <button type="button" className="tile-button [display:inline-flex] [height:30px] [align-items:center] [gap:6px] [border:1px_solid_var(--border)] [border-radius:8px] [background:var(--surface-strong)] [padding:0_11px] [color:var(--foreground)] [font-size:11.5px] [font-weight:600] [transition:140ms_ease] [&:hover]:[border-color:color-mix(in_oklab,_var(--primary)_40%,_var(--border))] [&:hover]:[background:color-mix(in_oklab,_var(--primary)_10%,_var(--surface-strong))] [&:hover]:[color:var(--primary)] [&_svg]:[width:13px] [&_svg]:[height:13px]" onClick={action.onClick}>
          {action.label}
          <ArrowRightIcon />
        </button>
      ) : null}
    </div>
  )
}

interface MetricTileProps {
  icon: typeof FolderIcon
  label: string
  value: string
  tone: Tone
  status: string
  meter: { label: string; value: number; readout?: string; tone?: "primary" | "warning" | "danger" | "neutral" }
}

function MetricTile({ icon: Icon, label, value, tone, status, meter }: MetricTileProps) {
  return (
    <article className="metric-tile [display:flex] [min-width:0] [flex-direction:column] [border:1px_solid_var(--border)] [border-radius:var(--radius-card)] [background:var(--card-sheen)] [padding:14px_15px_15px] [box-shadow:var(--elevation-card)] [&_.meter]:[margin-top:13px]">
      <div className="metric-tile-head [display:flex] [align-items:center] [justify-content:space-between] [gap:10px]">
        <span className="icon-tile [display:grid] [width:36px] [height:36px] [flex:0_0_auto] [place-items:center] [border-radius:11px] [background:color-mix(in_oklab,_var(--primary)_12%,_var(--surface-strong))] [color:var(--primary)] [box-shadow:inset_0_0_0_1px_color-mix(in_oklab,_var(--primary)_16%,_transparent)] [&_svg]:[width:17px] [&_svg]:[height:17px] [&[data-size='lg']]:[width:46px] [&[data-size='lg']]:[height:46px] [&[data-size='lg']]:[border-radius:14px] [&[data-size='lg']_svg]:[width:21px] [&[data-size='lg']_svg]:[height:21px] [&[data-tone='neutral']]:[background:var(--secondary)] [&[data-tone='neutral']]:[color:var(--muted-foreground)] [&[data-tone='neutral']]:[box-shadow:none] [&[data-tone='warning']]:[background:color-mix(in_oklab,_var(--warning)_14%,_var(--surface-strong))] [&[data-tone='warning']]:[color:var(--warning)] [&[data-tone='warning']]:[box-shadow:inset_0_0_0_1px_color-mix(in_oklab,_var(--warning)_20%,_transparent)] [&[data-tone='danger']]:[background:color-mix(in_oklab,_var(--danger)_14%,_var(--surface-strong))] [&[data-tone='danger']]:[color:var(--danger)] [&[data-tone='danger']]:[box-shadow:inset_0_0_0_1px_color-mix(in_oklab,_var(--danger)_20%,_transparent)] [&[data-size='sm']]:[width:30px] [&[data-size='sm']]:[height:30px] [&[data-size='sm']]:[border-radius:9px] [&[data-size='sm']_svg]:[width:15px] [&[data-size='sm']_svg]:[height:15px]" data-size="sm" data-tone={tone === "neutral" ? "neutral" : undefined}>
          <Icon />
        </span>
        <StatusPill tone={tone} bare>
          {status}
        </StatusPill>
      </div>
      <strong className="metric-tile-value [display:block] [overflow:hidden] [margin-top:13px] [font-size:22px] [font-weight:660] [letter-spacing:-0.035em] [text-overflow:ellipsis] [white-space:nowrap] [font-variant-numeric:tabular-nums]" title={value}>
        {value}
      </strong>
      <span className="metric-tile-label [display:block] [overflow:hidden] [margin-top:2px] [color:var(--muted-foreground)] [font-size:10.5px] [text-overflow:ellipsis] [white-space:nowrap]">{label}</span>
      <Meter label={meter.label} value={meter.value} readout={meter.readout} tone={meter.tone} />
    </article>
  )
}

function FeatureTile({
  className,
  icon: Icon,
  title,
  description,
  tone,
  status,
  action,
  onAction,
}: {
  className?: string
  icon: typeof FolderIcon
  title: string
  description: string
  tone: Tone
  status: string
  action: string
  onAction: () => void
}) {
  return (
    <section className={cn("card [position:relative] [display:flex] [min-width:0] [flex-direction:column] [overflow:hidden] [border:1px_solid_var(--border)] [border-radius:var(--radius-card)] [background:var(--card-sheen)] [box-shadow:var(--elevation-card)] feature-tile [position:relative] [justify-content:space-between] [min-height:148px] [padding:16px] [&>*:not(.mesh)]:[position:relative] [&>*:not(.mesh)]:[z-index:1] [&_h3]:[margin:0] [&_h3]:[font-size:14.5px] [&_h3]:[font-weight:640] [&_h3]:[letter-spacing:-0.02em] [&>p]:[margin:3px_0_0] [&>p]:[color:var(--muted-foreground)] [&>p]:[font-size:10.5px]", className)}>
      <div className="mesh [position:absolute] [right:-30px] [bottom:-40px] [width:210px] [height:170px] [background-image:radial-gradient(var(--mesh-dot)_1px,_transparent_1px)] [background-size:9px_9px] [mask-image:radial-gradient(120px_100px_at_70%_80%,_black,_transparent_72%)] [pointer-events:none] [opacity:0.85]" aria-hidden="true" />
      <div className="flex items-start gap-3">
        <div className="icon-tile [display:grid] [width:36px] [height:36px] [flex:0_0_auto] [place-items:center] [border-radius:11px] [background:color-mix(in_oklab,_var(--primary)_12%,_var(--surface-strong))] [color:var(--primary)] [box-shadow:inset_0_0_0_1px_color-mix(in_oklab,_var(--primary)_16%,_transparent)] [&_svg]:[width:17px] [&_svg]:[height:17px] [&[data-size='lg']]:[width:46px] [&[data-size='lg']]:[height:46px] [&[data-size='lg']]:[border-radius:14px] [&[data-size='lg']_svg]:[width:21px] [&[data-size='lg']_svg]:[height:21px] [&[data-tone='neutral']]:[background:var(--secondary)] [&[data-tone='neutral']]:[color:var(--muted-foreground)] [&[data-tone='neutral']]:[box-shadow:none] [&[data-tone='warning']]:[background:color-mix(in_oklab,_var(--warning)_14%,_var(--surface-strong))] [&[data-tone='warning']]:[color:var(--warning)] [&[data-tone='warning']]:[box-shadow:inset_0_0_0_1px_color-mix(in_oklab,_var(--warning)_20%,_transparent)] [&[data-tone='danger']]:[background:color-mix(in_oklab,_var(--danger)_14%,_var(--surface-strong))] [&[data-tone='danger']]:[color:var(--danger)] [&[data-tone='danger']]:[box-shadow:inset_0_0_0_1px_color-mix(in_oklab,_var(--danger)_20%,_transparent)] [&[data-size='sm']]:[width:30px] [&[data-size='sm']]:[height:30px] [&[data-size='sm']]:[border-radius:9px] [&[data-size='sm']_svg]:[width:15px] [&[data-size='sm']_svg]:[height:15px]" data-tone={tone === "neutral" ? "neutral" : undefined}>
          <Icon />
        </div>
        <div className="min-w-0">
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
      </div>
      <div className="feature-tile-foot [display:flex] [align-items:center] [justify-content:space-between] [gap:12px] [margin-top:20px]">
        <StatusPill tone={tone} bare>
          {status}
        </StatusPill>
        <button type="button" className="tile-button [display:inline-flex] [height:30px] [align-items:center] [gap:6px] [border:1px_solid_var(--border)] [border-radius:8px] [background:var(--surface-strong)] [padding:0_11px] [color:var(--foreground)] [font-size:11.5px] [font-weight:600] [transition:140ms_ease] [&:hover]:[border-color:color-mix(in_oklab,_var(--primary)_40%,_var(--border))] [&:hover]:[background:color-mix(in_oklab,_var(--primary)_10%,_var(--surface-strong))] [&:hover]:[color:var(--primary)] [&_svg]:[width:13px] [&_svg]:[height:13px]" onClick={onAction}>
          {action}
          <ArrowRightIcon />
        </button>
      </div>
    </section>
  )
}

type BooleanSetting = {
  [K in keyof AppSettings]: AppSettings[K] extends boolean ? K : never
}[keyof AppSettings]

function QuickSetting({ label, setting, settings }: { label: string; setting: BooleanSetting; settings: AppSettings }) {
  return (
    <div className="settings-panel-row [display:flex] [align-items:center] [justify-content:space-between] [gap:14px] [border-radius:9px] [padding:8px_8px_8px_0] [&>span]:[min-width:0] [&>span]:[color:var(--foreground)] [&>span]:[font-size:11.5px] [&>span]:[font-weight:500]">
      <span>{label}</span>
      <Switch
        aria-label={label}
        checked={settings[setting]}
        onCheckedChange={(next: boolean) => void window.folderSync.updateSetting(setting, next)}
      />
    </div>
  )
}

/** Samples total transfer throughput on a fixed interval so the chart shows real history, never synthetic data. */
function useThroughputHistory(bytesPerSecond: number, sampleCount = 48): number[] {
  const latest = useRef(bytesPerSecond)
  latest.current = bytesPerSecond
  const [history, setHistory] = useState<number[]>([])

  useEffect(() => {
    const id = window.setInterval(() => {
      setHistory((previous) => [...previous, latest.current].slice(-sampleCount))
    }, 2000)
    return () => window.clearInterval(id)
  }, [sampleCount])

  return history
}

/* -------------------------------------------------------------------------- */
/* Folders                                                                     */
/* -------------------------------------------------------------------------- */

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
    <div className="page-stack [display:grid] [gap:16px] [width:100%] [max-width:1520px] [margin:0_auto]">
      <section className="section-intro [display:flex] [align-items:center] [justify-content:space-between] [gap:24px] [&_h2]:[margin:0] [&_h2]:[font-size:17px] [&_h2]:[font-weight:650] [&_h2]:[letter-spacing:-0.03em] [&_p]:[margin:3px_0_0] [&_p]:[max-width:80ch] [&_p]:[color:var(--muted-foreground)] [&_p]:[font-size:11.5px] [&_p]:[line-height:1.5]">
        <div>
          <h2>Folder mappings</h2>
          <p>Each mapping has independent paths, direction, exclusions, history and bandwidth settings.</p>
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
        <section className="pairing-gate-card [position:relative] [display:grid] [grid-template-columns:auto_minmax(0,_1fr)_auto] [align-items:center] [gap:20px] [overflow:hidden] [border:1px_solid_color-mix(in_oklab,_var(--primary)_20%,_var(--border))] [border-radius:var(--radius-card)] [background:radial-gradient(600px_260px_at_92%_-20%,_color-mix(in_oklab,_var(--primary)_13%,_transparent),_transparent_70%),_var(--card-sheen)] [padding:20px] [box-shadow:var(--elevation-card)] [&>*]:[position:relative] [&>*]:[z-index:1] max-[1100px]:[grid-template-columns:auto_minmax(0,_1fr)] max-[1100px]:[&>button]:[grid-column:2] max-[1100px]:[&>button]:[justify-self:start]">
          <div className="pairing-gate-icon [display:grid] [width:50px] [height:50px] [place-items:center] [border-radius:15px] [background:color-mix(in_oklab,_var(--primary)_13%,_var(--surface-strong))] [color:var(--primary)] [box-shadow:inset_0_0_0_1px_color-mix(in_oklab,_var(--primary)_20%,_transparent)] [&_svg]:[width:22px] [&_svg]:[height:22px]">
            <LockKeyholeIcon />
          </div>
          <div className="pairing-gate-copy [&_h2]:[margin:4px_0_5px] [&_h2]:[font-size:17px] [&_h2]:[font-weight:650] [&_h2]:[letter-spacing:-0.03em] [&>p:not(.eyebrow)]:[max-width:80ch] [&>p:not(.eyebrow)]:[margin:0] [&>p:not(.eyebrow)]:[color:var(--muted-foreground)] [&>p:not(.eyebrow)]:[font-size:12px] [&>p:not(.eyebrow)]:[line-height:1.55]">
            <p className="eyebrow [margin:0] [color:var(--muted-foreground)] [font-size:10px] [font-weight:700] [letter-spacing:0.11em] [text-transform:uppercase]">Protected setup order</p>
            <h2>Pair your second computer before choosing folders</h2>
            <p>
              Tethera needs a trusted device identity before it can safely browse a destination or create a folder mapping. No
              folder can be added while this computer is unpaired.
            </p>
            <div className="pairing-gate-points [display:flex] [flex-wrap:wrap] [gap:8px_16px] [margin-top:12px] [color:var(--muted-foreground)] [font-size:11px] [&_span]:[display:inline-flex] [&_span]:[align-items:center] [&_span]:[gap:6px] [&_svg]:[width:14px] [&_svg]:[height:14px] [&_svg]:[color:var(--primary)]">
              <span>
                <ShieldCheckIcon /> Both computers approve the pairing
              </span>
              <span>
                <FolderOpenIcon /> Then choose a folder on each computer
              </span>
            </div>
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
        <section className="large-empty-state [display:grid] [min-height:380px] [place-items:center] [align-content:center] [border:1px_dashed_color-mix(in_oklab,_var(--border)_85%,_var(--primary))] [border-radius:var(--radius-card)] [background:radial-gradient(420px_200px_at_50%_0%,_color-mix(in_oklab,_var(--primary)_7%,_transparent),_transparent_70%),_color-mix(in_oklab,_var(--surface)_55%,_transparent)] [padding:44px] [text-align:center] [&_h2]:[margin:16px_0_6px] [&_h2]:[font-size:18px] [&_h2]:[font-weight:650] [&_h2]:[letter-spacing:-0.03em] [&_p]:[max-width:52ch] [&_p]:[margin:0_0_18px] [&_p]:[color:var(--muted-foreground)] [&_p]:[font-size:12px] [&_p]:[line-height:1.6]">
          <div className="large-empty-icon [display:grid] [width:50px] [height:50px] [place-items:center] [border-radius:15px] [background:color-mix(in_oklab,_var(--primary)_12%,_var(--surface))] [color:var(--primary)] [box-shadow:inset_0_0_0_1px_color-mix(in_oklab,_var(--primary)_18%,_transparent)] [&_svg]:[width:21px] [&_svg]:[height:21px]">
            <FolderIcon />
          </div>
          <h2>Choose exactly what stays in sync</h2>
          <p>
            Tethera never assumes your whole computer should be copied. Use the custom browser to choose one folder on each
            paired device.
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
    <article className="folder-card [position:relative] [overflow:hidden] [border:1px_solid_var(--border)] [border-radius:var(--radius-card)] [background:var(--card-sheen)] [box-shadow:var(--elevation-card)] [transition:border-color_160ms_ease,_transform_160ms_ease] [&:hover]:[border-color:color-mix(in_oklab,_var(--primary)_26%,_var(--border))]">
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
        <Button
          size="icon-sm"
          variant="ghost"
          disabled
          title="Folder actions are part of the next milestone"
          aria-label={`More options for ${folder.name}`}
        >
          <MoreHorizontalIcon />
        </Button>
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
        <Button size="sm" variant="ghost" disabled title="Detailed folder settings are part of the next milestone">
          <SlidersHorizontalIcon data-icon="inline-start" />
          Settings
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
    <div className="page-stack [display:grid] [gap:16px] [width:100%] [max-width:1520px] [margin:0_auto]">
      <section className="section-intro [display:flex] [align-items:center] [justify-content:space-between] [gap:24px] [&_h2]:[margin:0] [&_h2]:[font-size:17px] [&_h2]:[font-weight:650] [&_h2]:[letter-spacing:-0.03em] [&_p]:[margin:3px_0_0] [&_p]:[max-width:80ch] [&_p]:[color:var(--muted-foreground)] [&_p]:[font-size:11.5px] [&_p]:[line-height:1.5]">
        <div>
          <h2>Activity log</h2>
          <p>Configuration, connections, transfers, conflicts and recovery operations are recorded locally.</p>
        </div>
        <Button variant="outline" disabled title="Diagnostic export is not implemented yet">
          <ExternalLinkIcon data-icon="inline-start" />
          Export diagnostics
        </Button>
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
    <div className="page-stack [display:grid] [gap:16px] [width:100%] [max-width:1520px] [margin:0_auto]">
      <section className="section-intro [display:flex] [align-items:center] [justify-content:space-between] [gap:24px] [&_h2]:[margin:0] [&_h2]:[font-size:17px] [&_h2]:[font-weight:650] [&_h2]:[letter-spacing:-0.03em] [&_p]:[margin:3px_0_0] [&_p]:[max-width:80ch] [&_p]:[color:var(--muted-foreground)] [&_p]:[font-size:11.5px] [&_p]:[line-height:1.5]">
        <div>
          <h2>Trusted devices</h2>
          <p>
            Each computer has a persistent signing identity. Pairing only completes after both people compare and approve the
            same code.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={pairedDevices.length > 0 ? "success" : "warning"}>
            {pairedDevices.length > 0 ? `${pairedDevices.length} paired` : "Not paired"}
          </Badge>
          <PairDeviceDialog snapshot={snapshot} />
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
          <article className="device-card [position:relative] [overflow:hidden] [border:1px_solid_var(--border)] [border-radius:var(--radius-card)] [background:var(--card-sheen)] [padding:18px] [box-shadow:var(--elevation-card)] [&_h3]:[margin:0] [&_h3]:[font-size:14.5px] [&_h3]:[font-weight:640] [&_h3]:[letter-spacing:-0.02em]" key={device.id}>
            <div className="device-illustration [position:relative] [display:grid] [width:50px] [height:50px] [place-items:center] [margin-bottom:16px] [border-radius:15px] [background:color-mix(in_oklab,_var(--primary)_11%,_var(--surface-strong))] [color:var(--primary)] [box-shadow:inset_0_0_0_1px_color-mix(in_oklab,_var(--primary)_16%,_transparent)] [&_svg]:[width:22px] [&_svg]:[height:22px]">
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

        <article className="pair-device-card [display:flex] [min-height:260px] [flex-direction:column] [align-items:center] [justify-content:center] [gap:10px] [border:1px_dashed_color-mix(in_oklab,_var(--primary)_35%,_var(--border))] [border-radius:var(--radius-card)] [background:radial-gradient(300px_160px_at_50%_100%,_color-mix(in_oklab,_var(--primary)_8%,_transparent),_transparent_70%),_color-mix(in_oklab,_var(--surface)_45%,_transparent)] [padding:24px] [text-align:center] [&>strong]:[font-size:14px] [&>strong]:[font-weight:640] [&>span]:[max-width:46ch] [&>span]:[color:var(--muted-foreground)] [&>span]:[font-size:11px] [&>span]:[line-height:1.5]">
          <div className="large-empty-icon [display:grid] [width:50px] [height:50px] [place-items:center] [border-radius:15px] [background:color-mix(in_oklab,_var(--primary)_12%,_var(--surface))] [color:var(--primary)] [box-shadow:inset_0_0_0_1px_color-mix(in_oklab,_var(--primary)_18%,_transparent)] [&_svg]:[width:21px] [&_svg]:[height:21px]">
            <Link2Icon />
          </div>
          <strong>Pair a second computer</strong>
          <span>
            Nearby devices are discovered over your LAN. Both computers compare a one-time code before their identity keys are
            saved.
          </span>
          <div className="pair-device-actions [display:flex] [flex-wrap:wrap] [justify-content:center] [gap:8px] [margin-top:8px]">
            <PairDeviceDialog snapshot={snapshot} />
            <Button variant="outline" onClick={() => setPickerOpen(true)}>
              <FolderOpenIcon data-icon="inline-start" />
              Preview folder browser
            </Button>
          </div>
        </article>
      </section>

      <section className="setup-order-card [display:grid] [grid-template-columns:auto_minmax(0,_1fr)_auto_auto_minmax(0,_1fr)_auto_auto_minmax(0,_1fr)] [align-items:center] [gap:12px] [border:1px_solid_var(--border)] [border-radius:var(--radius-card)] [background:var(--card-sheen)] [padding:15px_17px] [box-shadow:var(--elevation-card)] [&>span]:[display:grid] [&>span]:[width:27px] [&>span]:[height:27px] [&>span]:[place-items:center] [&>span]:[border-radius:9px] [&>span]:[background:color-mix(in_oklab,_var(--primary)_13%,_var(--surface-strong))] [&>span]:[color:var(--primary)] [&>span]:[font-size:11px] [&>span]:[font-weight:700] [&>svg]:[width:15px] [&>svg]:[height:15px] [&>svg]:[color:var(--muted-foreground)] [&_strong]:[display:block] [&_strong]:[font-size:12px] [&_strong]:[font-weight:620] [&_p]:[margin:2px_0_0] [&_p]:[color:var(--muted-foreground)] [&_p]:[font-size:10.5px] max-[1100px]:[grid-template-columns:auto_minmax(0,_1fr)] max-[1100px]:[&>svg]:[display:none]">
        <span>1</span>
        <div>
          <strong>Pair</strong>
          <p>Establish trust between Linux and Windows.</p>
        </div>
        <ArrowRightIcon />
        <span>2</span>
        <div>
          <strong>Choose folders</strong>
          <p>Browse a source and destination with the custom picker.</p>
        </div>
        <ArrowRightIcon />
        <span>3</span>
        <div>
          <strong>Review and sync</strong>
          <p>Preview the initial merge before any files change.</p>
        </div>
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
    <div className="page-stack [display:grid] [gap:16px] [width:100%] [max-width:1520px] [margin:0_auto]">
      <section className="section-intro [display:flex] [align-items:center] [justify-content:space-between] [gap:24px] [&_h2]:[margin:0] [&_h2]:[font-size:17px] [&_h2]:[font-weight:650] [&_h2]:[letter-spacing:-0.03em] [&_p]:[margin:3px_0_0] [&_p]:[max-width:80ch] [&_p]:[color:var(--muted-foreground)] [&_p]:[font-size:11.5px] [&_p]:[line-height:1.5]">
        <div>
          <h2>Version history and deleted files</h2>
          <p>Overwritten and deleted copies will be stored locally in the central recovery archive.</p>
        </div>
      </section>
      <section className="large-empty-state [display:grid] [min-height:380px] [place-items:center] [align-content:center] [border:1px_dashed_color-mix(in_oklab,_var(--border)_85%,_var(--primary))] [border-radius:var(--radius-card)] [background:radial-gradient(420px_200px_at_50%_0%,_color-mix(in_oklab,_var(--primary)_7%,_transparent),_transparent_70%),_color-mix(in_oklab,_var(--surface)_55%,_transparent)] [padding:44px] [text-align:center] [&_h2]:[margin:16px_0_6px] [&_h2]:[font-size:18px] [&_h2]:[font-weight:650] [&_h2]:[letter-spacing:-0.03em] [&_p]:[max-width:52ch] [&_p]:[margin:0_0_18px] [&_p]:[color:var(--muted-foreground)] [&_p]:[font-size:12px] [&_p]:[line-height:1.6]">
        <div className="large-empty-icon [display:grid] [width:50px] [height:50px] [place-items:center] [border-radius:15px] [background:color-mix(in_oklab,_var(--primary)_12%,_var(--surface))] [color:var(--primary)] [box-shadow:inset_0_0_0_1px_color-mix(in_oklab,_var(--primary)_18%,_transparent)] [&_svg]:[width:21px] [&_svg]:[height:21px]">
          <HistoryIcon />
        </div>
        <h2>No recoverable versions yet</h2>
        <p>The archive browser becomes active once the Rust engine starts recording replaced or deleted files.</p>
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
        description="Bandwidth and connection safeguards. Detailed per-folder limits are planned for the sync milestone."
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

function viewTitle(view: View, snapshot: AppSnapshot): string {
  if (view === "overview") return snapshot.paused ? "Syncing is paused" : "Your folders at a glance"
  if (view === "folders") return "Synced folders"
  if (view === "activity") return "What Tethera has done"
  if (view === "devices") return "Devices and connections"
  if (view === "history") return "Recover earlier versions"
  return "Application preferences"
}

function overallHeadline(snapshot: AppSnapshot): string {
  if (snapshot.paused) return "Everything is safely paused"
  if (getPairedDevices(snapshot).length === 0) return "Pair your second computer first"
  if (snapshot.folders.some((folder) => folder.setupStatus === "ready-for-initial-sync")) return "Ready for the initial merge"
  if (snapshot.status === "needs-attention") return "A folder needs your attention"
  if (snapshot.status === "syncing") return "Synchronizing folder changes"
  if (snapshot.folders.length === 0) return "Ready for your first folder"
  if (snapshot.status === "offline") return "Configured and waiting for a peer"
  return "Everything is up to date"
}

function overallDescription(snapshot: AppSnapshot): string {
  if (snapshot.paused) return "Folder changes will remain local until you resume syncing."
  if (getPairedDevices(snapshot).length === 0) return "Folder selection stays locked until both computers approve a secure pairing."
  if (snapshot.folders.length === 0) return "Choose one folder on this computer and its destination on the paired device."
  if (snapshot.engineStatus !== "ready") return "Your folder mappings are saved, but live scanning waits for the Rust engine."
  if (snapshot.route === "offline") return "No paired device is currently connected. Your files remain unchanged."
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

function initials(name: string): string {
  const parts = name.trim().split(/[\s-_]+/).filter(Boolean)
  if (parts.length === 0) return "?"
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase()
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
