import { useState, type ChangeEvent, type KeyboardEvent, type ReactNode } from "react"
import { CheckCircle2Icon, DownloadIcon, RefreshCwIcon, RocketIcon } from "lucide-react"
import type { AppSettings, AppSnapshot, UpdateState } from "@shared/contracts"
import { Button } from "@/components/ui/button"
import { StatusPill } from "@/components/ui/status-pill"
import { Switch } from "@/components/ui/switch"
import { pretty } from "@/lib/format"
import { downloadReadout, formatLastChecked } from "@/lib/update-format"

export function SettingsView({ snapshot }: { snapshot: AppSnapshot }) {
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
        title="Updates"
        description="Tethera checks at startup and every few hours, then only downloads when you ask."
      >
        <UpdateSettingsRow update={snapshot.update} />
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

      <SettingsSection
        title="Scanning"
        description="Bound how much one folder scan collects on this computer before it reports a partial result."
      >
        <ScanLimitRow settings={settings} update={update} />
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

function ScanLimitRow({
  settings,
  update,
}: {
  settings: AppSettings
  update: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => Promise<void>
}) {
  const unlimited = settings.maxScanFiles === null
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const shown = draft ?? (unlimited ? "" : String(settings.maxScanFiles))

  async function commit(raw: string): Promise<void> {
    // The accepted envelope lives in main/ipc-validation.ts: a whole number
    // between 1,000 and 1,000,000, or No limit.
    const parsed = Number(raw)
    if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > 1_000_000) {
      setError("Enter a whole number between 1,000 and 1,000,000, or switch on No limit.")
      return
    }
    setError(null)
    setDraft(null)
    try {
      await update("maxScanFiles", parsed)
    } catch {
      setError("That didn't work. Try again shortly.")
    }
  }

  async function setUnlimited(next: boolean): Promise<void> {
    setError(null)
    setDraft(null)
    try {
      await update("maxScanFiles", next ? null : 10_000)
    } catch {
      setError("That didn't work. Try again shortly.")
    }
  }

  return (
    <SettingRow
      title="Scan file limit"
      description={
        error ??
        (unlimited
          ? "Scans collect every file without stopping. Very large folders use more memory while they compare."
          : "A scan stops and reports a partial result past this many files. Previews and transfers on this computer use it.")
      }
    >
      <div className="[display:flex] [align-items:center] [gap:10px]">
        <input
          className="field-control [width:100%] [height:38px] [border:1px_solid_var(--input)] [border-radius:9px] [outline:none] [background:var(--surface-sunken)] [padding:0_11px] [color:var(--foreground)] [font-size:12.5px] [transition:140ms_ease] [&:focus]:[border-color:color-mix(in_oklab,_var(--ring)_65%,_var(--border))] [&:focus]:[box-shadow:0_0_0_3px_color-mix(in_oklab,_var(--ring)_16%,_transparent)] [textarea&]:[height:auto] [textarea&]:[padding-block:10px] [textarea&]:[line-height:1.55] w-32"
          type="number"
          min={1000}
          max={1000000}
          step={1000}
          disabled={unlimited}
          aria-label="Maximum files per scan"
          placeholder="No limit"
          value={shown}
          onChange={(event: ChangeEvent<HTMLInputElement>) => setDraft(event.target.value)}
          onBlur={(event: ChangeEvent<HTMLInputElement>) => void commit(event.target.value)}
          onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
            if (event.key === "Enter") event.currentTarget.blur()
          }}
        />
        <label className="[display:flex] [align-items:center] [gap:6px] [font-size:10.5px] [color:var(--muted-foreground)]">
          <Switch aria-label="No scan file limit" checked={unlimited} onCheckedChange={(checked: boolean) => void setUnlimited(checked)} />
          No limit
        </label>
      </div>
    </SettingRow>
  )
}

