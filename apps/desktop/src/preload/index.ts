import { contextBridge, ipcRenderer } from "electron"
import type {
  AddFolderInput,
  AppSettingKey,
  AppSettings,
  AppSnapshot,
  FolderSyncApi,
} from "../shared/contracts"

const api: FolderSyncApi = {
  getSnapshot: () => ipcRenderer.invoke("app:get-snapshot"),
  pauseAll: () => ipcRenderer.invoke("app:pause-all"),
  resumeAll: () => ipcRenderer.invoke("app:resume-all"),
  chooseDirectory: () => ipcRenderer.invoke("dialog:choose-directory"),
  addFolder: (input: AddFolderInput) => ipcRenderer.invoke("folders:add", input),
  setFolderPaused: (folderId: string, paused: boolean) =>
    ipcRenderer.invoke("folders:set-paused", folderId, paused),
  removeFolder: (folderId: string) => ipcRenderer.invoke("folders:remove", folderId),
  revealPath: (targetPath: string) => ipcRenderer.invoke("shell:reveal-path", targetPath),
  updateSetting: <K extends AppSettingKey>(key: K, value: AppSettings[K]) =>
    ipcRenderer.invoke("settings:update", key, value),
  showWindow: () => ipcRenderer.invoke("window:show"),
  subscribe: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, nextSnapshot: AppSnapshot) => listener(nextSnapshot)
    ipcRenderer.on("app:snapshot", handler)
    return () => ipcRenderer.removeListener("app:snapshot", handler)
  },
}

contextBridge.exposeInMainWorld("folderSync", api)
