import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { EngineRpcError } from "../src/main/engine-supervisor"
import { buildPersistedDesktopState, DesktopStateStore } from "../src/main/desktop-state-storage"
import {
  buildLegacyImportBundle,
  ensureLegacyBackup,
  fingerprintLegacyPayload,
  LegacyMappingValidationError,
  readLegacyState,
  retireLegacyMappingFields,
  type LegacyStateSource,
} from "../src/main/legacy-mapping-migration"
import { initializeMappingAuthority } from "../src/main/mapping-authority"
import type {
  LegacyImportOutcome,
  LegacyImportRequest,
  LegacyMigrationStatus,
  MappingRecord,
} from "../src/main/mapping-index"

const NOW = "2026-08-02T12:00:00.000Z"

function legacyDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    settings: { theme: "dark", closeToTray: false },
    unrelatedPluginPreference: { compact: true },
    folders: [
      {
        id: "mapping-1",
        name: "Projects",
        localPath: "/home/tommy/Projects",
        remotePath: "C:\\Users\\tommy\\Projects",
        remoteDeviceId: "win-box",
        status: "offline",
        setupStatus: "active",
        mode: "two-way",
        paused: true,
        ignorePatterns: ["node_modules/"],
        historyDays: 45,
        historyMaxBytes: 7_000_000_000,
        createdAt: "2026-07-01T00:00:00Z",
        updatedAt: "2026-07-02T00:00:00Z",
      },
    ],
    mappings: { incoming: [], outgoing: [] },
    ...overrides,
  }
}

function readable(document = legacyDocument()): Exclude<LegacyStateSource, { kind: "unreadable" }> {
  return { kind: "readable", document, modifiedAt: "2026-07-03T00:00:00.000Z" }
}

function bundle(source = readable()) {
  return buildLegacyImportBundle(source, {
    localDeviceId: "linux-box",
    localDeviceName: "Linux Mint",
    importedAt: NOW,
    remoteDeviceName: () => "Windows 11",
  })
}

class FakeMappingRpc {
  calls: Array<{ method: string; params?: unknown }> = []
  records: MappingRecord[] = []
  status: LegacyMigrationStatus = {
    state: "pending",
    importedCount: 0,
  }
  failure: EngineRpcError | null = null

  async request<T>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params })
    if (this.failure && method === "mapping.getMigrationStatus") throw this.failure
    if (method === "mapping.getMigrationStatus") return this.status as T
    if (method === "mapping.recordMigrationFailure") {
      this.status = { ...this.status, state: "failed", lastError: (params as { detail: string }).detail }
      return this.status as T
    }
    if (method === "mapping.importLegacy") {
      const request = params as LegacyImportRequest
      this.records = request.records.map((item, index) => ({
        mapping: item.mapping,
        revision: index + 1,
        eventId: `legacy:${item.mapping.id}:${index + 1}:linux-box`,
        authorDeviceId: "linux-box",
        pendingDelivery: item.pendingDeliveryTargetDeviceId !== null,
      }))
      this.status = {
        state: "completed",
        sourceFingerprint: request.sourceFingerprint,
        importedCount: request.records.length,
        completedAt: request.importedAt,
      }
      return {
        status: this.status,
        importedCount: request.records.length,
        tombstonedCount: 0,
        alreadyCompleted: false,
      } satisfies LegacyImportOutcome as T
    }
    if (method === "mapping.list") return this.records as T
    throw new Error(`Unexpected method ${method}`)
  }
}

