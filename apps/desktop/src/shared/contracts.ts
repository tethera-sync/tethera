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
export type DeviceStatus = "this-device" | "online" | "offline" | "unpaired"
export type SyncMode = "two-way" | "send-only" | "receive-only"
export type ActivityLevel = "info" | "success" | "warning" | "error"
export type ThemePreference = "system" | "light" | "dark"

export interface FolderSummary {
  id: string
  name: string
  localPath: string
  remotePath: string
  status: OverallStatus
  mode: SyncMode
  paused: boolean
  progress?: number
  bytesPerSecond?: number
  currentAction?: string
  fileCount?: number
  lastSyncedAt?: string
  ignorePatterns: string[]
}

export interface DeviceSummary {
  id: string
  name: string
  platform: "linux" | "windows" | "unknown"
  status: DeviceStatus
  route: ConnectionRoute
  address?: string
  lastSeenAt?: string
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

export interface AppSnapshot {
  status: OverallStatus
  route: ConnectionRoute
  engineStatus: EngineStatus
  engineMessage?: string
  peerName?: string
  paused: boolean
  folders: FolderSummary[]
  devices: DeviceSummary[]
  activity: ActivityEvent[]
  settings: AppSettings
}

export interface AddFolderInput {
  name: string
  localPath: string
  remotePath: string
  mode: SyncMode
  ignorePatterns: string[]
}

export type AppSettingKey = keyof AppSettings

export interface FolderSyncApi {
  getSnapshot(): Promise<AppSnapshot>
  pauseAll(): Promise<AppSnapshot>
  resumeAll(): Promise<AppSnapshot>
  chooseDirectory(): Promise<string | null>
  addFolder(input: AddFolderInput): Promise<AppSnapshot>
  setFolderPaused(folderId: string, paused: boolean): Promise<AppSnapshot>
  removeFolder(folderId: string): Promise<AppSnapshot>
  revealPath(path: string): Promise<void>
  updateSetting<K extends AppSettingKey>(key: K, value: AppSettings[K]): Promise<AppSnapshot>
  showWindow(): Promise<void>
  subscribe(listener: (snapshot: AppSnapshot) => void): () => void
}
