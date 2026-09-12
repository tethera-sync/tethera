export type OverallStatus =
  | "up-to-date"
  | "syncing"
  | "paused"
  | "offline"
  | "needs-attention"

export type ConnectionRoute =
  | "lan-direct"
  | "tailscale-direct"
  | "tailscale-relay"
  | "connecting"
  | "offline"

export type EngineStatus = "starting" | "ready" | "unavailable" | "error"
export type MappingStoreStatus =
  | "loading"
  | "ready"
  | "unavailable"
  | "unsupported-schema"
  | "migration-required"
  | "migration-failed"
export type DeviceStatus = "this-device" | "online" | "offline" | "unpaired"
export type SyncMode = "two-way" | "send-only" | "receive-only"
export type ActivityLevel = "info" | "success" | "warning" | "error"
export type ThemePreference = "system" | "light" | "dark"
export type DirectoryEntryKind = "directory" | "symlink"
export type DirectoryLocationKind =
  | "home"
  | "desktop"
  | "documents"
  | "downloads"
  | "root"
  | "drive"
  | "mount"

export type FileConflictKind =
  | "unbased-divergence"
  | "simultaneous-modification"
  | "deletion-not-propagated"
  | "direction-blocked"
  | "initial-merge"

export type PairingSessionStatus =
  | "connecting"
  | "confirm-code"
  | "waiting-for-peer"
  | "waiting-for-approval"
  | "paired"
  | "rejected"
  | "cancelled"
  | "failed"

export type IncomingPairingStatus = "waiting-for-peer" | "ready-for-approval"
export type FolderSetupStatus = "pending-approval" | "ready-for-initial-sync" | "active"
export type MappingRequestStatus =
  | "pending"
  | "approved-awaiting-delivery"
  | "approved"
  | "rejected"
  | "failed"

export interface FolderSummary {
  id: string
  name: string
  localPath: string
  remotePath: string
  remoteDeviceId?: string
  status: OverallStatus
  setupStatus?: FolderSetupStatus
  mode: SyncMode
  paused: boolean
  progress?: number
  bytesPerSecond?: number
  currentAction?: string
  fileCount?: number
  lastSyncedAt?: string
  ignorePatterns: string[]
  historyDays?: number
  historyMaxBytes?: number
  /** Files larger than this are excluded from sync. `null` and absent both mean no limit. */
  maxFileBytes?: number | null
  conflictCount?: number
  recoveryIssueCount?: number
  /**
   * Transient report set when the initial merge stops because a fresh scan
   * found inaccessible items the setup preview did not already cover. Never
   * persisted; cleared when the user continues or dismisses it.
   */
  scanIssues?: FolderScanIssueReport
}

export interface DeviceSummary {
  id: string
  name: string
  platform: "linux" | "windows" | "unknown"
  status: DeviceStatus
  route: ConnectionRoute
  address?: string
  lastSeenAt?: string
  fingerprint?: string
  pairedAt?: string
}

export interface PairingCandidate {
  id: string
  name: string
  platform: "linux" | "windows" | "unknown"
  address: string
  fingerprint: string
  lastSeenAt: string
  acceptingPairing: boolean
}

export interface IncomingPairingRequest {
  id: string
  sessionId: string
  device: PairingCandidate
  comparisonCode: string
  status: IncomingPairingStatus
  createdAt: string
}

export interface OutgoingPairingSession {
  id: string
  device: PairingCandidate
  comparisonCode?: string
  status: PairingSessionStatus
  message?: string
  createdAt: string
}

export interface PairingState {
  localFingerprint: string
  acceptingPairing: boolean
  acceptingPairingUntil?: string
  discoveredDevices: PairingCandidate[]
  incomingRequests: IncomingPairingRequest[]
  outgoingSession?: OutgoingPairingSession
}

export interface ActivityEvent {
  id: string
  level: ActivityLevel
  title: string
  detail: string
  occurredAt: string
  folderId?: string
}

