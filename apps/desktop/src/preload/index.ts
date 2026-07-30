import { contextBridge, ipcRenderer } from "electron"
import type {
  AddFolderInput,
  AppSettingKey,
  AppSettings,
  AppSnapshot,
  ApproveFolderMappingInput,
  BrowseDirectoryInput,
  CreateDirectoryInput,
  FolderSyncApi,
  PreviewFolderMappingInput,
  RequestFolderMappingInput,
  RefreshIncomingMappingPreviewInput,
} from "../shared/contracts"

const api: FolderSyncApi = {
  getSnapshot: () => ipcRenderer.invoke("app:get-snapshot"),
  pauseAll: () => ipcRenderer.invoke("app:pause-all"),
  resumeAll: () => ipcRenderer.invoke("app:resume-all"),
  browseDirectory: (input: BrowseDirectoryInput) => ipcRenderer.invoke("filesystem:browse-directory", input),
  createDirectory: (input: CreateDirectoryInput) => ipcRenderer.invoke("filesystem:create-directory", input),
  previewFolderMapping: (input: PreviewFolderMappingInput) => ipcRenderer.invoke("folders:preview-mapping", input),
  requestFolderMapping: (input: RequestFolderMappingInput) => ipcRenderer.invoke("folders:request-mapping", input),
  refreshIncomingMappingPreview: (input: RefreshIncomingMappingPreviewInput) => ipcRenderer.invoke("folders:refresh-incoming-preview", input),
  approveFolderMapping: (input: ApproveFolderMappingInput) => ipcRenderer.invoke("folders:approve-mapping", input),
  rejectFolderMapping: (requestId: string) => ipcRenderer.invoke("folders:reject-mapping", requestId),
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
  subscribe: (listener: (snapshot: AppSnapshot) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: AppSnapshot) => listener(snapshot)
    ipcRenderer.on("app:snapshot", handler)
    return () => ipcRenderer.removeListener("app:snapshot", handler)
  },
}

contextBridge.exposeInMainWorld("folderSync", api)
