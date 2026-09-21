import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { DeviceSummary, PeerAppReport, PeerUpdateStatus } from "../src/shared/contracts"
import { PeerUpdatePanel } from "../src/renderer/components/peer-update-panel"
import { deviceVersionLabel, peerNeedsUpdate, peerUpdateView } from "../src/renderer/lib/peer-update"

function reported(update: PeerUpdateStatus, version = "0.1.22", install: PeerAppReport["install"] = "automatic"): DeviceSummary["app"] {
  return { kind: "reported", version, install, update }
}

function device(overrides: Partial<DeviceSummary> = {}): DeviceSummary {
  return { id: "pc", name: "Tommys-PC", platform: "windows", status: "online", route: "lan-direct", ...overrides }
}

describe("peerUpdateView", () => {
  test("offers an update to a computer behind this one", () => {
    expect(peerUpdateView(device({ app: reported({ status: "idle" }) }), "0.1.23")).toEqual({
      kind: "offer", action: "update", reason: "behind", from: "0.1.22", to: "0.1.23", needsApproval: false,
    })
    expect(peerUpdateView(device({ app: reported({ status: "idle" }, "0.1.23") }), "0.1.23")).toEqual({ kind: "none" })
    expect(peerUpdateView(device({ app: reported({ status: "idle" }, "0.1.24") }), "0.1.23")).toEqual({ kind: "none" })
  })

  test("offers a release the computer found itself, and installing one it already downloaded", () => {
    expect(peerUpdateView(device({ app: reported({ status: "available", version: "0.1.24" }, "0.1.23") }), "0.1.23")).toMatchObject({
      kind: "offer", action: "update", reason: "release", to: "0.1.24",
    })
    expect(peerUpdateView(device({ app: reported({ status: "downloaded", version: "0.1.24" }, "0.1.23") }), "0.1.23")).toMatchObject({
      kind: "offer", action: "install", to: "0.1.24",
    })
  })

  test("never offers to update a development build", () => {
    expect(peerUpdateView(device({ app: reported({ status: "idle" }, "0.1.22", "unsupported") }), "0.1.23")).toEqual({ kind: "none" })
  })

  test("waits for approval on a computer whose install needs a password", () => {
    const app = reported({ status: "downloaded", version: "0.1.23" }, "0.1.22", "needs-approval")
    expect(peerUpdateView(device({ app }), "0.1.23")).toEqual({ kind: "needs-approval", version: "0.1.23" })
  })

  test("follows the computer's own progress while updating it", () => {
    expect(peerUpdateView(device({ app: reported({ status: "checking" }), appUpdate: { status: "updating" } }), "0.1.23"))
      .toEqual({ kind: "checking" })
    expect(peerUpdateView(device({
      app: reported({ status: "downloading", version: "0.1.23", progressPercent: 37 }),
      appUpdate: { status: "updating" },
    }), "0.1.23")).toEqual({ kind: "downloading", version: "0.1.23", percent: 37 })
    expect(peerUpdateView(device({ app: reported({ status: "downloaded", version: "0.1.23" }), appUpdate: { status: "restarting" } }), "0.1.23"))
      .toEqual({ kind: "restarting" })
  })

  test("offers a retry only while an update is still worth offering", () => {
    const appUpdate = { status: "failed", message: "Denied." } as const
    expect(peerUpdateView(device({ app: reported({ status: "idle" }), appUpdate }), "0.1.23"))
      .toEqual({ kind: "failed", message: "Denied.", canRetry: true })
    expect(peerUpdateView(device({ app: reported({ status: "not-available" }, "0.1.23"), appUpdate }), "0.1.23"))
      .toEqual({ kind: "failed", message: "Denied.", canRetry: false })
  })

  test("asks for a manual update of a computer too old to report its version", () => {
    const view = peerUpdateView(device({ app: { kind: "legacy" } }), "0.1.23")
    expect(view).toEqual({ kind: "legacy" })
    expect(peerNeedsUpdate(view)).toBe(true)
    expect(peerNeedsUpdate(peerUpdateView(device(), "0.1.23"))).toBe(false)
  })
})

describe("deviceVersionLabel", () => {
  test("names each computer's version, or why it is unknown", () => {
    expect(deviceVersionLabel(device({ status: "this-device" }), "0.1.23")).toBe("v0.1.23")
    expect(deviceVersionLabel(device({ app: reported({ status: "idle" }) }), "0.1.23")).toBe("v0.1.22")
    expect(deviceVersionLabel(device({ app: { kind: "legacy" } }), "0.1.23")).toBe("Older version")
    expect(deviceVersionLabel(device(), "0.1.23")).toBe("Not known yet")
  })
})

describe("PeerUpdatePanel", () => {
  const html = (summary: DeviceSummary) => renderToStaticMarkup(<PeerUpdatePanel device={summary} localVersion="0.1.23" />)

  test("offers the update with what happens next", () => {
    const markup = html(device({ app: reported({ status: "idle" }) }))
    expect(markup).toContain("Tommys-PC is on v0.1.22; this computer has v0.1.23.")
    expect(markup).toContain("restarts to finish")
    expect(markup).toMatch(/<button[^>]*>Update Tommys-PC<\/button>/)
    expect(markup).not.toMatch(/<button[^>]*\sdisabled=""/)
  })

  test("says a password is needed there for a Linux package install", () => {
    expect(html(device({ app: reported({ status: "idle" }, "0.1.22", "needs-approval") }))).toContain("asks for a password there")
  })

  test("disables the offer while the computer is offline", () => {
    const markup = html(device({ status: "offline", app: reported({ status: "idle" }) }))
    expect(markup).toMatch(/<button[^>]*\sdisabled=""/)
    expect(markup).toContain("Available when Tommys-PC is online.")
  })

  test("shows download progress as a progress bar", () => {
    const markup = html(device({
      app: reported({ status: "downloading", version: "0.1.23", progressPercent: 40 }),
      appUpdate: { status: "updating" },
    }))
    expect(markup).toContain('role="progressbar"')
    expect(markup).toContain('aria-valuenow="40"')
    expect(markup).toContain("Downloading v0.1.23 on Tommys-PC")
  })

  test("explains a failure and offers another attempt", () => {
    const markup = html(device({ app: reported({ status: "idle" }), appUpdate: { status: "failed", message: "It stopped before the update finished. Try again." } }))
    expect(markup).toContain("Couldn&#x27;t update Tommys-PC")
    expect(markup).toContain("It stopped before the update finished.")
    expect(markup).toMatch(/<button[^>]*>Try again<\/button>/)
  })

  test("renders nothing when the computer is current", () => {
    expect(html(device({ app: reported({ status: "not-available" }, "0.1.23") }))).toBe("")
  })
})
