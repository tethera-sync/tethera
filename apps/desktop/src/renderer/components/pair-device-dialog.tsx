import { useEffect, useMemo, useRef, useState } from "react"
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

type PairDeviceDialogProps =
  | {
      snapshot: AppSnapshot
      /** Uncontrolled use: the dialog owns its state and renders its own trigger. */
      open?: undefined
      onOpenChange?: undefined
    }
  | {
      snapshot: AppSnapshot
      /** Controlled use: both props are required so triggers and close actions always update the effective state. */
      open: boolean
      onOpenChange: (open: boolean) => void
    }

export function PairDeviceDialog({
  snapshot,
  open: controlledOpen,
  onOpenChange,
}: PairDeviceDialogProps) {
  const [internalOpen, setInternalOpen] = useState(false)
  const open = controlledOpen ?? internalOpen
  const setOpen = onOpenChange ?? setInternalOpen
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)
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
    if (busyRef.current) return
    busyRef.current = true
    setBusyAction(action)
    setError(null)
    try {
      await operation()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to complete the pairing action.")
    } finally {
      busyRef.current = false
      setBusyAction(null)
    }
  }

  const outgoing = pairing.outgoingSession
  const terminalOutgoing = outgoing && ["paired", "rejected", "cancelled", "failed"].includes(outgoing.status)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {controlledOpen === undefined ? (
        <DialogTrigger render={<Button />}>
          <Link2Icon data-icon="inline-start" />
          Start pairing
        </DialogTrigger>
      ) : null}
      <DialogContent className="pairing-dialog [width:min(760px,_calc(100vw_-_32px))] [max-width:760px] [max-height:min(860px,_calc(100vh_-_32px))] [overflow-y:auto]">
        <DialogHeader>
          <div className="pairing-dialog-heading [display:flex] [align-items:flex-start] [gap:12px]">
            <div className="pairing-dialog-icon [display:grid] [width:40px] [height:40px] [flex:0_0_auto] [place-items:center] [border:1px_solid_color-mix(in_oklab,_var(--primary)_26%,_var(--border))] [border-radius:12px] [background:color-mix(in_oklab,_var(--primary)_11%,_var(--surface-strong))] [color:var(--primary)] [&_svg]:[width:20px] [&_svg]:[height:20px]"><ShieldCheckIcon /></div>
            <div>
              <DialogTitle>Pair another computer</DialogTitle>
              <DialogDescription>
                Both computers compare the same one-time code before either identity is trusted.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="pairing-security-note [display:flex] [align-items:center] [gap:11px] [margin-top:18px] [border:1px_solid_var(--border)] [border-radius:var(--radius-tile)] [background:var(--surface-sunken)] [padding:10px_12px] [&>svg]:[width:18px] [&>svg]:[height:18px] [&>svg]:[color:var(--primary)] [&_span]:[display:block] [&_span]:[color:var(--muted-foreground)] [&_span]:[font-size:9px] [&_span]:[text-transform:uppercase] [&_span]:[letter-spacing:0.08em] [&_code]:[display:block] [&_code]:[margin-top:2px] [&_code]:[font-size:10.5px] [&_code]:[letter-spacing:0.04em]">
          <FingerprintIcon />
          <div>
            <span>This computer’s identity</span>
            <code>{pairing.localFingerprint}</code>
          </div>
        </div>

        <section className={cn("pairing-visibility-card [display:flex] [align-items:center] [justify-content:space-between] [gap:18px] [margin-top:14px] [border:1px_solid_var(--border)] [border-radius:13px] [background:var(--surface)] [padding:14px] max-[760px]:[align-items:stretch] max-[760px]:[flex-direction:column] max-[760px]:[&>button]:[width:100%]", pairing.acceptingPairing && "pairing-visibility-active [border-color:color-mix(in_oklab,_var(--success)_38%,_var(--border))] [background:color-mix(in_oklab,_var(--success)_7%,_var(--surface))]")}>
          <div className="pairing-visibility-copy [display:flex] [min-width:0] [align-items:flex-start] [gap:11px] [&_p]:[margin-top:4px] [&_p]:[max-width:54ch] [&_p]:[color:var(--muted-foreground)] [&_p]:[font-size:10.5px] [&_p]:[line-height:1.45]">
            <div className="pairing-radio-icon [display:grid] [width:34px] [height:34px] [flex:0_0_auto] [place-items:center] [border-radius:10px] [background:var(--secondary)] [color:var(--primary)] [&_svg]:[width:17px] [&_svg]:[height:17px]"><RadioIcon /></div>
            <div>
              <div className="pairing-visibility-title [display:flex] [align-items:center] [gap:8px] [&_strong]:[font-size:12px]">
                <strong>{pairing.acceptingPairing ? "Visible for pairing" : "Not accepting pairing requests"}</strong>
                {pairing.acceptingPairing ? <Badge variant="success">{remaining ?? "5:00"}</Badge> : null}
              </div>
              <p>
                {pairing.acceptingPairing
                  ? "Nearby Tethera computers can find this device for five minutes."
                  : "Turn this on from either computer, then select it from the nearby list."}
              </p>
            </div>
          </div>
          <Button
            variant={pairing.acceptingPairing ? "outline" : "default"}
            disabled={Boolean(busyAction)}
            onClick={() => run("visibility", () => window.folderSync.setPairingAvailable(!pairing.acceptingPairing))}
          >
            {busyAction === "visibility" ? <LoaderCircleIcon className="animate-spin" data-icon="inline-start" /> : <WifiIcon data-icon="inline-start" />}
            {pairing.acceptingPairing ? "Stop being visible" : "Allow pairing for 5 minutes"}
          </Button>
        </section>

        {pairing.incomingRequests.length > 0 ? (
          <section className="pairing-section [margin-top:18px]">
            <div className="pairing-section-heading [display:flex] [align-items:center] [justify-content:space-between] [gap:14px] [margin-bottom:9px] [&_h3]:[font-size:12.5px] [&_h3]:[font-weight:640] [&_p]:[margin-top:3px] [&_p]:[color:var(--muted-foreground)] [&_p]:[font-size:10px]">
              <div><h3>Incoming request</h3><p>Only approve when both screens show the same code.</p></div>
              <Badge variant="info">Action required</Badge>
            </div>
            <div className="pairing-request-list [display:grid] [gap:9px]">
              {pairing.incomingRequests.map((request) => (
                <article className="pairing-request-card [border:1px_solid_var(--border)] [border-radius:var(--radius-tile)] [background:var(--surface)] [padding:13px]" key={request.id}>
                  <DeviceIdentity candidate={request.device} />
                  <ComparisonCode code={request.comparisonCode} />
                  {request.status === "waiting-for-peer" ? (
                    <div className="pairing-waiting-row [display:flex] [align-items:center] [justify-content:center] [gap:8px] [margin-top:12px] [color:var(--muted-foreground)] [font-size:10.5px] [&_svg]:[width:15px] [&_svg]:[height:15px]">
                      <LoaderCircleIcon className="animate-spin" />
                      <span>Waiting for {request.device.name} to confirm the code…</span>
                    </div>
                  ) : (
                    <div className="pairing-request-actions [display:flex] [justify-content:flex-end] [gap:8px] [margin-top:12px]">
                      <Button
                        variant="outline"
                        disabled={Boolean(busyAction)}
                        onClick={() => run(`reject:${request.id}`, () => window.folderSync.rejectPairing(request.id))}
                      >
                        Reject
                      </Button>
                      <Button
                        disabled={Boolean(busyAction)}
                        onClick={() => run(`approve:${request.id}`, () => window.folderSync.approvePairing(request.id))}
                      >
                        <ShieldCheckIcon data-icon="inline-start" />
                        {busyAction === "approve:" + request.id ? "Approving…" : "Codes match — approve"}
                      </Button>
                    </div>
                  )}
                </article>
              ))}
            </div>
          </section>
        ) : null}

        {outgoing ? (
          <section className="pairing-section [margin-top:18px]">
            <div className="pairing-section-heading [display:flex] [align-items:center] [justify-content:space-between] [gap:14px] [margin-bottom:9px] [&_h3]:[font-size:12.5px] [&_h3]:[font-weight:640] [&_p]:[margin-top:3px] [&_p]:[color:var(--muted-foreground)] [&_p]:[font-size:10px]">
              <div><h3>Pairing with {outgoing.device.name}</h3><p>{outgoing.message ?? pairingStatusDescription(outgoing.status)}</p></div>
              <PairingStatusBadge status={outgoing.status} />
            </div>
            <article className="outgoing-pairing-card [border:1px_solid_var(--border)] [border-radius:var(--radius-tile)] [background:var(--surface)] [padding:13px]">
              <DeviceIdentity candidate={outgoing.device} />
              {outgoing.comparisonCode ? <ComparisonCode code={outgoing.comparisonCode} /> : null}
              {outgoing.status === "connecting" ? (
                <div className="pairing-waiting-row [display:flex] [align-items:center] [justify-content:center] [gap:8px] [margin-top:12px] [color:var(--muted-foreground)] [font-size:10.5px] [&_svg]:[width:15px] [&_svg]:[height:15px]"><LoaderCircleIcon className="animate-spin" /><span>Opening a direct LAN connection…</span></div>
              ) : null}
              {outgoing.status === "confirm-code" ? (
                <div className="pairing-request-actions [display:flex] [justify-content:flex-end] [gap:8px] [margin-top:12px]">
                  <Button variant="outline" disabled={Boolean(busyAction)} onClick={() => run("cancel", () => window.folderSync.cancelPairing(outgoing.id))}>Cancel</Button>
                  <Button disabled={Boolean(busyAction)} onClick={() => run("confirm", () => window.folderSync.confirmPairing(outgoing.id))}>
                    <ShieldCheckIcon data-icon="inline-start" />
                    {busyAction === "confirm" ? "Confirming…" : "Codes match — continue"}
                  </Button>
                </div>
              ) : null}
              {outgoing.status === "waiting-for-approval" || outgoing.status === "waiting-for-peer" ? (
                <div className="pairing-waiting-row [display:flex] [align-items:center] [justify-content:center] [gap:8px] [margin-top:12px] [color:var(--muted-foreground)] [font-size:10.5px] [&_svg]:[width:15px] [&_svg]:[height:15px]"><LoaderCircleIcon className="animate-spin" /><span>{outgoing.message}</span></div>
              ) : null}
              {terminalOutgoing ? (
                <div className="pairing-request-actions [display:flex] [justify-content:flex-end] [gap:8px] [margin-top:12px]">
                  <Button variant="outline" onClick={() => run("dismiss", () => window.folderSync.cancelPairing(outgoing.id))}>
                    {outgoing.status === "paired" ? "Done" : "Close"}
                  </Button>
                </div>
              ) : null}
            </article>
          </section>
        ) : (
          <section className="pairing-section [margin-top:18px]">
            <div className="pairing-section-heading [display:flex] [align-items:center] [justify-content:space-between] [gap:14px] [margin-bottom:9px] [&_h3]:[font-size:12.5px] [&_h3]:[font-weight:640] [&_p]:[margin-top:3px] [&_p]:[color:var(--muted-foreground)] [&_p]:[font-size:10px]">
              <div><h3>Nearby computers</h3><p>Only devices currently allowing pairing appear here.</p></div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => run("refresh", () => window.folderSync.getSnapshot())}
                disabled={Boolean(busyAction)}
              >
                <RefreshCwIcon className={busyAction === "refresh" ? "animate-spin" : undefined} data-icon="inline-start" />
                Refresh
              </Button>
            </div>

            {pairing.discoveredDevices.length > 0 ? (
              <div className="nearby-device-list [display:grid] [gap:9px]">
                {pairing.discoveredDevices.map((candidate) => (
                  <article className="nearby-device-card [border:1px_solid_var(--border)] [border-radius:var(--radius-tile)] [background:var(--surface)] [padding:13px] [display:flex] [align-items:center] [justify-content:space-between] [gap:14px] max-[760px]:[align-items:stretch] max-[760px]:[flex-direction:column] max-[760px]:[&>button]:[width:100%]" key={candidate.id}>
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
              <div className="pairing-empty-state [display:flex] [min-height:104px] [align-items:center] [justify-content:center] [gap:12px] [border:1px_dashed_var(--border)] [border-radius:var(--radius-tile)] [background:color-mix(in_oklab,_var(--surface-sunken)_70%,_transparent)] [padding:18px] [text-align:left] [&>svg]:[width:24px] [&>svg]:[height:24px] [&>svg]:[color:var(--muted-foreground)] [&_strong]:[display:block] [&_strong]:[font-size:11.5px] [&_span]:[display:block] [&_span]:[max-width:56ch] [&_span]:[margin-top:3px] [&_span]:[color:var(--muted-foreground)] [&_span]:[font-size:10px] [&_span]:[line-height:1.45]">
                <ShieldQuestionIcon />
                <div>
                  <strong>No computers are available yet</strong>
                  <span>Keep both computers on the same LAN or Tailscale network. Open Tethera on the other computer, choose “Allow pairing for 5 minutes”, and keep this dialog open.</span>
                </div>
              </div>
            )}
          </section>
        )}

        {error ? <div className="pairing-error [display:flex] [align-items:flex-start] [gap:8px] [margin-top:12px] [border:1px_solid_color-mix(in_oklab,_var(--destructive)_35%,_var(--border))] [border-radius:10px] [background:color-mix(in_oklab,_var(--destructive)_9%,_var(--surface))] [padding:9px_11px] [color:var(--destructive)] [font-size:10.5px] [&_svg]:[width:16px] [&_svg]:[height:16px] [&_svg]:[flex:0_0_auto]" role="alert"><XCircleIcon /><span>{error} Try the same action again.</span></div> : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DeviceIdentity({ candidate }: { candidate: PairingCandidate }) {
  return (
    <div className="pairing-device-identity [display:flex] [min-width:0] [align-items:center] [gap:11px] [&>div:last-child]:[min-width:0] [&_strong]:[display:block] [&_strong]:[overflow:hidden] [&_strong]:[font-size:12px] [&_strong]:[text-overflow:ellipsis] [&_strong]:[white-space:nowrap] [&_span]:[display:block] [&_span]:[overflow:hidden] [&_span]:[margin-top:2px] [&_span]:[color:var(--muted-foreground)] [&_span]:[font-size:9.5px] [&_span]:[text-overflow:ellipsis] [&_span]:[white-space:nowrap] [&_code]:[display:block] [&_code]:[overflow:hidden] [&_code]:[margin-top:4px] [&_code]:[color:var(--muted-foreground)] [&_code]:[font-size:8.5px] [&_code]:[letter-spacing:0.035em] [&_code]:[text-overflow:ellipsis] [&_code]:[white-space:nowrap]">
      <div className="pairing-device-icon [display:grid] [width:38px] [height:38px] [flex:0_0_auto] [place-items:center] [border-radius:11px] [background:var(--secondary)] [color:var(--primary)] [&_svg]:[width:18px] [&_svg]:[height:18px]">
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
    <div className="comparison-code-block [display:grid] [place-items:center] [margin-top:13px] [border:1px_solid_color-mix(in_oklab,_var(--primary)_24%,_var(--border))] [border-radius:var(--radius-tile)] [background:color-mix(in_oklab,_var(--primary)_8%,_var(--surface-sunken))] [padding:15px] [text-align:center] [&>div]:[display:flex] [&>div]:[align-items:center] [&>div]:[gap:6px] [&>div]:[color:var(--muted-foreground)] [&>div]:[font-size:9px] [&>div]:[text-transform:uppercase] [&>div]:[letter-spacing:0.07em] [&>div_svg]:[width:14px] [&>div_svg]:[height:14px] [&>div_svg]:[color:var(--primary)] [&_strong]:[margin-top:7px] [&_strong]:[font-size:28px] [&_strong]:[font-variant-numeric:tabular-nums] [&_strong]:[letter-spacing:0.16em] [&_p]:[margin-top:5px] [&_p]:[color:var(--muted-foreground)] [&_p]:[font-size:9.5px] max-[760px]:[&_strong]:[font-size:23px]">
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
