import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { FolderScanIssueReport } from "../src/shared/contracts"
import { ScanIssuesAlert, ScanIssuesDetail } from "../src/renderer/components/scan-issues-alert"

const report: FolderScanIssueReport = {
  local: [{ path: "locked", reason: "Permission denied", kind: "directory" }],
  remote: [{ path: "gone.txt", reason: "No longer exists", kind: "file" }],
  localCount: 1,
  remoteCount: 3,
}

describe("ScanIssuesAlert", () => {
  test("renders each inaccessible path, its reason and the true total", () => {
    const html = renderToStaticMarkup(
      <ScanIssuesAlert
        report={report}
        localName="Laptop"
        remoteName="Desktop"
        acknowledged={false}
        onAcknowledgedChange={() => undefined}
      />,
    )
    expect(html).toContain("4 items could not be read")
    expect(html).toContain("locked")
    expect(html).toContain("Permission denied")
    expect(html).toContain("gone.txt")
    expect(html).toContain("No longer exists")
    expect(html).toContain("Showing the first 1 of 3.")
    expect(html).toContain("Continue anyway and skip 4 items")
  })

  test("renders nothing when there is nothing to report", () => {
    expect(
      renderToStaticMarkup(
        <ScanIssuesAlert
          report={{ local: [], remote: [], localCount: 0, remoteCount: 0 }}
          localName="Laptop"
          remoteName="Desktop"
          acknowledged={false}
          onAcknowledgedChange={() => undefined}
        />,
      ),
    ).toBe("")
  })

  test("lists only the sides that reported an issue", () => {
    const html = renderToStaticMarkup(
      <ScanIssuesDetail
        report={{ local: report.local, remote: [], localCount: 1, remoteCount: 0 }}
        localName="Laptop"
        remoteName="Desktop"
      />,
    )
    expect(html).toContain("On Laptop")
    expect(html).not.toContain("On Desktop")
    expect(html).toContain("Permission denied")
  })
})
