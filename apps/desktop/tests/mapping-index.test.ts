import { describe, expect, test } from "bun:test"
import type { FolderMappingPreview, FolderMappingProposal, FolderSummary } from "../src/shared/contracts"
import {
  folderFromMappingRecord,
  invertMode,
  mappingConfigurationFromLegacyFolder,
  mappingConfigurationFromProposal,
  type MappingRecord,
} from "../src/main/mapping-index"

function preview(): FolderMappingPreview {
  return {
    localFiles: 12,
    remoteFiles: 10,
    identicalFiles: 9,
    differentFiles: 1,
    localOnlyFiles: 2,
    remoteOnlyFiles: 0,
    ignoredLocal: 0,
    ignoredRemote: 0,
    bytesToRemote: 4096,
    bytesToLocal: 0,
    invalidWindowsNames: [],
    caseCollisions: [],
    truncated: false,
    samples: [],
  }
}

function proposal(): FolderMappingProposal {
  return {
    id: "mapping-1",
    name: "Projects",
    initiatorDeviceId: "linux-box",
    initiatorDeviceName: "Linux Mint",
    responderDeviceId: "win-box",
    initiatorPath: "/home/tommy/Projects",
    responderPath: "C:\\Users\\tommy\\Projects",
    mode: "send-only",
    ignorePatterns: ["node_modules/"],
    historyDays: 30,
    historyMaxBytes: 5_000_000_000,
    preview: preview(),
    createdAt: "2026-08-01T00:00:00.000Z",
  }
}

function folder(overrides: Partial<FolderSummary> = {}): FolderSummary {
  return {
    id: "mapping-1",
    name: "Projects",
    localPath: "/home/tommy/Projects",
    remotePath: "C:\\Users\\tommy\\Projects",
    remoteDeviceId: "win-box",
    status: "offline",
    setupStatus: "ready-for-initial-sync",
    mode: "send-only",
    paused: false,
    ignorePatterns: ["node_modules/"],
    historyDays: 30,
    historyMaxBytes: 5_000_000_000,
    ...overrides,
  }
}

function record(overrides: Partial<MappingRecord> = {}): MappingRecord {
  return {
    mapping: mappingConfigurationFromProposal(proposal(), {
      responderDeviceName: "Windows 11",
      responderPath: "C:\\Users\\tommy\\Projects",
      setupStatus: "ready-for-initial-sync",
      now: "2026-08-02T09:30:00.000Z",
    }),
    revision: 1,
    eventId: "active:mapping-1:1:linux-box",
    authorDeviceId: "linux-box",
    pendingDelivery: false,
    ...overrides,
  }
}

describe("mapping configuration projections", () => {
  test("inverts one-way modes without changing two-way", () => {
    expect(invertMode("send-only")).toBe("receive-only")
    expect(invertMode("receive-only")).toBe("send-only")
    expect(invertMode("two-way")).toBe("two-way")
  })

  test("preserves the approved paths, rules, preview, and timestamps", () => {
    const configuration = mappingConfigurationFromProposal(proposal(), {
      responderDeviceName: "Windows 11",
      responderPath: "D:\\Work\\Projects",
      setupStatus: "ready-for-initial-sync",
      now: "2026-08-02T09:30:00.000Z",
    })
    expect(configuration.id).toBe("mapping-1")
    expect(configuration.initiatorPath).toBe("/home/tommy/Projects")
    expect(configuration.responderPath).toBe("D:\\Work\\Projects")
    expect(configuration.preview).toEqual(preview())
    expect(configuration.createdAt).toBe("2026-08-01T00:00:00.000Z")
    expect(configuration.updatedAt).toBe("2026-08-02T09:30:00.000Z")
    expect(configuration.paused).toBe(false)
  })

  test("both legacy peers derive the same participant orientation", () => {
    const linux = mappingConfigurationFromLegacyFolder(
      folder(),
      "win-box",
      "linux-box",
      "Linux Mint",
      "Windows 11",
      "2026-08-01T00:00:00.000Z",
      "2026-08-01T00:00:00.000Z",
    )
    const windows = mappingConfigurationFromLegacyFolder(
      folder({
        localPath: "C:\\Users\\tommy\\Projects",
        remotePath: "/home/tommy/Projects",
        remoteDeviceId: "linux-box",
        mode: "receive-only",
      }),
      "linux-box",
      "win-box",
      "Windows 11",
      "Linux Mint",
      "2026-08-01T00:00:00.000Z",
      "2026-08-01T00:00:00.000Z",
    )
    expect(windows).toEqual(linux)
  })
})

describe("folderFromMappingRecord", () => {
  test("reads the nested authoritative record for the initiator", () => {
    const result = folderFromMappingRecord(record(), "linux-box")
    expect(result?.localPath).toBe("/home/tommy/Projects")
    expect(result?.remotePath).toBe("C:\\Users\\tommy\\Projects")
    expect(result?.remoteDeviceId).toBe("win-box")
    expect(result?.mode).toBe("send-only")
  })

  test("swaps paths and mode for the responder", () => {
    const result = folderFromMappingRecord(record(), "win-box")
    expect(result?.localPath).toBe("C:\\Users\\tommy\\Projects")
    expect(result?.remotePath).toBe("/home/tommy/Projects")
    expect(result?.mode).toBe("receive-only")
  })

  test("surfaces SQLite pending-delivery state without changing configuration", () => {
    const result = folderFromMappingRecord(record({ pendingDelivery: true }), "linux-box")
    expect(result?.currentAction).toContain("waiting for the paired computer")
  })

  test("excludes records that do not include this device", () => {
    expect(folderFromMappingRecord(record(), "stranger")).toBeNull()
  })

  test("preserves UNC and Linux paths byte-for-byte", () => {
    const uncRecord = record({
      mapping: {
        ...record().mapping,
        initiatorPath: "\\\\server\\share\\Projects",
        responderPath: "/mnt/data/Projects",
      },
    })
    expect(folderFromMappingRecord(uncRecord, "linux-box")?.localPath).toBe("\\\\server\\share\\Projects")
    expect(folderFromMappingRecord(uncRecord, "win-box")?.localPath).toBe("/mnt/data/Projects")
  })
})
