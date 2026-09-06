import { useState } from "react"
import {
  CheckCircle2Icon,
  CircleAlertIcon,
  DownloadIcon,
  RefreshCwIcon,
  RocketIcon,
  XIcon,
} from "lucide-react"
import type { UpdateState } from "@shared/contracts"
import { Button } from "./ui/button"
import { downloadReadout, formatLastChecked } from "@/lib/update-format"

const shell =
  "update-banner [display:flex] [min-height:48px] [flex:0_0_auto] [align-items:center] [gap:11px] [margin:10px_24px_0] [padding:11px_13px] [border:1px_solid_color-mix(in_oklab,_var(--primary)_24%,_var(--border))] [border-radius:10px] [background:color-mix(in_oklab,_var(--primary)_7%,_var(--surface))] [&>svg]:[width:17px] [&>svg]:[height:17px] [&>svg]:[flex:0_0_auto] [&>svg]:[color:var(--primary)] [&>div:first-of-type]:[min-width:0] [&>div:first-of-type]:[flex:1] [&_strong]:[display:block] [&_span]:[display:block] [&_strong]:[font-size:11.5px] [&_strong]:[font-weight:650] [&_span]:[margin-top:2px] [&_span]:[color:var(--muted-foreground)] [&_span]:[font-size:10.5px] [&_span]:[line-height:1.4] max-[760px]:[align-items:stretch] max-[760px]:[flex-direction:column] max-[760px]:[&>div:last-child]:[display:flex] max-[760px]:[&>div:last-child]:[width:100%]"
const successTone =
  "update-banner-success [border-color:color-mix(in_oklab,_var(--success)_38%,_var(--border))] [background:color-mix(in_oklab,_var(--success)_9%,_var(--surface))] [&>svg]:[color:var(--success)]"
const errorTone =
  "update-banner-error [border-color:color-mix(in_oklab,_var(--destructive)_38%,_var(--border))] [background:color-mix(in_oklab,_var(--destructive)_9%,_var(--surface))] [&>svg]:[color:var(--destructive)]"

function bannerKey(update: UpdateState): string {
  const version = "version" in update && update.version ? update.version : ""
  return `${update.status}:${version}:${update.lastCheckedAt ?? ""}`
}

function versionLine(currentVersion: string | undefined, lastCheckedAt: string | undefined): string | undefined {
  const checked = formatLastChecked(lastCheckedAt)
  if (currentVersion && checked) return `You're on v${currentVersion} · Last checked ${checked}`
  if (currentVersion) return `You're on v${currentVersion}`
  if (checked) return `Last checked ${checked}`
  return undefined
}

function ReleaseNotes({ notes }: { notes?: string }) {
  if (!notes) return null
  return (
    <details className="update-notes [margin-top:6px] [&_summary]:[cursor:pointer] [&_summary]:[font-size:10.5px] [&_summary]:[font-weight:600] [&_summary]:[color:var(--primary)] [&_p]:[margin:6px_0_0] [&_p]:[white-space:pre-line]">
      <summary>What&apos;s new</summary>
      <p>{notes}</p>
    </details>
  )
}

function DismissButton({ label, onDismiss }: { label: string; onDismiss: () => void }) {
  return (
    <Button type="button" variant="ghost" size="sm" onClick={onDismiss} aria-label={label} title={label}>
      <XIcon />
    </Button>
  )
}

