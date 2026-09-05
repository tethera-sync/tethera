import { useEffect, useState } from "react"
import {
  ChevronsLeftIcon,
  LaptopIcon,
  Link2Icon,
  MonitorIcon,
  MoonIcon,
  PauseIcon,
  PlayIcon,
  RefreshCwIcon,
  SunIcon,
} from "lucide-react"
import type { AppSettings, AppSnapshot, ConnectionRoute } from "@shared/contracts"
import tetheraMark from "@/assets/tethera-mark.svg"
import { AddFolderDialog } from "@/components/add-folder-dialog"
import { FolderMappingApprovalDialog } from "@/components/folder-mapping-approval-dialog"
import { MappingStoreBanner } from "@/components/mapping-store-banner"
import { UpdateBanner } from "@/components/update-banner"
import { RecoveryView } from "@/components/recovery-view"
import { Button } from "@/components/ui/button"
import { StatusPill } from "@/components/ui/status-pill"
import { cn } from "@/lib/utils"
import { prettyPlatform, prettyRoute } from "@/lib/format"
import { navItems, viewTitle, type View } from "@/lib/navigation"
import { getLocalDevice, getPairedDevices, mappingMutationAvailability } from "@/lib/snapshot"
import { ActivityView } from "./views/activity"
import { DevicesView } from "./views/devices"
import { FoldersView } from "./views/folders"
import { Overview } from "./views/overview"
import { SettingsView } from "./views/settings"

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
  const recoveryCount = snapshot.folders.reduce(
    (total, folder) => total + (folder.conflictCount ?? 0) + (folder.recoveryIssueCount ?? 0),
    0,
  )
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
            <img className="size-full object-contain" src={tetheraMark} alt="" />
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
                      {item.id === "history" && recoveryCount > 0 ? (
                        <span
                          className="nav-count [min-width:19px] [border-radius:999px] [background:color-mix(in_oklab,_var(--warning)_20%,_transparent)] [padding:2px_6px] [color:var(--warning)] [font-size:9.5px] [font-weight:700] [text-align:center]"
                          aria-label={`${recoveryCount} recovery items waiting`}
                        >
                          {Math.min(recoveryCount, 99)}
                        </span>
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
            {!loading && view === "history" ? <RecoveryView snapshot={snapshot} /> : null}
            {!loading && view === "settings" ? <SettingsView snapshot={snapshot} /> : null}
          </div>
        </div>
      </main>
    </div>
  )
}

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

function LoadingScreen() {
  return (
    <div className="loading-screen [display:grid] [min-height:400px] [place-items:center] [align-content:center] [gap:12px] [color:var(--muted-foreground)] [&_svg]:[width:21px] [&_svg]:[height:21px] [&_p]:[margin:0] [&_p]:[font-size:12px]">
      <RefreshCwIcon className="animate-spin" />
      <p>Loading Tethera…</p>
    </div>
  )
}
