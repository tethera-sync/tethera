import type { FolderMappingPreview, FolderMappingProposal, FolderSetupStatus, FolderSummary, SyncMode } from "../shared/contracts"

/** Mirrors the `MappingRecord` the Rust engine persists to and returns from its `SQLite` mapping index. */
export interface MappingRecord {
  id: string
  name: string
  initiatorDeviceId: string
  initiatorDeviceName: string
  responderDeviceId: string
  responderDeviceName: string
  initiatorPath: string
  responderPath: string
  mode: SyncMode
  ignorePatterns: string[]
  historyDays: number
  historyMaxBytes: number
  setupStatus: FolderSetupStatus
  pendingDelivery: boolean
  preview: FolderMappingPreview | null
  createdAt: string
  updatedAt: string
}

export function invertMode(mode: SyncMode): SyncMode {
  if (mode === "send-only") return "receive-only"
  if (mode === "receive-only") return "send-only"
  return "two-way"
}

/** Builds the durable record for a freshly approved mapping, from the negotiated proposal. */
export function mappingRecordFromProposal(
  proposal: FolderMappingProposal,
  responderDeviceName: string,
  setupStatus: FolderSetupStatus,
): MappingRecord {
  return {
    id: proposal.id,
    name: proposal.name,
    initiatorDeviceId: proposal.initiatorDeviceId,
    initiatorDeviceName: proposal.initiatorDeviceName,
    responderDeviceId: proposal.responderDeviceId,
    responderDeviceName,
    initiatorPath: proposal.initiatorPath,
    responderPath: proposal.responderPath,
    mode: proposal.mode,
    ignorePatterns: proposal.ignorePatterns,
    historyDays: proposal.historyDays,
    historyMaxBytes: proposal.historyMaxBytes,
    setupStatus,
    pendingDelivery: false,
    preview: proposal.preview,
    createdAt: proposal.createdAt,
    updatedAt: new Date().toISOString(),
  }
}

/**
 * Synthesises a durable record for a folder that's already configured locally but is missing
 * from the mapping index — for example, it was approved while the Rust engine wasn't running.
 * The original proposal (device names, initial preview) is gone by this point, so this always
 * encodes the local device as the record's "initiator" side. That's safe because the index is
 * a private, per-machine store: nothing outside this device ever reads its initiator/responder
 * fields, so the round trip through `folderFromMappingRecord` on this same device stays
 * self-consistent even if it wasn't the true historical initiator.
 */
export function mappingRecordFromFolder(
  folder: FolderSummary,
  remoteDeviceId: string,
  localDeviceId: string,
  localDeviceName: string,
  remoteDeviceName: string,
  timestamp: string,
): MappingRecord {
  return {
    id: folder.id,
    name: folder.name,
    initiatorDeviceId: localDeviceId,
    initiatorDeviceName: localDeviceName,
    responderDeviceId: remoteDeviceId,
    responderDeviceName: remoteDeviceName,
    initiatorPath: folder.localPath,
    responderPath: folder.remotePath,
    mode: folder.mode,
    ignorePatterns: folder.ignorePatterns,
    historyDays: folder.historyDays ?? 30,
    historyMaxBytes: folder.historyMaxBytes ?? 5 * 1024 ** 3,
    setupStatus: folder.setupStatus ?? "ready-for-initial-sync",
    pendingDelivery: false,
    preview: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

/**
 * Reconstructs the `FolderSummary` this device should have configured from a durable mapping
 * record, recovering local state (for example after `state.json` was lost or predates the
 * index) from the engine's `SQLite` copy. Returns `null` if `localDeviceId` isn't a party to
 * the mapping, which should never happen for records this device's engine returns but is
 * checked rather than assumed.
 */
export function folderFromMappingRecord(record: MappingRecord, localDeviceId: string): FolderSummary | null {
  if (record.initiatorDeviceId === localDeviceId) {
    return {
      id: record.id,
      name: record.name,
      localPath: record.initiatorPath,
      remotePath: record.responderPath,
      remoteDeviceId: record.responderDeviceId,
      status: "offline",
      setupStatus: record.setupStatus,
      mode: record.mode,
      paused: false,
      ignorePatterns: record.ignorePatterns,
      historyDays: record.historyDays,
      historyMaxBytes: record.historyMaxBytes,
      currentAction: "Recovered from the durable mapping index.",
    }
  }
  if (record.responderDeviceId === localDeviceId) {
    return {
      id: record.id,
      name: record.name,
      localPath: record.responderPath,
      remotePath: record.initiatorPath,
      remoteDeviceId: record.initiatorDeviceId,
      status: "offline",
      setupStatus: record.setupStatus,
      mode: invertMode(record.mode),
      paused: false,
      ignorePatterns: record.ignorePatterns,
      historyDays: record.historyDays,
      historyMaxBytes: record.historyMaxBytes,
      currentAction: "Recovered from the durable mapping index.",
    }
  }
  return null
}