describe("legacy state conversion", () => {
  test("preserves stable ids, approved paths, mode, rules, limits, pause state, and timestamps", () => {
    const result = bundle().request.records[0]
    expect(result.mapping).toMatchObject({
      id: "mapping-1",
      initiatorPath: "/home/tommy/Projects",
      responderPath: "C:\\Users\\tommy\\Projects",
      mode: "two-way",
      ignorePatterns: ["node_modules/"],
      historyDays: 45,
      historyMaxBytes: 7_000_000_000,
      setupStatus: "active",
      paused: true,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-02T00:00:00.000Z",
    })
  })

  test("preserves an approval that was still pending peer delivery", () => {
    const document = legacyDocument({
      mappings: {
        incoming: [{ id: "mapping-1", status: "approved-awaiting-delivery" }],
        outgoing: [],
      },
    })
    expect(bundle(readable(document)).request.records[0]?.pendingDeliveryTargetDeviceId).toBe("win-box")
  })

  test("a fresh installation and a readable zero-mapping snapshot create an intentional empty import", () => {
    const missing = bundle({ kind: "missing", document: {}, modifiedAt: NOW })
    const empty = bundle(readable(legacyDocument({ folders: [] })))
    expect(missing.request.records).toEqual([])
    expect(empty.request.records).toEqual([])
    expect(missing.request.sourceFingerprint).toHaveLength(64)
  })

  test("rejects a malformed record without partially converting neighbours", () => {
    const document = legacyDocument({
      folders: [legacyDocument().folders instanceof Array ? legacyDocument().folders[0] : {}, { id: "broken" }],
    })
    expect(() => bundle(readable(document))).toThrow(LegacyMappingValidationError)
  })

  test("rejects duplicate mapping ids", () => {
    const original = (legacyDocument().folders as unknown[])[0]
    expect(() => bundle(readable(legacyDocument({ folders: [original, { ...(original as object) }] })))).toThrow(
      "duplicate id",
    )
  })

  test("the backup payload excludes unrelated state and potential secrets", () => {
    const document = legacyDocument({ privateKey: "must-not-copy" })
    const folder = (document.folders as Record<string, unknown>[])[0]
    folder.privateKey = "nested-private-key"
    ;(document.mappings as Record<string, unknown>).incoming = [
      {
        id: "mapping-1",
        status: "approved-awaiting-delivery",
        contentBase64: "user-file-contents",
        proposal: {
          id: "mapping-1",
          name: "Projects",
          privateKey: "proposal-private-key",
        },
      },
    ]
    const result = bundle(readable(document))
    expect(JSON.stringify(result.backupPayload)).not.toContain("must-not-copy")
    expect(JSON.stringify(result.backupPayload)).not.toContain("nested-private-key")
    expect(JSON.stringify(result.backupPayload)).not.toContain("proposal-private-key")
    expect(JSON.stringify(result.backupPayload)).not.toContain("user-file-contents")
    expect(result.backupPayload).toHaveProperty("folders")
  })

  test("rejects a malformed stored preview instead of partially importing the mapping", () => {
    const document = legacyDocument({
      mappings: {
        incoming: [
          {
            id: "mapping-1",
            proposal: { preview: { localFiles: -1, samples: [{ path: "\0", category: "other" }] } },
          },
        ],
        outgoing: [],
      },
    })
    expect(() => bundle(readable(document))).toThrow("malformed comparison preview")
  })

  test("rejects malformed unreadable issue detail before sanitisation", () => {
    const validPreview = {
      localFiles: 0,
      remoteFiles: 0,
      identicalFiles: 0,
      differentFiles: 0,
      localOnlyFiles: 0,
      remoteOnlyFiles: 0,
      ignoredLocal: 0,
      ignoredRemote: 0,
      bytesToRemote: 0,
      bytesToLocal: 0,
      invalidWindowsNames: [],
      caseCollisions: [],
      truncated: false,
      samples: [],
    }
    const malformedValues: unknown[] = [
      "not-an-array",
      [{ path: "locked", reason: "", kind: "directory" }],
      [{ path: "locked", reason: "denied", kind: "socket" }],
      [{ path: "locked", reason: "x".repeat(201), kind: "file" }],
      Array.from({ length: 101 }, (_, index) => ({ path: `p${index}`, reason: "denied", kind: "file" })),
    ]
    for (const malformed of malformedValues) {
      const document = legacyDocument({
        mappings: {
          incoming: [{ id: "mapping-1", proposal: { preview: { ...validPreview, unreadableLocal: malformed } } }],
          outgoing: [],
        },
      })
      expect(() => bundle(readable(document))).toThrow("malformed comparison preview")
    }

    // An empty path means the scanned root and stays valid; totals are not capped like the detail list.
    const accepted = legacyDocument({
      mappings: {
        incoming: [{
          id: "mapping-1",
          proposal: {
            preview: {
              ...validPreview,
              unreadableLocal: [{ path: "", reason: "Permission denied", kind: "directory" }],
              unreadableLocalCount: 10_000,
            },
          },
        }],
        outgoing: [],
      },
    })
    expect(() => bundle(readable(accepted))).not.toThrow()
  })
})

