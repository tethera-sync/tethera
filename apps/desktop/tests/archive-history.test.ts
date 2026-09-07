import { expect, test } from "bun:test"
import { archiveObjectKey } from "../src/main/version-archive"
import { ARCHIVE_HISTORY_LIMIT, listArchivedVersions, type ArchiveHistoryRpc } from "../src/main/archive-history"
import { sha256Hex as digest } from "./helpers"

interface RawArchiveEntry {
  id: string
  mappingId: string
  path: string
  kind: "sync" | "restore"
  syncOperationId?: number | null
  oldDigest?: string | null
  oldSize?: number | null
  replacementDigest: string
  replacementSize: number
  archiveDigest?: string | null
  archiveObjectKey?: string | null
  restoredFromJournalId?: string | null
  state: "planned" | "archived" | "installed" | "completed" | "aborted" | "recovery-required" | "integrity-failed"
  createdAt: string
  updatedAt: string
  completedAt?: string | null
  lastError?: string | null
  localRoot: string
  archiveState?: "available" | "missing" | "corrupt" | null
  archiveVerifiedAt?: string | null
  archiveError?: string | null
}

function makeEntry(overrides: Partial<RawArchiveEntry> = {}): RawArchiveEntry {
  const baseDigest = digest(`${overrides.id ?? "entry"}-digest`)
  const replacementDigest = digest(`${overrides.id ?? "entry"}-replacement`)
  const now = new Date("2026-09-07T12:00:00.000Z").toISOString()
  return {
    id: "entry",
    mappingId: "mapping-1",
    path: "notes/todo.txt",
    kind: "sync",
    oldDigest: baseDigest,
    oldSize: 12,
    replacementDigest,
    replacementSize: 20,
    archiveDigest: baseDigest,
    archiveObjectKey: archiveObjectKey(baseDigest),
    state: "completed",
    createdAt: now,
    updatedAt: now,
    localRoot: "/tmp/tethera",
    archiveState: "available",
    ...overrides,
  }
}

function rpcWithResponse(response: unknown, requests: Array<{ method: string; params?: unknown }>): ArchiveHistoryRpc {
  return {
    request: async (method: string, params?: unknown) => {
      requests.push({ method, params })
      return response
    },
  }
}

test("maps engine entries to archive history without leaking internal archive details", async () => {
  const archivedDigest = digest("archived-content")
  const archiveKey = archiveObjectKey(archivedDigest)
  const localRoot = "/var/lib/tethera/folder-1"
  const requests: Array<{ method: string; params?: unknown }> = []
  const result = await listArchivedVersions(
    rpcWithResponse(
      [
        {
          id: "newest",
          mappingId: "mapping-1",
          path: "notes/newest.txt",
          kind: "restore",
          oldDigest: archivedDigest,
          oldSize: 9,
          replacementDigest: digest("replacement-newest"),
          replacementSize: 15,
          archiveDigest: archivedDigest,
          archiveObjectKey: archiveKey,
          restoredFromJournalId: "journal-1",
          state: "completed",
          createdAt: "2026-09-07T11:59:00.000Z",
          updatedAt: "2026-09-07T11:59:01.000Z",
          completedAt: "2026-09-07T11:59:02.000Z",
          localRoot,
          archiveState: "available",
        },
        {
          id: "older",
          mappingId: "mapping-1",
          path: "notes/older.txt",
          kind: "sync",
          oldDigest: archivedDigest,
          oldSize: 7,
          replacementDigest: digest("replacement-older"),
          replacementSize: 11,
          archiveDigest: archivedDigest,
          archiveObjectKey: archiveKey,
          state: "completed",
          createdAt: "2026-09-07T11:58:00.000Z",
          updatedAt: "2026-09-07T11:58:01.000Z",
          localRoot,
        },
      ],
      requests,
    ),
    "mapping-1",
    "History",
  )

  expect(requests).toEqual([
    {
      method: "archive.listVersions",
      params: { id: "mapping-1", limit: ARCHIVE_HISTORY_LIMIT + 1 },
    },
  ])
  expect(result.mappingId).toBe("mapping-1")
  expect(result.folderName).toBe("History")
  expect(result.truncated).toBe(false)
  expect(result.versions.map((version) => version.entryId)).toEqual(["newest", "older"])
  expect(result.versions[0]).toEqual({
    entryId: "newest",
    path: "notes/newest.txt",
    archivedAt: "2026-09-07T11:59:00.000Z",
    replacedSize: 9,
    replacementSize: 15,
    origin: "restore",
    availability: "available",
    restorable: true,
  })
  expect(result.versions[1]).toEqual({
    entryId: "older",
    path: "notes/older.txt",
    archivedAt: "2026-09-07T11:58:00.000Z",
    replacedSize: 7,
    replacementSize: 11,
    origin: "sync",
    availability: "missing",
    restorable: false,
    unavailableReason: "The archived content is missing.",
  })

  const serialized = JSON.stringify(result)
  expect(serialized.includes(localRoot)).toBe(false)
  expect(serialized.includes(archiveKey)).toBe(false)
  expect(serialized.includes(archivedDigest)).toBe(false)
})