export function UpdateBanner({ update }: { update: UpdateState }) {
  const [dismissedKey, setDismissedKey] = useState<string | null>(null)
  const [working, setWorking] = useState<"check" | "download" | "install" | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  if (update.status === "idle") return null
  // Active progress is never dismissible and never a live region: the
  // throttled progressbar below is enough without announcing every percent.
  if (update.status === "checking") {
    return (
      <div className={`${shell}`} role="status">
        <RefreshCwIcon className="animate-spin" />
        <div>
          <strong>Checking for updates…</strong>
          <span>Comparing your build with the latest release.</span>
        </div>
      </div>
    )
  }

  if (update.status === "downloading") {
    const readout = downloadReadout(update)
    const percent = Math.min(Math.max(Math.round(update.progressPercent), 0), 100)
    return (
      <div className={shell} aria-live="off">
        <DownloadIcon />
        <div>
          <strong>Downloading Tethera v{update.version}…</strong>
          <span>{readout} · Keep Tethera open until the download finishes.</span>
          <div
            className="update-progress [margin-top:8px] [height:5px] [overflow:hidden] [border-radius:999px] [background:var(--chart-track)]"
            role="progressbar"
            aria-label={`Downloading Tethera version ${update.version}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-valuetext={readout}
          >
            <div
              className="update-progress-fill [height:100%] [border-radius:999px] [background:linear-gradient(90deg,_color-mix(in_oklab,_var(--chart-1)_55%,_transparent),_var(--chart-1))] [transition:width_420ms_cubic-bezier(0.32,_0.72,_0,_1)]"
              style={{ width: `${Math.max(percent, percent > 0 ? 2 : 0)}%` }}
            />
          </div>
        </div>
        <div className="shrink-0 [font-variant-numeric:tabular-nums] [font-size:11.5px] [font-weight:650]">{percent}%</div>
      </div>
    )
  }

  if (dismissedKey === bannerKey(update)) return null
  const dismiss = () => setDismissedKey(bannerKey(update))

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

  if (update.status === "not-available") {
    const line = versionLine(update.currentVersion, update.lastCheckedAt)
    return (
      <div className={`${shell} ${successTone}`} role="status">
        <CheckCircle2Icon />
        <div>
          <strong>You&apos;re up to date</strong>
          {line ? <span>{line}.</span> : null}
          {actionError ? <span className="[color:var(--destructive)]">{actionError}</span> : null}
        </div>
        <div className="shrink-0 [display:flex] [align-items:center] [gap:8px]">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={working === "check"}
            onClick={() => void run("check")}
          >
            <RefreshCwIcon className={working === "check" ? "animate-spin" : undefined} data-icon="inline-start" />
            {working === "check" ? "Checking…" : "Check again"}
          </Button>
          <DismissButton label="Dismiss up-to-date notice" onDismiss={dismiss} />
        </div>
      </div>
    )
  }

  if (update.status === "available") {
    const line = versionLine(update.currentVersion, update.lastCheckedAt)
    return (
      <div className={shell} role="status">
        <DownloadIcon />
        <div>
          <strong>Tethera v{update.version} is available</strong>
          {line ? <span>{line}. Download now, or skip it and we&apos;ll ask again later.</span> : null}
          <ReleaseNotes notes={update.releaseNotes} />
          {actionError ? <span className="[color:var(--destructive)]">{actionError}</span> : null}
        </div>
        <div className="shrink-0 [display:flex] [align-items:center] [gap:8px]">
          <Button type="button" variant="ghost" size="sm" onClick={dismiss}>
            Later
          </Button>
          <Button type="button" size="sm" disabled={working === "download"} onClick={() => void run("download")}>
            <DownloadIcon data-icon="inline-start" />
            {working === "download" ? "Starting…" : "Download"}
          </Button>
        </div>
      </div>
    )
  }

  if (update.status === "downloaded") {
    return (
      <div className={`${shell} ${successTone}`} role="status">
        <RocketIcon />
        <div>
          <strong>Tethera v{update.version} is ready to install</strong>
          <span>Restart to switch to the new version. Your folders and pairings carry over.</span>
          <ReleaseNotes notes={update.releaseNotes} />
          {actionError ? <span className="[color:var(--destructive)]">{actionError}</span> : null}
        </div>
        <div className="shrink-0 [display:flex] [align-items:center] [gap:8px]">
          <Button type="button" variant="outline" size="sm" onClick={dismiss}>
            On next launch
          </Button>
          <Button type="button" size="sm" disabled={working === "install"} onClick={() => void run("install")}>
            {working === "install" ? "Restarting…" : "Restart & update"}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className={`${shell} ${errorTone}`} role="alert">
      <CircleAlertIcon />
      <div>
        <strong>Update check failed</strong>
        <span>
          {update.message} We&apos;ll retry automatically.
        </span>
        {actionError ? <span className="[color:var(--destructive)]">{actionError}</span> : null}
      </div>
      <div className="shrink-0 [display:flex] [align-items:center] [gap:8px]">
        <Button type="button" variant="outline" size="sm" disabled={working === "check"} onClick={() => void run("check")}>
          <RefreshCwIcon className={working === "check" ? "animate-spin" : undefined} data-icon="inline-start" />
          {working === "check" ? "Retrying…" : "Retry"}
        </Button>
        <DismissButton label="Dismiss update error" onDismiss={dismiss} />
      </div>
    </div>
  )
}
