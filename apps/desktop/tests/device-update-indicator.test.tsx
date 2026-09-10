import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { UpdateState } from "../src/shared/contracts"
import {
  DeviceUpdateIndicator,
  invokeSidebarUpdateAction,
  quietCopy,
} from "../src/renderer/components/device-update-indicator"
import { TooltipProvider } from "../src/renderer/components/ui/tooltip"

/** Renders the indicator inside the Radix TooltipProvider it requires. */
function indicatorHtml(update: UpdateState): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <DeviceUpdateIndicator update={update} />
    </TooltipProvider>,
  )
}

describe("DeviceUpdateIndicator", () => {
  test("idle renders a tooltip icon button that checks on click", () => {
    const html = indicatorHtml({ status: "idle", currentVersion: "0.1.1" })
    expect(html).toContain("<button")
    expect(html).toContain('aria-label="Check for updates"')
    // Detail copy lives in the shadcn Tooltip, not a native title.
    expect(html).not.toContain("title=")
    expect(html).not.toContain("Check again")
  })

  test("checking renders a spinning status with no action", () => {
    const html = indicatorHtml({ status: "checking" })
    expect(html).toContain('role="status"')
    expect(html).toContain("animate-spin")
    expect(html).not.toContain("<button")
  })

  test("up-to-date stays an icon with a recheck action", () => {
    const html = indicatorHtml({
      status: "not-available",
      currentVersion: "0.1.1",
      lastCheckedAt: "2026-09-05T12:00:00Z",
    })
    expect(html).toContain("up to date")
    expect(html).not.toContain("title=")
    expect(html).not.toContain("Check again</")
  })

  test("available offers an explicit download action", () => {
    const html = indicatorHtml({
      status: "available",
      version: "0.2.0",
      releaseNotes: "Faster startup",
      currentVersion: "0.1.1",
    })
    expect(html).toContain("Download Tethera version 0.2.0")
    expect(html).not.toContain("title=")
  })

  test("downloading stays a status with the percent in its label", () => {
    const html = indicatorHtml({
      status: "downloading",
      version: "0.2.0",
      progressPercent: 42,
      transferredBytes: 1024,
      totalBytes: 2048,
    })
    expect(html).toContain('role="status"')
    expect(html).toContain("42")
    expect(html).not.toContain("<button")
  })

  test("gates installs behind an explicit restart action", () => {
    const html = indicatorHtml({ status: "downloaded", version: "0.2.0" })
    expect(html).toContain("Restart and install Tethera version 0.2.0")
  })

  test("surfaces failures with retry", () => {
    const html = indicatorHtml({ status: "error", message: "No network." })
    expect(html).toContain("No network.")
    expect(html).toContain("Retry update check")
    expect(html).not.toContain("title=")
  })

  test("exposes the failure message outside any tooltip", () => {
    const html = indicatorHtml({ status: "error", message: "No network." })
    expect(html).toContain("aria-describedby=")
    expect(html).toContain("sr-only")
    expect(html).toContain("No network.")
    // The accessible name carries the failure so AT users hear the cause.
    expect(html).toContain("Update failed: No network.")
  })

  test("action buttons start enabled and disable only while working", () => {
    const available = indicatorHtml({ status: "available", version: "0.2.0" })
    // working is null on first render, so no disabled attribute yet. While an
    // action is pending the component sets working and disables the button.
    expect(available).not.toContain("disabled=")
    const failed = indicatorHtml({ status: "error", message: "No network." })
    expect(failed).not.toContain("disabled=")
  })
})

describe("quietCopy", () => {
  test("carries the tooltip detail previously in native titles", () => {
    expect(quietCopy({ status: "idle", currentVersion: "0.1.1" }).title).toContain("Check for updates.")
    expect(quietCopy({ status: "checking" }).title).toContain("Comparing your build")
    expect(
      quietCopy({
        status: "not-available",
        currentVersion: "0.1.1",
        lastCheckedAt: "2026-09-05T12:00:00Z",
      }).title,
    ).toContain("Click to check again.")
  })
})

describe("invokeSidebarUpdateAction", () => {
  function stubApi(overrides: {
    checkForUpdates?: () => Promise<void>
    downloadUpdate?: () => Promise<void>
    quitAndInstall?: () => Promise<void>
  } = {}) {
    const seen: string[] = []
    return {
      seen,
      api: {
        checkForUpdates: overrides.checkForUpdates ?? (async () => { seen.push("check") }),
        downloadUpdate: overrides.downloadUpdate ?? (async () => { seen.push("download") }),
        quitAndInstall: overrides.quitAndInstall ?? (async () => { seen.push("install") }),
      },
    }
  }

  test("routes check, download, and install to the matching bridge call", async () => {
    const check = stubApi()
    expect(await invokeSidebarUpdateAction("check", check.api)).toBeNull()
    expect(check.seen).toEqual(["check"])

    const download = stubApi()
    expect(await invokeSidebarUpdateAction("download", download.api)).toBeNull()
    expect(download.seen).toEqual(["download"])

    const install = stubApi()
    expect(await invokeSidebarUpdateAction("install", install.api)).toBeNull()
    expect(install.seen).toEqual(["install"])
  })

  test("returns the rejection message so the indicator can surface retry state", async () => {
    const failing = stubApi({
      checkForUpdates: async () => {
        throw new Error("No network.")
      },
    })
    expect(await invokeSidebarUpdateAction("check", failing.api)).toBe("No network.")
  })

  test("falls back for non-Error or empty rejections", async () => {
    const nonError = stubApi({
      downloadUpdate: async () => {
        throw "boom"
      },
    })
    expect(await invokeSidebarUpdateAction("download", nonError.api)).toBe(
      "That didn't work. Try again shortly.",
    )

    const empty = stubApi({
      quitAndInstall: async () => {
        throw new Error("")
      },
    })
    expect(await invokeSidebarUpdateAction("install", empty.api)).toBe("That didn't work. Try again shortly.")
  })
})
