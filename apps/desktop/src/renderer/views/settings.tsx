import { useRef, useState, type ChangeEvent, type KeyboardEvent, type ReactNode } from "react"
import { CheckCircle2Icon, DownloadIcon, RefreshCwIcon, RocketIcon } from "lucide-react"
import type { AppSettings, AppSnapshot, UpdateState } from "@shared/contracts"
import { MAX_SYNCABLE_FILES_PER_SIDE } from "@shared/sync-capacity"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { StatusPill } from "@/components/ui/status-pill"
import { Switch } from "@/components/ui/switch"
import { pretty } from "@/lib/format"
import { downloadReadout, formatLastChecked } from "@/lib/update-format"

export function SettingsView({ snapshot }: { snapshot: AppSnapshot }) {
  const { settings, mappingStore } = snapshot
  const [saving, setSaving] = useState<keyof AppSettings | null>(null)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [mappingRetrying, setMappingRetrying] = useState(false)
  const [mappingError, setMappingError] = useState<string | null>(null)
  const mappingRetryingRef = useRef(false)
  const pendingSetting = useRef<keyof AppSettings | null>(null)
  const retrySetting = useRef<{ key: keyof AppSettings; value: AppSettings[keyof AppSettings] } | null>(null)

  async function update<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    // All setting controls disable while `saving` is set, so this guard only
    // covers re-entrant programmatic calls (e.g. double-invoked retries).
    if (pendingSetting.current) return
    pendingSetting.current = key
    retrySetting.current = { key, value }
    setSaving(key)
    setSettingsError(null)
    try {
      await window.folderSync.updateSetting(key, value)
    } catch (error: unknown) {
      setSettingsError(error instanceof Error ? error.message : "That setting could not be saved. Try again.")
    } finally {
      pendingSetting.current = null
      setSaving(null)
    }
  }

  async function retryMappingStore() {
    if (mappingRetryingRef.current) return
    mappingRetryingRef.current = true
    setMappingRetrying(true)
    setMappingError(null)
    try {
      await window.folderSync.retryMappingStore()
    } catch (error: unknown) {
      setMappingError(error instanceof Error ? error.message : "Folder configuration could not be reopened. Try again.")
    } finally {
      mappingRetryingRef.current = false
      setMappingRetrying(false)
    }
  }

  return (
    <div className="page-stack [display:grid] [gap:16px] [width:100%] [max-width:1520px] [margin:0_auto] max-w-4xl">
      <SettingsSection
        title="Application"
        description="Choose what happens when Tethera closes and when you sign in."
      >
        <SettingRow title="Keep syncing in the tray" description="Closing the window hides Tethera instead of quitting it.">
          <Switch
            aria-label="Keep syncing in the tray"
            checked={settings.closeToTray}
            disabled={saving !== null}
            onCheckedChange={(checked: boolean) => void update("closeToTray", checked)}
          />
        </SettingRow>
        <SettingRow title="Launch after sign-in" description="Start Tethera when you sign into Windows or Linux.">
          <Switch
            aria-label="Launch after sign-in"
            checked={settings.launchAtLogin}
            disabled={saving !== null}
            onCheckedChange={(checked: boolean) => void update("launchAtLogin", checked)}
          />
        </SettingRow>
        <SettingRow title="Start minimised" description="Keep the window hidden when Tethera starts.">
          <Switch
            aria-label="Start minimised"
            checked={settings.startMinimised}
            disabled={saving !== null}
            onCheckedChange={(checked: boolean) => void update("startMinimised", checked)}
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection
        title="Scanning"
        description="Bound how much one folder scan collects on this computer before it reports a partial result."
      >
        <ScanLimitRow settings={settings} update={update} savingKey={saving} />
      </SettingsSection>

      <SettingsSection title="Appearance" description="The interface follows your system theme by default.">
        <SettingRow title="Theme" description="Change the desktop interface without affecting sync behaviour.">
          <NativeSelect
            className="w-40"
            value={settings.theme}
            aria-label="Theme"
            disabled={saving !== null}
            onChange={(event: ChangeEvent<HTMLSelectElement>) => {
              const value = event.target.value
              if (value === "system" || value === "light" || value === "dark") void update("theme", value)
            }}
          >
            <NativeSelectOption value="system">System</NativeSelectOption>
            <NativeSelectOption value="light">Light</NativeSelectOption>
            <NativeSelectOption value="dark">Dark</NativeSelectOption>
          </NativeSelect>
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Updates" description="Tethera checks periodically and only downloads when you ask.">
        <UpdateSettingsRow update={snapshot.update} />
      </SettingsSection>

      <SettingsSection title="Network" description="Controls for transfers on limited connections.">
        <SettingRow title="Metered connections" description="Automatic metered connection detection is unavailable. Use Pause all before using a limited connection.">
          <StatusPill tone="neutral">Unavailable</StatusPill>
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Folder configuration" description="The local folder configuration is stored safely on this computer.">
        <SettingRow
          title={mappingStore.status === "ready" ? "Available" : pretty(mappingStore.status)}
          description={mappingStore.status === "ready" ? "Folder changes are ready to use." : mappingStore.detail ?? "Folder changes stay disabled until configuration is available."}
        >
          {mappingStore.status === "ready" ? (
            <StatusPill tone="success"><CheckCircle2Icon className="size-3" /> Ready</StatusPill>
          ) : (
            <Button size="sm" variant="outline" disabled={mappingRetrying || mappingStore.status === "loading"} onClick={() => void retryMappingStore()}>
              <RefreshCwIcon className={mappingRetrying || mappingStore.status === "loading" ? "animate-spin" : undefined} data-icon="inline-start" />
              {mappingRetrying || mappingStore.status === "loading" ? "Retrying…" : "Retry"}
            </Button>
          )}
        </SettingRow>
        <div className="mapping-diagnostics [padding:10px_18px_14px] [color:var(--muted-foreground)] [font-size:11px] [&_summary]:[cursor:pointer] [&_summary]:[font-weight:600] [&_dl]:[display:grid] [&_dl]:[gap:6px] [&_dl]:[margin:10px_0_0] [&_dl>div]:[display:flex] [&_dl>div]:[justify-content:space-between] [&_dt]:[margin:0] [&_dd]:[margin:0] [&_dd]:[color:var(--foreground)] [&_dd]:[font-family:ui-monospace,_SFMono-Regular,_Menlo,_Monaco,_Consolas,_monospace]">
          <details>
            <summary>Technical details</summary>
            <dl>
              <div><dt>Schema version</dt><dd>{mappingStore.schemaVersion ?? "Unavailable"}</dd></div>
              <div><dt>Migration</dt><dd>{mappingStore.migrationState ?? "Unavailable"}</dd></div>
              <div><dt>Journal mode</dt><dd>{mappingStore.journalMode ?? "Unavailable"}</dd></div>
              <div><dt>Mutations</dt><dd>{mappingStore.mutationsEnabled ? "Enabled" : "Disabled"}</dd></div>
            </dl>
          </details>
        </div>
      </SettingsSection>
      {mappingError ? <Alert variant="destructive" className="[border:1px_solid_var(--destructive)] [border-radius:9px] [padding:12px_16px] [color:var(--destructive)]"><AlertDescription>{mappingError} <Button size="sm" variant="outline" disabled={mappingRetrying} onClick={() => void retryMappingStore()}><RefreshCwIcon className={mappingRetrying ? "animate-spin" : undefined} data-icon="inline-start" />{mappingRetrying ? "Retrying…" : "Retry"}</Button></AlertDescription></Alert> : null}
      {settingsError ? <Alert variant="destructive" className="[border:1px_solid_var(--destructive)] [border-radius:9px] [padding:12px_16px] [color:var(--destructive)]"><AlertDescription>{settingsError} <Button size="sm" variant="outline" disabled={saving !== null} onClick={() => { const retry = retrySetting.current; if (retry) void update(retry.key, retry.value) }}><RefreshCwIcon className={saving !== null ? "animate-spin" : undefined} data-icon="inline-start" />{saving !== null ? "Saving…" : "Retry"}</Button></AlertDescription></Alert> : null}
    </div>
  )
}