test("marks truncated history when the engine returns more than the effective limit", async () => {
  const requests: Array<{ method: string; params?: unknown }> = []
  const response = Array.from({ length: 4 }, (_, index) =>
    makeEntry({
      id: `entry-${index}`,
      path: `notes/${index}.txt`,
      createdAt: `2026-09-07T11:5${index}:00.000Z`,
      updatedAt: `2026-09-07T11:5${index}:01.000Z`,
      replacementDigest: digest(`replacement-${index}`),
      oldDigest: digest(`old-${index}`),
      archiveDigest: digest(`old-${index}`),
      archiveObjectKey: archiveObjectKey(digest(`old-${index}`)),
    }),
  )
  const result = await listArchivedVersions(rpcWithResponse(response, requests), "mapping-1", "History", 3)
  expect(requests[0]).toEqual({ method: "archive.listVersions", params: { id: "mapping-1", limit: 4 } })
  expect(result.truncated).toBe(true)
  expect(result.versions).toHaveLength(3)
  expect(result.versions.map((version) => version.entryId)).toEqual(["entry-0", "entry-1", "entry-2"])
})

test("does not mark history truncated when the engine returns fewer rows than requested", async () => {
  const response = [makeEntry({ id: "entry-0" }), makeEntry({ id: "entry-1", path: "notes/1.txt" })]
  const result = await listArchivedVersions(rpcWithResponse(response, []), "mapping-1", "History", 5)
  expect(result.truncated).toBe(false)
  expect(result.versions).toHaveLength(2)
})

test("marks unavailable archive objects as missing and non-restorable", async () => {
  const result = await listArchivedVersions(
    rpcWithResponse(
      [
        makeEntry({
          id: "entry-0",
          archiveState: undefined,
          state: "completed",
          path: "notes/missing.txt",
        }),
      ],
      [],
    ),
    "mapping-1",
    "History",
  )

  expect(result.versions[0]).toMatchObject({
    availability: "missing",
    restorable: false,
    unavailableReason: "The archived content is missing.",
  })
})

test("marks available entries that are still recovering as non-restorable", async () => {
  const archivedDigest = digest("recovering")
  const result = await listArchivedVersions(
    rpcWithResponse(
      [
        makeEntry({
          id: "entry-0",
          path: "notes/recovering.txt",
          oldDigest: archivedDigest,
          archiveDigest: archivedDigest,
          archiveObjectKey: archiveObjectKey(archivedDigest),
          archiveState: "available",
          state: "recovery-required",
        }),
      ],
      [],
    ),
    "mapping-1",
    "History",
  )

  expect(result.versions[0].restorable).toBe(false)
  expect(result.versions[0].unavailableReason).toBe(
    "This replacement needs recovery before its archived version can be restored.",
  )

  const inProgress = await listArchivedVersions(
    rpcWithResponse(
      [
        makeEntry({
          id: "entry-1",
          path: "notes/in-progress.txt",
          archiveState: "available",
          state: "installed",
        }),
      ],
      [],
    ),
    "mapping-1",
    "History",
  )

  expect(inProgress.versions[0].unavailableReason).toBe("This replacement is still in progress.")
})

test("rejects malformed engine responses instead of returning an empty history", async () => {
  await expect(listArchivedVersions(rpcWithResponse({ not: "an array" }, []), "mapping-1", "History")).rejects.toThrow(
    /The archive version history could not be read/,
  )
  await expect(
    listArchivedVersions(
      rpcWithResponse(
        [
          {
            ...makeEntry({ id: "entry-0" }),
            replacementSize: "bad",
          },
        ],
        [],
      ),
      "mapping-1",
      "History",
    ),
  ).rejects.toThrow(/The archive version history could not be read/)
})

test("reports the malformed field path without leaking payload values", async () => {
  const localRoot = "/Users/alice/tethera"
  const archiveKey = "archive-object-secret-key"
  let error: unknown = undefined
  try {
    await listArchivedVersions(
      rpcWithResponse(
        [
          {
            ...makeEntry({
              id: "entry-0",
              localRoot,
              archiveObjectKey: archiveKey,
            }),
            replacementSize: "bad",
          },
        ],
        [],
      ),
      "mapping-1",
      "History",
    )
  } catch (caught) {
    error = caught
  }

  expect(error).toBeInstanceOf(Error)
  if (!(error instanceof Error)) throw error
  expect(error.message).toContain('versions.0.replacementSize')
  expect(error.message).toContain('invalid_type')
  expect(error.message).not.toContain(localRoot)
  expect(error.message).not.toContain(archiveKey)
})

test("skips entries that have no archived previous content", async () => {
  const result = await listArchivedVersions(
    rpcWithResponse(
      [
        makeEntry({
          id: "skipped",
          oldSize: null,
          path: "notes/skipped.txt",
        }),
        makeEntry({
          id: "kept",
          oldSize: 14,
          path: "notes/kept.txt",
        }),
      ],
      [],
    ),
    "mapping-1",
    "History",
  )

  expect(result.versions).toHaveLength(1)
  expect(result.versions[0].entryId).toBe("kept")
})
