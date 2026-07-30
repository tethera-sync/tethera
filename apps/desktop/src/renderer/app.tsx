import { useEffect, useMemo, useState, type ChangeEvent, type ReactNode } from "react"
import {
  ActivityIcon,
  ArchiveRestoreIcon,
  ArrowRightIcon,
  CheckCircle2Icon,
  CircleAlertIcon,
  ComputerIcon,
  ExternalLinkIcon,
  FolderClockIcon,
  FolderIcon,
  GaugeIcon,
  HardDriveIcon,
  HistoryIcon,
  LaptopIcon,
  MoreHorizontalIcon,
  NetworkIcon,
  PauseIcon,
  PlayIcon,
  RefreshCwIcon,
  Settings2Icon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  Trash2Icon,
  WifiOffIcon,
} from "lucide-react"
import type {
  ActivityEvent,
  AppSettings,
  AppSnapshot,
  ConnectionRoute,
  FolderSummary,
  OverallStatus,
} from "@shared/contracts"
import { AddFolderDialog } from "@/components/add-folder-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"

const emptySnapshot: AppSnapshot = {
  status: "offline",
  route: "offline",
  engineStatus: "starting",
  engineMessage: "Connecting…",
  paused: false,
  folders: [],
  devices: [],
  activity: [],
  settings: {
    closeToTray: true,
    launchAtLogin: false,
    startMinimised: false,
    pauseOnMetered: true,
    theme: "system",
  },
}

type View = "overview" | "folders" | "activity" | "devices" | "history" | "settings"

const navItems = [
  { id: "overview", label: "Overview", icon: GaugeIcon },
  { id: "folders", label: "Folders", icon: FolderIcon },
  { id: "activity", label: "Activity", icon: ActivityIcon },
  { id: "devices", label: "Devices", icon: ComputerIcon },
  { id: "history", label: "Recovery", icon: ArchiveRestoreIcon },
  { id: "settings", label: "Settings", icon: Settings2Icon },
] satisfies Array<{ id: View; label: string; icon: typeof GaugeIcon }>

export function App() {
  const [snapshot, setSnapshot] = useState(emptySnapshot)
  const [view, setView] = useState<View>("overview")
  const [loading, setLoading] = useState(true)

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

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            <RefreshCwIcon />
          </div>
          <div>
            <p className="brand-name">FolderSync</p>
            <p className="brand-caption">Private peer-to-peer sync</p>
          </div>
        </div>

        <nav className="nav-list" aria-label="Primary navigation">
          {navItems.map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.id}
                type="button"
                className={cn("nav-item", view === item.id && "nav-item-active")}
                onClick={() => setView(item.id)}
              >
                <Icon />
                <span>{item.label}</span>
                {item.id === "activity" && snapshot.activity.length > 0 ? (
                  <span className="nav-count">{Math.min(snapshot.activity.length, 99)}</span>
                ) : null}
              </button>
            )
          })}
        </nav>

        <div className="sidebar-footer">
          <EngineCard snapshot={snapshot} />
          <div className="device-chip">
            <div className="device-icon">
              <LaptopIcon />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{snapshot.devices[0]?.name ?? "This computer"}</p>
              <p className="truncate text-xs text-muted-foreground">{prettyPlatform(snapshot.devices[0]?.platform)}</p>
            </div>
          </div>
        </div>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div>
            <p className="eyebrow">{navItems.find((item) => item.id === view)?.label}</p>
            <h1>{viewTitle(view, snapshot)}</h1>
          </div>
          <div className="topbar-actions">
            <ConnectionBadge route={snapshot.route} />
            <Button variant="outline" onClick={togglePause}>
              {snapshot.paused ? <PlayIcon data-icon="inline-start" /> : <PauseIcon data-icon="inline-start" />}
              {snapshot.paused ? "Resume all" : "Pause all"}
            </Button>
            <AddFolderDialog onAdded={() => setView("folders")} />
          </div>
        </header>

        <div className="content-scroll">
          {loading ? <LoadingScreen /> : null}
          {!loading && view === "overview" ? <Overview snapshot={snapshot} onNavigate={setView} /> : null}
          {!loading && view === "folders" ? <FoldersView snapshot={snapshot} /> : null}
          {!loading && view === "activity" ? <ActivityView activity={snapshot.activity} /> : null}
          {!loading && view === "devices" ? <DevicesView snapshot={snapshot} /> : null}
          {!loading && view === "history" ? <HistoryView /> : null}
          {!loading && view === "settings" ? <SettingsView settings={snapshot.settings} /> : null}
        </div>
      </main>
    </div>
  )
}