export interface AppSettings {
  closeToTray: boolean
  launchAtLogin: boolean
  startMinimised: boolean
  pauseOnMetered: boolean
  theme: ThemePreference
  /**
   * Ceiling on files collected by one folder scan before it reports
   * `truncated`. `null` removes the ceiling for an explicitly opted-in
   * unbounded scan; the default is 10,000.
   */
  maxScanFiles: number | null
}

export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "downloaded"
  | "error"

/**
 * Discriminated update state shared over IPC snapshots.
 *
 * Each variant only carries the fields that are meaningful for that status so
 * callers cannot render nonsense combinations (for example a `downloading`
 * state without a percentage). `lastCheckedAt` is an ISO timestamp recording
 * the most recent feed response; `currentVersion` echoes `app.getVersion()`
 * so the renderer can state "You're on vX" without a separate IPC call.
 */
export type UpdateState =
  | { status: "idle"; currentVersion?: string; lastCheckedAt?: string }
  | { status: "checking"; currentVersion?: string; lastCheckedAt?: string }
  | {
      status: "available"
      version: string
      releaseNotes?: string
      releaseDate?: string
      currentVersion?: string
      lastCheckedAt?: string
    }
  | { status: "not-available"; currentVersion?: string; lastCheckedAt?: string }
  | {
      status: "downloading"
      version: string
      progressPercent: number
      bytesPerSecond?: number
      transferredBytes?: number
      totalBytes?: number
      currentVersion?: string
      lastCheckedAt?: string
    }
  | {
      status: "downloaded"
      version: string
      releaseNotes?: string
      releaseDate?: string
      currentVersion?: string
      lastCheckedAt?: string
    }
  | {
      status: "error"
      message: string
      version?: string
      currentVersion?: string
      lastCheckedAt?: string
    }

export interface MappingPreviewItem {
  path: string
  category: "local-only" | "remote-only" | "different" | "invalid-name" | "case-collision"
  size?: number
}

/**
 * One file or directory a scan could not read, with a user-facing reason
 * ("Permission denied", "No longer exists", ...). Paths are relative to the
 * scanned folder root; an empty path means the root itself. The reason never
 * carries an absolute path or a raw operating-system message.
 */
export interface FolderScanIssue {
  path: string
  reason: string
  kind: "file" | "directory"
}

/** A bounded per-side report of unreadable items; `localCount`/`remoteCount` carry the true totals. */
export interface FolderScanIssueReport {
  local: FolderScanIssue[]
  remote: FolderScanIssue[]
  localCount: number
  remoteCount: number
}

export interface FolderMappingPreview {
  localFiles: number
  remoteFiles: number
  identicalFiles: number
  differentFiles: number
  localOnlyFiles: number
  remoteOnlyFiles: number
  ignoredLocal: number
  ignoredRemote: number
  bytesToRemote: number
  bytesToLocal: number
  invalidWindowsNames: string[]
  caseCollisions: string[]
  truncated: boolean
  samples: MappingPreviewItem[]
  /**
   * Items that could not be read. Lists are bounded; the counts carry the
   * true totals. Both are absent on previews produced by older versions, so
   * consumers must treat missing values as zero.
   */
  unreadableLocal?: FolderScanIssue[]
  unreadableRemote?: FolderScanIssue[]
  unreadableLocalCount?: number
  unreadableRemoteCount?: number
}

export type FolderPreviewPhase = "scan-local" | "scan-remote" | "compare"

export interface FolderScanActivity {
  stage: "listing" | "inspecting" | "hashing" | "complete"
  currentPath: string
  scannedFiles: number
  ignoredEntries: number
  unreadableEntries: number
  hashedBytes: number
  /**
   * Files whose digest came from an earlier scan of the same tree instead of
   * being read again. Absent from older producers, which means zero.
   */
  reusedFiles?: number
}

/**
 * Transient progress for one folder-comparison operation. Emitted on the
 * `folders:preview-progress` channel, keyed by the client-generated
 * `operationId` the renderer passed with its IPC call so concurrent
 * comparisons in different dialogs never cross-talk. Never persisted.
 */
