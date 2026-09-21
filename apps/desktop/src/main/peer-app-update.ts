import { z } from "zod"
import { isAppVersion } from "../shared/app-version"
import type {
  PeerAppReport,
  PeerAppStatus,
  PeerAppUpdateRequest,
  PeerUpdateInstall,
  PeerUpdateStatus,
  UpdateState,
} from "../shared/contracts"
import { UNSUPPORTED_PEER_REQUEST } from "./peer-capabilities"
import type { PeerRequest } from "./peer-session-service"

/** Asks a paired computer for its `PeerAppReport`. */
export const APP_UPDATE_STATUS_REQUEST = "app-update-status"
/** Asks a paired computer to install the newest release from its own update feed. Answered with its `PeerAppReport`. */
export const APP_UPDATE_INSTALL_REQUEST = "app-update-install"

/** How often an online computer's report is re-read while no update is running. */
export const PEER_APP_STATUS_TTL_MS = 10 * 60_000
/** How often an updating computer is polled for progress; also the owner's refresh tick. */
export const PEER_APP_UPDATE_POLL_MS = 3_000
/** How long an installing computer may take to restart, or an updating one stay out of reach, before its update is reported as failed. */
export const PEER_APP_UPDATE_RECONNECT_MS = 10 * 60_000
/** A failed version read is retried sooner than the idle refresh, since the computer may have just come online. */
const PEER_APP_STATUS_RETRY_MS = 60_000
const PEER_APP_REQUEST_TIMEOUT_MS = 15_000

export interface PeerAppClient {
  request(deviceId: string, request: PeerRequest, timeoutMs?: number): Promise<unknown>
}

/** This computer's report to a paired computer. Release notes and byte counts stay local. */
export function peerAppReport(version: string, install: PeerUpdateInstall, update: UpdateState): PeerAppReport {
  return { version, install, update: peerUpdateStatus(update) }
}

function peerUpdateStatus(update: UpdateState): PeerUpdateStatus {
  switch (update.status) {
    case "idle":
    case "checking":
    case "not-available":
      return { status: update.status }
    case "available":
      return { status: "available", version: update.version }
    case "downloading":
      return { status: "downloading", version: update.version, progressPercent: update.progressPercent }
    case "downloaded":
      return update.installError
        ? { status: "downloaded", version: update.version, installError: update.installError }
        : { status: "downloaded", version: update.version }
    case "error":
      return { status: "error", message: update.message }
  }
}

const appVersionSchema = z.string().max(64).refine(isAppVersion)
const peerMessageSchema = z.string().min(1).max(500)
const peerAppReportSchema = z.object({
  version: appVersionSchema,
  install: z.enum(["automatic", "needs-approval", "unsupported"]),
  update: z.discriminatedUnion("status", [
    z.object({ status: z.literal("idle") }),
    z.object({ status: z.literal("checking") }),
    z.object({ status: z.literal("available"), version: appVersionSchema }),
    z.object({ status: z.literal("not-available") }),
    z.object({ status: z.literal("downloading"), version: appVersionSchema, progressPercent: z.number().int().min(0).max(100) }),
    z.object({ status: z.literal("downloaded"), version: appVersionSchema, installError: peerMessageSchema.optional() }),
    z.object({ status: z.literal("error"), message: peerMessageSchema }),
  ]),
})

/** Validates a paired computer's report, which is untrusted input like any peer message. */
export function parsePeerAppReport(value: unknown): PeerAppReport {
  const parsed = peerAppReportSchema.safeParse(value)
  if (!parsed.success) throw new Error("The paired computer returned an invalid version report.")
  return parsed.data
}

/**
 * Reads a paired computer's report. A computer that predates reports answers
 * with the exact unsupported-request error, and only that reply means
 * `legacy`: a malformed report or a transport failure is an error.
 */
export async function requestPeerAppStatus(client: PeerAppClient, peerId: string): Promise<PeerAppStatus> {
  try {
    const response = await client.request(peerId, { type: APP_UPDATE_STATUS_REQUEST }, PEER_APP_REQUEST_TIMEOUT_MS)
    return { kind: "reported", ...parsePeerAppReport(response) }
  } catch (error) {
    if (error instanceof Error && error.message === UNSUPPORTED_PEER_REQUEST) return { kind: "legacy" }
    throw error
  }
}

