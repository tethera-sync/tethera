import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { SidebarUpdatePill } from "../src/renderer/components/sidebar-update-pill"

describe("SidebarUpdatePill", () => {
  test("idle renders a tooltip icon button that checks on click", () => {
    const html = renderToStaticMarkup(<SidebarUpdatePill update={{ status: "idle", currentVersion: "0.1.1" }} />)
    expect(html).toContain("<button")
    expect(html).toContain('aria-label="Check for updates"')
    expect(html).toContain("Check for updates.")
    expect(html).not.toContain("Check again")
  })

  test("checking renders a spinning status with no action", () => {
    const html = renderToStaticMarkup(<SidebarUpdatePill update={{ status: "checking" }} />)
    expect(html).toContain('role="status"')
    expect(html).toContain("animate-spin")
    expect(html).not.toContain("<button")
  })

  test("up-to-date stays icon-and-tooltip only with a recheck action", () => {
    const html = renderToStaticMarkup(
      <SidebarUpdatePill
        update={{ status: "not-available", currentVersion: "0.1.1", lastCheckedAt: "2026-09-05T12:00:00Z" }}
      />,
    )
    expect(html).toContain("up to date")
    expect(html).toContain("Click to check again.")
    expect(html).not.toContain("Check again</")
  })

  test("available offers an explicit download with dismiss", () => {
    const html = renderToStaticMarkup(
      <SidebarUpdatePill
        update={{ status: "available", version: "0.2.0", releaseNotes: "Faster startup", currentVersion: "0.1.1" }}
      />,
    )
    expect(html).toContain("Update v0.2.0")
    expect(html).toContain("Download Tethera version 0.2.0")
    expect(html).toContain("Remind me later")
  })

  test("exposes download progress as a labelled progressbar", () => {
    const html = renderToStaticMarkup(
      <SidebarUpdatePill
        update={{
          status: "downloading",
          version: "0.2.0",
          progressPercent: 42,
          transferredBytes: 1024,
          totalBytes: 2048,
        }}
      />,
    )
    expect(html).toContain('role="progressbar"')
    expect(html).toContain('aria-valuenow="42"')
    expect(html).toContain("Downloading 42%")
  })

  test("gates installs behind an explicit restart action", () => {
    const html = renderToStaticMarkup(<SidebarUpdatePill update={{ status: "downloaded", version: "0.2.0" }} />)
    expect(html).toContain("Restart to update")
    expect(html).toContain("Restart and install Tethera version 0.2.0")
    expect(html).toContain("On next launch")
  })

  test("surfaces failures as alerts with retry", () => {
    const html = renderToStaticMarkup(<SidebarUpdatePill update={{ status: "error", message: "No network." }} />)
    expect(html).toContain('role="alert"')
    expect(html).toContain("No network.")
    expect(html).toContain("Retry update check")
  })
})
