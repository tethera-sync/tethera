import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { Overview } from "../src/renderer/views/overview"
import { overallHeadline, setupActionTarget } from "../src/renderer/lib/snapshot"
import type { FolderSummary, IncomingMappingRequest, OutgoingMappingRequest } from "../src/shared/contracts"
import { appSnapshot } from "./helpers"

const folder: FolderSummary = {
  id: "test-folder", name: "Documents", localPath: "/tmp/tethera-test/local",
  remotePath: "C:\\Tethera-test\\remote", remoteDeviceId: "test-peer",
  mode: "two-way", paused: false, status: "needs-attention",
  setupStatus: "ready-for-initial-sync", ignorePatterns: [],
}
const peer = { id: "test-peer", name: "Other computer", platform: "windows", status: "online", route: "lan-direct" } as const

function render(snapshot = appSnapshot()) {
  return renderToStaticMarkup(<Overview snapshot={snapshot} onNavigate={() => undefined} />)
}

describe("overview setup", () => {
  test("gives first-run users a next action without redundant empty panels", () => {
    const html = render()
    expect(html).toContain("Set up pairing")
    expect(html).not.toContain("No folders configured")
    expect(html).not.toContain("Recent activity")
  })

  test("keeps the initial merge actionable until a folder is active", () => {
    const snapshot = appSnapshot({ devices: [peer], folders: [folder] })
    expect(render(snapshot)).toContain("Open initial merge")
    expect(render({ ...snapshot, folders: [{ ...folder, setupStatus: "active", status: "up-to-date" }] })).not.toContain("Set up folder sync")
  })

  test("pending approval does not appear as completed setup", () => {
    expect(render(appSnapshot({ devices: [peer], folders: [{ ...folder, setupStatus: "pending-approval" }] }))).toContain("Review requests")
  })

  test("routes outgoing mapping requests to the folders view", () => {
    const outgoing = (status: OutgoingMappingRequest["status"]) => ({
      id: `out-${status}`,
      toDeviceId: "test-peer",
      toDeviceName: "Other computer",
      proposal: { id: "proposal-1", name: "Documents" },
      status,
    }) as OutgoingMappingRequest
    for (const status of ["pending", "approved-awaiting-delivery"] as const) {
      const snapshot = appSnapshot({ devices: [peer], mappings: { incoming: [], outgoing: [outgoing(status)] } })
      expect(setupActionTarget(snapshot)).toBe("folders")
      expect(render(snapshot)).toContain("Review requests")
    }
  })

  test("keeps pairing and incoming approvals on the devices view", () => {
    expect(setupActionTarget(appSnapshot())).toBe("devices")
    const incoming = {
      id: "in-1",
      fromDeviceId: "test-peer",
      fromDeviceName: "Other computer",
      proposal: { id: "proposal-1", name: "Documents" },
      status: "pending",
      selectedDestinationPath: "/tmp/tethera-test/incoming",
    } as IncomingMappingRequest
    expect(setupActionTarget(appSnapshot({ devices: [peer], mappings: { incoming: [incoming], outgoing: [] } }))).toBe("devices")
    expect(setupActionTarget(appSnapshot({ devices: [peer], folders: [{ ...folder, setupStatus: "pending-approval" }] }))).toBe("devices")
  })

  test("unavailable engine or configuration cannot claim healthy sync", () => {
    expect(overallHeadline(appSnapshot({ devices: [peer], engineStatus: "error" }))).toBe("Sync is unavailable")
    expect(overallHeadline(appSnapshot({ devices: [peer], mappingStore: { status: "unavailable", mutationsEnabled: false, pendingDeliveryCount: 0 } }))).toBe("Sync is unavailable")
  })
})