describe("legacy migration durability", () => {
  test("writes and verifies a mapping-only backup", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "tethera-legacy-backup-"))
    const payload = bundle().backupPayload
    const fingerprint = fingerprintLegacyPayload(payload)
    const backup = await ensureLegacyBackup(path.join(directory, "state.json"), payload, fingerprint)
    expect(JSON.parse(await readFile(backup, "utf8"))).toEqual(payload)
    expect(await ensureLegacyBackup(path.join(directory, "state.json"), payload, fingerprint)).toBe(backup)
  })

  test("successful import is read back before state.json mapping ownership is retired", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "tethera-authority-"))
    const statePath = path.join(directory, "state.json")
    const document = legacyDocument()
    await writeFile(statePath, JSON.stringify(document), "utf8")
    const rpc = new FakeMappingRpc()
    const result = await initializeMappingAuthority({
      rpc,
      statePath,
      legacySource: readable(document),
      localDeviceId: "linux-box",
      localDeviceName: "Linux Mint",
      remoteDeviceName: () => "Windows 11",
      now: NOW,
    })
    expect(result.records).toHaveLength(1)
    expect(result.migration.state).toBe("completed")
    expect(rpc.calls.some((call) => call.method === "mapping.list")).toBe(true)
    const cleaned = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>
    expect(cleaned.folders).toBeUndefined()
    expect(cleaned.settings).toEqual(document.settings)
    expect(cleaned.unrelatedPluginPreference).toEqual(document.unrelatedPluginPreference)
  })

  test("a crash after database commit retries cleanup without importing twice", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "tethera-authority-retry-"))
    const statePath = path.join(directory, "state.json")
    const document = legacyDocument()
    await writeFile(statePath, JSON.stringify(document), "utf8")
    const intended = bundle(readable(document))
    const rpc = new FakeMappingRpc()
    rpc.records = intended.request.records.map((item) => ({
      mapping: item.mapping,
      revision: 1,
      eventId: "legacy:mapping-1:1:linux-box",
      authorDeviceId: "linux-box",
      pendingDelivery: false,
    }))
    rpc.status = {
      state: "completed",
      sourceFingerprint: intended.request.sourceFingerprint,
      importedCount: 1,
      completedAt: NOW,
    }
    await initializeMappingAuthority({
      rpc,
      statePath,
      legacySource: readable(document),
      localDeviceId: "linux-box",
      localDeviceName: "Linux Mint",
      remoteDeviceName: () => "Windows 11",
      now: NOW,
    })
    expect(rpc.calls.filter((call) => call.method === "mapping.importLegacy")).toHaveLength(0)
    expect((JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>).folders).toBeUndefined()
  })

  test("an unrelated state write before import cannot erase mappings after a crash", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "tethera-authority-preimport-write-"))
    const statePath = path.join(directory, "state.json")
    const original = legacyDocument()
    await writeFile(statePath, JSON.stringify(original), "utf8")

    const beforeCrash = new DesktopStateStore(statePath, original, true)
    await beforeCrash.update((current) =>
      buildPersistedDesktopState(
        current,
        {
          paused: false,
          mappings: { incoming: [], outgoing: [] },
          activity: [],
          settings: {
            closeToTray: true,
            launchAtLogin: false,
            startMinimised: false,
            pauseOnMetered: true,
            theme: "dark",
          },
        },
        false,
      ),
    )

    const restartedDocument = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>
    expect(restartedDocument.folders).toEqual(original.folders)
    const restartedStore = new DesktopStateStore(statePath, restartedDocument, true)
    const rpc = new FakeMappingRpc()
    const result = await initializeMappingAuthority({
      rpc,
      statePath,
      legacySource: readable(restartedDocument),
      localDeviceId: "linux-box",
      localDeviceName: "Linux Mint",
      remoteDeviceName: () => "Windows 11",
      now: NOW,
      retireLegacyState: ({ sourceFingerprint, backupFileName, retiredAt }) =>
        restartedStore.update((current) =>
          retireLegacyMappingFields(current, sourceFingerprint, backupFileName, retiredAt),
        ),
    })

    expect(result.records).toHaveLength(1)
    const cleaned = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>
    expect(cleaned.folders).toBeUndefined()
    expect((cleaned.settings as { theme: string }).theme).toBe("dark")
  })

  test("a completed database is never overwritten by a changed stale state.json", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "tethera-authority-mismatch-"))
    const statePath = path.join(directory, "state.json")
    const document = legacyDocument()
    await writeFile(statePath, JSON.stringify(document), "utf8")
    const rpc = new FakeMappingRpc()
    rpc.status = {
      state: "completed",
      sourceFingerprint: "f".repeat(64),
      importedCount: 0,
      completedAt: NOW,
    }
    const result = await initializeMappingAuthority({
      rpc,
      statePath,
      legacySource: readable(document),
      localDeviceId: "linux-box",
      localDeviceName: "Linux Mint",
      remoteDeviceName: () => "Windows 11",
      now: NOW,
    })
    expect(result.cleanupWarning).toContain("not imported")
    expect(rpc.calls.filter((call) => call.method === "mapping.importLegacy")).toHaveLength(0)
    expect((JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>).folders).toBeDefined()
  })

  test("malformed or unreadable state records failure and leaves migration incomplete", async () => {
    const rpc = new FakeMappingRpc()
    await expect(
      initializeMappingAuthority({
        rpc,
        statePath: "/unused/state.json",
        legacySource: { kind: "unreadable", detail: "state.json could not be read (EACCES)" },
        localDeviceId: "linux-box",
        localDeviceName: "Linux Mint",
        remoteDeviceName: () => "Windows 11",
        now: NOW,
      }),
    ).rejects.toThrow("blocked")
    expect(rpc.status.state).toBe("failed")
    expect(rpc.calls.some((call) => call.method === "mapping.importLegacy")).toBe(false)
  })

  test("database-unavailable and newer-schema errors remain distinct", async () => {
    for (const code of ["MAPPING_STORE_UNAVAILABLE", "MAPPING_STORE_UNSUPPORTED_SCHEMA"] as const) {
      const rpc = new FakeMappingRpc()
      rpc.failure = new EngineRpcError("database unavailable", code)
      await expect(
        initializeMappingAuthority({
          rpc,
          statePath: "/unused/state.json",
          legacySource: { kind: "missing", document: {}, modifiedAt: NOW },
          localDeviceId: "linux-box",
          localDeviceName: "Linux Mint",
          remoteDeviceName: () => "Windows 11",
          now: NOW,
        }),
      ).rejects.toMatchObject({ code })
    }
  })

  test("state reader distinguishes a missing file from unreadable JSON", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "tethera-state-read-"))
    expect((await readLegacyState(path.join(directory, "missing.json"), NOW)).kind).toBe("missing")
    const invalid = path.join(directory, "state.json")
    await writeFile(invalid, "{not-json", "utf8")
    const result = await readLegacyState(invalid, NOW)
    expect(result.kind).toBe("unreadable")
    if (result.kind === "unreadable") expect(result.detail).not.toContain(directory)
  })

  test("cleanup removes only mapping ownership", () => {
    const document = legacyDocument({
      mappings: {
        incoming: [{ id: "mapping-1", status: "approved-awaiting-delivery" }, { id: "proposal-2", status: "pending" }],
        outgoing: [{ id: "mapping-1", status: "approved" }, { id: "proposal-3", status: "failed" }],
      },
    })
    const result = retireLegacyMappingFields(document, "a".repeat(64), "backup.json", NOW)
    expect(result.folders).toBeUndefined()
    expect(result.settings).toEqual(document.settings)
    expect(result.mappings).toEqual({
      incoming: [{ id: "proposal-2", status: "pending" }],
      outgoing: [{ id: "proposal-3", status: "failed" }],
    })
    expect(result.mappingIndexMigration).toMatchObject({ state: "completed" })
  })
})