/** An update this computer asked a paired computer to install, while it runs. */
export interface PeerUpdateJob {
  /** The version the computer reported when asked. Any other version means the update installed. */
  fromVersion: string
  /** When it first reported the update downloaded and installing. Losing contact after that means it is restarting. */
  installingSince?: number
  /** When it last answered, for the reconnect deadline. */
  lastContactAt: number
}

export type PeerUpdateObservation = { kind: "report"; report: PeerAppReport } | { kind: "unreachable" }

export type PeerUpdateOutcome = { kind: "updated"; version: string } | { kind: "failed"; message: string }

export type PeerUpdateJobStep =
  | { kind: "continue"; job: PeerUpdateJob }
  /** Downloaded and waiting for approval on that computer, which its own report shows from here. */
  | { kind: "handed-over" }
  | PeerUpdateOutcome

/** Advances an update job by one report from, or failed contact with, the updating computer. */
export function advancePeerUpdateJob(job: PeerUpdateJob, observation: PeerUpdateObservation, now: number): PeerUpdateJobStep {
  if (observation.kind === "unreachable") {
    if (now - job.lastContactAt < PEER_APP_UPDATE_RECONNECT_MS) return { kind: "continue", job }
    return {
      kind: "failed",
      message: job.installingSince !== undefined
        ? "It hasn't reconnected since it started installing. Check Tethera on that computer."
        : "It went offline before the update finished. Try again when it's back online.",
    }
  }
  const { report } = observation
  if (report.version !== job.fromVersion) return { kind: "updated", version: report.version }
  const { update } = report
  switch (update.status) {
    case "checking":
    case "downloading":
      return { kind: "continue", job: { fromVersion: job.fromVersion, lastContactAt: now } }
    case "downloaded": {
      if (update.installError) return { kind: "failed", message: update.installError }
      if (report.install === "needs-approval") return { kind: "handed-over" }
      const installingSince = job.installingSince ?? now
      if (now - installingSince >= PEER_APP_UPDATE_RECONNECT_MS) {
        return { kind: "failed", message: "It downloaded the update but hasn't restarted to install it. Check Tethera on that computer." }
      }
      return { kind: "continue", job: { ...job, installingSince, lastContactAt: now } }
    }
    case "error":
      return { kind: "failed", message: update.message }
    case "not-available":
      return { kind: "failed", message: `No newer release is published, so it stays on v${report.version}.` }
    case "idle":
    case "available":
      // The updating computer moves from available to downloading synchronously,
      // so either state here means it restarted or dropped the request.
      return { kind: "failed", message: "It stopped before the update finished. Try again." }
  }
}

export interface PairedPeer {
  id: string
  name: string
  online: boolean
}

export interface PeerAppUpdatesOptions {
  client: PeerAppClient
  /** Called after any change a device card shows. */
  onChange(): void
  /** Called once when an update this computer requested ends. */
  onFinished(peerName: string, outcome: PeerUpdateOutcome): void
  now?: () => number
}

interface PeerEntry {
  online: boolean
  refreshing: boolean
  /** An install request is in flight; polls wait so a report from before it cannot advance the job. */
  starting: boolean
  nextRefreshAt?: number
  status?: PeerAppStatus
  job?: PeerUpdateJob
  failure?: string
}

/**
 * Tracks each paired computer's Tethera version and follows the updates this
 * computer asks them to install. The owner calls `refreshDue` on a timer, so
 * it controls the cadence and the timer's lifetime.
 */
export class PeerAppUpdates {
  readonly #options: PeerAppUpdatesOptions
  readonly #now: () => number
  readonly #entries = new Map<string, PeerEntry>()

  constructor(options: PeerAppUpdatesOptions) {
    this.#options = options
    this.#now = options.now ?? Date.now
  }

  /** The device-card fields for one paired computer. Both keys are always present so a merge clears stale values. */
  view(peerId: string): { app: PeerAppStatus | undefined; appUpdate: PeerAppUpdateRequest | undefined } {
    const entry = this.#entries.get(peerId)
    if (!entry) return { app: undefined, appUpdate: undefined }
    return { app: entry.status, appUpdate: updateRequestView(entry) }
  }

