import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { AppSnapshot, ArchiveHistory, ArchivedVersion, TetheraApi } from "../src/shared/contracts"
import {
  ArchiveHistoryContent,
  ArchiveHistoryView,
  ArchiveMessage,
  ArchiveVersionRow,
  loadArchiveHistory,
  submitVersionRestore,
  type ArchiveHistoryRequestState,
} from "../src/renderer/components/archive-history-view"
import { appSnapshot } from "./helpers"

function activeFolder(id: string, name: string): AppSnapshot["folders"][number] {
  return {
    id,
    name,
    localPath: `/local/${name.toLowerCase()}`,
    remotePath: `C:\\${name}`,
    status: "up-to-date",
    setupStatus: "active",
    mode: "two-way",
    paused: false,
    ignorePatterns: [],
  }
}

function archivedVersion(overrides: Partial<ArchivedVersion> = {}): ArchivedVersion {
  return {
    entryId: "version-1",
    path: "notes/todo.txt",
    archivedAt: "2026-09-07T08:00:00.000Z",
    replacedSize: 2048,
    replacementSize: 1024,
    origin: "sync",
    availability: "available",
    restorable: true,
    ...overrides,
  }
}

function readyRequest({
  versions,
  truncated = false,
  refreshError,
}: {
  versions: ArchivedVersion[]
  truncated?: boolean
  refreshError?: string
}): ArchiveHistoryRequestState {
  const request: ArchiveHistoryRequestState = {
    status: "ready",
    data: {
      mappingId: "folder-1",
      folderName: "Documents",
      versions,
      truncated,
    },
  }

  if (refreshError) {
    request.refreshError = refreshError
  }

  return request
}

describe("ArchiveHistoryView", () => {
  test("renders a loading state", () => {
    const html = renderToStaticMarkup(
      <ArchiveHistoryContent request={{ status: "loading" }} onRetry={() => undefined} onSelectVersion={() => undefined} />,
    )

    expect(html).toContain('role="status"')
    expect(html).toContain("Loading archived versions")
  })

  test("renders an error state with retry", () => {
    const html = renderToStaticMarkup(
      <ArchiveHistoryContent
        request={{ status: "error", message: "The archive index is unavailable." }}
        onRetry={() => undefined}
        onSelectVersion={() => undefined}
      />,
    )

    expect(html).toContain('role="alert"')
    expect(html).toContain("Archive history unavailable")
    expect(html).toContain("The archive index is unavailable.")
    expect(html).toContain("Try again")
  })

  test("renders the empty state when the folder has no archived versions yet", () => {
    const html = renderToStaticMarkup(
      <ArchiveHistoryContent
        request={readyRequest({ versions: [] })}
        onRetry={() => undefined}
        onSelectVersion={() => undefined}
      />,
    )

    expect(html).toContain("No archived versions yet")
    expect(html).toContain("has not produced any archived versions")
    expect(html).toContain("Refresh")
  })

  test("renders the no active folders state from the container", () => {
    const html = renderToStaticMarkup(<ArchiveHistoryView snapshot={appSnapshot()} />)

    expect(html).toContain("No active folders")
    expect(html).toContain("Activate a folder first")
  })

  test("renders version history details with human-readable origin wording", () => {
    const html = renderToStaticMarkup(
      <ArchiveHistoryContent
        request={readyRequest({
          versions: [
            archivedVersion({
              entryId: "version-1",
              path: "notes/todo.txt",
              replacedSize: 2048,
              origin: "sync",
            }),
            archivedVersion({
              entryId: "version-2",
              path: "reports/q3.md",
              replacedSize: 1024,
              origin: "restore",
            }),
          ],
        })}
        onRetry={() => undefined}
        onSelectVersion={() => undefined}
      />,
    )

    expect(html).toContain("notes/todo.txt")
    expect(html).toContain("reports/q3.md")
    expect(html).toContain("2.0 KB")
    expect(html).toContain("1.0 KB")
    expect(html).toContain("Replaced by sync")
    expect(html).toContain("Replaced by a restore")
  })

  test("renders a disabled restore control with its reason when a version is not restorable", () => {
    const html = renderToStaticMarkup(
      <ArchiveVersionRow
        version={archivedVersion({
          availability: "missing",
          restorable: false,
          unavailableReason: "This content is missing from the archive store.",
        })}
        selected={false}
        onRestore={() => undefined}
      />,
    )

    expect(html).toContain('disabled=""')
    expect(html).toContain("This content is missing from the archive store.")
  })

  test("renders an enabled restore control for a restorable version", () => {
    const html = renderToStaticMarkup(
      <ArchiveVersionRow
        version={archivedVersion({ restorable: true })}
        selected={false}
        onRestore={() => undefined}
      />,
    )

    expect(html).toContain("Restore")
    expect(html).not.toContain('disabled=""')
  })

  test("renders the truncated notice only when the request is truncated", () => {
    const truncatedHtml = renderToStaticMarkup(
      <ArchiveHistoryContent
        request={readyRequest({
          versions: [archivedVersion()],
          truncated: true,
        })}
        onRetry={() => undefined}
        onSelectVersion={() => undefined}
      />,
    )
    const completeHtml = renderToStaticMarkup(
      <ArchiveHistoryContent
        request={readyRequest({
          versions: [archivedVersion()],
          truncated: false,
        })}
        onRetry={() => undefined}
        onSelectVersion={() => undefined}
      />,
    )

    expect(truncatedHtml).toContain("Recent versions only")
    expect(truncatedHtml).toContain("Only the most recent archived versions are shown here.")
    expect(completeHtml).not.toContain("Recent versions only")
  })

  test("renders the archive message component with an alert tone", () => {
    const html = renderToStaticMarkup(
      <ArchiveMessage
        announcement="alert"
        tone="danger"
        icon={<span aria-hidden="true">!</span>}
        title="Archive history unavailable"
        detail="The archive index is unavailable."
        action={<button type="button">Try again</button>}
      />,
    )

    expect(html).toContain('role="alert"')
    expect(html).toContain("Archive history unavailable")
    expect(html).toContain("Try again")
  })

  test("offers each active folder for history browsing from the container", () => {
    const html = renderToStaticMarkup(
      <ArchiveHistoryView
        snapshot={appSnapshot({ folders: [activeFolder("folder-1", "Documents"), activeFolder("folder-2", "Photos")] })}
      />,
    )

    expect(html).toContain("Documents")
    expect(html).toContain("Photos")
    expect(html).toContain("Loading archived versions")
  })

  test("submitVersionRestore reports success and failure directly", async () => {
    const restored = await submitVersionRestore(async (entryId) => {
      expect(entryId).toBe("version-1")
      return undefined
    }, "version-1")

    const failed = await submitVersionRestore(async () => {
      throw new Error("Restore failed.")
    }, "version-2")

    expect(restored).toEqual({ status: "restored" })
    expect(failed).toEqual({ status: "failed", message: "Restore failed." })
  })

  test("submitVersionRestore invokes restore exactly once with the selected archive", async () => {
    const seen: string[] = []
    const outcome = await submitVersionRestore(async (entryId) => {
      seen.push(entryId)
      return undefined
    }, "version-9")

    expect(outcome).toEqual({ status: "restored" })
    expect(seen).toEqual(["version-9"])
  })
})

