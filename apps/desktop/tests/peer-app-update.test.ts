import { describe, expect, test } from "bun:test"
import type { PeerAppReport, PeerUpdateStatus } from "../src/shared/contracts"
import {
  APP_UPDATE_INSTALL_REQUEST,
  APP_UPDATE_STATUS_REQUEST,
  PEER_APP_STATUS_TTL_MS,
  PEER_APP_UPDATE_POLL_MS,
  PEER_APP_UPDATE_RECONNECT_MS,
  PeerAppUpdates,
  advancePeerUpdateJob,
  parsePeerAppReport,
  peerAppReport,
  requestPeerAppStatus,
  type PeerUpdateJob,
  type PeerUpdateOutcome,
} from "../src/main/peer-app-update"
import { UNSUPPORTED_PEER_REQUEST } from "../src/main/peer-capabilities"
import type { PeerRequest } from "../src/main/peer-session-service"

function report(update: PeerUpdateStatus, version = "0.1.22", install: PeerAppReport["install"] = "automatic"): PeerAppReport {
  return { version, install, update }
}

describe("peer app reports", () => {
  test("share progress but keep release notes and byte counts local", () => {
    expect(peerAppReport("0.1.22", "automatic", {
      status: "downloading", version: "0.1.23", progressPercent: 42, bytesPerSecond: 1_000, transferredBytes: 5, totalBytes: 10, currentVersion: "0.1.22",
    })).toEqual(report({ status: "downloading", version: "0.1.23", progressPercent: 42 }))
    expect(peerAppReport("0.1.22", "needs-approval", { status: "available", version: "0.1.23", releaseNotes: "Notes" }))
      .toEqual(report({ status: "available", version: "0.1.23" }, "0.1.22", "needs-approval"))
    expect(peerAppReport("0.1.22", "automatic", { status: "downloaded", version: "0.1.23", installError: "Denied." }).update)
      .toEqual({ status: "downloaded", version: "0.1.23", installError: "Denied." })
  })

  test("round-trip through the peer parser", () => {
    const sent = peerAppReport("0.1.22", "automatic", { status: "error", message: "Couldn't reach the update server." })
    expect(parsePeerAppReport(JSON.parse(JSON.stringify(sent)))).toEqual(sent)
  })

  test("reject malformed reports from a peer", () => {
    const valid = report({ status: "downloading", version: "0.1.23", progressPercent: 42 })
    expect(() => parsePeerAppReport({ ...valid, version: "../../etc" })).toThrow("invalid version report")
    expect(() => parsePeerAppReport({ ...valid, install: "silent" })).toThrow("invalid version report")
    expect(() => parsePeerAppReport({ ...valid, update: { status: "downloading", version: "0.1.23", progressPercent: 101 } })).toThrow("invalid version report")
    expect(() => parsePeerAppReport({ ...valid, update: { status: "installing" } })).toThrow("invalid version report")
    expect(() => parsePeerAppReport({ ...valid, update: { status: "error", message: "x".repeat(501) } })).toThrow("invalid version report")
    expect(() => parsePeerAppReport(null)).toThrow("invalid version report")
  })
})

describe("requestPeerAppStatus", () => {
  test("treats only the exact unsupported-request reply as an older Tethera", async () => {
    const legacy = { request: async () => { throw new Error(UNSUPPORTED_PEER_REQUEST) } }
    expect(await requestPeerAppStatus(legacy, "pc")).toEqual({ kind: "legacy" })

    const offline = { request: async () => { throw new Error("Could not connect to the trusted computer.") } }
    await expect(requestPeerAppStatus(offline, "pc")).rejects.toThrow("Could not connect")

    const malformed = { request: async () => ({ version: "0.1.22" }) }
    await expect(requestPeerAppStatus(malformed, "pc")).rejects.toThrow("invalid version report")
  })

  test("sends the status request and tags the answer as reported", async () => {
    const requests: PeerRequest[] = []
    const client = { request: async (_id: string, request: PeerRequest) => { requests.push(request); return report({ status: "idle" }) } }
    expect(await requestPeerAppStatus(client, "pc")).toEqual({ kind: "reported", ...report({ status: "idle" }) })
    expect(requests).toEqual([{ type: APP_UPDATE_STATUS_REQUEST }])
  })
})

