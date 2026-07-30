import type { FolderSyncApi } from "../shared/contracts"

declare global {
  interface Window {
    folderSync: FolderSyncApi
  }
}

export {}
