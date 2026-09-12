import { createHash } from "node:crypto"
import type { FileManifest } from "../src/main/folder-manifest"
import type { AppSnapshot } from "../src/shared/contracts"

export function appSnapshot(overrides: Partial<AppSnapshot> = {}): AppSnapshot {
  return {
    status: "offline", route: "offline", engineStatus: "ready", paused: false,
    mappingStore: { status: "ready", mutationsEnabled: true, pendingDeliveryCount: 0 },
    folders: [], devices: [], activity: [],
    pairing: { localFingerprint: "test-device", acceptingPairing: false, discoveredDevices: [], incomingRequests: [] },
    mappings: { incoming: [], outgoing: [] },
    settings: { closeToTray: true, launchAtLogin: false, startMinimised: false, pauseOnMetered: true, theme: "system" },
    update: { status: "idle" },
    ...overrides,
  }
}

/** Builds a minimal in-memory manifest for comparison and sync-plan tests. */
export function manifest(files: FileManifest["files"], unreadableEntries: FileManifest["unreadableEntries"] = []): FileManifest {
  return { rootPath: "/tmp/test", files, ignored: 0, unreadable: unreadableEntries.length, unreadableEntries, truncated: false }
}

/** Lowercase SHA-256 hex digest used to build deterministic fixtures. */
export function sha256Hex(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex")
}
