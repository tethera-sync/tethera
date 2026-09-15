import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { FoldersView } from "../src/renderer/views/folders"
import type { FolderSummary } from "../src/shared/contracts"
import { appSnapshot } from "./helpers"

const folder: FolderSummary = {
  id: "test-folder", name: "Documents", localPath: "/tmp/tethera-test/local",
  remotePath: "C:\\Tethera-test\\remote", remoteDeviceId: "test-peer",
  mode: "two-way", paused: false, status: "up-to-date", setupStatus: "active", ignorePatterns: [],
}
const peer = { id: "test-peer", name: "Other computer", platform: "windows", status: "online", route: "lan-direct" } as const

function render(snapshot = appSnapshot()) {
  return renderToStaticMarkup(<FoldersView snapshot={snapshot} onNavigate={() => undefined} />)
}

describe("folders view", () => {
  test("explains an unavailable mapping store instead of rendering nothing", () => {
    const html = render(appSnapshot({
      mappingStore: { status: "unavailable", detail: "The database is locked.", mutationsEnabled: false, pendingDeliveryCount: 0 },
    }))
    expect(html).toContain("Folder mappings are unavailable")
    expect(html).toContain("The database is locked.")
    expect(html).toContain("Open Settings")
  })

  test("shows limited live updates only while the watcher is degraded", () => {
    const degraded = appSnapshot({
      devices: [peer],
      folders: [{ ...folder, watchDegraded: { message: "The operating system would not let Tethera watch every folder." } }],
    })
    expect(render(degraded)).toContain("Live updates are limited")
    expect(render(appSnapshot({ devices: [peer], folders: [folder] }))).not.toContain("Live updates are limited")
  })

  test("a sync problem takes precedence over the watch notice", () => {
    const snapshot = appSnapshot({
      devices: [peer],
      folders: [{
        ...folder,
        problem: { title: "Sync interrupted", detail: "The paired computer is offline.", occurredAt: new Date().toISOString() },
        watchDegraded: { message: "The operating system would not let Tethera watch every folder." },
      }],
    })
    const html = render(snapshot)
    expect(html).toContain("Sync interrupted")
    expect(html).not.toContain("Live updates are limited")
  })
})
