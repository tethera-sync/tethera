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
import { downloadReadout, formatLastChecked } from "@/lib/update-format"

const quietButton =
  "update-check-icon [display:flex] [width:100%] [height:32px] [align-items:center] [justify-content:center] [border:1px_solid_transparent] [border-radius:8px] [background:transparent] [color:var(--muted-foreground)] [transition:140ms_ease] [&:hover]:[background:var(--accent)] [&:hover]:[color:var(--foreground)] [&_svg]:[width:16px] [&_svg]:[height:16px] [&:disabled]:[opacity:0.7]"
const pill =
  "update-pill [position:relative] [display:flex] [width:100%] [min-height:32px] [align-items:center] [gap:2px] [border:1px_solid_var(--border)] [border-radius:9px] [background:var(--surface)] [padding:2px] [color:var(--muted-foreground)]"
const pillMain =
  "update-pill-main [display:flex] [min-width:0] [flex:1] [height:28px] [align-items:center] [gap:7px] [border:0] [border-radius:7px] [background:transparent] [padding:0_8px] [color:inherit] [font-size:11.5px] [font-weight:600] [text-align:left] [&:hover]:[background:var(--accent)] [&_svg]:[width:14px] [&_svg]:[height:14px] [&_svg]:[flex:0_0_auto]"
const pillLabel = "update-pill-label [overflow:hidden] [flex:1] [text-overflow:ellipsis] [white-space:nowrap]"
const pillDismiss =
  "update-pill-dismiss [display:grid] [width:24px] [height:24px] [flex:0_0_auto] [place-items:center] [border:0] [border-radius:6px] [background:transparent] [color:inherit] [&:hover]:[background:var(--accent)] [&_svg]:[width:13px] [&_svg]:[height:13px]"
const warnTone =
  "update-pill-warn [border-color:color-mix(in_oklab,_var(--warning)_38%,_var(--border))] [background:color-mix(in_oklab,_var(--warning)_9%,_var(--surface))] [color:var(--warning)]"
const successTone =
  "update-pill-success [border-color:color-mix(in_oklab,_var(--success)_38%,_var(--border))] [background:color-mix(in_oklab,_var(--success)_9%,_var(--surface))] [color:var(--success)]"
const errorTone =
  "update-pill-error [border-color:color-mix(in_oklab,_var(--destructive)_38%,_var(--border))] [background:color-mix(in_oklab,_var(--destructive)_9%,_var(--surface))] [color:var(--destructive)]"
const progressTone =
  "update-pill-progress [border-color:color-mix(in_oklab,_var(--primary)_30%,_var(--border))] [background:color-mix(in_oklab,_var(--primary)_8%,_var(--surface))] [color:var(--primary)]"

function pillKey(update: UpdateState): string {
  const version = "version" in update && update.version ? update.version : ""
  return `${update.status}:${version}:${update.lastCheckedAt ?? ""}`
}

function checkedSuffix(lastCheckedAt: string | undefined): string {
  const checked = formatLastChecked(lastCheckedAt)
  return checked ? ` · Last checked ${checked}` : ""
}

/** Native-tooltip + accessible-label copy for the quiet icon states. */
function quietCopy(update: UpdateState): { label: string; title: string } {
  const checked = checkedSuffix(update.lastCheckedAt)
  const current = "currentVersion" in update && update.currentVersion ? `You're on v${update.currentVersion}. ` : ""
  switch (update.status) {
    case "checking":
      return { label: "Checking for updates", title: "Checking for updates… Comparing your build with the latest release." }
    case "not-available":
      return { label: "You're up to date", title: `You're up to date. ${current}Last checked ${formatLastChecked(update.lastCheckedAt) ?? "recently"}. Click to check again.` }
    default:
      return { label: "Check for updates", title: `Check for updates. ${current}Installed builds also check at startup.${checked}.` }
  }
}