describe("advancePeerUpdateJob", () => {
  const job: PeerUpdateJob = { fromVersion: "0.1.22", lastContactAt: 1_000 }

  test("follows checking and downloading, and records the contact", () => {
    expect(advancePeerUpdateJob(job, { kind: "report", report: report({ status: "checking" }) }, 5_000))
      .toEqual({ kind: "continue", job: { ...job, lastContactAt: 5_000 } })
    expect(advancePeerUpdateJob(job, { kind: "report", report: report({ status: "downloading", version: "0.1.23", progressPercent: 50 }) }, 5_000))
      .toEqual({ kind: "continue", job: { ...job, lastContactAt: 5_000 } })
  })

  test("expects a restart once an automatic install has the update, but not indefinitely", () => {
    const downloaded = { kind: "report", report: report({ status: "downloaded", version: "0.1.23" }) } as const
    const installing = { fromVersion: "0.1.22", installingSince: 5_000, lastContactAt: 5_000 }
    expect(advancePeerUpdateJob(job, downloaded, 5_000)).toEqual({ kind: "continue", job: installing })
    expect(advancePeerUpdateJob(installing, downloaded, 6_000)).toEqual({ kind: "continue", job: { ...installing, lastContactAt: 6_000 } })
    expect(advancePeerUpdateJob(installing, downloaded, 5_000 + PEER_APP_UPDATE_RECONNECT_MS)).toEqual({
      kind: "failed", message: "It downloaded the update but hasn't restarted to install it. Check Tethera on that computer.",
    })
  })

  test("hands a password-protected install over to that computer", () => {
    const downloaded = report({ status: "downloaded", version: "0.1.23" }, "0.1.22", "needs-approval")
    expect(advancePeerUpdateJob(job, { kind: "report", report: downloaded }, 5_000)).toEqual({ kind: "handed-over" })
  })

  test("finishes when the computer reports any other version", () => {
    expect(advancePeerUpdateJob(job, { kind: "report", report: report({ status: "idle" }, "0.1.23") }, 5_000))
      .toEqual({ kind: "updated", version: "0.1.23" })
  })

  test("fails with the computer's reason", () => {
    expect(advancePeerUpdateJob(job, { kind: "report", report: report({ status: "error", message: "Offline." }) }, 5_000))
      .toEqual({ kind: "failed", message: "Offline." })
    expect(advancePeerUpdateJob(job, { kind: "report", report: report({ status: "downloaded", version: "0.1.23", installError: "Denied." }) }, 5_000))
      .toEqual({ kind: "failed", message: "Denied." })
    expect(advancePeerUpdateJob(job, { kind: "report", report: report({ status: "not-available" }) }, 5_000))
      .toEqual({ kind: "failed", message: "No newer release is published, so it stays on v0.1.22." })
    expect(advancePeerUpdateJob(job, { kind: "report", report: report({ status: "idle" }) }, 5_000))
      .toEqual({ kind: "failed", message: "It stopped before the update finished. Try again." })
  })

  test("waits for a computer out of reach until the reconnect deadline", () => {
    const deadline = job.lastContactAt + PEER_APP_UPDATE_RECONNECT_MS
    expect(advancePeerUpdateJob(job, { kind: "unreachable" }, deadline - 1)).toEqual({ kind: "continue", job })
    expect(advancePeerUpdateJob(job, { kind: "unreachable" }, deadline)).toEqual({
      kind: "failed", message: "It went offline before the update finished. Try again when it's back online.",
    })
    expect(advancePeerUpdateJob({ ...job, installingSince: job.lastContactAt }, { kind: "unreachable" }, deadline)).toEqual({
      kind: "failed", message: "It hasn't reconnected since it started installing. Check Tethera on that computer.",
    })
  })
})

/** A paired computer whose answers the test sets, recording every request. */
function fakePeer(initial: PeerAppReport) {
  const state = { answer: initial as PeerAppReport | Error, requests: [] as string[] }
  const client = {
    async request(_deviceId: string, request: PeerRequest): Promise<unknown> {
      state.requests.push(request.type)
      if (state.answer instanceof Error) throw state.answer
      return state.answer
    },
  }
  return { state, client }
}

function tracker(client: { request(deviceId: string, request: PeerRequest): Promise<unknown> }) {
  const clock = { now: 0 }
  const finished: Array<{ peerName: string; outcome: PeerUpdateOutcome }> = []
  let changes = 0
  const updates = new PeerAppUpdates({
    client,
    now: () => clock.now,
    onChange: () => { changes += 1 },
    onFinished: (peerName, outcome) => finished.push({ peerName, outcome }),
  })
  return { updates, clock, finished, changes: () => changes }
}

const settle = () => Bun.sleep(0)
const pc = { id: "pc", name: "Tommys-PC" }

