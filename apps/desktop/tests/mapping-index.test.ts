import { describe, expect, test } from "bun:test"
import type { FolderMappingPreview, FolderMappingProposal, FolderSummary } from "../src/shared/contracts"
import {
  folderFromMappingRecord,
  invertMode,
  mappingRecordFromFolder,
  mappingRecordFromProposal,
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
    mode: "two-way",
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
    mode: "two-way",
    paused: false,
    ignorePatterns: ["node_modules/"],
    historyDays: 30,
    historyMaxBytes: 5_000_000_000,
    ...overrides,
  }
}

describe("invertMode", () => {
  test("swaps send-only and receive-only, leaves two-way alone", () => {
    expect(invertMode("send-only")).toBe("receive-only")
    expect(invertMode("receive-only")).toBe("send-only")
    expect(invertMode("two-way")).toBe("two-way")
  })
})

describe("mappingRecordFromProposal", () => {
  const options = {
    responderDeviceName: "Windows 11",
    responderPath: "C:\\Users\\tommy\\Projects",
    setupStatus: "ready-for-initial-sync",
    pendingDelivery: false,
  } as const

  test("carries proposal fields into the durable record", () => {
    const record = mappingRecordFromProposal(proposal(), options)
    expect(record.id).toBe("mapping-1")
    expect(record.initiatorDeviceId).toBe("linux-box")
    expect(record.initiatorDeviceName).toBe("Linux Mint")
    expect(record.responderDeviceId).toBe("win-box")
    expect(record.responderDeviceName).toBe("Windows 11")
    expect(record.setupStatus).toBe("ready-for-initial-sync")
    expect(record.pendingDelivery).toBe(false)
    expect(record.preview).toEqual(preview())
  })

  test("records the destination the responder actually chose, not the proposal's suggestion", () => {
    // The responder is free to approve into somewhere other than the suggested folder, and the
    // durable record has to point at the real one.
    const record = mappingRecordFromProposal(proposal(), {
      ...options,
      responderPath: "D:\\Work\\Projects",
    })
    expect(record.responderPath).toBe("D:\\Work\\Projects")
    expect(record.initiatorPath).toBe("/home/tommy/Projects")
  })

  test("marks the responder's own approval as pending until the peer acknowledges it", () => {
    // The responder approves first and only learns the peer got it later, so it starts pending.
    const responderSide = mappingRecordFromProposal(proposal(), { ...options, pendingDelivery: true })
    expect(responderSide.pendingDelivery).toBe(true)

    // The initiator only ever sees an approval that has already arrived, so it is never pending.
    const initiatorSide = mappingRecordFromProposal(proposal(), { ...options, pendingDelivery: false })
    expect(initiatorSide.pendingDelivery).toBe(false)

    // Both computers describe the same mapping under the same id, so re-persisting the
    // responder's record with delivery confirmed converges on the initiator's view.
    expect(responderSide.id).toBe(initiatorSide.id)
    expect({ ...responderSide, pendingDelivery: false, updatedAt: "" }).toEqual({
      ...initiatorSide,
      updatedAt: "",
    })
  })

  test("keeps createdAt from the proposal and stamps updatedAt at write time", () => {
    const record = mappingRecordFromProposal(proposal(), { ...options, now: "2026-08-02T09:30:00.000Z" })
    expect(record.createdAt).toBe("2026-08-01T00:00:00.000Z")
    expect(record.updatedAt).toBe("2026-08-02T09:30:00.000Z")
  })

  test("leaves both platforms' path separators alone", () => {
    const record = mappingRecordFromProposal(proposal(), options)
    expect(record.initiatorPath).toBe("/home/tommy/Projects")
    expect(record.responderPath).toBe("C:\\Users\\tommy\\Projects")
    expect(record.responderPath).not.toContain("/")
  })
})

describe("folderFromMappingRecord", () => {
  const record: MappingRecord = {
    id: "mapping-1",
    name: "Projects",
    initiatorDeviceId: "linux-box",
    initiatorDeviceName: "Linux Mint",
    responderDeviceId: "win-box",
    responderDeviceName: "Windows 11",
    initiatorPath: "/home/tommy/Projects",
    responderPath: "C:\\Users\\tommy\\Projects",
    mode: "send-only",
    ignorePatterns: ["node_modules/"],
    historyDays: 30,
    historyMaxBytes: 5_000_000_000,
    setupStatus: "ready-for-initial-sync",
    pendingDelivery: false,
    preview: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  }

  test("reconstructs the initiator's local folder verbatim", () => {
    const result = folderFromMappingRecord(record, "linux-box")
    expect(result).not.toBeNull()
    expect(result?.localPath).toBe("/home/tommy/Projects")
    expect(result?.remotePath).toBe("C:\\Users\\tommy\\Projects")
    expect(result?.remoteDeviceId).toBe("win-box")
    expect(result?.mode).toBe("send-only")
  })

  test("reconstructs the responder's local folder with paths and mode swapped/inverted", () => {
    const result = folderFromMappingRecord(record, "win-box")
    expect(result).not.toBeNull()
    expect(result?.localPath).toBe("C:\\Users\\tommy\\Projects")
    expect(result?.remotePath).toBe("/home/tommy/Projects")
    expect(result?.remoteDeviceId).toBe("linux-box")
    expect(result?.mode).toBe("receive-only")
  })

  test("returns null when the local device isn't a party to the mapping", () => {
    expect(folderFromMappingRecord(record, "some-other-device")).toBeNull()
  })

  test("carries a Windows path through unchanged on the responder's side", () => {
    // The responder is the Windows machine here: its own folder must come back as a Windows
    // path, and the Linux peer's path must survive as the remote one.
    const result = folderFromMappingRecord(record, "win-box")
    expect(result?.localPath).toBe("C:\\Users\\tommy\\Projects")
    expect(result?.localPath).not.toContain("/")
    expect(result?.remotePath).toBe("/home/tommy/Projects")
  })

  test("round-trips a UNC path without rewriting separators", () => {
    const unc: MappingRecord = { ...record, initiatorPath: "\\\\server\\share\\Projects", initiatorDeviceId: "win-box", responderDeviceId: "linux-box", responderPath: "/mnt/data/Projects" }
    expect(folderFromMappingRecord(unc, "win-box")?.localPath).toBe("\\\\server\\share\\Projects")
    expect(folderFromMappingRecord(unc, "linux-box")?.localPath).toBe("/mnt/data/Projects")
  })
})

describe("mappingRecordFromFolder round-trips through folderFromMappingRecord", () => {
  test("a self-healed record reproduces the same folder on this device", () => {
    const original = folder({ mode: "receive-only" })
    const record = mappingRecordFromFolder(
      original,
      "win-box",
      "linux-box",
      "Linux Mint",
      "Windows 11",
      "2026-08-01T00:00:00.000Z",
    )

    // Self-healing always encodes the local device as the record's initiator, so reading it
    // back on the same device must reproduce the original folder untouched.
    const reconstructed = folderFromMappingRecord(record, "linux-box")
    expect(reconstructed).not.toBeNull()
    expect(reconstructed?.localPath).toBe(original.localPath)
    expect(reconstructed?.remotePath).toBe(original.remotePath)
    expect(reconstructed?.remoteDeviceId).toBe(original.remoteDeviceId)
    expect(reconstructed?.mode).toBe(original.mode)
  })
})