function updateHeadline(update: UpdateState): { title: string; description: string } {
  const checked = formatLastChecked(update.lastCheckedAt)
  const checkedSuffix = checked ? ` · Last checked ${checked}` : ""
  switch (update.status) {
    case "checking":
      return { title: "Checking for updates…", description: "Comparing your build with the latest release." }
    case "available":
      return {
        title: `Tethera v${update.version} is available`,
        description: `You're on v${update.currentVersion ?? "unknown"}${checkedSuffix}. Downloading starts only when you ask.`,
      }
    case "downloading":
      return {
        title: `Downloading v${update.version}… ${Math.round(update.progressPercent)}%`,
        description: `${downloadReadout(update)}${checkedSuffix}. Keep Tethera open until it finishes.`,
      }
    case "downloaded":
      return {
        title: `Tethera v${update.version} is ready`,
        description: "Restart to switch to the new version. Folders and pairings carry over.",
      }
    case "not-available":
      return {
        title: "You're up to date",
        description: `Tethera v${update.currentVersion ?? "unknown"}${checkedSuffix}.`,
      }
    case "error":
      return { title: "Update check failed", description: `${update.message} We'll retry automatically.` }
    case "idle":
    default:
      return {
        title: "Automatic updates",
        description: `You're on v${update.currentVersion ?? "unknown"}. Installed builds check at startup and every few hours.`,
      }
  }
}

function UpdateSettingsRow({ update }: { update: UpdateState }) {
  const [working, setWorking] = useState<"check" | "download" | "install" | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const { title, description } = updateHeadline(update)
  const releaseNotes = "releaseNotes" in update ? update.releaseNotes : undefined
  const releaseVersion = "version" in update && update.version ? update.version : undefined

  async function run(action: "check" | "download" | "install") {
    if (working) return
    setWorking(action)
    setActionError(null)
    try {
      if (action === "check") await window.folderSync.checkForUpdates()
      else if (action === "download") await window.folderSync.downloadUpdate()
      else await window.folderSync.quitAndInstall()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "That didn't work. Try again shortly.")
    } finally {
      setWorking(null)
    }
  }

  return (
    <>
      <SettingRow title={title} description={actionError ?? description}>
        <div className="[display:flex] [align-items:center] [gap:8px]">
          {update.status === "downloaded" ? (
            <StatusPill tone="success">
              <CheckCircle2Icon className="size-3" /> Ready
            </StatusPill>
          ) : null}
          {update.status === "available" ? (
            <Button size="sm" disabled={working === "download"} onClick={() => void run("download")}>
              <DownloadIcon data-icon="inline-start" />
              {working === "download" ? "Starting…" : `Download v${update.version}`}
            </Button>
          ) : null}
          {update.status === "downloaded" ? (
            <Button size="sm" disabled={working === "install"} onClick={() => void run("install")}>
              <RocketIcon data-icon="inline-start" />
              {working === "install" ? "Restarting…" : "Restart & update"}
            </Button>
          ) : null}
          {update.status !== "checking" && update.status !== "downloading" && update.status !== "downloaded" ? (
            <Button
              size="sm"
              variant={update.status === "available" ? "outline" : "default"}
              disabled={working === "check"}
              onClick={() => void run("check")}
            >
              <RefreshCwIcon className={working === "check" ? "animate-spin" : undefined} data-icon="inline-start" />
              {working === "check" ? "Checking…" : update.status === "error" ? "Retry" : "Check for updates"}
            </Button>
          ) : null}
          {update.status === "downloading" ? (
            <StatusPill tone="info" pulse>
              Downloading
            </StatusPill>
          ) : null}
        </div>
      </SettingRow>
      {releaseNotes && releaseVersion ? (
        <div className="update-release-notes [padding:10px_18px_14px] [color:var(--muted-foreground)] [font-size:10.5px] [&_summary]:[cursor:pointer] [&_summary]:[font-weight:600] [&_p]:[margin:8px_0_0] [&_p]:[white-space:pre-line] [&_p]:[line-height:1.5]">
          <details>
            <summary>What&apos;s new in v{releaseVersion}</summary>
            <p>{releaseNotes}</p>
          </details>
        </div>
      ) : null}
    </>
  )
}
