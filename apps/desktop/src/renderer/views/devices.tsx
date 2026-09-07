import { useState } from "react"
import {
  ComputerIcon,
  FolderOpenIcon,
  LaptopIcon,
  Link2Icon,
  ShieldCheckIcon,
} from "lucide-react"
import type { AppSnapshot } from "@shared/contracts"
import { FolderPickerDialog } from "@/components/folder-picker-dialog"
import { PairDeviceDialog } from "@/components/pair-device-dialog"
import { RevokeDeviceDialog } from "@/components/revoke-device-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { StatusPill } from "@/components/ui/status-pill"
import { cn } from "@/lib/utils"
import { pretty, prettyPlatform, prettyRoute } from "@/lib/format"
import { getLocalDevice, getPairedDevices } from "@/lib/snapshot"

export function DevicesView({
  snapshot,
  onReviewMapping,
  onRefresh,
}: {
  snapshot: AppSnapshot
  onReviewMapping(): void
  onRefresh(): Promise<void>
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  // One shared pairing dialog for every entry point below, so concurrent
  // pairing actions share a single busy lock and error state.
  const [pairingOpen, setPairingOpen] = useState(false)
  const localDevice = getLocalDevice(snapshot)
  const pairedDevices = getPairedDevices(snapshot)

  return (
    <div className="page-stack [display:grid] [gap:16px] [width:100%] [max-width:1180px] [margin:0_auto]">
      <section className="section-intro [display:flex] [align-items:center] [justify-content:space-between] [gap:24px] [&_h2]:[margin:0] [&_h2]:[font-size:17px] [&_h2]:[font-weight:650] [&_h2]:[letter-spacing:-0.03em] [&_p]:[margin:3px_0_0] [&_p]:[max-width:80ch] [&_p]:[color:var(--muted-foreground)] [&_p]:[font-size:11.5px] [&_p]:[line-height:1.5]">
        <div>
          <h2>Trusted devices</h2>
          <p>Pairing completes only after the same one-time code is approved on both computers.</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={pairedDevices.length > 0 ? "success" : "warning"}>
            {pairedDevices.length > 0 ? `${pairedDevices.length} paired` : "Not paired"}
          </Badge>
          <PairingButton onOpen={() => setPairingOpen(true)} />
        </div>
      </section>

      {snapshot.pairing.incomingRequests.length > 0 ? (
        <section className="incoming-pairing-banner [display:flex] [align-items:center] [justify-content:space-between] [gap:16px] [border:1px_solid_color-mix(in_oklab,_var(--primary)_30%,_var(--border))] [border-radius:var(--radius-tile)] [background:color-mix(in_oklab,_var(--primary)_9%,_var(--surface))] [padding:12px_14px] [&>div:first-child]:[display:flex] [&>div:first-child]:[align-items:center] [&>div:first-child]:[gap:10px] [&_svg]:[width:18px] [&_svg]:[height:18px] [&_svg]:[color:var(--primary)] [&_span]:[display:grid] [&_span]:[gap:2px] [&_strong]:[font-size:11.5px] [&_small]:[color:var(--muted-foreground)] [&_small]:[font-size:10px] max-[760px]:[align-items:stretch] max-[760px]:[flex-direction:column]">
          <div>
            <ShieldCheckIcon />
            <span>
              <strong>Pairing approval needed</strong>
              <small>Open “Start pairing” to compare the code and approve the request.</small>
            </span>
          </div>
          <PairingButton onOpen={() => setPairingOpen(true)} />
        </section>
      ) : null}

      {snapshot.mappings.incoming.some((request) => request.status === "pending") ? (
        <section className="incoming-pairing-banner [display:flex] [align-items:center] [justify-content:space-between] [gap:16px] [border:1px_solid_color-mix(in_oklab,_var(--primary)_30%,_var(--border))] [border-radius:var(--radius-tile)] [background:color-mix(in_oklab,_var(--primary)_9%,_var(--surface))] [padding:12px_14px] [&>div:first-child]:[display:flex] [&>div:first-child]:[align-items:center] [&>div:first-child]:[gap:10px] [&_svg]:[width:18px] [&_svg]:[height:18px] [&_svg]:[color:var(--primary)] [&_span]:[display:grid] [&_span]:[gap:2px] [&_strong]:[font-size:11.5px] [&_small]:[color:var(--muted-foreground)] [&_small]:[font-size:10px] max-[760px]:[align-items:stretch] max-[760px]:[flex-direction:column]">
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

      <section className="device-grid [display:grid] [grid-template-columns:repeat(3,_minmax(0,_1fr))] [align-items:start] [gap:14px] max-[1360px]:[grid-template-columns:repeat(2,_minmax(0,_1fr))] max-[900px]:[grid-template-columns:1fr]">
        {snapshot.devices.map((device) => (
          <article className="device-card [position:relative] [overflow:hidden] [border:1px_solid_var(--border)] [border-radius:var(--radius-card)] [background:var(--surface)] [padding:18px] [box-shadow:var(--elevation-card)] [&_h3]:[margin:0] [&_h3]:[font-size:14.5px] [&_h3]:[font-weight:640] [&_h3]:[letter-spacing:-0.02em]" key={device.id}>
            <div className="device-illustration [position:relative] [display:grid] [width:42px] [height:42px] [place-items:center] [margin-bottom:14px] [border-radius:10px] [background:var(--secondary)] [color:var(--muted-foreground)] [&_svg]:[width:19px] [&_svg]:[height:19px]">
              {device.platform === "windows" ? <ComputerIcon /> : <LaptopIcon />}
              <span className={cn("presence-dot [position:absolute] [right:1px] [bottom:1px] [width:11px] [height:11px] [border:2px_solid_var(--surface)] [border-radius:999px] [&.online]:[background:var(--success)] [&.offline]:[background:var(--muted-foreground)]", device.status === "online" || device.status === "this-device" ? "online" : "offline")} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3>{device.name}</h3>
                {device.status === "this-device" ? <Badge variant="info">This device</Badge> : null}
              </div>
              <p className="mt-1 text-[11px] text-[var(--muted-foreground)]">{prettyPlatform(device.platform)}</p>
            </div>
            <dl className="device-details [display:grid] [gap:9px] [margin:18px_0_0] [border-top:1px_solid_color-mix(in_oklab,_var(--border)_70%,_transparent)] [padding-top:14px] [&>div]:[display:flex] [&>div]:[justify-content:space-between] [&>div]:[gap:12px] [&_dt]:[color:var(--muted-foreground)] [&_dt]:[font-size:10.5px] [&_dd]:[overflow:hidden] [&_dd]:[margin:0] [&_dd]:[font-size:10.5px] [&_dd]:[font-weight:550] [&_dd]:[text-overflow:ellipsis] [&_dd]:[white-space:nowrap]">
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
                <dd className="device-fingerprint [max-width:180px] [overflow:hidden] [font-family:ui-monospace,_SFMono-Regular,_Menlo,_Monaco,_Consolas,_monospace] [font-size:9px] [text-overflow:ellipsis] [white-space:nowrap]">{device.fingerprint ?? "Loading…"}</dd>
              </div>
            </dl>
            {device.status !== "this-device" ? <RevokeDeviceDialog device={device} /> : null}
          </article>
        ))}

        {pairedDevices.length === 0 ? (
          <article className="pair-device-card [display:flex] [min-height:220px] [flex-direction:column] [align-items:center] [justify-content:center] [gap:9px] [border:1px_dashed_var(--border)] [border-radius:var(--radius-card)] [background:var(--surface)] [padding:24px] [text-align:center] [&>strong]:[font-size:14px] [&>strong]:[font-weight:640] [&>span]:[max-width:46ch] [&>span]:[color:var(--muted-foreground)] [&>span]:[font-size:11px] [&>span]:[line-height:1.5]">
            <div className="large-empty-icon [display:grid] [width:40px] [height:40px] [place-items:center] [border-radius:10px] [background:var(--secondary)] [color:var(--muted-foreground)] [&_svg]:[width:18px] [&_svg]:[height:18px]">
              <Link2Icon />
            </div>
            <strong>No paired computer</strong>
            <span>Keep Tethera open on both computers, then compare and approve the one-time code.</span>
            <div className="pair-device-actions [display:flex] [flex-wrap:wrap] [justify-content:center] [gap:8px] [margin-top:8px]">
              <PairingButton onOpen={() => setPairingOpen(true)} />
              <Button variant="outline" onClick={() => setPickerOpen(true)}>
                <FolderOpenIcon data-icon="inline-start" />
                Preview folder browser
              </Button>
            </div>
          </article>
        ) : null}
      </section>

      <FolderPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        device={localDevice}
        title="Preview the folder browser"
        description="This preview only browses this computer and does not create a sync mapping."
        onSelect={() => setPickerOpen(false)}
      />
      <PairDeviceDialog snapshot={snapshot} onRefresh={onRefresh} open={pairingOpen} onOpenChange={setPairingOpen} />
    </div>
  )
}

function PairingButton({ onOpen }: { onOpen(): void }) {
  return (
    <Button onClick={onOpen}>
      <Link2Icon data-icon="inline-start" />
      Start pairing
    </Button>
  )
}
