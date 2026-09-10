import { contextBridge, ipcRenderer } from "electron"
import { unwrapFolderComparisonResult, type FolderComparisonResult } from "../shared/folder-comparison-result"
import type {
  AddFolderInput,
  AppSettingKey,
  AppSettings,
  AppSnapshot,
  ApproveFolderMappingInput,
  BrowseDirectoryInput,
  CreateDirectoryInput,
  ConflictInspectionInput,
  FolderPreviewProgress,
  FolderMappingPreview,
  TetheraApi,
  PreviewFolderMappingInput,
  RequestFolderMappingInput,
  RefreshIncomingMappingPreviewInput,
  ResolveFileConflictInput,
} from "../shared/contracts"

const api: TetheraApi = {
  getSnapshot: () => ipcRenderer.invoke("app:get-snapshot"),
  retryMappingStore: () => ipcRenderer.invoke("mapping-store:retry"),
  restoreArchivedVersion: (entryId: string) => ipcRenderer.invoke("archive:restore", entryId),
  listArchivedVersions: (mappingId: string) => ipcRenderer.invoke("archive:list-versions", mappingId),
  getRecoveryState: () => ipcRenderer.invoke("recovery:get-state"),
  inspectFileConflict: (input: ConflictInspectionInput) => ipcRenderer.invoke("recovery:inspect-conflict", input),
  resolveFileConflict: (input: ResolveFileConflictInput) => ipcRenderer.invoke("recovery:resolve-conflict", input),
  revealConflictFile: (input: ConflictInspectionInput) => ipcRenderer.invoke("recovery:reveal-conflict-file", input),
  pauseAll: () => ipcRenderer.invoke("app:pause-all"),
  resumeAll: () => ipcRenderer.invoke("app:resume-all"),
  browseDirectory: (input: BrowseDirectoryInput) => ipcRenderer.invoke("filesystem:browse-directory", input),
  createDirectory: (input: CreateDirectoryInput) => ipcRenderer.invoke("filesystem:create-directory", input),
  previewFolderMapping: (input: PreviewFolderMappingInput, progressOperationId?: string) =>
    invokeComparison<FolderMappingPreview>("folders:preview-mapping", input, progressOperationId),
  cancelFolderPreview: (progressOperationId: string) => ipcRenderer.invoke("folders:cancel-preview", progressOperationId),
  requestFolderMapping: (input: RequestFolderMappingInput, progressOperationId?: string) =>
    invokeComparison<AppSnapshot>("folders:request-mapping", input, progressOperationId),
  refreshIncomingMappingPreview: (input: RefreshIncomingMappingPreviewInput, progressOperationId?: string) =>
    invokeComparison<AppSnapshot>("folders:refresh-incoming-preview", input, progressOperationId),
  approveFolderMapping: (input: ApproveFolderMappingInput, progressOperationId?: string) =>
    invokeComparison<AppSnapshot>("folders:approve-mapping", input, progressOperationId),
  rejectFolderMapping: (requestId: string) => ipcRenderer.invoke("folders:reject-mapping", requestId),
  startInitialSync: (folderId: string) => ipcRenderer.invoke("folders:start-initial-sync", folderId),
  addFolder: (input: AddFolderInput) => ipcRenderer.invoke("folders:add", input),
  setFolderPaused: (folderId: string, paused: boolean) => ipcRenderer.invoke("folders:set-paused", folderId, paused),
  removeFolder: (folderId: string) => ipcRenderer.invoke("folders:remove", folderId),
  revealPath: (path: string) => ipcRenderer.invoke("shell:reveal-path", path),
  updateSetting: <K extends AppSettingKey>(key: K, value: AppSettings[K]) => ipcRenderer.invoke("settings:update", key, value),
  setPairingAvailable: (enabled: boolean) => ipcRenderer.invoke("pairing:set-available", enabled),
  startPairing: (deviceId: string) => ipcRenderer.invoke("pairing:start", deviceId),
  confirmPairing: (sessionId: string) => ipcRenderer.invoke("pairing:confirm", sessionId),
  cancelPairing: (sessionId: string) => ipcRenderer.invoke("pairing:cancel", sessionId),
  approvePairing: (requestId: string) => ipcRenderer.invoke("pairing:approve", requestId),
  rejectPairing: (requestId: string) => ipcRenderer.invoke("pairing:reject", requestId),
  revokeDevice: (deviceId: string) => ipcRenderer.invoke("pairing:revoke", deviceId),
  showWindow: () => ipcRenderer.invoke("window:show"),
  checkForUpdates: () => ipcRenderer.invoke("updates:check"),
  downloadUpdate: () => ipcRenderer.invoke("updates:download"),
  quitAndInstall: () => ipcRenderer.invoke("updates:install"),
  subscribe: (listener: (snapshot: AppSnapshot) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: AppSnapshot) => listener(snapshot)
    ipcRenderer.on("app:snapshot", handler)
    return () => ipcRenderer.removeListener("app:snapshot", handler)
  },
  onPreviewProgress: (listener: (progress: FolderPreviewProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: FolderPreviewProgress) => listener(progress)
    ipcRenderer.on("folders:preview-progress", handler)
    return () => ipcRenderer.removeListener("folders:preview-progress", handler)
  },
}

contextBridge.exposeInMainWorld("folderSync", api)

async function invokeComparison<T>(
  channel: "folders:preview-mapping" | "folders:request-mapping" | "folders:refresh-incoming-preview" | "folders:approve-mapping",
  input: PreviewFolderMappingInput | RequestFolderMappingInput | RefreshIncomingMappingPreviewInput | ApproveFolderMappingInput,
  progressOperationId?: string,
): Promise<T> {
  const result: FolderComparisonResult<T> = await ipcRenderer.invoke(channel, input, progressOperationId)
  return unwrapFolderComparisonResult(result)
}
