import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { FolderWorkPanel } from "../src/renderer/components/folder-work-panel"
import { copyProgress, initialMergeSteps } from "../src/renderer/lib/folder-work"
import { FoldersView } from "../src/renderer/views/folders"
import type { FolderSummary, FolderWork, FolderWorkActivity } from "../src/shared/contracts"
import { appSnapshot } from "./helpers"

const MB = 1024 * 1024
const names = { thisComputer: "Office-PC", otherComputer: "Laptop" }

describe("initial merge steps", () => {
  test("orders the passes from this computer's point of view", () => {
    expect(initialMergeSteps({ step: 2, firstPassUpdates: "other-computer" }, names)).toEqual([
      { label: "Update Laptop", state: "done" },
      { label: "Update Office-PC", state: "active" },
      { label: "Verify both folders", state: "todo" },
    ])
  })
})

describe("copy progress", () => {
  const copying: Extract<FolderWorkActivity, { kind: "copying" }> = {
    kind: "copying",
    destination: "this-computer",
    path: "docs/report.pdf",
    completedFiles: 3,
    totalFiles: 10,
    transferredBytes: 50 * MB,
    totalBytes: 100 * MB,
    bytesPerSecond: 10 * MB,
  }

  test("reports bytes, file position and time left", () => {
    expect(copyProgress(copying)).toEqual({
      fraction: 0.5,
      readout: "10 MB/s · about 5s left",
      detail: "File 4 of 10 · 50 MB of 100 MB",
    })
  })

  test("falls back to the file fraction when there are no bytes to measure", () => {
    expect(copyProgress({ ...copying, transferredBytes: 0, totalBytes: 0, bytesPerSecond: 0 }).readout).toBe("30%")
  })
})

describe("folder work panel", () => {
  test("shows what each computer is scanning and the current merge step", () => {
    const work: FolderWork = {
      startedAt: new Date().toISOString(),
      initialMerge: { step: 1, firstPassUpdates: "this-computer" },
      activity: {
        kind: "scanning",
        purpose: "initial-merge",
        local: { stage: "hashing", currentPath: "photos/2024/beach.jpg", scannedFiles: 1204, ignoredEntries: 12, unreadableEntries: 2, hashedBytes: 0 },
      },
    }
    const html = renderToStaticMarkup(<FolderWorkPanel work={work} names={names} />)
    expect(html).toContain("Scanning both folders")
    expect(html).toContain("Reading file contents to compare")
    expect(html).toContain("1,204 files checked")
    expect(html).toContain("photos/2024/beach.jpg")
    expect(html).toContain("2 unreadable")
    expect(html).toContain("Live counts have not arrived yet")
    expect(html).toContain('aria-current="step"')
  })
})

describe("folder card", () => {
  test("keeps a failed merge visible as an error after the peer goes offline", () => {
    const folder: FolderSummary = {
      id: "test-folder", name: "coding", localPath: "/tmp/tethera-test/local", remotePath: "C:\\Tethera-test\\remote",
      remoteDeviceId: "test-peer", mode: "two-way", paused: false, status: "offline",
      setupStatus: "ready-for-initial-sync", ignorePatterns: [], currentAction: "Initial merge failed.",
      problem: { title: "Initial merge failed", detail: "EEXIST: file already exists", occurredAt: new Date().toISOString() },
    }
    const peer = { id: "test-peer", name: "Laptop", platform: "linux", status: "offline", route: "offline" } as const
    const html = renderToStaticMarkup(
      <FoldersView snapshot={appSnapshot({ devices: [peer], folders: [folder] })} onNavigate={() => undefined} />,
    )
    expect(html).toContain('role="alert"')
    expect(html).toContain("EEXIST: file already exists")
    expect(html).toContain("Laptop must be online before starting the initial merge.")
  })
})