describe("loadArchiveHistory", () => {
  type FolderSyncMock = Pick<TetheraApi, "listArchivedVersions" | "restoreArchivedVersion">

  function history(mappingId: string): ArchiveHistory {
    return { mappingId, folderName: "Documents", versions: [], truncated: false }
  }

  function deferred<T>(): {
    promise: Promise<T>
    resolve: (value: T) => void
    reject: (error: unknown) => void
  } {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }

  test("passes the selected folder id to listArchivedVersions", async () => {
    const seen: string[] = []
    const folderSync: FolderSyncMock = {
      listArchivedVersions: async (mappingId) => {
        seen.push(mappingId)
        return history(mappingId)
      },
      restoreArchivedVersion: async () => appSnapshot(),
    }

    const outcome = await loadArchiveHistory("folder-2", () => true, folderSync.listArchivedVersions)

    expect(seen).toEqual(["folder-2"])
    expect(outcome).toEqual({ status: "ready", data: history("folder-2") })
  })

  test("ignores a stale archive result when the selection changes first", async () => {
    const gate = deferred<ArchiveHistory>()
    let current = true
    const pending = loadArchiveHistory("folder-1", () => current, () => gate.promise)

    current = false
    gate.resolve(history("folder-1"))

    expect(await pending).toBeUndefined()
  })

  test("ignores a stale archive failure when the selection changes first", async () => {
    const gate = deferred<ArchiveHistory>()
    let current = true
    const pending = loadArchiveHistory("folder-1", () => current, () => gate.promise)

    current = false
    gate.reject(new Error("Archive history could not be loaded."))

    expect(await pending).toBeUndefined()
  })

  test("reports a current load failure without throwing", async () => {
    const outcome = await loadArchiveHistory("folder-1", () => true, async () => {
      throw new Error("The archive index is unavailable.")
    })

    expect(outcome).toEqual({ status: "error", message: "The archive index is unavailable." })
  })
})
