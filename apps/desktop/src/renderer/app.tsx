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
    <div className="app-shell" data-rail={rail}>
      <FolderMappingApprovalDialog
        request={pendingMapping}
        localDevice={localDevice}
        mutationsEnabled={mappingMutationsEnabled}
        disabledReason={mappingMutationReason}
        open={mappingApprovalOpen}
        onOpenChange={setMappingApprovalOpen}
      />

      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            <img src={tetheraLogo} alt="" />
          </div>
          <div className="brand-text">
            <p className="brand-name">Tethera</p>
            <span className="brand-tag">P2P</span>
          </div>
          <button
            type="button"
            className="rail-toggle"
            onClick={() => setRail((previous) => !previous)}
            aria-label={rail ? "Expand sidebar" : "Collapse sidebar"}
            aria-pressed={rail}
          >
            <ChevronsLeftIcon />
          </button>
        </div>

        <div className="nav-scroll">
          {navGroups.map((group) => (
            <nav key={group.label} aria-label={group.label}>
              <p className="nav-group-label">{group.label}</p>
              <div className="nav-list">
                {group.items.map((item) => {
                  const Icon = item.icon
                  const active = view === item.id
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={cn("nav-item", active && "nav-item-active")}
                      onClick={() => setView(item.id)}
                      aria-current={active ? "page" : undefined}
                      title={rail ? item.label : undefined}
                    >
                      <Icon />
                      <span>{item.label}</span>
                      {item.id === "activity" && snapshot.activity.length > 0 ? (
                        <span className="nav-count">{Math.min(snapshot.activity.length, 99)}</span>
                      ) : null}
                      {item.id === "folders" && attentionCount > 0 ? (
                        <span className="nav-dot" role="img" aria-label={`${attentionCount} folders need attention`} />
                      ) : null}
                      {item.id === "devices" && pendingApprovals > 0 ? (
                        <span className="nav-dot" role="img" aria-label={`${pendingApprovals} approvals waiting`} />
                      ) : null}
                    </button>
                  )
                })}
              </div>
            </nav>
          ))}
        </div>

        <div className="sidebar-footer">
          <ThemeSwitcher theme={snapshot.settings.theme} />
          <div className="device-chip">
            <div className="device-icon">
              <LaptopIcon />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-semibold">{localDevice.name}</p>
              <p className="truncate text-[10px] text-muted-foreground">{prettyPlatform(localDevice.platform)}</p>
            </div>
          </div>
        </div>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div className="min-w-0">
            <p className="eyebrow">{allNavItems.find((item) => item.id === view)?.label}</p>
            <h1>{viewTitle(view, snapshot)}</h1>
          </div>
          <div className="topbar-actions">
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
            <div className="topbar-divider" aria-hidden="true" />
            <div className="identity-chip">
              <span className="identity-avatar" aria-hidden="true">
                {initials(localDevice.name)}
              </span>
              <div className="min-w-0">
                <strong>{localDevice.name}</strong>
                <span>{prettyPlatform(localDevice.platform)}</span>
              </div>
            </div>
          </div>
        </header>

        <div className="main-body">
          <UpdateBanner update={snapshot.update} />
          <MappingStoreBanner state={snapshot.mappingStore} />

          <div className="content-scroll">
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
    <div className="page-stack">
      <section className="card status-hero">
        <div className="mesh" aria-hidden="true" />
        <div className="status-hero-copy">
          <p className="welcome-eyebrow">Current status</p>
          <h2>{overallHeadline(snapshot)}</h2>
          <p>{overallDescription(snapshot)}</p>
          <div className="hero-chips">
            <span className="hero-chip">
              <StatusPill
                tone={snapshot.engineStatus === "ready" ? "success" : snapshot.engineStatus === "starting" ? "info" : "warning"}
                bare
                pulse={snapshot.engineStatus === "starting"}
              >
                Engine
              </StatusPill>
              <strong>{snapshot.engineMessage ?? pretty(snapshot.engineStatus)}</strong>
            </span>
            <span className="hero-chip">
              <StatusPill tone={snapshot.route === "offline" ? "neutral" : "success"} bare>
                Transport
              </StatusPill>
              <strong>{snapshot.route === "offline" ? "No peer connected" : `Encrypted · ${prettyRoute(snapshot.route)}`}</strong>
            </span>
          </div>
        </div>
        <div className="status-hero-side">
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
          <div className="status-hero-actions">
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
        <section className="card setup-steps">
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
        <div className="metric-strip">
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
        <section className="card">
          <div className="card-head">
            <div className="min-w-0">
              <h2 className="card-title">Transfer throughput</h2>
              <p className="card-caption">Live sample of all folder transfers, taken every 2 seconds.</p>
            </div>
            <div className="network-stats">
              <span className="network-stat" data-dir="up">
                <ArrowUpIcon />
                <strong>{formatRate(throughput)}</strong>
              </span>
              <span className="network-stat" data-dir="down">
                <ArrowDownIcon />
                <strong>{formatRate(0)}</strong>
              </span>
            </div>
          </div>
          <div className="card-body">
            <div className="chart-frame">
              {hasLiveThroughput ? (
                <Sparkline points={history} height={132} />
              ) : (
                <div className="chart-overlay">
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

      <div className="split-even">
        <section className="card">
          <div className="card-head">
            <div className="min-w-0">
              <h2 className="card-title">Recent activity</h2>
              <p className="card-caption">Configuration and connection events.</p>
            </div>
            <button type="button" className="card-link" onClick={() => onNavigate("activity")}>
              View log
              <ArrowRightIcon />
            </button>
          </div>
          {latestActivity.length === 0 ? (
            <CompactEmptyState icon={ActivityIcon} title="Nothing to show" description="Events appear here as you configure and sync." />
          ) : (
            <div className="activity-list compact">
              {latestActivity.map((event) => (
                <ActivityRow key={event.id} event={event} />
              ))}
            </div>
          )}
        </section>

        <section className="card">
          <div className="card-head">
            <div className="min-w-0">
              <h2 className="card-title">Platform settings</h2>
              <p className="card-caption">The switches you change most often.</p>
            </div>
            <button type="button" className="card-link" onClick={() => onNavigate("settings")}>
              All settings
              <ArrowRightIcon />
            </button>
          </div>
          <div className="card-body">
            <p className="panel-subheading">General preferences</p>
            <div className="settings-panel-list">
              <QuickSetting label="Keep syncing in the tray" setting="closeToTray" settings={snapshot.settings} />
              <QuickSetting label="Launch after sign-in" setting="launchAtLogin" settings={snapshot.settings} />
              <QuickSetting label="Start minimised" setting="startMinimised" settings={snapshot.settings} />
            </div>
            <p className="panel-subheading">Network safeguards</p>
            <div className="settings-panel-list">
              <QuickSetting label="Pause on metered networks" setting="pauseOnMetered" settings={snapshot.settings} />
            </div>
          </div>
        </section>
      </div>

      <div className="tile-row">
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
    <div className="setup-step" data-state={state}>
      <span className="setup-step-index">{state === "done" ? <CheckCircle2Icon /> : index}</span>
      <div className="min-w-0 flex-1">
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
      {action ? (
        <button type="button" className="tile-button" onClick={action.onClick}>
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
    <article className="metric-tile">
      <div className="metric-tile-head">
        <span className="icon-tile" data-size="sm" data-tone={tone === "neutral" ? "neutral" : undefined}>
          <Icon />
        </span>
        <StatusPill tone={tone} bare>
          {status}
        </StatusPill>
      </div>
      <strong className="metric-tile-value" title={value}>
        {value}
      </strong>
      <span className="metric-tile-label">{label}</span>
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
    <section className={cn("card feature-tile", className)}>
      <div className="mesh" aria-hidden="true" />
      <div className="flex items-start gap-3">
        <div className="icon-tile" data-tone={tone === "neutral" ? "neutral" : undefined}>
          <Icon />
        </div>
        <div className="min-w-0">
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
      </div>
      <div className="feature-tile-foot">
        <StatusPill tone={tone} bare>
          {status}
        </StatusPill>
        <button type="button" className="tile-button" onClick={onAction}>
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
    <div className="settings-panel-row">
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
    <div className="page-stack">
      <section className="section-intro">
        <div>
          <h2>Folder mappings</h2>
          <p>Each mapping has independent paths, direction, exclusions, history and bandwidth settings.</p>
        </div>
        {snapshot.folders.length > 0 ? (
          <div className="segmented" role="group" aria-label="Filter folders">
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
        <section className="pairing-gate-card">
          <div className="pairing-gate-icon">
            <LockKeyholeIcon />
          </div>
          <div className="pairing-gate-copy">
            <p className="eyebrow">Protected setup order</p>
            <h2>Pair your second computer before choosing folders</h2>
            <p>
              Tethera needs a trusted device identity before it can safely browse a destination or create a folder mapping. No
              folder can be added while this computer is unpaired.
            </p>
            <div className="pairing-gate-points">
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
        <section className="mapping-request-list">
          {snapshot.mappings.outgoing.map((request) => (
            <div key={request.id} className={`mapping-request-row mapping-request-${request.status}`}>
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
        <section className="card">
          <CompactEmptyState
            icon={RefreshCwIcon}
            title="Loading folder mappings"
            description="Tethera is reading the authoritative mapping database. No legacy snapshot is being shown while it loads."
          />
        </section>
      ) : snapshot.mappingStore.status !== "ready" ? null : snapshot.folders.length === 0 && pairedDevice ? (
        <section className="large-empty-state">
          <div className="large-empty-icon">
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
            <div className="attention-banner">
              <CircleAlertIcon />
              <div>
                <strong>Existing mappings are inactive</strong>
                <span>These were created before pairing became mandatory. Pair a device before they can be used.</span>
              </div>
            </div>
          ) : null}
          {folders.length === 0 ? (
            <section className="card">
              <CompactEmptyState
                icon={FolderClockIcon}
                title="No folders in this filter"
                description="Switch back to All to see every configured mapping."
              />
            </section>
          ) : (
            <section className="folder-grid">
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
    <article className="folder-card">
      <div className="folder-card-head">
        <div className="icon-tile" data-tone={paused ? "neutral" : undefined}>
          <FolderIcon />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate">{folder.name}</h3>
            <StatusPill tone={statusTone(folder.status)} pulse={folder.status === "syncing"}>
              {folderStatusLabel(folder)}
            </StatusPill>
          </div>
          <p className="mt-1 truncate text-[11px] text-muted-foreground">{prettyMode(folder.mode)}</p>
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

      <div className="path-map">
        <PathBlock label="This computer" path={folder.localPath} onReveal={() => window.folderSync.revealPath(folder.localPath)} />
        <div className="path-arrow">
          <ArrowRightIcon />
        </div>
        <PathBlock label="Paired computer" path={folder.remotePath} />
      </div>

      {folder.progress !== undefined ? (
        <div className="folder-progress">
          <Meter
            label={folder.currentAction ?? "Transferring"}
            value={folder.progress}
            readout={folder.bytesPerSecond ? formatRate(folder.bytesPerSecond) : `${Math.round(folder.progress * 100)}%`}
          />
        </div>
      ) : null}

      {folder.currentAction && folder.progress === undefined ? (
        <div className="folder-action-note" role={folder.status === "needs-attention" ? "alert" : undefined}>
          {folder.status === "needs-attention" ? <CircleAlertIcon /> : <ShieldCheckIcon />}
          <span>{folder.currentAction}</span>
        </div>
      ) : null}

      <div className="folder-stats">
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

      <div className="folder-card-footer">
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
    <div className="page-stack">
      <section className="section-intro">
        <div>
          <h2>Activity log</h2>
          <p>Configuration, connections, transfers, conflicts and recovery operations are recorded locally.</p>
        </div>
        <Button variant="outline" disabled title="Diagnostic export is not implemented yet">
          <ExternalLinkIcon data-icon="inline-start" />
          Export diagnostics
        </Button>
      </section>

      <section className="card">
        {activity.length === 0 ? (
          <CompactEmptyState icon={ActivityIcon} title="No activity yet" description="Events appear when you configure or sync folders." />
        ) : (
          <div className="activity-list">
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
    <div className="activity-row">
      <div className={cn("activity-icon", `activity-${event.level}`)}>
        <Icon />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[12.5px] font-semibold">{event.title}</p>
        <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{event.detail}</p>
      </div>
      <time className="shrink-0 text-[10px] tabular-nums text-muted-foreground" dateTime={event.occurredAt}>
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
    <div className="page-stack">
      <section className="section-intro">
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
        <section className="incoming-pairing-banner">
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
        <section className="incoming-pairing-banner">
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

      <section className="device-grid">
        {snapshot.devices.map((device) => (
          <article className="device-card" key={device.id}>
            <div className="device-illustration">
              {device.platform === "windows" ? <ComputerIcon /> : <LaptopIcon />}
              <span className={cn("presence-dot", device.status === "online" || device.status === "this-device" ? "online" : "offline")} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3>{device.name}</h3>
                {device.status === "this-device" ? <Badge variant="info">This device</Badge> : null}
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">{prettyPlatform(device.platform)}</p>
            </div>
            <dl className="device-details">
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
                <dd className="device-fingerprint">{device.fingerprint ?? "Loading…"}</dd>
              </div>
            </dl>
            {device.status !== "this-device" ? <RevokeDeviceDialog device={device} /> : null}
          </article>
        ))}

        <article className="pair-device-card">
          <div className="large-empty-icon">
            <Link2Icon />
          </div>
          <strong>Pair a second computer</strong>
          <span>
            Nearby devices are discovered over your LAN. Both computers compare a one-time code before their identity keys are
            saved.
          </span>
          <div className="pair-device-actions">
            <PairDeviceDialog snapshot={snapshot} />
            <Button variant="outline" onClick={() => setPickerOpen(true)}>
              <FolderOpenIcon data-icon="inline-start" />
              Preview folder browser
            </Button>
          </div>
        </article>
      </section>

      <section className="setup-order-card">
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
    <div className="page-stack">
      <section className="section-intro">
        <div>
          <h2>Version history and deleted files</h2>
          <p>Overwritten and deleted copies will be stored locally in the central recovery archive.</p>
        </div>
      </section>
      <section className="large-empty-state">
        <div className="large-empty-icon">
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
    <div className="page-stack max-w-4xl">
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
        <div className="mapping-diagnostics">
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
            className="field-control w-40"
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
    <section className="settings-section">
      <div className="settings-heading">
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      <div className="settings-list">{children}</div>
    </section>
  )
}

function SettingRow({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <div className="setting-row">
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
    <div className="theme-switcher">
      <span>Appearance</span>
      <div className="theme-options" role="group" aria-label="Theme">
        {options.map((option) => {
          const Icon = option.icon
          return (
            <button
              key={option.id}
              type="button"
              className="theme-option"
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
    <div className="path-block">
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
      <div className="update-banner update-banner-error">
        <CircleAlertIcon />
        <span>Update check failed: {update.message ?? "Unknown error."}</span>
      </div>
    )
  }

  if (update.status === "available") {
    return (
      <div className="update-banner">
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
      <div className="update-banner">
        <DownloadIcon />
        <span>Downloading update… {update.progressPercent ?? 0}%</span>
      </div>
    )
  }

  return (
    <div className="update-banner">
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
    <div className="compact-empty">
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
    <div className="loading-screen">
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