  /** Reads the report of each online computer that is due: immediately once it comes online, then on its schedule. */
  refreshDue(peers: readonly PairedPeer[]): void {
    const now = this.#now()
    for (const peer of peers) {
      const entry = this.#entry(peer.id)
      const cameOnline = peer.online && !entry.online
      entry.online = peer.online
      if (entry.refreshing || entry.starting) continue
      if (!peer.online) {
        if (entry.job) {
          this.#advance(peer.name, entry, { kind: "unreachable" })
          if (!entry.job) this.#options.onChange()
        }
        continue
      }
      if (cameOnline || entry.nextRefreshAt === undefined || now >= entry.nextRefreshAt) void this.#refresh(peer, entry)
    }
  }

  /**
   * Asks a paired computer to install the newest release. Its answer and later
   * progress are followed through `refreshDue`; a refused request is recorded
   * as the failure the device card shows.
   */
  async start(peer: { id: string; name: string }): Promise<void> {
    const entry = this.#entry(peer.id)
    if (entry.job) return
    const status = entry.status
    if (status?.kind !== "reported") {
      throw new Error(`Tethera on ${peer.name} is too old to update from here. Update it on that computer first.`)
    }
    if (status.install === "unsupported") {
      throw new Error(`${peer.name} runs a development build of Tethera, which can't update itself.`)
    }
    entry.failure = undefined
    entry.job = { fromVersion: status.version, lastContactAt: this.#now() }
    entry.starting = true
    this.#options.onChange()
    try {
      const response = await this.#options.client.request(peer.id, { type: APP_UPDATE_INSTALL_REQUEST }, PEER_APP_REQUEST_TIMEOUT_MS)
      const report = parsePeerAppReport(response)
      this.#record(entry, { kind: "reported", ...report })
      this.#advance(peer.name, entry, { kind: "report", report })
    } catch (error) {
      entry.job = undefined
      const message = error instanceof Error && error.message ? error.message : "The update request failed."
      entry.failure = message
      this.#options.onFinished(peer.name, { kind: "failed", message })
    } finally {
      entry.starting = false
      entry.nextRefreshAt = this.#now() + PEER_APP_UPDATE_POLL_MS
      this.#options.onChange()
    }
  }

  forget(peerId: string): void {
    this.#entries.delete(peerId)
  }

  #entry(peerId: string): PeerEntry {
    let entry = this.#entries.get(peerId)
    if (!entry) {
      entry = { online: false, refreshing: false, starting: false }
      this.#entries.set(peerId, entry)
    }
    return entry
  }

  async #refresh(peer: PairedPeer, entry: PeerEntry): Promise<void> {
    entry.refreshing = true
    // A read sent before an update was requested describes the computer before
    // it accepted, so it may only advance the job it was sent under.
    const job = entry.job
    const current = (): boolean => job !== undefined && entry.job === job
    let succeeded = false
    try {
      const status = await requestPeerAppStatus(this.#options.client, peer.id)
      succeeded = true
      this.#record(entry, status)
      if (current()) {
        this.#advance(peer.name, entry, status.kind === "reported" ? { kind: "report", report: status } : { kind: "unreachable" })
      }
    } catch (error) {
      if (current()) this.#advance(peer.name, entry, { kind: "unreachable" })
      else console.warn(`[peer-app] unable to read the Tethera version of ${peer.name}`, error)
    } finally {
      const interval = entry.job ? PEER_APP_UPDATE_POLL_MS : succeeded ? PEER_APP_STATUS_TTL_MS : PEER_APP_STATUS_RETRY_MS
      entry.nextRefreshAt = this.#now() + interval
      entry.refreshing = false
      this.#options.onChange()
    }
  }

  #record(entry: PeerEntry, status: PeerAppStatus): void {
    // A failure is about the version it was reported against.
    if (entry.status?.kind === "reported" && status.kind === "reported" && entry.status.version !== status.version) {
      entry.failure = undefined
    }
    entry.status = status
  }

  #advance(peerName: string, entry: PeerEntry, observation: PeerUpdateObservation): void {
    if (!entry.job) return
    const step = advancePeerUpdateJob(entry.job, observation, this.#now())
    if (step.kind === "continue") {
      entry.job = step.job
      return
    }
    entry.job = undefined
    if (step.kind === "handed-over") return
    if (step.kind === "failed") entry.failure = step.message
    this.#options.onFinished(peerName, step)
  }
}

function updateRequestView(entry: PeerEntry): PeerAppUpdateRequest | undefined {
  if (entry.job) return entry.job.installingSince === undefined ? { status: "updating" } : { status: "restarting" }
  return entry.failure === undefined ? undefined : { status: "failed", message: entry.failure }
}
