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
  FolderOpenIcon,
  GaugeIcon,
  HardDriveIcon,
  HistoryIcon,
  LaptopIcon,
  Link2Icon,
  LockKeyholeIcon,
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
  DeviceSummary,
  FolderSummary,
  OverallStatus,
} from "@shared/contracts"
import { AddFolderDialog } from "@/components/add-folder-dialog"
import { FolderPickerDialog } from "@/components/folder-picker-dialog"
import { FolderMappingApprovalDialog } from "@/components/folder-mapping-approval-dialog"
import { PairDeviceDialog } from "@/components/pair-device-dialog"
import { RevokeDeviceDialog } from "@/components/revoke-device-dialog"
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

  const localDevice = getLocalDevice(snapshot)
  const pairedDevice = getPairedDevices(snapshot)[0]
  const pendingMapping = snapshot.mappings.incoming.find((request) => request.status === "pending")

  return (
    <div className="app-shell">
      <FolderMappingApprovalDialog request={pendingMapping} localDevice={localDevice} />
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
            <Button variant="outline" onClick={togglePause} disabled={snapshot.folders.length === 0}>
              {snapshot.paused ? <PlayIcon data-icon="inline-start" /> : <PauseIcon data-icon="inline-start" />}
              {snapshot.paused ? "Resume all" : "Pause all"}
            </Button>
            {pairedDevice ? (
              <AddFolderDialog
                localDevice={localDevice}
                pairedDevice={pairedDevice}
                onAdded={() => setView("folders")}
                disabled={pairedDevice.status !== "online"}
                disabledReason={`${pairedDevice.name} must be online to browse and approve a mapping.`}
              />
            ) : (
              <Button onClick={() => setView("devices")}>
                <Link2Icon data-icon="inline-start" />
                Pair device
              </Button>
            )}
          </div>
        </header>

        <div className="content-scroll">
          {loading ? <LoadingScreen /> : null}
          {!loading && view === "overview" ? <Overview snapshot={snapshot} onNavigate={setView} /> : null}
          {!loading && view === "folders" ? <FoldersView snapshot={snapshot} onNavigate={setView} /> : null}
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
          <span>{getPairedDevices(snapshot).length} paired devices</span>
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
              title={getPairedDevices(snapshot).length === 0 ? "Pair a device first" : "No folders yet"}
              description={getPairedDevices(snapshot).length === 0
                ? "Folder selection unlocks after a trusted second computer is paired."
                : "Add your first folder to define what FolderSync should manage."}
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

function FoldersView({ snapshot, onNavigate }: { snapshot: AppSnapshot; onNavigate: (view: View) => void }) {
  const localDevice = getLocalDevice(snapshot)
  const pairedDevice = getPairedDevices(snapshot)[0]

  return (
    <div className="page-stack">
      <section className="section-intro">
        <div>
          <h2>Folder mappings</h2>
          <p>Each mapping has independent paths, direction, exclusions, history and bandwidth settings.</p>
        </div>
        <Badge variant={pairedDevice ? "neutral" : "warning"}>
          {pairedDevice ? `${snapshot.folders.length} configured` : "Pairing required"}
        </Badge>
      </section>

      {!pairedDevice ? (
        <section className="pairing-gate-card">
          <div className="pairing-gate-icon"><LockKeyholeIcon /></div>
          <div className="pairing-gate-copy">
            <p className="eyebrow">Protected setup order</p>
            <h2>Pair your second computer before choosing folders</h2>
            <p>
              FolderSync needs a trusted device identity before it can safely browse a destination or create a folder mapping.
              No folder can be added while this computer is unpaired.
            </p>
            <div className="pairing-gate-points">
              <span><ShieldCheckIcon /> Both computers approve the pairing</span>
              <span><FolderOpenIcon /> Then choose a folder on each computer</span>
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
              <div><RefreshCwIcon className={request.status === "pending" ? "animate-spin" : undefined} /><span><strong>{request.proposal.name}</strong><small>{request.message ?? pretty(request.status)}</small></span></div>
              <Badge variant={request.status === "approved" ? "success" : request.status === "rejected" || request.status === "failed" ? "danger" : "info"}>{pretty(request.status)}</Badge>
            </div>
          ))}
        </section>
      ) : null}

      {snapshot.folders.length === 0 && pairedDevice ? (
        <section className="large-empty-state">
          <div className="large-empty-icon"><FolderIcon /></div>
          <h2>Choose exactly what stays in sync</h2>
          <p>
            FolderSync never assumes your whole computer should be copied. Use the custom browser to choose one folder on each paired device.
          </p>
          <AddFolderDialog
            localDevice={localDevice}
            pairedDevice={pairedDevice}
            onAdded={() => undefined}
            disabled={pairedDevice.status !== "online"}
            disabledReason={`${pairedDevice.name} must be online to browse and approve a mapping.`}
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
          <section className="folder-grid">
            {snapshot.folders.map((folder) => (
              <FolderCard key={folder.id} folder={folder} />
            ))}
          </section>
        </>
      ) : null}
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

      {folder.currentAction ? <div className="folder-action-note"><ShieldCheckIcon /><span>{folder.currentAction}</span></div> : null}

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
  const [pickerOpen, setPickerOpen] = useState(false)
  const localDevice = getLocalDevice(snapshot)
  const pairedDevices = getPairedDevices(snapshot)

  return (
    <div className="page-stack">
      <section className="section-intro">
        <div>
          <h2>Trusted devices</h2>
          <p>Each computer has a persistent signing identity. Pairing only completes after both people compare and approve the same code.</p>
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
          <div><ShieldCheckIcon /><span><strong>Pairing approval needed</strong><small>Open “Start pairing” to compare the code and approve the request.</small></span></div>
          <PairDeviceDialog snapshot={snapshot} />
        </section>
      ) : null}

      {snapshot.mappings.incoming.some((request) => request.status === "pending") ? (
        <section className="incoming-pairing-banner">
          <div><FolderOpenIcon /><span><strong>Folder approval needed</strong><small>Review the requested local destination before the mapping is created.</small></span></div>
          <Badge variant="warning">Action required</Badge>
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
              <p className="mt-1 text-sm text-muted-foreground">{prettyPlatform(device.platform)}</p>
            </div>
            <dl className="device-details">
              <div><dt>Status</dt><dd>{pretty(device.status)}</dd></div>
              <div><dt>Connection</dt><dd>{prettyRoute(device.route)}</dd></div>
              <div><dt>Address</dt><dd>{device.address ?? "Not connected"}</dd></div>
              <div><dt>Identity</dt><dd className="device-fingerprint">{device.fingerprint ?? "Loading…"}</dd></div>
            </dl>
            {device.status !== "this-device" ? <RevokeDeviceDialog device={device} /> : null}
          </article>
        ))}

        <article className="pair-device-card">
          <div className="large-empty-icon"><Link2Icon /></div>
          <strong>Pair a second computer</strong>
          <span>Nearby devices are discovered over your LAN. Both computers compare a one-time code before their identity keys are saved.</span>
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
        <span>1</span><div><strong>Pair</strong><p>Establish trust between Linux and Windows.</p></div>
        <ArrowRightIcon />
        <span>2</span><div><strong>Choose folders</strong><p>Browse a source and destination with the custom picker.</p></div>
        <ArrowRightIcon />
        <span>3</span><div><strong>Review and sync</strong><p>Preview the initial merge before any files change.</p></div>
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
  if (getPairedDevices(snapshot).length === 0) return "Pair your second computer first"
  if (snapshot.status === "needs-attention") return "A folder needs your attention"
  if (snapshot.folders.length === 0) return "Ready for your first folder"
  if (snapshot.route === "offline") return "Configured and waiting for a peer"
  return "Everything is up to date"
}

function overallDescription(snapshot: AppSnapshot): string {
  if (snapshot.paused) return "Folder changes will remain local until you resume syncing."
  if (getPairedDevices(snapshot).length === 0) return "Folder selection stays locked until both computers approve a secure pairing."
  if (snapshot.folders.length === 0) return "Choose one folder on this computer and its destination on the paired device."
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
  if (status === "paused" || status === "offline") return "tone-warning"
  return "tone-success"
}

function getLocalDevice(snapshot: AppSnapshot): DeviceSummary {
  return snapshot.devices.find((device) => device.status === "this-device") ?? {
    id: "local-device",
    name: "This computer",
    platform: "unknown",
    status: "this-device",
    route: "offline",
  }
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