function Overview({ snapshot, onNavigate }: { snapshot: AppSnapshot; onNavigate: (view: View) => void }) {
  const activeFolders = snapshot.folders.filter((folder) => folder.status !== "paused").length
  const attentionCount = snapshot.folders.filter((folder) => folder.status === "needs-attention").length
  const latestActivity = snapshot.activity.slice(0, 5)

  return (
    <div className="page-stack">
      <section className="hero-card">
        <div className="hero-copy">
          <div className={cn("hero-status-icon", statusTone(snapshot.status))}>
            {snapshot.status === "needs-attention" ? <CircleAlertIcon /> : snapshot.paused ? <PauseIcon /> : <ShieldCheckIcon />}
          </div>
          <div>
            <p className="text-sm font-medium text-muted-foreground">Current status</p>
            <h2>{overallHeadline(snapshot)}</h2>
            <p>{overallDescription(snapshot)}</p>
          </div>
        </div>
        <div className="hero-meta">
          <span>{snapshot.folders.length} configured folders</span>
          <span>{snapshot.devices.length - 1} paired devices</span>
        </div>
      </section>

      <section className="metrics-grid" aria-label="Sync summary">
        <MetricCard icon={FolderIcon} label="Active folders" value={String(activeFolders)} detail={`${snapshot.folders.length} total configured`} />
        <MetricCard icon={NetworkIcon} label="Connection" value={prettyRoute(snapshot.route)} detail={snapshot.peerName ?? "No paired peer online"} />
        <MetricCard icon={HardDriveIcon} label="Transfer queue" value="0 B" detail="Nothing waiting to transfer" />
        <MetricCard
          icon={attentionCount > 0 ? CircleAlertIcon : CheckCircle2Icon}
          label="Needs attention"
          value={String(attentionCount)}
          detail={attentionCount > 0 ? "Review before syncing" : "No unresolved problems"}
        />
      </section>

      <section className="two-column-grid">
        <div className="panel-card">
          <PanelHeader title="Synced folders" description="Folders configured on this computer." actionLabel="View all" onAction={() => onNavigate("folders")} />
          {snapshot.folders.length === 0 ? (
            <CompactEmptyState
              icon={FolderClockIcon}
              title="No folders yet"
              description="Add your first folder to define what FolderSync should manage."
            />
          ) : (
            <div className="divide-y divide-border">
              {snapshot.folders.slice(0, 4).map((folder) => (
                <FolderRow key={folder.id} folder={folder} compact />
              ))}
            </div>
          )}
        </div>

        <div className="panel-card">
          <PanelHeader title="Recent activity" description="Important changes and configuration events." actionLabel="View log" onAction={() => onNavigate("activity")} />
          {latestActivity.length === 0 ? (
            <CompactEmptyState icon={ActivityIcon} title="Nothing to show" description="Sync and configuration events will appear here." />
          ) : (
            <div className="activity-list compact">
              {latestActivity.map((event) => (
                <ActivityRow key={event.id} event={event} />
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

function FoldersView({ snapshot }: { snapshot: AppSnapshot }) {
  return (
    <div className="page-stack">
      <section className="section-intro">
        <div>
          <h2>Folder mappings</h2>
          <p>Each mapping has independent paths, direction, exclusions, history and bandwidth settings.</p>
        </div>
        <Badge variant="neutral">{snapshot.folders.length} configured</Badge>
      </section>

      {snapshot.folders.length === 0 ? (
        <section className="large-empty-state">
          <div className="large-empty-icon"><FolderIcon /></div>
          <h2>Choose exactly what stays in sync</h2>
          <p>
            FolderSync never assumes your whole computer should be copied. Add individual folders and choose a destination for each device.
          </p>
          <AddFolderDialog onAdded={() => undefined} />
        </section>
      ) : (
        <section className="folder-grid">
          {snapshot.folders.map((folder) => (
            <FolderCard key={folder.id} folder={folder} />
          ))}
        </section>
      )}
    </div>
  )
}

function FolderCard({ folder }: { folder: FolderSummary }) {
  const [busy, setBusy] = useState(false)
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
      `Remove “${folder.name}” from FolderSync? Files on both computers will be left untouched.`,
    )
    if (confirmed) await window.folderSync.removeFolder(folder.id)
  }

  return (
    <article className="folder-card">
      <div className="folder-card-head">
        <div className="folder-icon-tile"><FolderIcon /></div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate">{folder.name}</h3>
            <StatusBadge status={folder.status} />
          </div>
          <p className="mt-1 truncate text-sm text-muted-foreground">{prettyMode(folder.mode)}</p>
        </div>
        <Button size="icon-sm" variant="ghost" disabled title="Folder actions are part of the next milestone" aria-label={`More options for ${folder.name}`}>
          <MoreHorizontalIcon />
        </Button>
      </div>

      <div className="path-map">
        <PathBlock label="This computer" path={folder.localPath} onReveal={() => window.folderSync.revealPath(folder.localPath)} />
        <div className="path-arrow"><ArrowRightIcon /></div>
        <PathBlock label="Paired computer" path={folder.remotePath} />
      </div>

      <div className="folder-stats">
        <div><span>Files</span><strong>{folder.fileCount?.toLocaleString("en-GB") ?? "Not scanned"}</strong></div>
        <div><span>Ignored rules</span><strong>{folder.ignorePatterns.length}</strong></div>
        <div><span>Last sync</span><strong>{folder.lastSyncedAt ? formatRelative(folder.lastSyncedAt) : "Never"}</strong></div>
      </div>

      <div className="folder-card-footer">
        <Button size="sm" variant="outline" onClick={setPaused} disabled={busy}>
          {paused ? <PlayIcon data-icon="inline-start" /> : <PauseIcon data-icon="inline-start" />}
          {paused ? "Resume" : "Pause"}
        </Button>
        <Button size="sm" variant="ghost" disabled title="Detailed folder settings are part of the next milestone"><SlidersHorizontalIcon data-icon="inline-start" />Settings</Button>
        <Button className="ml-auto" size="icon-sm" variant="ghost" aria-label={`Remove ${folder.name}`} onClick={remove}>
          <Trash2Icon />
        </Button>
      </div>
    </article>
  )
}

function FolderRow({ folder, compact = false }: { folder: FolderSummary; compact?: boolean }) {
  return (
    <div className={cn("folder-row", compact && "folder-row-compact")}>
      <div className="folder-row-icon"><FolderIcon /></div>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{folder.name}</p>
        <p className="truncate text-xs text-muted-foreground">{folder.localPath}</p>
      </div>
      <StatusBadge status={folder.status} />
    </div>
  )
}

function ActivityView({ activity }: { activity: ActivityEvent[] }) {
  return (
    <div className="page-stack">
      <section className="section-intro">
        <div>
          <h2>Activity log</h2>
          <p>Configuration, connections, transfers, conflicts and recovery operations will be recorded locally.</p>
        </div>
        <Button variant="outline" disabled title="Diagnostic export is not implemented yet"><ExternalLinkIcon data-icon="inline-start" />Export diagnostics</Button>
      </section>

      <section className="panel-card overflow-hidden">
        {activity.length === 0 ? (
          <CompactEmptyState icon={ActivityIcon} title="No activity yet" description="Events will appear when you configure or sync folders." />
        ) : (
          <div className="activity-list">
            {activity.map((event) => <ActivityRow key={event.id} event={event} showDate />)}
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
      <div className={cn("activity-icon", `activity-${event.level}`)}><Icon /></div>
      <div className="min-w-0 flex-1">
        <p className="font-medium">{event.title}</p>
        <p className="mt-0.5 text-sm text-muted-foreground">{event.detail}</p>
      </div>
      <time className="shrink-0 text-xs text-muted-foreground" dateTime={event.occurredAt}>
        {showDate ? formatDateTime(event.occurredAt) : formatRelative(event.occurredAt)}
      </time>
    </div>
  )
}

function DevicesView({ snapshot }: { snapshot: AppSnapshot }) {
  return (
    <div className="page-stack">
      <section className="section-intro">
        <div>
          <h2>Trusted devices</h2>
          <p>Devices use persistent cryptographic identities. Both sides must approve every pairing.</p>
        </div>
        <Button disabled title="Pairing is the next implementation milestone"><ComputerIcon data-icon="inline-start" />Pairing next</Button>
      </section>

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
              <p className="mt-1 text-sm text-muted-foreground">{prettyPlatform(device.platform)}</p>
            </div>
            <dl className="device-details">
              <div><dt>Status</dt><dd>{pretty(device.status)}</dd></div>
              <div><dt>Connection</dt><dd>{prettyRoute(device.route)}</dd></div>
              <div><dt>Address</dt><dd>{device.address ?? "Not connected"}</dd></div>
            </dl>
          </article>
        ))}

        <button type="button" className="pair-device-card" disabled>
          <div className="large-empty-icon"><ComputerIcon /></div>
          <strong>Pairing is the next milestone</strong>
          <span>The planned flow supports a one-time code, QR code and local-network approval.</span>
        </button>
      </section>
    </div>
  )
}

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
        <div className="large-empty-icon"><HistoryIcon /></div>
        <h2>No recoverable versions yet</h2>
        <p>The archive browser becomes active once the Rust engine starts recording replaced or deleted files.</p>
      </section>
    </div>
  )
}

function SettingsView({ settings }: { settings: AppSettings }) {
  async function update<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    await window.folderSync.updateSetting(key, value)
  }

  return (
    <div className="page-stack max-w-4xl">
      <SettingsSection title="Application" description="Choose how FolderSync behaves when the desktop window is closed or the computer starts.">
        <SettingRow title="Keep syncing in the tray" description="Closing the window hides FolderSync instead of quitting it.">
          <Switch aria-label="Keep syncing in the tray" checked={settings.closeToTray} onCheckedChange={(checked: boolean) => update("closeToTray", checked)} />
        </SettingRow>
        <SettingRow title="Launch after sign-in" description="Start FolderSync when you sign into Windows or Linux.">
          <Switch aria-label="Launch after sign-in" checked={settings.launchAtLogin} onCheckedChange={(checked: boolean) => update("launchAtLogin", checked)} />
        </SettingRow>
        <SettingRow title="Start minimised" description="Open directly into the system tray when launched automatically.">
          <Switch aria-label="Start minimised" checked={settings.startMinimised} onCheckedChange={(checked: boolean) => update("startMinimised", checked)} />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Network" description="Bandwidth and connection safeguards. Detailed per-folder limits are planned for the sync milestone.">
        <SettingRow title="Pause on metered networks" description="Avoid large transfers on connections marked as metered.">
          <Switch aria-label="Pause on metered networks" checked={settings.pauseOnMetered} onCheckedChange={(checked: boolean) => update("pauseOnMetered", checked)} />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Appearance" description="The interface follows your system theme by default.">
        <SettingRow title="Theme" description="Change the desktop interface without affecting sync behaviour.">
          <select className="field-control w-40" value={settings.theme} onChange={(event: ChangeEvent<HTMLSelectElement>) => update("theme", event.target.value as AppSettings["theme"])}>
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
      <div className="settings-heading"><h2>{title}</h2><p>{description}</p></div>
      <div className="settings-list">{children}</div>
    </section>
  )
}

function SettingRow({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <div className="setting-row">
      <div><h3>{title}</h3><p>{description}</p></div>
      <div className="shrink-0">{children}</div>
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
          <button type="button" aria-label={`Reveal ${path}`} onClick={onReveal}><ExternalLinkIcon /></button>
        ) : null}
      </div>
    </div>
  )
}

