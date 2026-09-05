import type { ChangeEvent, ReactNode } from "react"
import { CheckCircle2Icon, RefreshCwIcon } from "lucide-react"
import type { AppSettings, AppSnapshot } from "@shared/contracts"
import { Button } from "@/components/ui/button"
import { StatusPill } from "@/components/ui/status-pill"
import { Switch } from "@/components/ui/switch"
import { pretty } from "@/lib/format"

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
