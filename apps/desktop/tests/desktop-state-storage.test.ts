import { describe, expect, test } from "bun:test"
import {
  buildPersistedDesktopState,
  DesktopStateStore,
} from "../src/main/desktop-state-storage"
import type { PersistedDesktopProjection } from "../src/main/desktop-state-storage"

function projection(theme: "system" | "dark" = "system"): PersistedDesktopProjection {
  return {
    paused: false,
    mappings: { incoming: [], outgoing: [] },
    activity: [],
    settings: {
      closeToTray: true,
      launchAtLogin: false,
      startMinimised: false,
      pauseOnMetered: true,
      theme,
      maxScanFiles: 10_000,
    },
  }
}

describe("desktop state persistence", () => {
  test("retains legacy folders during unrelated writes until mapping retirement commits", () => {
    const legacyFolders = [{ id: "mapping-1", localPath: "/opaque/local", remotePath: "C:\\opaque\\remote" }]
    const beforeImport = buildPersistedDesktopState(
      { folders: legacyFolders, unrelatedPreference: { compact: true } },
      projection("dark"),
      false,
    )
    expect(beforeImport.folders).toEqual(legacyFolders)
    expect(beforeImport).toHaveProperty("unrelatedPreference")
    expect((beforeImport.settings as { theme: string }).theme).toBe("dark")

    const afterImport = buildPersistedDesktopState(beforeImport, projection("dark"), true)
    expect(afterImport.folders).toBeUndefined()
  })

  test("persists structured initial-merge conflicts independently of mapping ownership", () => {
    const state = buildPersistedDesktopState(
      {},
      {
        ...projection(),
        initialSyncOutcomes: {
          "folder-1": {
            completedAt: "2026-08-08T10:00:00.000Z",
            copiedFiles: 2,
            fileCount: 4,
            conflicts: [{ path: "notes.txt", reason: "Different content was left untouched." }],
          },
        },
      },
      true,
    )
    expect(state.initialSyncOutcomes).toEqual({
      "folder-1": {
        completedAt: "2026-08-08T10:00:00.000Z",
        copiedFiles: 2,
        fileCount: 4,
        conflicts: [{ path: "notes.txt", reason: "Different content was left untouched." }],
      },
    })
  })

  test("serializes concurrent writes and builds each document from the last commit", async () => {
    const writes: Record<string, unknown>[] = []
    let releaseFirst: (() => void) | undefined
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const store = new DesktopStateStore("state.json", { revision: 0 }, true, async (_path, document) => {
      if (writes.length === 0) await firstBlocked
      writes.push(document)
    })

    const first = store.update((current) => ({ ...current, revision: 1, first: true }))
    const second = store.update((current) => ({ ...current, revision: 2, second: true }))
    releaseFirst?.()
    await Promise.all([first, second])

    expect(writes).toEqual([
      { revision: 1, first: true },
      { revision: 2, first: true, second: true },
    ])
    expect(store.document).toEqual({ revision: 2, first: true, second: true })
  })

  test("a failed write does not advance state and does not poison the queue", async () => {
    let attempts = 0
    const store = new DesktopStateStore("state.json", { safe: true }, true, async () => {
      attempts += 1
      if (attempts === 1) throw new Error("disk unavailable")
    })
    await expect(store.update((current) => ({ ...current, lost: true }))).rejects.toThrow("disk unavailable")
    expect(store.document).toEqual({ safe: true })
    await store.update((current) => ({ ...current, recovered: true }))
    expect(store.document).toEqual({ safe: true, recovered: true })
  })
})