export interface FolderPreviewProgress {
  operationId: string
  phase: FolderPreviewPhase
  scannedFiles?: number
  activity?: FolderScanActivity
  /**
   * True when the comparison reused the scans from the operation's earlier
   * review step, so the UI does not present a cache-backed step as a fresh
   * folder scan.
   */
  reused?: boolean
}

export interface FolderMappingProposal {
  id: string
  name: string
  initiatorDeviceId: string
  initiatorDeviceName: string
  responderDeviceId: string
  initiatorPath: string
  responderPath: string
  mode: SyncMode
  ignorePatterns: string[]
  historyDays: number
  historyMaxBytes: number
  maxFileBytes: number | null
  preview: FolderMappingPreview
  createdAt: string
}

export interface IncomingMappingRequest {
  id: string
  fromDeviceId: string
  fromDeviceName: string
  proposal: FolderMappingProposal
  status: MappingRequestStatus
  selectedDestinationPath: string
  message?: string
}

export interface OutgoingMappingRequest {
  id: string
  toDeviceId: string
  toDeviceName: string
  proposal: FolderMappingProposal
  status: MappingRequestStatus
  message?: string
}

export interface MappingState {
  incoming: IncomingMappingRequest[]
  outgoing: OutgoingMappingRequest[]
}

export interface MappingStoreState {
  status: MappingStoreStatus
  detail?: string
  schemaVersion?: number
  migrationState?: "pending" | "completed" | "failed"
  journalMode?: string
  mutationsEnabled: boolean
  pendingDeliveryCount: number
  cleanupWarning?: string
}

export interface RecoveryConflict {
  mappingId: string
  folderName: string
  path: string
  kind: FileConflictKind
  detectedAt?: string
  localDeviceId: string
  localDeviceName: string
  localDigest?: string
  remoteDeviceId: string
  remoteDeviceName: string
  remoteDigest?: string
  resolutionQueued: boolean
  detail: string
}

export interface RecoveryIssue {
  id: string
  mappingId: string
  folderName: string
  path: string
  state: "recovery-required" | "integrity-failed"
  detail: string
}

export interface RecoveryState {
  conflicts: RecoveryConflict[]
  issues: RecoveryIssue[]
}

export interface ArchivedVersion {
  entryId: string
  path: string
  archivedAt: string
  replacedSize: number
  replacementSize: number
  origin: "sync" | "restore"
  availability: "available" | "missing" | "corrupt"
  restorable: boolean
  unavailableReason?: string
}

export interface ArchiveHistory {
  mappingId: string
  folderName: string
  versions: ArchivedVersion[]
  truncated: boolean
}

export interface ConflictInspectionInput {
  mappingId: string
  path: string
}

export interface ConflictCopyInspection {
  deviceId: string
  deviceName: string
  location: "this-computer" | "paired-computer"
  present: boolean
  digest?: string
  size?: number
  modifiedAt?: string
}

export interface ConflictInspection {
  conflict: RecoveryConflict
  local: ConflictCopyInspection
  remote: ConflictCopyInspection
}

export interface ConflictCopyExpectation {
  deviceId: string
  digest: string
  size: number
}

export interface ResolveFileConflictInput extends ConflictInspectionInput {
  winnerDeviceId: string
  inspectedCopies: [ConflictCopyExpectation, ConflictCopyExpectation]
}

export interface AppSnapshot {
  status: OverallStatus
  route: ConnectionRoute
  engineStatus: EngineStatus
  engineMessage?: string
  mappingStore: MappingStoreState
  peerName?: string
  paused: boolean
  folders: FolderSummary[]
  devices: DeviceSummary[]
  pairing: PairingState
  mappings: MappingState
  activity: ActivityEvent[]
  settings: AppSettings
  update: UpdateState
}

export interface AddFolderInput {
  name: string
  localPath: string
  remotePath: string
  remoteDeviceId: string
  mode: SyncMode
  ignorePatterns: string[]
  historyDays: number
  historyMaxBytes: number
  /** Files larger than this are excluded from sync. `null` means no limit. */
  maxFileBytes: number | null
}

