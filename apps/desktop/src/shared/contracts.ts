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
}

export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "downloaded"
  | "error"

export interface UpdateState {
  status: UpdateStatus
  version?: string
  progressPercent?: number
  message?: string
}

export interface MappingPreviewItem {
  path: string
  category: "local-only" | "remote-only" | "different" | "invalid-name" | "case-collision"
  size?: number
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
  pauseAll(): Promise<AppSnapshot>
  resumeAll(): Promise<AppSnapshot>
  browseDirectory(input: BrowseDirectoryInput): Promise<DirectoryListing>
  createDirectory(input: CreateDirectoryInput): Promise<DirectoryListing>
  previewFolderMapping(input: PreviewFolderMappingInput): Promise<FolderMappingPreview>
  requestFolderMapping(input: RequestFolderMappingInput): Promise<AppSnapshot>
  refreshIncomingMappingPreview(input: RefreshIncomingMappingPreviewInput): Promise<AppSnapshot>
  approveFolderMapping(input: ApproveFolderMappingInput): Promise<AppSnapshot>
  rejectFolderMapping(requestId: string): Promise<AppSnapshot>
  startInitialSync(folderId: string): Promise<AppSnapshot>
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
}