function EngineCard({ snapshot }: { snapshot: AppSnapshot }) {
  const icon = snapshot.engineStatus === "ready" ? CheckCircle2Icon : snapshot.engineStatus === "starting" ? RefreshCwIcon : CircleAlertIcon
  const Icon = icon
  return (
    <div className={cn("engine-card", `engine-${snapshot.engineStatus}`)}>
      <Icon className={snapshot.engineStatus === "starting" ? "animate-spin" : undefined} />
      <div className="min-w-0">
        <p>Rust engine · {pretty(snapshot.engineStatus)}</p>
        <span title={snapshot.engineMessage}>{snapshot.engineMessage}</span>
      </div>
    </div>
  )
}

function ConnectionBadge({ route }: { route: ConnectionRoute }) {
  return (
    <Badge variant={route === "offline" ? "neutral" : "success"}>
      {route === "offline" ? <WifiOffIcon /> : <NetworkIcon />}
      {prettyRoute(route)}
    </Badge>
  )
}

function StatusBadge({ status }: { status: OverallStatus }) {
  const variant = status === "up-to-date" ? "success" : status === "needs-attention" ? "danger" : status === "paused" ? "warning" : "neutral"
  return <Badge variant={variant}>{pretty(status)}</Badge>
}

function MetricCard({ icon: Icon, label, value, detail }: { icon: typeof FolderIcon; label: string; value: string; detail: string }) {
  return (
    <article className="metric-card">
      <div className="metric-icon"><Icon /></div>
      <div><p>{label}</p><strong>{value}</strong><span>{detail}</span></div>
    </article>
  )
}