export interface PreviewFolderMappingInput extends AddFolderInput {}

export interface RequestFolderMappingInput extends AddFolderInput {
  preview: FolderMappingPreview
}

export interface ApproveFolderMappingInput {
  requestId: string
  destinationPath: string
}

export interface RefreshIncomingMappingPreviewInput {
  requestId: string
  destinationPath: string
}

export interface DirectoryEntry {
  name: string
  path: string
  kind: DirectoryEntryKind
  hidden: boolean
}

export interface DirectoryLocation {
  id: string
  label: string
  path: string
  kind: DirectoryLocationKind
}

export interface DirectoryListing {
  deviceId: string
  deviceName: string
  currentPath: string
  parentPath: string | null
  separator: "/" | "\\"
  entries: DirectoryEntry[]
  locations: DirectoryLocation[]
  readOnly?: boolean
}

export interface BrowseDirectoryInput {
  deviceId: string
  path?: string
  includeHidden?: boolean
}

export interface CreateDirectoryInput {
  deviceId: string
  parentPath: string
  name: string
}

export type AppSettingKey = keyof AppSettings

export interface TetheraApi {
  getSnapshot(): Promise<AppSnapshot>
  retryMappingStore(): Promise<AppSnapshot>
  restoreArchivedVersion(entryId: string): Promise<AppSnapshot>
  listArchivedVersions(mappingId: string): Promise<ArchiveHistory>
  getRecoveryState(): Promise<RecoveryState>
  inspectFileConflict(input: ConflictInspectionInput): Promise<ConflictInspection>
  resolveFileConflict(input: ResolveFileConflictInput): Promise<AppSnapshot>
  revealConflictFile(input: ConflictInspectionInput): Promise<void>
  pauseAll(): Promise<AppSnapshot>
  resumeAll(): Promise<AppSnapshot>
  browseDirectory(input: BrowseDirectoryInput): Promise<DirectoryListing>
  createDirectory(input: CreateDirectoryInput): Promise<DirectoryListing>
  previewFolderMapping(input: PreviewFolderMappingInput, progressOperationId?: string): Promise<FolderMappingPreview>
  cancelFolderPreview(progressOperationId: string): Promise<void>
  requestFolderMapping(input: RequestFolderMappingInput, progressOperationId?: string): Promise<AppSnapshot>
  refreshIncomingMappingPreview(input: RefreshIncomingMappingPreviewInput, progressOperationId?: string): Promise<AppSnapshot>
  approveFolderMapping(input: ApproveFolderMappingInput, progressOperationId?: string): Promise<AppSnapshot>
  rejectFolderMapping(requestId: string): Promise<AppSnapshot>
  startInitialSync(folderId: string, acknowledgeUnreadable?: boolean): Promise<AppSnapshot>
  dismissInitialSyncIssues(folderId: string): Promise<AppSnapshot>
  addFolder(input: AddFolderInput): Promise<AppSnapshot>
  setFolderPaused(folderId: string, paused: boolean): Promise<AppSnapshot>
  removeFolder(folderId: string): Promise<AppSnapshot>
  revealPath(path: string): Promise<void>
  updateSetting<K extends AppSettingKey>(key: K, value: AppSettings[K]): Promise<AppSnapshot>
  setPairingAvailable(enabled: boolean): Promise<AppSnapshot>
  startPairing(deviceId: string): Promise<AppSnapshot>
  confirmPairing(sessionId: string): Promise<AppSnapshot>
  cancelPairing(sessionId: string): Promise<AppSnapshot>
  approvePairing(requestId: string): Promise<AppSnapshot>
  rejectPairing(requestId: string): Promise<AppSnapshot>
  revokeDevice(deviceId: string): Promise<AppSnapshot>
  showWindow(): Promise<void>
  checkForUpdates(): Promise<void>
  downloadUpdate(): Promise<void>
  quitAndInstall(): Promise<void>
  subscribe(listener: (snapshot: AppSnapshot) => void): () => void
  onPreviewProgress(listener: (progress: FolderPreviewProgress) => void): () => void
}