function SettingsSection({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="settings-section [overflow:hidden] [border:1px_solid_var(--border)] [border-radius:var(--radius-card)] [background:var(--card-sheen)] [box-shadow:var(--elevation-card)]">
      <div className="settings-heading [border-bottom:1px_solid_color-mix(in_oklab,_var(--border)_70%,_transparent)] [padding:15px_18px] [&_h2]:[margin:0] [&_h2]:[font-size:14px] [&_h2]:[font-weight:640] [&_h2]:[letter-spacing:-0.02em] [&_p]:[margin:3px_0_0] [&_p]:[color:var(--muted-foreground)] [&_p]:[font-size:12px] [&_p]:[line-height:1.5]">
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      <div className="settings-list [display:grid]">{children}</div>
    </section>
  )
}

function SettingRow({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <div className="setting-row [display:flex] [min-height:66px] [align-items:center] [justify-content:space-between] [gap:26px] [border-bottom:1px_solid_color-mix(in_oklab,_var(--border)_55%,_transparent)] [padding:13px_18px] [&:last-child]:[border-bottom:0] [&_h3]:[margin:0] [&_h3]:[font-size:12px] [&_h3]:[font-weight:600] [&_p]:[margin:3px_0_0] [&_p]:[color:var(--muted-foreground)] [&_p]:[font-size:12px] [&_p]:[line-height:1.45]">
      <div>
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

/** The scan limit governs previews on this computer only; sync itself still fails closed at the engine's per-side ceiling, so the row must not imply a higher limit enables a larger sync. */
function scanLimitDescription(unlimited: boolean, exceedsSyncCapacity: boolean): string {
  const scanning = unlimited
    ? "Scans collect every file without stopping. Very large folders use more memory while they compare."
    : "A scan stops and reports a partial result past this many files. Previews and transfers on this computer use it."
  const capacity = `Syncing still fails above ${MAX_SYNCABLE_FILES_PER_SIDE.toLocaleString("en-GB")} files on either computer, so a higher limit here only makes previews longer.`
  return exceedsSyncCapacity ? `${scanning} ${capacity} This setting is above that limit.` : `${scanning} ${capacity}`
}

function ScanLimitRow({
  settings,
  update,
  savingKey,
}: {
  settings: AppSettings
  update: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => Promise<void>
  /** Key currently saving, if any. Other keys disable this row; this row serialises its own intents locally. */
  savingKey: keyof AppSettings | null
}) {
  const unlimited = settings.maxScanFiles === null
  const exceedsSyncCapacity = unlimited || (settings.maxScanFiles !== null && settings.maxScanFiles > MAX_SYNCABLE_FILES_PER_SIDE)
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const shown = draft ?? (unlimited ? "" : String(settings.maxScanFiles))
  // A blur commit can still be saving when the No-limit switch is toggled
  // (the toggle arrives without a prior blur). Both write maxScanFiles, so
  // queue the latest intent instead of dropping it in update()'s guard.
  const rowBusy = useRef(false)
  const queuedValue = useRef<number | null | undefined>(undefined)
  const peerSaving = savingKey !== null && savingKey !== "maxScanFiles"

  async function saveRow(value: number | null): Promise<void> {
    if (rowBusy.current) {
      queuedValue.current = value
      return
    }
    rowBusy.current = true
    try {
      await update("maxScanFiles", value)
    } catch {
      setError("That didn't work. Try again shortly.")
    } finally {
      rowBusy.current = false
    }
    const next = queuedValue.current
    queuedValue.current = undefined
    if (next !== undefined) await saveRow(next)
  }

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
    await saveRow(parsed)
  }

  async function setUnlimited(next: boolean): Promise<void> {
    setError(null)
    setDraft(null)
    await saveRow(next ? null : 10_000)
  }

  return (
    <SettingRow
      title="Scan file limit"
      description={error ?? scanLimitDescription(unlimited, exceedsSyncCapacity)}
    >
      <div className="[display:flex] [align-items:center] [gap:10px]">
        <Input
          className="w-32"
          type="number"
          min={1000}
          max={1000000}
          step={1000}
          disabled={peerSaving || unlimited}
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
          <Switch aria-label="No scan file limit" checked={unlimited} disabled={peerSaving} onCheckedChange={(checked: boolean) => void setUnlimited(checked)} />
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
  const workingRef = useRef<"check" | "download" | "install" | null>(null)
  const retryAction = useRef<"check" | "download" | "install" | null>(null)
  const { title, description } = updateHeadline(update)
  const releaseNotes = "releaseNotes" in update ? update.releaseNotes : undefined
  const releaseVersion = "version" in update && update.version ? update.version : undefined

  async function run(action: "check" | "download" | "install") {
    if (workingRef.current) return
    workingRef.current = action
    retryAction.current = action
    setWorking(action)
    setActionError(null)
    try {
      if (action === "check") await window.folderSync.checkForUpdates()
      else if (action === "download") await window.folderSync.downloadUpdate()
      else await window.folderSync.quitAndInstall()
    } catch (error: unknown) {
      setActionError(error instanceof Error ? error.message : "That update action failed. Try again.")
    } finally {
      workingRef.current = null
      setWorking(null)
    }
  }

  function retry() {
    const action = retryAction.current
    if (action) void run(action)
  }

  return (
    <>
      <SettingRow title={title} description={description}>
        {actionError ? <div role="alert" className="[color:var(--destructive)] [font-size:12px]">{actionError}</div> : null}
        <div className="[display:flex] [align-items:center] [gap:8px]">
          {update.status === "downloaded" ? (
            <StatusPill tone="success">
              <CheckCircle2Icon className="size-3" /> Ready
            </StatusPill>
          ) : null}
          {update.status === "available" ? (
            <Button size="sm" disabled={working !== null} onClick={() => void run("download")}>
              <DownloadIcon data-icon="inline-start" />
              {working === "download" ? "Starting…" : `Download v${update.version}`}
            </Button>
          ) : null}
          {update.status === "downloaded" ? (
            <Button size="sm" disabled={working !== null} onClick={() => void run("install")}>
              <RocketIcon data-icon="inline-start" />
              {working === "install" ? "Restarting…" : "Restart & update"}
            </Button>
          ) : null}
          {update.status !== "checking" && update.status !== "downloading" && update.status !== "downloaded" ? (
            <Button
              size="sm"
              variant={update.status === "available" ? "outline" : "default"}
              disabled={working !== null}
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
      {actionError && retryAction.current ? (
        <div className="[padding:0_18px_12px]">
          <Button size="sm" variant="outline" disabled={working !== null} onClick={retry}>Retry</Button>
        </div>
      ) : null}
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
