import { useEffect, useMemo, useState } from "react"
import {
  CheckCircle2Icon,
  Clock3Icon,
  ComputerIcon,
  FingerprintIcon,
  LaptopIcon,
  Link2Icon,
  LoaderCircleIcon,
  RadioIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  ShieldQuestionIcon,
  WifiIcon,
  XCircleIcon,
} from "lucide-react"
import type { AppSnapshot, PairingCandidate } from "@shared/contracts"
import { Badge } from "@/components/ui/badge"
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
import { cn } from "@/lib/utils"

export function PairDeviceDialog({ snapshot }: { snapshot: AppSnapshot }) {
  const [open, setOpen] = useState(false)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [clockTick, setClockTick] = useState(0)
  const pairing = snapshot.pairing

  useEffect(() => {
    if (!open || !pairing.acceptingPairingUntil) return
    const timer = window.setInterval(() => setClockTick((value) => value + 1), 1_000)
    return () => window.clearInterval(timer)
  }, [open, pairing.acceptingPairingUntil])

  const remaining = useMemo(() => {
    if (!pairing.acceptingPairingUntil) return null
    const milliseconds = new Date(pairing.acceptingPairingUntil).getTime() - Date.now()
    if (milliseconds <= 0) return "ending…"
    const minutes = Math.floor(milliseconds / 60_000)
    const seconds = Math.floor((milliseconds % 60_000) / 1_000)
    return `${minutes}:${seconds.toString().padStart(2, "0")}`
  }, [pairing.acceptingPairingUntil, pairing.acceptingPairing, open, clockTick])

  async function run(action: string, operation: () => Promise<unknown>) {
    setBusyAction(action)
    setError(null)
    try {
      await operation()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to complete the pairing action.")
    } finally {
      setBusyAction(null)
    }
  }

  const outgoing = pairing.outgoingSession
  const terminalOutgoing = outgoing && ["paired", "rejected", "cancelled", "failed"].includes(outgoing.status)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>
        <Link2Icon data-icon="inline-start" />
        Start pairing
      </DialogTrigger>
      <DialogContent className="pairing-dialog">
        <DialogHeader>
          <div className="pairing-dialog-heading">
            <div className="pairing-dialog-icon"><ShieldCheckIcon /></div>
            <div>
              <DialogTitle>Pair another computer</DialogTitle>
              <DialogDescription>
                Both computers compare the same one-time code before either identity is trusted.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="pairing-security-note">
          <FingerprintIcon />
          <div>
            <span>This computer’s identity</span>
            <code>{pairing.localFingerprint}</code>
          </div>
        </div>

        <section className={cn("pairing-visibility-card", pairing.acceptingPairing && "pairing-visibility-active")}>
          <div className="pairing-visibility-copy">
            <div className="pairing-radio-icon"><RadioIcon /></div>
            <div>
              <div className="pairing-visibility-title">
                <strong>{pairing.acceptingPairing ? "Visible for pairing" : "Not accepting pairing requests"}</strong>
                {pairing.acceptingPairing ? <Badge variant="success">{remaining ?? "5:00"}</Badge> : null}
              </div>
              <p>
                {pairing.acceptingPairing
                  ? "Nearby FolderSync computers can find this device for five minutes."
                  : "Turn this on from either computer, then select it from the nearby list."}
              </p>
            </div>
          </div>
          <Button
            variant={pairing.acceptingPairing ? "outline" : "default"}
            disabled={busyAction === "visibility"}
            onClick={() => run("visibility", () => window.folderSync.setPairingAvailable(!pairing.acceptingPairing))}
          >
            {busyAction === "visibility" ? <LoaderCircleIcon className="animate-spin" data-icon="inline-start" /> : <WifiIcon data-icon="inline-start" />}
            {pairing.acceptingPairing ? "Stop being visible" : "Allow pairing for 5 minutes"}
          </Button>
        </section>

        {pairing.incomingRequests.length > 0 ? (
          <section className="pairing-section">
            <div className="pairing-section-heading">
              <div><h3>Incoming request</h3><p>Only approve when both screens show the same code.</p></div>
              <Badge variant="info">Action required</Badge>
            </div>
            <div className="pairing-request-list">
              {pairing.incomingRequests.map((request) => (
                <article className="pairing-request-card" key={request.id}>
                  <DeviceIdentity candidate={request.device} />
                  <ComparisonCode code={request.comparisonCode} />
                  {request.status === "waiting-for-peer" ? (
                    <div className="pairing-waiting-row">
                      <LoaderCircleIcon className="animate-spin" />
                      <span>Waiting for {request.device.name} to confirm the code…</span>
                    </div>
                  ) : (
                    <div className="pairing-request-actions">
                      <Button
                        variant="outline"
                        disabled={busyAction === `reject:${request.id}`}
                        onClick={() => run(`reject:${request.id}`, () => window.folderSync.rejectPairing(request.id))}
                      >
                        Reject
                      </Button>
                      <Button
                        disabled={busyAction === `approve:${request.id}`}
                        onClick={() => run(`approve:${request.id}`, () => window.folderSync.approvePairing(request.id))}
                      >
                        <ShieldCheckIcon data-icon="inline-start" />
                        Codes match — approve
                      </Button>
                    </div>
                  )}
                </article>
              ))}
            </div>
          </section>
        ) : null}

        {outgoing ? (
          <section className="pairing-section">
            <div className="pairing-section-heading">
              <div><h3>Pairing with {outgoing.device.name}</h3><p>{outgoing.message ?? pairingStatusDescription(outgoing.status)}</p></div>
              <PairingStatusBadge status={outgoing.status} />
            </div>
            <article className="outgoing-pairing-card">
              <DeviceIdentity candidate={outgoing.device} />
              {outgoing.comparisonCode ? <ComparisonCode code={outgoing.comparisonCode} /> : null}
              {outgoing.status === "connecting" ? (
                <div className="pairing-waiting-row"><LoaderCircleIcon className="animate-spin" /><span>Opening a direct LAN connection…</span></div>
              ) : null}
              {outgoing.status === "confirm-code" ? (
                <div className="pairing-request-actions">
                  <Button variant="outline" onClick={() => run("cancel", () => window.folderSync.cancelPairing(outgoing.id))}>Cancel</Button>
                  <Button onClick={() => run("confirm", () => window.folderSync.confirmPairing(outgoing.id))}>
                    <ShieldCheckIcon data-icon="inline-start" />
                    Codes match — continue
                  </Button>
                </div>
              ) : null}
              {outgoing.status === "waiting-for-approval" || outgoing.status === "waiting-for-peer" ? (
                <div className="pairing-waiting-row"><LoaderCircleIcon className="animate-spin" /><span>{outgoing.message}</span></div>
              ) : null}
              {terminalOutgoing ? (
                <div className="pairing-request-actions">
                  <Button variant="outline" onClick={() => run("dismiss", () => window.folderSync.cancelPairing(outgoing.id))}>
                    {outgoing.status === "paired" ? "Done" : "Close"}
                  </Button>
                </div>
              ) : null}
            </article>
          </section>
        ) : (
          <section className="pairing-section">
            <div className="pairing-section-heading">
              <div><h3>Nearby computers</h3><p>Only devices currently allowing pairing appear here.</p></div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => run("refresh", () => window.folderSync.getSnapshot())}
                disabled={busyAction === "refresh"}
              >
                <RefreshCwIcon className={busyAction === "refresh" ? "animate-spin" : undefined} data-icon="inline-start" />
                Refresh
              </Button>
            </div>

            {pairing.discoveredDevices.length > 0 ? (
              <div className="nearby-device-list">
                {pairing.discoveredDevices.map((candidate) => (
                  <article className="nearby-device-card" key={candidate.id}>
                    <DeviceIdentity candidate={candidate} />
                    <Button
                      disabled={Boolean(busyAction)}
                      onClick={() => run(`start:${candidate.id}`, () => window.folderSync.startPairing(candidate.id))}
                    >
                      <Link2Icon data-icon="inline-start" />
                      Pair
                    </Button>
                  </article>
                ))}
              </div>
            ) : (
              <div className="pairing-empty-state">
                <ShieldQuestionIcon />
                <div>
                  <strong>No computers are available yet</strong>
                  <span>Open FolderSync on the other computer and choose “Allow pairing for 5 minutes”.</span>
                </div>
              </div>
            )}
          </section>
        )}

        {error ? <div className="pairing-error"><XCircleIcon /><span>{error}</span></div> : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DeviceIdentity({ candidate }: { candidate: PairingCandidate }) {
  return (
    <div className="pairing-device-identity">
      <div className="pairing-device-icon">
        {candidate.platform === "windows" ? <ComputerIcon /> : <LaptopIcon />}
      </div>
      <div>
        <strong>{candidate.name}</strong>
        <span>{candidate.platform === "windows" ? "Windows 11" : candidate.platform === "linux" ? "Linux" : "Unknown platform"} · {candidate.address}</span>
        <code>{candidate.fingerprint}</code>
      </div>
    </div>
  )
}

function ComparisonCode({ code }: { code: string }) {
  return (
    <div className="comparison-code-block">
      <div><ShieldCheckIcon /><span>Comparison code</span></div>
      <strong>{code}</strong>
      <p>Never approve if the code differs on either computer.</p>
    </div>
  )
}

function PairingStatusBadge({ status }: { status: string }) {
  if (status === "paired") return <Badge variant="success"><CheckCircle2Icon />Paired</Badge>
  if (status === "failed" || status === "rejected") return <Badge variant="danger"><XCircleIcon />{status === "failed" ? "Failed" : "Rejected"}</Badge>
  if (status === "cancelled") return <Badge variant="neutral">Cancelled</Badge>
  return <Badge variant="info"><Clock3Icon />In progress</Badge>
}

function pairingStatusDescription(status: string): string {
  if (status === "connecting") return "Connecting directly over your local network."
  if (status === "confirm-code") return "Compare the code shown on both computers."
  if (status === "waiting-for-approval") return "The other computer still needs to approve this identity."
  if (status === "paired") return "Both computers now trust each other."
  if (status === "rejected") return "The other computer declined the request."
  if (status === "cancelled") return "Pairing was cancelled."
  return "Pairing could not be completed."
}