describe("PeerAppUpdates", () => {
  test("reads a computer when it comes online, then only on its schedule", async () => {
    const peer = fakePeer(report({ status: "idle" }))
    const { updates, clock } = tracker(peer.client)

    updates.refreshDue([{ ...pc, online: false }])
    await settle()
    expect(peer.state.requests).toEqual([])

    updates.refreshDue([{ ...pc, online: true }])
    await settle()
    expect(updates.view(pc.id).app).toEqual({ kind: "reported", ...report({ status: "idle" }) })

    clock.now = PEER_APP_STATUS_TTL_MS - 1
    updates.refreshDue([{ ...pc, online: true }])
    await settle()
    expect(peer.state.requests).toHaveLength(1)

    updates.refreshDue([{ ...pc, online: false }])
    updates.refreshDue([{ ...pc, online: true }])
    await settle()
    expect(peer.state.requests).toHaveLength(2)
  })

  test("follows an automatic update through the restart to the new version", async () => {
    const peer = fakePeer(report({ status: "not-available" }))
    const { updates, clock, finished } = tracker(peer.client)
    updates.refreshDue([{ ...pc, online: true }])
    await settle()

    peer.state.answer = report({ status: "checking" })
    await updates.start(pc)
    expect(peer.state.requests.at(-1)).toBe(APP_UPDATE_INSTALL_REQUEST)
    expect(updates.view(pc.id).appUpdate).toEqual({ status: "updating" })

    peer.state.answer = report({ status: "downloading", version: "0.1.23", progressPercent: 40 })
    clock.now += PEER_APP_UPDATE_POLL_MS
    updates.refreshDue([{ ...pc, online: true }])
    await settle()
    expect(updates.view(pc.id).app).toMatchObject({ update: { status: "downloading", progressPercent: 40 } })

    peer.state.answer = report({ status: "downloaded", version: "0.1.23" })
    clock.now += PEER_APP_UPDATE_POLL_MS
    updates.refreshDue([{ ...pc, online: true }])
    await settle()
    expect(updates.view(pc.id).appUpdate).toEqual({ status: "restarting" })

    clock.now += PEER_APP_UPDATE_POLL_MS
    updates.refreshDue([{ ...pc, online: false }])
    expect(updates.view(pc.id).appUpdate).toEqual({ status: "restarting" })

    peer.state.answer = report({ status: "idle" }, "0.1.23")
    updates.refreshDue([{ ...pc, online: true }])
    await settle()
    expect(finished).toEqual([{ peerName: "Tommys-PC", outcome: { kind: "updated", version: "0.1.23" } }])
    expect(updates.view(pc.id)).toEqual({ app: { kind: "reported", ...report({ status: "idle" }, "0.1.23") }, appUpdate: undefined })
  })

  test("records a refused request as the failure to show", async () => {
    const peer = fakePeer(report({ status: "idle" }))
    const { updates, finished } = tracker(peer.client)
    updates.refreshDue([{ ...pc, online: true }])
    await settle()

    peer.state.answer = new Error("Tommys-PC is in the middle of a merge or restore. Update it when that finishes.")
    await updates.start(pc)
    expect(updates.view(pc.id).appUpdate).toEqual({
      status: "failed", message: "Tommys-PC is in the middle of a merge or restore. Update it when that finishes.",
    })
    expect(finished).toHaveLength(1)

    // A computer updated some other way no longer carries the old failure.
    peer.state.answer = report({ status: "idle" }, "0.1.23")
    updates.refreshDue([{ ...pc, online: false }])
    updates.refreshDue([{ ...pc, online: true }])
    await settle()
    expect(updates.view(pc.id).appUpdate).toBeUndefined()
  })

  test("refuses computers that cannot update from here", async () => {
    const legacy = { request: async () => { throw new Error(UNSUPPORTED_PEER_REQUEST) } }
    const old = tracker(legacy)
    old.updates.refreshDue([{ ...pc, online: true }])
    await settle()
    await expect(old.updates.start(pc)).rejects.toThrow("too old to update from here")

    const development = tracker(fakePeer(report({ status: "idle" }, "0.1.22", "unsupported")).client)
    development.updates.refreshDue([{ ...pc, online: true }])
    await settle()
    await expect(development.updates.start(pc)).rejects.toThrow("development build")

    await expect(tracker(legacy).updates.start(pc)).rejects.toThrow("too old to update from here")
  })

  test("ignores a read that was already in flight when the update was requested", async () => {
    let releaseStaleRead: (() => void) | undefined
    let reads = 0
    const client = {
      async request(_deviceId: string, request: PeerRequest): Promise<unknown> {
        if (request.type === APP_UPDATE_INSTALL_REQUEST) return report({ status: "checking" })
        reads += 1
        if (reads === 2) await new Promise<void>((resolve) => { releaseStaleRead = resolve })
        return report({ status: "not-available" })
      },
    }
    const { updates, clock, finished } = tracker(client)
    updates.refreshDue([{ ...pc, online: true }])
    await settle()

    clock.now = PEER_APP_STATUS_TTL_MS
    updates.refreshDue([{ ...pc, online: true }])
    await settle()
    await updates.start(pc)
    releaseStaleRead?.()
    await settle()

    expect(finished).toEqual([])
    expect(updates.view(pc.id).appUpdate).toEqual({ status: "updating" })
  })
})
