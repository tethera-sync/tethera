import { useState, type ReactNode } from "react"
import { ArrowUpCircleIcon, RefreshCwIcon } from "lucide-react"
import type { DeviceSummary } from "@shared/contracts"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Meter } from "@/components/ui/meter"
import { peerUpdateView, type PeerUpdateView } from "@/lib/peer-update"

const panel =
  "peer-update-panel [display:grid] [gap:8px] [margin-top:14px] [border:1px_solid_color-mix(in_oklab,_var(--primary)_24%,_var(--border))] [border-radius:var(--radius-tile)] [background:color-mix(in_oklab,_var(--primary)_6%,_var(--surface))] [padding:11px_12px]"
const detail = "[margin:0] [color:var(--muted-foreground)] [font-size:10.5px] [line-height:1.5]"

/**
 * Updating a paired computer's Tethera from this one: the offer when it is
 * behind, its progress while it checks, downloads and restarts, and what
 * went wrong. Renders nothing when there is nothing to update.
 */
export function PeerUpdatePanel({ device, localVersion }: { device: DeviceSummary; localVersion?: string }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const view = peerUpdateView(device, localVersion)

  async function startUpdate() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await window.folderSync.updatePairedDevice(device.id)
    } catch (caught) {
      setError(caught instanceof Error && caught.message ? caught.message : `Couldn't start the update on ${device.name}.`)
    } finally {
      setBusy(false)
    }
  }

  const content = panelContent(view, device, { busy, onUpdate: () => void startUpdate() })
  if (!content) return null
  return (
    <>
      {content}
      {error ? (
        <Alert variant="destructive" className="mt-2">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </>
  )
}

function panelContent(view: PeerUpdateView, device: DeviceSummary, action: { busy: boolean; onUpdate(): void }): ReactNode {
  const { name } = device
  const online = device.status === "online"
  switch (view.kind) {
    case "none":
      return null
    case "legacy":
      return (
        <p className={`${detail} [margin-top:14px]`}>
          Tethera on {name} is too old to update from here. Update it on that computer once; after that, updates can start from here.
        </p>
      )
    case "offer": {
      const label = view.action === "install" ? `Install on ${name}` : `Update ${name}`
      return (
        <section aria-label={`Update ${name}`} className={panel}>
          <div className="[display:flex] [align-items:flex-start] [gap:9px]">
            <ArrowUpCircleIcon aria-hidden="true" className="mt-px size-4 shrink-0 text-[var(--primary)]" />
            <div className="[display:grid] [gap:3px]">
              <strong className="[font-size:11.5px] [font-weight:600]">{view.action === "install" ? "Update ready" : "Update available"}</strong>
              <p className={detail}>{offerSummary(view, name)}</p>
              <p className={detail}>
                {view.needsApproval
                  ? `${name} downloads it, then asks for a password there to install it.`
                  : `Tethera on ${name} restarts to finish. Syncing resumes when it reconnects.`}
              </p>
            </div>
          </div>
          <Button size="sm" disabled={!online || action.busy} onClick={action.onUpdate}>
            {action.busy ? <RefreshCwIcon data-icon="inline-start" className="animate-spin motion-reduce:animate-none" /> : null}
            {label}
          </Button>
          {online ? null : <p className={detail}>Available when {name} is online.</p>}
        </section>
      )
    }
    case "checking":
      return <Progressing label={`Checking for the update on ${name}…`} />
    case "downloading":
      return (
        <section aria-label={`Updating ${name}`} className={panel}>
          <Meter label={`Downloading v${view.version} on ${name}`} value={view.percent / 100} />
        </section>
      )
    case "restarting":
      return <Progressing label={`Installing the update and restarting Tethera on ${name}…`} note="Syncing resumes when it reconnects." />
    case "needs-approval":
      return (
        <section aria-label={`Update ${name}`} className={panel}>
          <strong className="[font-size:11.5px] [font-weight:600]">Waiting for approval on {name}</strong>
          <p className={detail}>
            v{view.version} is downloaded there. Choose Restart to install in Tethera on {name}; it asks for your password.
          </p>
        </section>
      )
    case "failed":
      return (
        <Alert variant="destructive" className="mt-[14px]">
          <AlertTitle>Couldn't update {name}</AlertTitle>
          <AlertDescription>{view.message}</AlertDescription>
          {view.canRetry ? (
            <Button size="sm" variant="outline" className="mt-2 w-fit" disabled={!online || action.busy} onClick={action.onUpdate}>
              Try again
            </Button>
          ) : null}
        </Alert>
      )
  }
}

function offerSummary(view: Extract<PeerUpdateView, { kind: "offer" }>, name: string): string {
  if (view.action === "install") return `v${view.to} is downloaded on ${name}, which is on v${view.from}.`
  if (view.reason === "release") return `${name} is on v${view.from}; v${view.to} is available.`
  return `${name} is on v${view.from}; this computer has v${view.to}.`
}

function Progressing({ label, note }: { label: string; note?: string }) {
  return (
    <section className={panel}>
      <div className="[display:flex] [align-items:flex-start] [gap:9px]">
        <RefreshCwIcon aria-hidden="true" className="mt-px size-4 shrink-0 animate-spin text-[var(--primary)] motion-reduce:animate-none" />
        <div className="[display:grid] [gap:3px]">
          <strong role="status" className="[font-size:11.5px] [font-weight:600]">{label}</strong>
          {note ? <p className={detail}>{note}</p> : null}
        </div>
      </div>
    </section>
  )
}