export function SidebarUpdatePill({ update }: { update: UpdateState }) {
  const [dismissedKey, setDismissedKey] = useState<string | null>(null)
  const [working, setWorking] = useState<"check" | "download" | "install" | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

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

  // Quiet icon-only states: no banner, no label — tooltip carries the detail.
  if (update.status === "idle" || update.status === "checking" || update.status === "not-available") {
    const copy = quietCopy(update)
    if (update.status === "checking") {
      return (
        <div className="update-check-icon [display:flex] [width:100%] [height:32px] [align-items:center] [justify-content:center] [color:var(--primary)] [&_svg]:[width:16px] [&_svg]:[height:16px]" role="status" aria-label={copy.label} title={copy.title}>
          <RefreshCwIcon className="animate-spin" />
        </div>
      )
    }
    const Icon = update.status === "not-available" ? CheckCircle2Icon : RefreshCwIcon
    return (
      <>
        <button
          type="button"
          className={quietButton}
          title={copy.title}
          aria-label={copy.label}
          disabled={working === "check"}
          onClick={() => void run("check")}
        >
          {working === "check" ? <RefreshCwIcon className="animate-spin" /> : <Icon />}
        </button>
        {actionError ? (
          <p role="alert" className="[margin:0] [padding:0_4px] [color:var(--destructive)] [font-size:10px]">
            {actionError}
          </p>
        ) : null}
      </>
    )
  }

  if (update.status === "downloading") {
    const readout = downloadReadout(update)
    const percent = Math.min(Math.max(Math.round(update.progressPercent), 0), 100)
    const title = `Downloading Tethera v${update.version}… ${readout}. Keep Tethera open until it finishes.`
    return (
      <div className={`${pill} ${progressTone}`} role="status" aria-label={title} title={title}>
        <div className={`${pillMain} [cursor:default]`}>
          <DownloadIcon />
          <span className={pillLabel}>Downloading {percent}%</span>
        </div>
        <div
          className="[position:absolute] [inset-inline:8px] [bottom:1px] [height:2px] [overflow:hidden] [border-radius:999px] [background:color-mix(in_oklab,_var(--primary)_18%,_transparent)]"
          role="progressbar"
          aria-label={`Downloading Tethera version ${update.version}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-valuetext={readout}
        >
          <div className="[height:100%] [border-radius:999px] [background:var(--primary)]" style={{ width: `${Math.max(percent, percent > 0 ? 2 : 0)}%` }} />
        </div>
      </div>
    )
  }

  if (dismissedKey === pillKey(update)) return null
  const dismiss = () => setDismissedKey(pillKey(update))

  if (update.status === "available") {
    const title = `Tethera v${update.version} is available.${checkedSuffix(update.lastCheckedAt)}. Click to download.`
    return (
      <>
        <div className={`${pill} ${warnTone}`}>
          <button
            type="button"
            className={pillMain}
            title={title}
            aria-label={`Download Tethera version ${update.version}`}
            disabled={working !== null}
            onClick={() => void run("download")}
          >
            {working === "download" ? <RefreshCwIcon className="animate-spin" /> : <DownloadIcon />}
            <span className={pillLabel}>{working === "download" ? "Starting…" : `Update v${update.version}`}</span>
          </button>
          <button type="button" className={pillDismiss} aria-label="Remind me later" title="Remind me later" onClick={dismiss}>
            <XIcon />
          </button>
        </div>
        {actionError ? (
          <p role="alert" className="[margin:0] [padding:0_4px] [color:var(--destructive)] [font-size:10px]">
            {actionError}
          </p>
        ) : null}
      </>
    )
  }

  if (update.status === "downloaded") {
    const title = `Tethera v${update.version} is ready to install. Restart to switch — folders and pairings carry over.`
    return (
      <>
        <div className={`${pill} ${successTone}`}>
          <button
            type="button"
            className={pillMain}
            title={title}
            aria-label={`Restart and install Tethera version ${update.version}`}
            disabled={working !== null}
            onClick={() => void run("install")}
          >
            <RocketIcon />
            <span className={pillLabel}>{working === "install" ? "Restarting…" : "Restart to update"}</span>
          </button>
          <button type="button" className={pillDismiss} aria-label="Install on next launch" title="On next launch" onClick={dismiss}>
            <XIcon />
          </button>
        </div>
        {actionError ? (
          <p role="alert" className="[margin:0] [padding:0_4px] [color:var(--destructive)] [font-size:10px]">
            {actionError}
          </p>
        ) : null}
      </>
    )
  }

  return (
    <>
      <div className={`${pill} ${errorTone}`} role="alert">
        <button
          type="button"
          className={pillMain}
          title={`${update.message} We'll retry automatically. Click to retry now.`}
          aria-label="Retry update check"
          disabled={working !== null}
          onClick={() => void run("check")}
        >
          {working === "check" ? <RefreshCwIcon className="animate-spin" /> : <CircleAlertIcon />}
          <span className={pillLabel}>{working === "check" ? "Retrying…" : "Update failed"}</span>
        </button>
        <button type="button" className={pillDismiss} aria-label="Dismiss update error" title="Dismiss" onClick={dismiss}>
          <XIcon />
        </button>
      </div>
      {actionError ? (
        <p role="alert" className="[margin:0] [padding:0_4px] [color:var(--destructive)] [font-size:10px]">
          {actionError}
        </p>
      ) : null}
    </>
  )
}
