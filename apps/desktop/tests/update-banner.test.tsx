import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { UpdateBanner } from "../src/renderer/components/update-banner"

describe("UpdateBanner", () => {
  test("stays quiet when idle", () => {
    expect(renderToStaticMarkup(<UpdateBanner update={{ status: "idle", currentVersion: "0.1.1" }} />)).toBe("")
  })

  test("announces checks politely without actions", () => {
    const html = renderToStaticMarkup(<UpdateBanner update={{ status: "checking" }} />)
    expect(html).toContain('role="status"')
    expect(html).toContain("Checking for updates")
  })

  test("confirms up-to-date builds with a recheck action", () => {
    const html = renderToStaticMarkup(
      <UpdateBanner
        update={{ status: "not-available", currentVersion: "0.1.1", lastCheckedAt: "2026-09-05T12:00:00Z" }}
      />,
    )
    expect(html).toContain("re up to date")
    expect(html).toContain("Check again")
  })

  test("offers an explicit download with release notes", () => {
    const html = renderToStaticMarkup(
      <UpdateBanner
        update={{ status: "available", version: "0.2.0", releaseNotes: "Faster startup", currentVersion: "0.1.1" }}
      />,
    )
    expect(html).toContain("v0.2.0 is available")
    expect(html).toContain("Download")
    expect(html).toContain("s new")
    expect(html).toContain("Later")
  })

  test("exposes download progress as a labelled progressbar", () => {
    const html = renderToStaticMarkup(
      <UpdateBanner
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
    expect(html).toContain("42%")
  })

  test("gates installs behind an explicit restart action", () => {
    const html = renderToStaticMarkup(<UpdateBanner update={{ status: "downloaded", version: "0.2.0" }} />)
    expect(html).toContain("ready to install")
    expect(html).toContain("Restart &amp; update")
    expect(html).toContain("On next launch")
  })

  test("surfaces failures as alerts with retry", () => {
    const html = renderToStaticMarkup(<UpdateBanner update={{ status: "error", message: "No network." }} />)
    expect(html).toContain('role="alert"')
    expect(html).toContain("No network.")
    expect(html).toContain("Retry")
  })
})
