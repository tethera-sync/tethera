import { useId, useState } from "react"
import {
  CheckCircle2Icon,
  CircleAlertIcon,
  DownloadIcon,
  RefreshCwIcon,
  RocketIcon,
} from "lucide-react"
import type { TetheraApi, UpdateState } from "@shared/contracts"
import { downloadReadout, formatLastChecked } from "@/lib/update-format"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

const indicatorButton =
  "device-update-indicator [display:grid] [width:28px] [height:28px] [flex:0_0_auto] [place-items:center] [border:0] [border-radius:7px] [background:transparent] [color:var(--muted-foreground)] [transition:140ms_ease] [&:hover]:[background:var(--accent)] [&:hover]:[color:var(--foreground)] [&_svg]:[width:15px] [&_svg]:[height:15px] [&:disabled]:[opacity:0.7]"
const indicatorStatus =
  "device-update-status [display:grid] [width:28px] [height:28px] [flex:0_0_auto] [place-items:center] [color:var(--primary)] [&_svg]:[width:15px] [&_svg]:[height:15px]"
const warnTone = "[color:var(--warning)]"
const successTone = "[color:var(--success)]"
const errorTone = "[color:var(--destructive)]"

/** Update bridge action invoked from the indicator. */
export type SidebarUpdateAction = "check" | "download" | "install"

/**
 * Invokes one update bridge call and normalises the outcome.
 *
 * Returns `null` when the bridge call succeeds, otherwise the message to
 * surface. Never throws so callers can clear working state uniformly.
 */
export async function invokeSidebarUpdateAction(
  action: SidebarUpdateAction,
  api: Pick<TetheraApi, "checkForUpdates" | "downloadUpdate" | "quitAndInstall">,
): Promise<string | null> {
  try {
    if (action === "check") await api.checkForUpdates()
    else if (action === "download") await api.downloadUpdate()
    else await api.quitAndInstall()
    return null
  } catch (error) {
    return error instanceof Error && error.message ? error.message : "That didn't work. Try again shortly."
  }
}

/** Suffix describing when the feed was last checked, if known. */
function checkedSuffix(lastCheckedAt: string | undefined): string {
  const checked = formatLastChecked(lastCheckedAt)
  return checked ? ` · Last checked ${checked}` : ""
}

/**
 * Tooltip + accessible-label copy for the quiet icon states.
 *
 * Exported so tests can assert the tooltip copy without rendering a
 * portalled Tooltip.
 */
export function quietCopy(update: UpdateState): { label: string; title: string } {
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

/**
 * Compact update status indicator that lives inline next to the device
 * chip in the sidebar footer.
 *
 * The icon and tone reflect the update state; clicking runs the primary
 * action (check, download, restart, or retry) and the shadcn Tooltip
 * carries the detail. Progress states are status-only. Action failures
 * surface as screen-reader alerts so the tight layout stays intact.
 */
export function DeviceUpdateIndicator({ update }: { update: UpdateState }) {
  const [working, setWorking] = useState<SidebarUpdateAction | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const errorDetailId = useId()

  async function run(action: SidebarUpdateAction) {
    if (working) return
    setWorking(action)
    setActionError(null)
    const failure = await invokeSidebarUpdateAction(action, window.folderSync)
    if (failure) setActionError(failure)
    setWorking(null)
  }

  if (update.status === "checking") {
    const copy = quietCopy(update)
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span className={indicatorStatus} role="status" aria-label={copy.label}>
              <RefreshCwIcon className="animate-spin" />
            </span>
          }
        />
        <TooltipContent>{copy.title}</TooltipContent>
      </Tooltip>
    )
  }

  if (update.status === "downloading") {
    const readout = downloadReadout(update)
    const percent = Math.min(Math.max(Math.round(update.progressPercent), 0), 100)
    const label = `Downloading Tethera version ${update.version}, ${percent} percent`
    const title = `Downloading Tethera v${update.version}… ${readout}. Keep Tethera open until it finishes.`
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span className={indicatorStatus} role="status" aria-label={label}>
              <DownloadIcon />
            </span>
          }
        />
        <TooltipContent>{title}</TooltipContent>
      </Tooltip>
    )
  }

  if (update.status === "error") {
    return (
      <>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                className={`${indicatorButton} ${errorTone}`}
                aria-label={`Update failed: ${update.message}. Retry update check`}
                aria-describedby={errorDetailId}
                disabled={working !== null}
                onClick={() => void run("check")}
              >
                {working === "check" ? <RefreshCwIcon className="animate-spin" /> : <CircleAlertIcon />}
              </Button>
            }
          />
          <TooltipContent>{`${update.message} We'll retry automatically. Click to retry now.`}</TooltipContent>
        </Tooltip>
        <span id={errorDetailId} className="sr-only">{`${update.message} We'll retry automatically.`}</span>
        {actionError ? (
          <span role="alert" className="sr-only">{actionError}</span>
        ) : null}
      </>
    )
  }

  if (update.status === "available") {
    const title = `Tethera v${update.version} is available.${checkedSuffix(update.lastCheckedAt)}. Click to download.`
    return (
      <>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                className={`${indicatorButton} ${warnTone}`}
                aria-label={`Download Tethera version ${update.version}`}
                disabled={working !== null}
                onClick={() => void run("download")}
              >
                {working === "download" ? <RefreshCwIcon className="animate-spin" /> : <DownloadIcon />}
              </Button>
            }
          />
          <TooltipContent>{title}</TooltipContent>
        </Tooltip>
        {actionError ? (
          <span role="alert" className="sr-only">{actionError}</span>
        ) : null}
      </>
    )
  }

  if (update.status === "downloaded") {
    const title = `Tethera v${update.version} is ready to install. Restart to switch — folders and pairings carry over.`
    return (
      <>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                className={`${indicatorButton} ${successTone}`}
                aria-label={`Restart and install Tethera version ${update.version}`}
                disabled={working !== null}
                onClick={() => void run("install")}
              >
                <RocketIcon />
              </Button>
            }
          />
          <TooltipContent>{title}</TooltipContent>
        </Tooltip>
        {actionError ? (
          <span role="alert" className="sr-only">{actionError}</span>
        ) : null}
      </>
    )
  }

  const copy = quietCopy(update)
  const Icon = update.status === "not-available" ? CheckCircle2Icon : RefreshCwIcon
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              className={indicatorButton}
              aria-label={copy.label}
              disabled={working === "check"}
              onClick={() => void run("check")}
            >
              {working === "check" ? <RefreshCwIcon className="animate-spin" /> : <Icon />}
            </Button>
          }
        />
        <TooltipContent>{copy.title}</TooltipContent>
      </Tooltip>
      {actionError ? (
        <span role="alert" className="sr-only">{actionError}</span>
      ) : null}
    </>
  )
}
