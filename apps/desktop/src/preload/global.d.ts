import type { TetheraApi } from "../shared/contracts"

declare global {
  interface Window {
    folderSync: TetheraApi
  }
}

export {}
