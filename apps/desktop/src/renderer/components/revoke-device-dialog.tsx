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
      <DialogTrigger render={<Button variant="outline" size="sm" className="device-revoke-button" />}>
        <Trash2Icon data-icon="inline-start" />
        Remove trust
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <div className="pairing-dialog-heading">
            <div className="pairing-dialog-icon pairing-dialog-icon-danger"><ShieldXIcon /></div>
            <div>
              <DialogTitle>Remove trust for {device.name}?</DialogTitle>
              <DialogDescription>
                This computer will reject new peer sessions from that identity. Existing folder mappings are kept but marked as needing attention.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="revoke-device-summary">
          <span>Identity fingerprint</span>
          <code>{device.fingerprint ?? "Unavailable"}</code>
        </div>

        <p className="revoke-warning">
          This does not delete files on either computer. Pair the devices again to restore trust.
        </p>

        {error ? <p className="pairing-error">{error}</p> : null}

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