function PanelHeader({ title, description, actionLabel, onAction }: { title: string; description: string; actionLabel: string; onAction: () => void }) {
  return (
    <div className="panel-header">
      <div><h2>{title}</h2><p>{description}</p></div>
      <Button variant="ghost" size="sm" onClick={onAction}>{actionLabel}<ArrowRightIcon data-icon="inline-end" /></Button>
    </div>
  )
}

function CompactEmptyState({ icon: Icon, title, description }: { icon: typeof FolderIcon; title: string; description: string }) {
  return (
    <div className="compact-empty"><Icon /><div><p>{title}</p><span>{description}</span></div></div>
  )
}

function LoadingScreen() {
  return (
    <div className="loading-screen">
      <RefreshCwIcon className="animate-spin" />
      <p>Loading FolderSync…</p>
    </div>
  )
}

function viewTitle(view: View, snapshot: AppSnapshot): string {
  if (view === "overview") return snapshot.paused ? "Syncing is paused" : "Your folders at a glance"
  if (view === "folders") return "Synced folders"
  if (view === "activity") return "What FolderSync has done"
  if (view === "devices") return "Devices and connections"
  if (view === "history") return "Recover earlier versions"
  return "Application preferences"
}

function overallHeadline(snapshot: AppSnapshot): string {
  if (snapshot.paused) return "Everything is safely paused"
  if (snapshot.status === "needs-attention") return "A folder needs your attention"
  if (snapshot.folders.length === 0) return "Ready for your first folder"
  if (snapshot.route === "offline") return "Configured and waiting for a peer"
  return "Everything is up to date"
}

function overallDescription(snapshot: AppSnapshot): string {
  if (snapshot.paused) return "Folder changes will remain local until you resume syncing."
  if (snapshot.folders.length === 0) return "Choose a local folder and the path it should use on your second computer."
  if (snapshot.engineStatus !== "ready") return "Your folder mappings are saved, but live scanning waits for the Rust engine."
  if (snapshot.route === "offline") return "No paired device is currently connected. Your files remain unchanged."
  return "There are no queued transfers or unresolved conflicts."
}

function pretty(value: string): string {
  return value.replaceAll("-", " ").replace(/^./, (character) => character.toUpperCase())
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

function statusTone(status: OverallStatus): string {
  if (status === "needs-attention") return "tone-danger"
  if (status === "paused") return "tone-warning"
  return "tone-success"
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
