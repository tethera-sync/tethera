import type {
  FolderMappingPreview,
  FolderMappingProposal,
  FolderSetupStatus,
  FolderSummary,
  SyncMode,
} from "../shared/contracts"

/**
 * Typed mirror of the bounded Rust mapping RPC contract.
 *
 * Paths remain opaque strings throughout this module. None of these projections opens,
 * normalises, scans, creates, moves, or deletes a path.
 */

export interface MappingConfiguration {
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
  paused: boolean
  preview: FolderMappingPreview | null
  createdAt: string
  updatedAt: string
}

export interface MappingRecord {
  mapping: MappingConfiguration
  revision: number
  eventId: string
  authorDeviceId: string
  pendingDelivery: boolean
}

export interface MappingTombstone {
  mappingId: string
  deletionEventId: string
  deletionRevision: number
  deletionTimestamp: string
  deletingDeviceId: string
  lastKnownUpdateRevision: number
  tombstoneCreatedAt: string
  initiatorDeviceId: string
  responderDeviceId: string
}

export type MappingEvent =
  | { kind: "active"; record: MappingRecord }
  | { kind: "tombstone"; tombstone: MappingTombstone }

export interface MappingDelivery {
  mappingId: string
  eventId: string
  revision: number
  targetDeviceId: string
  event: MappingEvent
  createdAt: string
}

export interface MappingApplyOutcome {
  status: "applied" | "duplicate" | "stale" | "tombstoned"
  mappingId: string
  eventId: string
  revision: number
}

export type MappingAcknowledgement = Pick<MappingApplyOutcome, "mappingId" | "eventId" | "revision">

export interface LegacyMigrationStatus {
  state: "pending" | "completed" | "failed"
  sourceFingerprint?: string
  importedCount: number
  completedAt?: string
  lastError?: string
}

export interface LegacyImportRecord {
  mapping: MappingConfiguration
  pendingDeliveryTargetDeviceId: string | null
}

export interface LegacyImportRequest {
  sourceFingerprint: string
  importingDeviceId: string
  importedAt: string
  records: LegacyImportRecord[]
}

export interface LegacyImportOutcome {
  status: LegacyMigrationStatus
  importedCount: number
  tombstonedCount: number
  alreadyCompleted: boolean
}

export function invertMode(mode: SyncMode): SyncMode {
  if (mode === "send-only") return "receive-only"
  if (mode === "receive-only") return "send-only"
  return "two-way"
}

export interface MappingConfigurationFromProposalOptions {
  responderDeviceName: string
  responderPath: string
  setupStatus: FolderSetupStatus
  paused?: boolean
  now?: string
}

/** Builds the configuration that SQLite will wrap in a monotonic active event. */
export function mappingConfigurationFromProposal(
  proposal: FolderMappingProposal,
  options: MappingConfigurationFromProposalOptions,
): MappingConfiguration {
  return {
    id: proposal.id,
    name: proposal.name,
    initiatorDeviceId: proposal.initiatorDeviceId,
    initiatorDeviceName: proposal.initiatorDeviceName,
    responderDeviceId: proposal.responderDeviceId,
    responderDeviceName: options.responderDeviceName,
    initiatorPath: proposal.initiatorPath,
    responderPath: options.responderPath,
    mode: proposal.mode,
    ignorePatterns: proposal.ignorePatterns,
    historyDays: proposal.historyDays,
    historyMaxBytes: proposal.historyMaxBytes,
    setupStatus: options.setupStatus,
    paused: options.paused ?? false,
    preview: proposal.preview,
    createdAt: proposal.createdAt,
    updatedAt: options.now ?? new Date().toISOString(),
  }
}

/**
 * Converts one validated legacy folder into a configuration without dereferencing either path.
 * The old snapshot did not retain participant orientation, so device ids provide a deterministic
 * ordering that both peers independently derive. Paths and mode are swapped only as a semantic
 * projection; their bytes are not rewritten.
 */
export function mappingConfigurationFromLegacyFolder(
  folder: FolderSummary,
  remoteDeviceId: string,
  localDeviceId: string,
  localDeviceName: string,
  remoteDeviceName: string,
  createdAt: string,
  updatedAt: string,
  preview: FolderMappingPreview | null = null,
): MappingConfiguration {
  const localFirst = localDeviceId.localeCompare(remoteDeviceId) <= 0
  const localFirstConfiguration: MappingConfiguration = {
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
    historyMaxBytes: folder.historyMaxBytes ?? 10 * 1024 ** 3,
    setupStatus: folder.setupStatus ?? "ready-for-initial-sync",
    paused: folder.paused,
    preview,
    createdAt,
    updatedAt,
  }
  if (localFirst) return localFirstConfiguration
  return {
    ...localFirstConfiguration,
    initiatorDeviceId: remoteDeviceId,
    initiatorDeviceName: remoteDeviceName,
    responderDeviceId: localDeviceId,
    responderDeviceName: localDeviceName,
    initiatorPath: folder.remotePath,
    responderPath: folder.localPath,
    mode: invertMode(folder.mode),
  }
}

/** Projects one active authoritative record into the renderer model. */
export function folderFromMappingRecord(record: MappingRecord, localDeviceId: string): FolderSummary | null {
  const mapping = record.mapping
  const pendingNote = record.pendingDelivery ? "Configuration update is waiting for the paired computer." : undefined
  const localIsInitiator = mapping.initiatorDeviceId === localDeviceId
  if (!localIsInitiator && mapping.responderDeviceId !== localDeviceId) return null
  return {
    id: mapping.id,
    name: mapping.name,
    localPath: localIsInitiator ? mapping.initiatorPath : mapping.responderPath,
    remotePath: localIsInitiator ? mapping.responderPath : mapping.initiatorPath,
    remoteDeviceId: localIsInitiator ? mapping.responderDeviceId : mapping.initiatorDeviceId,
    status: mapping.paused ? "paused" : "offline",
    setupStatus: mapping.setupStatus,
    mode: localIsInitiator ? mapping.mode : invertMode(mapping.mode),
    paused: mapping.paused,
    ignorePatterns: mapping.ignorePatterns,
    historyDays: mapping.historyDays,
    historyMaxBytes: mapping.historyMaxBytes,
    currentAction: pendingNote,
  }
}
