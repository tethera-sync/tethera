import { useState } from "react"
import { ShieldXIcon, Trash2Icon } from "lucide-react"
import type { DeviceSummary } from "@shared/contracts"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"

export function RevokeDeviceDialog({ device }: { device: DeviceSummary }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function revoke() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await window.folderSync.revokeDevice(device.id)
      setOpen(false)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to remove device trust.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" className="device-revoke-button [width:100%] [margin-top:14px]" />}>
        <Trash2Icon data-icon="inline-start" />
        Remove trust
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <div className="pairing-dialog-heading [display:flex] [align-items:flex-start] [gap:12px]">
            <div className="pairing-dialog-icon [display:grid] [width:40px] [height:40px] [flex:0_0_auto] [place-items:center] [border:1px_solid_color-mix(in_oklab,_var(--primary)_26%,_var(--border))] [border-radius:12px] [background:color-mix(in_oklab,_var(--primary)_11%,_var(--surface-strong))] [color:var(--primary)] [&_svg]:[width:20px] [&_svg]:[height:20px] pairing-dialog-icon-danger [border-color:color-mix(in_oklab,_var(--destructive)_30%,_var(--border))] [background:color-mix(in_oklab,_var(--destructive)_10%,_var(--surface))] [color:var(--destructive)]"><ShieldXIcon /></div>
            <div>
              <DialogTitle>Remove trust for {device.name}?</DialogTitle>
              <DialogDescription>
                This computer will reject new peer sessions from that identity. Existing folder mappings are kept but marked as needing attention.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="revoke-device-summary [margin-top:18px] [border:1px_solid_var(--border)] [border-radius:var(--radius-tile)] [background:var(--surface-sunken)] [padding:11px_12px] [&_span]:[display:block] [&_span]:[color:var(--muted-foreground)] [&_span]:[font-size:9px] [&_span]:[text-transform:uppercase] [&_span]:[letter-spacing:0.07em] [&_code]:[display:block] [&_code]:[margin-top:4px] [&_code]:[font-size:10px] [&_code]:[letter-spacing:0.04em]">
          <span>Identity fingerprint</span>
          <code>{device.fingerprint ?? "Unavailable"}</code>
        </div>

        <p className="revoke-warning [margin-top:12px] [color:var(--muted-foreground)] [font-size:10.5px] [line-height:1.5]">
          This does not delete files on either computer. Pair the devices again to restore trust.
        </p>

        {error ? <p className="pairing-error [display:flex] [align-items:flex-start] [gap:8px] [margin-top:12px] [border:1px_solid_color-mix(in_oklab,_var(--destructive)_35%,_var(--border))] [border-radius:10px] [background:color-mix(in_oklab,_var(--destructive)_9%,_var(--surface))] [padding:9px_11px] [color:var(--destructive)] [font-size:10.5px] [&_svg]:[width:16px] [&_svg]:[height:16px] [&_svg]:[flex:0_0_auto]">{error}</p> : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
          <Button variant="destructive" onClick={revoke} disabled={busy}>
            <Trash2Icon data-icon="inline-start" />
            {busy ? "Removing…" : "Remove trust"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
