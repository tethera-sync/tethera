import type { AppSnapshot, DeviceSummary, FolderSummary, MappingStoreState, TetheraApi } from "@shared/contracts"
import { pretty } from "./format"

/** The device entry representing this computer, with a fallback while the snapshot loads. */
export function getLocalDevice(snapshot: AppSnapshot): DeviceSummary {
  return (
    snapshot.devices.find((device) => device.status === "this-device") ?? {
      id: "local-device",
      name: "This computer",
      platform: "unknown",
      status: "this-device",
      route: "offline",
    }
  )
}

/** Paired computers, excluding the local device and unpaired discoveries. */
export function getPairedDevices(snapshot: AppSnapshot): DeviceSummary[] {
  return snapshot.devices.filter(
    (device) => device.id !== "local-device" && (device.status === "online" || device.status === "offline"),
  )
}

/** Whether mapping mutations are durably safe right now, with the reason to show when they are not. */
export function mappingMutationAvailability(state: MappingStoreState): { enabled: boolean; reason: string } {
  return {
    enabled: state.status === "ready" && state.mutationsEnabled,
    reason: state.detail ?? "The mapping database must be ready before configuration can change.",
  }
}

/** Headline for the overview status card, prioritising the most actionable state. */
export function overallHeadline(snapshot: AppSnapshot): string {
  if (snapshot.engineStatus === "starting" || snapshot.mappingStore.status === "loading") return "Getting ready to sync"
  if (snapshot.engineStatus !== "ready" || !mappingMutationAvailability(snapshot.mappingStore).enabled) return "Sync is unavailable"
  if (snapshot.paused) return "Everything is safely paused"
  if (getPairedDevices(snapshot).length === 0) return "Pair your second computer first"
  if (snapshot.route === "offline") return `${getPairedDevices(snapshot)[0]?.name ?? "The paired computer"} is offline`
  if (snapshot.folders.some((folder) => folder.setupStatus === "ready-for-initial-sync")) return "Ready for the initial merge"
  if (snapshot.status === "needs-attention") return "A folder needs your attention"
  if (snapshot.status === "syncing") return "Synchronizing folder changes"
  if (snapshot.folders.length === 0) return "Ready for your first folder"
  return "Everything is up to date"
}

/** Supporting copy for the overview status card. */
export function overallDescription(snapshot: AppSnapshot): string {
  if (snapshot.engineStatus === "starting" || snapshot.mappingStore.status === "loading") return "Loading your saved folders and checking that syncing can start safely."
  if (snapshot.engineStatus !== "ready" || !mappingMutationAvailability(snapshot.mappingStore).enabled) return "Tethera cannot sync right now. Use Retry above, or open Settings to review the connection to your saved folder configuration."
  if (snapshot.paused) return "Folder changes will remain local until you resume syncing."
  if (getPairedDevices(snapshot).length === 0) return "Folder selection stays locked until both computers approve a secure pairing."
  if (snapshot.route === "offline") {
    return snapshot.folders.length === 0
      ? "Bring the paired computer online before choosing the first folder."
      : "Your folder mappings are saved. Syncing will resume when the paired computer reconnects."
  }
  if (snapshot.folders.length === 0) return "Choose one folder on this computer and its destination on the paired device."
  if (snapshot.folders.some((folder) => folder.setupStatus === "ready-for-initial-sync")) {
    return "Start the merge on either computer to copy missing files safely in the configured direction."
  }
  if (snapshot.status === "syncing") return "Tethera is verifying and transferring changed files over the secure peer connection."
  if (snapshot.status === "needs-attention") return "Review the affected folder. Tethera leaves ambiguous versions and deletions untouched."
  return "Tethera is watching each active folder and will synchronize safe changes automatically."
}

/** User-facing folder status, accounting for mappings still awaiting their initial merge. */
export function folderStatusLabel(folder: FolderSummary): string {
  if (folder.status === "up-to-date" && folder.setupStatus === "active") return "Up to date"
  if (folder.status === "needs-attention" && folder.setupStatus === "ready-for-initial-sync") return "Ready for initial merge"
  return pretty(folder.status)
}

export interface SnapshotSubscription {
  getSnapshot(): AppSnapshot
  subscribe(listener: (snapshot: AppSnapshot) => void): () => void
  loadInitial(): Promise<void>
  beginAction(): number
  applyActionResult(snapshot: AppSnapshot, revision: number): boolean
}

/**
 * Keeps pushed snapshots authoritative over an older request that was already
 * in flight when the renderer subscribed.
 */
export function createSnapshotSubscription(api: Pick<TetheraApi, "getSnapshot" | "subscribe">, fallback: AppSnapshot): SnapshotSubscription {
  let current = fallback
  let revision = 0
  let activeListener: ((snapshot: AppSnapshot) => void) | null = null

  function publish(snapshot: AppSnapshot) {
    current = snapshot
    revision += 1
    activeListener?.(snapshot)
  }

  return {
    getSnapshot: () => current,
    subscribe(listener) {
      activeListener = listener
      const unsubscribe = api.subscribe((snapshot) => publish(snapshot))
      return () => {
        if (activeListener === listener) activeListener = null
        unsubscribe()
      }
    },
    async loadInitial() {
      const requestRevision = revision
      try {
        const snapshot = await api.getSnapshot()
        if (revision === requestRevision) publish(snapshot)
      } catch (error: unknown) {
        if (revision === requestRevision) throw error
      }
    },
    beginAction: () => revision,
    applyActionResult(snapshot, actionRevision) {
      if (revision !== actionRevision) return false
      publish(snapshot)
      return true
    },
  }
}
