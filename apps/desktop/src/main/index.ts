import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  type MenuItemConstructorOptions,
  shell,
  Tray,
} from "electron"
import { autoUpdater } from "electron-updater"
import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, readdir, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import type {
  AddFolderInput,
  AppSettingKey,
  AppSettings,
  AppSnapshot,
  ApproveFolderMappingInput,
  BrowseDirectoryInput,
  CreateDirectoryInput,
  DeviceSummary,
  DirectoryEntry,
  DirectoryListing,
  DirectoryLocation,
  FolderMappingProposal,
  FolderMappingPreview,
  FolderSummary,
  IncomingMappingRequest,
  MappingState,
  PairingState,
  PreviewFolderMappingInput,
  RequestFolderMappingInput,
  RefreshIncomingMappingPreviewInput,
  UpdateState,
} from "../shared/contracts"
import {
  EngineRpcError,
  EngineSupervisor,
  type EngineState,
  type MappingStoreHealth,
} from "./engine-supervisor"
import { compareManifests, scanFolder, type FileManifest } from "./folder-manifest"
import { computeSyncPlan, MAX_TRANSFER_FILE_BYTES, writeFileAtomic } from "./initial-sync"
import {
  folderFromMappingRecord,
  mappingConfigurationFromProposal,
  type MappingAcknowledgement,
  type MappingApplyOutcome,
  type MappingConfiguration,
  type MappingDelivery,
  type MappingEvent,
  type MappingRecord,
} from "./mapping-index"
import {
  initializeMappingAuthority,
  MappingAuthorityInitializationError,
} from "./mapping-authority"
import {
  readLegacyState,
  retireLegacyMappingFields,
  type LegacyStateSource,
} from "./legacy-mapping-migration"
import {
  buildPersistedDesktopState,
  DesktopStateStore,
} from "./desktop-state-storage"
import { PairingService } from "./pairing-service"
import { PeerSessionService, type PeerRequest, type PeerRequestContext } from "./peer-session-service"
import { resolveWithinRoot } from "./path-safety"

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
let snapshot: AppSnapshot
let decisionRetryTimer: NodeJS.Timeout | null = null
const decisionDeliveriesInFlight = new Set<string>()
const configurationDeliveriesInFlight = new Set<string>()
const initialSyncInFlight = new Set<string>()
const mappingRecords = new Map<string, MappingRecord>()
let legacyStateSource: LegacyStateSource = { kind: "missing", document: {}, modifiedAt: new Date(0).toISOString() }
let desktopStateStore: DesktopStateStore
let mappingOwnershipRetired = false
let mappingAuthorityInitialization: Promise<void> | null = null

const engine = new EngineSupervisor()
let pairing: PairingService | null = null
let peerSessions: PeerSessionService | null = null
const execFileAsync = promisify(execFile)

const emptyPairingState: PairingState = {
  localFingerprint: "Loading…",
  acceptingPairing: false,
  discoveredDevices: [],
  incomingRequests: [],
}

const emptyMappingState: MappingState = { incoming: [], outgoing: [] }
const idleUpdateState: UpdateState = { status: "idle" }

const defaultSettings: AppSettings = {
  closeToTray: true,
  launchAtLogin: false,
  startMinimised: false,
  pauseOnMetered: true,
  theme: "system",
}

function platform(): DeviceSummary["platform"] {
  return process.platform === "win32" ? "windows" : process.platform === "linux" ? "linux" : "unknown"
}

function getLocalDevice(): DeviceSummary {
  return {
    id: "local-device",
    name: os.hostname(),
    platform: platform(),
    status: "this-device",
    route: "offline",
  }
}

function getLocalIdentityId(): string {
  return pairing?.getLocalSessionIdentity().id ?? "local-device"
}

function getPairedDevices(): DeviceSummary[] {
  return snapshot.devices.filter(
    (device) => device.id !== "local-device" && (device.status === "online" || device.status === "offline"),
  )
}

function getPairedDevice(deviceId?: string): DeviceSummary | undefined {
  const devices = getPairedDevices()
  return deviceId ? devices.find((device) => device.id === deviceId) : devices[0]
}

function getInitialSnapshot(): AppSnapshot {
  return {
    status: "offline",
    route: "offline",
    engineStatus: "starting",
    engineMessage: "Checking the Rust sync engine…",
    mappingStore: {
      status: "loading",
      mutationsEnabled: false,
      pendingDeliveryCount: 0,
    },
    paused: false,
    folders: [],
    devices: [getLocalDevice()],
    pairing: emptyPairingState,
    mappings: emptyMappingState,
    activity: [
      {
        id: randomUUID(),
        level: "info",
        title: "Pair your second computer",
        detail: "Folder mappings stay locked until this computer has a trusted paired peer.",
        occurredAt: new Date().toISOString(),
      },
    ],
    settings: defaultSettings,
    update: idleUpdateState,
  }
}

function stateFilePath(): string {
  return path.join(app.getPath("userData"), "state.json")
}

async function loadState(): Promise<void> {
  snapshot = getInitialSnapshot()
  legacyStateSource = await readLegacyState(stateFilePath())
  const readable = legacyStateSource.kind !== "unreadable"
  const loadedDocument = legacyStateSource.kind === "unreadable" ? {} : legacyStateSource.document
  desktopStateStore = new DesktopStateStore(stateFilePath(), loadedDocument, readable)
  mappingOwnershipRetired = readable && !Object.hasOwn(loadedDocument, "folders")

  if (legacyStateSource.kind !== "unreadable") {
    const parsed = loadedDocument as Partial<AppSnapshot>
    snapshot = {
      ...snapshot,
      ...parsed,
      // Mapping ownership is never hydrated from this legacy field. It is retained in
      // `legacyStateSource` only until the one-time SQLite transaction is verified.
      folders: [],
      engineStatus: "starting",
      engineMessage: "Checking the Rust sync engine…",
      mappingStore: {
        status: "loading",
        mutationsEnabled: false,
        pendingDeliveryCount: 0,
      },
      devices: [getLocalDevice()],
      pairing: emptyPairingState,
      mappings: {
        incoming: parsed.mappings?.incoming ?? [],
        outgoing: parsed.mappings?.outgoing ?? [],
      },
      settings: { ...defaultSettings, ...(parsed.settings ?? {}) },
      update: idleUpdateState,
    }
  } else {
    pushActivity("Desktop state unavailable", legacyStateSource.detail, "error")
  }

  recomputeOverallStatus()
}

async function persistState(): Promise<void> {
  if (!desktopStateStore.writesEnabled) {
    console.warn("[state] state.json is unreadable; refusing to overwrite it")
    return
  }
  await desktopStateStore.update((current) =>
    buildPersistedDesktopState(
      current,
      {
        paused: snapshot.paused,
        mappings: snapshot.mappings,
        activity: snapshot.activity,
        settings: snapshot.settings,
      },
      mappingOwnershipRetired,
    ),
  )
}

function idleFolderStatus(): FolderSummary["status"] {
  if (getPairedDevices().length === 0) return "needs-attention"
  return "offline"
}

function recomputeOverallStatus(): void {
  if (snapshot.paused) {
    snapshot.status = "paused"
    return
  }
  if (snapshot.folders.some((folder) => folder.status === "needs-attention")) {
    snapshot.status = "needs-attention"
    return
  }
  if (snapshot.folders.some((folder) => folder.status === "syncing")) {
    snapshot.status = "syncing"
    return
  }
  if (
    snapshot.folders.length === 0 ||
    snapshot.folders.some((folder) => folder.status === "offline") ||
    getPairedDevices().length === 0 ||
    snapshot.engineStatus !== "ready" ||
    snapshot.route === "offline"
  ) {
    snapshot.status = "offline"
    return
  }
  snapshot.status = "up-to-date"
}

function pushActivity(
  title: string,
  detail: string,
  level: "info" | "success" | "warning" | "error" = "info",
  folderId?: string,
): void {
  snapshot.activity = [
    {
      id: randomUUID(),
      title,
      detail,
      level,
      folderId,
      occurredAt: new Date().toISOString(),
    },
    ...snapshot.activity,
  ].slice(0, 100)
}

function broadcastSnapshot(): AppSnapshot {
  recomputeOverallStatus()
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send("app:snapshot", snapshot)
  rebuildTrayMenu()
  return snapshot
}

async function mutate(mutator: () => void): Promise<AppSnapshot> {
  mutator()
  recomputeOverallStatus()
  await persistState()
  return broadcastSnapshot()
}

function requirePairingService(): PairingService {
  if (!pairing) throw new Error("The pairing service is not ready.")
  return pairing
}

function requirePeerSessions(): PeerSessionService {
  if (!peerSessions) throw new Error("The secure peer-session service is not ready.")
  return peerSessions
}

function syncPairingSnapshot(): AppSnapshot {
  if (!pairing) return snapshot
  const trustedDevices = pairing.getTrustedDevices()
  snapshot.pairing = pairing.getState()
  snapshot.devices = [
    { ...getLocalDevice(), fingerprint: snapshot.pairing.localFingerprint },
    ...trustedDevices,
  ]

  const onlinePeer = trustedDevices.find((device) => device.status === "online")
  snapshot.route = onlinePeer?.route ?? "offline"
  snapshot.peerName = onlinePeer?.name
  snapshot.folders = snapshot.folders.map((folder) => {
    if (folder.paused || snapshot.paused) return { ...folder, status: "paused" }
    if (!folder.remoteDeviceId || !trustedDevices.some((device) => device.id === folder.remoteDeviceId)) {
      return { ...folder, status: "needs-attention" }
    }
    return { ...folder, status: "offline" }
  })
  void flushPendingMappingDecisions()
  void flushPendingConfigurationDeliveries()
  return broadcastSnapshot()
}

async function startNetworkServices(): Promise<void> {
  pairing = new PairingService({
    dataDirectory: app.getPath("userData"),
    deviceName: os.hostname(),
    platform: platform(),
  })

  pairing.on("change", () => syncPairingSnapshot())
  pairing.on("incoming", (request: { device: { name: string } }) => {
    pushActivity(
      "Pairing request received",
      `${request.device.name} wants to pair. Compare the code on both computers before approving.`,
      "info",
    )
    syncPairingSnapshot()
  })
  pairing.on("paired", (device: { id: string; name: string }) => {
    pushActivity("Device paired", `${device.name} is now a trusted Tethera device.`, "success")
    syncPairingSnapshot()
    void persistState()
  })
  pairing.on("revoked", (device: { id: string; name: string }) => {
    snapshot.folders = snapshot.folders.map((folder) =>
      folder.remoteDeviceId === device.id ? { ...folder, status: "needs-attention" } : folder,
    )
    pushActivity("Device trust removed", `${device.name} can no longer access this Tethera installation.`, "warning")
    syncPairingSnapshot()
    void persistState()
  })
  pairing.on("error-state", (error: Error) => {
    pushActivity("Pairing service problem", error.message, "error")
    broadcastSnapshot()
  })

  await pairing.start()
  peerSessions = new PeerSessionService({ pairing, onRequest: handlePeerRequest })
  peerSessions.on("error-state", (error: Error) => {
    pushActivity("Secure peer session problem", error.message, "error")
    broadcastSnapshot()
  })
  await peerSessions.start()
  decisionRetryTimer = setInterval(() => {
    void flushPendingMappingDecisions()
    void flushPendingConfigurationDeliveries()
  }, 5_000)
  syncPairingSnapshot()
}

async function setAllPaused(paused: boolean): Promise<AppSnapshot> {
  return mutate(() => {
    snapshot.paused = paused
    snapshot.folders = snapshot.folders.map((folder) => ({
      ...folder,
      status: paused || folder.paused ? "paused" : idleFolderStatus(),
    }))
    pushActivity(
      paused ? "Syncing paused" : "Syncing resumed",
      paused ? "All configured folders were paused." : "Configured folders can sync when the paired device is online.",
      paused ? "warning" : "success",
    )
  })
}

function normaliseBrowsePath(requestedPath?: string): string {
  const candidate = requestedPath?.trim() || os.homedir()
  if (candidate.includes("\0")) throw new Error("The folder path is invalid.")
  return path.resolve(candidate)
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath)
    return true
  } catch {
    return false
  }
}

async function getWindowsDriveLocations(): Promise<DirectoryLocation[]> {
  const fallbackRoot = path.parse(os.homedir()).root
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[System.IO.DriveInfo]::GetDrives() | Where-Object { $_.IsReady } | ForEach-Object { $_.Name }",
      ],
      { windowsHide: true },
    )
    const roots = stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
    return (roots.length > 0 ? roots : [fallbackRoot]).map((root) => ({
      id: `drive:${root.toLowerCase()}`,
      label: root.replace(/[\\/]$/, ""),
      path: root,
      kind: "drive" as const,
    }))
  } catch {
    return [{ id: `drive:${fallbackRoot.toLowerCase()}`, label: fallbackRoot, path: fallbackRoot, kind: "drive" }]
  }
}

async function getUnixMountLocations(): Promise<DirectoryLocation[]> {
  const username = os.userInfo().username
  const mountParents = ["/mnt", `/media/${username}`, `/run/media/${username}`]
  const locations: DirectoryLocation[] = []
  for (const parent of mountParents) {
    try {
      const entries = await readdir(parent, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const mountPath = path.join(parent, entry.name)
        locations.push({ id: `mount:${mountPath}`, label: entry.name, path: mountPath, kind: "mount" })
      }
    } catch {
      // Optional mount roots are often absent.
    }
  }
  return locations
}

async function getDirectoryLocations(): Promise<DirectoryLocation[]> {
  const home = os.homedir()
  const candidates: DirectoryLocation[] = [
    { id: "home", label: "Home", path: home, kind: "home" },
    { id: "desktop", label: "Desktop", path: path.join(home, "Desktop"), kind: "desktop" },
    { id: "documents", label: "Documents", path: path.join(home, "Documents"), kind: "documents" },
    { id: "downloads", label: "Downloads", path: path.join(home, "Downloads"), kind: "downloads" },
  ]
  if (process.platform === "win32") candidates.push(...(await getWindowsDriveLocations()))
  else {
    candidates.push({ id: "root", label: "Computer", path: path.parse(home).root, kind: "root" })
    candidates.push(...(await getUnixMountLocations()))
  }

  const deduplicated = new Map<string, DirectoryLocation>()
  for (const location of candidates) {
    if (await pathExists(location.path)) deduplicated.set(path.resolve(location.path), location)
  }
  return [...deduplicated.values()]
}

async function readDirectoryEntry(parentPath: string, name: string, isDirectory: boolean, isSymbolicLink: boolean): Promise<DirectoryEntry | null> {
  const entryPath = path.join(parentPath, name)
  if (isDirectory) return { name, path: entryPath, kind: "directory", hidden: name.startsWith(".") }
  if (!isSymbolicLink) return null
  try {
    const linked = await stat(entryPath)
    if (!linked.isDirectory()) return null
    return { name, path: entryPath, kind: "symlink", hidden: name.startsWith(".") }
  } catch {
    return null
  }
}

async function browseHostDirectory(
  requestedPath: string | undefined,
  includeHidden: boolean | undefined,
  deviceId: string,
  deviceName: string,
  readOnly = false,
): Promise<DirectoryListing> {
  const currentPath = normaliseBrowsePath(requestedPath)
  const currentStat = await stat(currentPath)
  if (!currentStat.isDirectory()) throw new Error("The selected path is not a folder.")
  const dirents = await readdir(currentPath, { withFileTypes: true })
  const entries = (
    await Promise.all(dirents.map((entry) => readDirectoryEntry(currentPath, entry.name, entry.isDirectory(), entry.isSymbolicLink())))
  )
    .filter((entry): entry is DirectoryEntry => Boolean(entry))
    .filter((entry) => includeHidden || !entry.hidden)
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }))
  return {
    deviceId,
    deviceName,
    currentPath,
    parentPath: path.dirname(currentPath) === currentPath ? null : path.dirname(currentPath),
    separator: path.sep === "\\" ? "\\" : "/",
    entries,
    locations: await getDirectoryLocations(),
    readOnly,
  }
}

async function browseDirectory(input: BrowseDirectoryInput): Promise<DirectoryListing> {
  if (input.deviceId === "local-device") {
    return browseHostDirectory(input.path, input.includeHidden, "local-device", getLocalDevice().name)
  }
  const peer = getPairedDevice(input.deviceId)
  if (!peer) throw new Error("This device is not paired.")
  if (peer.status !== "online") throw new Error(`${peer.name} is offline.`)
  const listing = await requirePeerSessions().request<DirectoryListing>(peer.id, {
    type: "browse-directory",
    path: input.path,
    includeHidden: Boolean(input.includeHidden),
  })
  return { ...listing, deviceId: peer.id, deviceName: peer.name, readOnly: true }
}

async function createLocalDirectory(input: CreateDirectoryInput): Promise<DirectoryListing> {
  if (input.deviceId !== "local-device") {
    throw new Error("Create the destination folder on the other computer when approving the mapping request.")
  }
  const name = input.name.trim()
  if (!name || name === "." || name === ".." || /[\\/\0]/.test(name)) {
    throw new Error("Enter a valid folder name without slashes.")
  }
  const parentPath = normaliseBrowsePath(input.parentPath)
  await mkdir(path.join(parentPath, name))
  return browseHostDirectory(parentPath, true, "local-device", getLocalDevice().name)
}

function validateMappingInput(input: AddFolderInput): void {
  if (!input.localPath?.trim() || !input.remotePath?.trim()) throw new Error("Choose both folders before continuing.")
  if (!input.remoteDeviceId?.trim()) throw new Error("Choose a paired computer.")
  if (!(["two-way", "send-only", "receive-only"] as const).includes(input.mode)) throw new Error("The sync direction is invalid.")
  if (!Number.isInteger(input.historyDays) || input.historyDays < 1 || input.historyDays > 3_650) {
    throw new Error("Version history must be between 1 and 3,650 days.")
  }
  if (!Number.isSafeInteger(input.historyMaxBytes) || input.historyMaxBytes < 1024 ** 3 || input.historyMaxBytes > 4 * 1024 ** 4) {
    throw new Error("The history storage cap must be between 1 GB and 4 TB.")
  }
  if (!Array.isArray(input.ignorePatterns) || input.ignorePatterns.length > 256) {
    throw new Error("Use no more than 256 ignore patterns.")
  }
  if (input.ignorePatterns.some((pattern) => typeof pattern !== "string" || pattern.length > 512 || pattern.includes("\0"))) {
    throw new Error("An ignore pattern is invalid or too long.")
  }
  if (input.name.length > 120) throw new Error("The folder name must be 120 characters or fewer.")
}

function requireMappingMutations(): void {
  if (
    engine.state.status !== "ready" ||
    snapshot.mappingStore.status !== "ready" ||
    !snapshot.mappingStore.mutationsEnabled
  ) {
    throw new Error(
      snapshot.mappingStore.detail ??
        "The authoritative mapping database is not ready. Mapping changes are disabled to protect existing configuration.",
    )
  }
}

function mappingStoreStateFromHealth(health: MappingStoreHealth): AppSnapshot["mappingStore"] {
  const status = mappingStoreStatusFromHealth(health)
  return {
    status,
    detail: health.detail,
    schemaVersion: health.schemaVersion,
    migrationState: health.migrationState,
    journalMode: health.journalMode,
    mutationsEnabled: status === "ready" && health.mutationsEnabled,
    pendingDeliveryCount: snapshot.mappingStore.pendingDeliveryCount,
  }
}

function mappingStoreStatusFromHealth(health: MappingStoreHealth): AppSnapshot["mappingStore"]["status"] {
  if (health.status === "unsupported-schema") return "unsupported-schema"
  if (health.status === "migration-failed" || health.migrationState === "failed") return "migration-failed"
  if (health.status !== "ready") return "unavailable"
  if (health.migrationState !== "completed") return "migration-required"
  return "ready"
}

function hydrateAuthoritativeMappings(records: MappingRecord[]): void {
  mappingRecords.clear()
  for (const record of records) mappingRecords.set(record.mapping.id, record)
  const previous = new Map(snapshot.folders.map((folder) => [folder.id, folder]))
  const localDeviceId = getLocalIdentityId()
  snapshot.folders = records.flatMap((record) => {
    const projected = folderFromMappingRecord(record, localDeviceId)
    if (!projected) return []
    const runtime = previous.get(projected.id)
    const peerTrusted = projected.remoteDeviceId
      ? getPairedDevices().some((device) => device.id === projected.remoteDeviceId)
      : false
    return [
      {
        ...projected,
        ...(runtime
          ? {
              progress: runtime.progress,
              bytesPerSecond: runtime.bytesPerSecond,
              fileCount: runtime.fileCount,
              lastSyncedAt: runtime.lastSyncedAt,
              currentAction: projected.currentAction ?? runtime.currentAction,
            }
          : {}),
        status:
          projected.paused || snapshot.paused
            ? "paused"
            : peerTrusted
              ? "offline"
              : "needs-attention",
      },
    ]
  })
}

async function refreshAuthoritativeMappings(): Promise<void> {
  const [records, pending] = await Promise.all([
    engine.request<MappingRecord[]>("mapping.list"),
    engine.request<MappingDelivery[]>("mapping.listPendingDelivery"),
  ])
  hydrateAuthoritativeMappings(records)
  snapshot.mappingStore.pendingDeliveryCount = pending.length
}

async function initializeAuthoritativeMappings(health: MappingStoreHealth): Promise<void> {
  if (mappingAuthorityInitialization) return await mappingAuthorityInitialization
  const generation = engine.generation
  mappingAuthorityInitialization = (async () => {
    const reportedState = mappingStoreStateFromHealth(health)
    snapshot.mappingStore =
      health.status === "ready"
        ? { ...reportedState, status: "loading", mutationsEnabled: false }
        : reportedState
    broadcastSnapshot()
    if (health.status !== "ready") return

    try {
      const identity = requirePairingService().getLocalSessionIdentity()
      const result = await initializeMappingAuthority({
        rpc: engine,
        statePath: stateFilePath(),
        legacySource: legacyStateSource,
        localDeviceId: identity.id,
        localDeviceName: identity.name,
        remoteDeviceName: (deviceId) => getPairedDevice(deviceId)?.name ?? deviceId,
        retireLegacyState: async ({ sourceFingerprint, backupFileName, retiredAt }) => {
          const retired = await desktopStateStore.update((current) =>
            retireLegacyMappingFields(current, sourceFingerprint, backupFileName, retiredAt),
          )
          mappingOwnershipRetired = true
          return retired
        },
      })
      if (engine.generation !== generation) return
      if (result.stateDocument) {
        legacyStateSource = {
          kind: "readable",
          document: result.stateDocument,
          modifiedAt: new Date().toISOString(),
        }
        snapshot.mappings = {
          incoming: snapshot.mappings.incoming.filter(
            (request) => request.status !== "approved" && request.status !== "approved-awaiting-delivery",
          ),
          outgoing: snapshot.mappings.outgoing.filter((request) => request.status !== "approved"),
        }
      }
      hydrateAuthoritativeMappings(result.records)
      snapshot.mappingStore = {
        status: "ready",
        schemaVersion: health.schemaVersion,
        migrationState: result.migration.state,
        journalMode: health.journalMode,
        mutationsEnabled: true,
        pendingDeliveryCount: result.records.filter((record) => record.pendingDelivery).length,
        cleanupWarning: result.cleanupWarning,
      }
      await refreshAuthoritativeMappings()
      broadcastSnapshot()
      void flushPendingConfigurationDeliveries()
    } catch (error) {
      if (engine.generation !== generation) return
      const detail = error instanceof Error ? error.message : "The mapping database could not be initialised."
      const status =
        error instanceof EngineRpcError && error.code === "MAPPING_STORE_UNSUPPORTED_SCHEMA"
          ? "unsupported-schema"
          : error instanceof MappingAuthorityInitializationError ||
              (error instanceof EngineRpcError &&
                ["MAPPING_MIGRATION_FAILED", "MAPPING_STORE_MIGRATION_FAILED"].includes(error.code))
            ? "migration-failed"
            : error instanceof EngineRpcError && error.code === "MAPPING_MIGRATION_REQUIRED"
              ? "migration-required"
              : "unavailable"
      snapshot.mappingStore = {
        ...snapshot.mappingStore,
        status,
        detail,
        mutationsEnabled: false,
      }
      console.error("[mapping-index] authoritative store initialisation failed:", detail)
      pushActivity("Mapping database unavailable", detail, "error")
      broadcastSnapshot()
    }
  })().finally(() => {
    mappingAuthorityInitialization = null
    const current = engine.state
    if (current.status === "ready" && engine.generation !== generation) {
      void initializeAuthoritativeMappings(current.mappingStore)
    }
  })
  return await mappingAuthorityInitialization
}

async function upsertAuthoritativeMapping(
  mapping: MappingConfiguration,
  targetDeviceId: string | null,
  expectedRevision: number | null,
): Promise<MappingRecord> {
  requireMappingMutations()
  const record = await engine.request<MappingRecord>("mapping.upsert", {
    mapping,
    authorDeviceId: getLocalIdentityId(),
    deliveryTargetDeviceId: targetDeviceId,
    expectedRevision,
    occurredAt: mapping.updatedAt,
  })
  await refreshAuthoritativeMappings()
  return record
}

async function removeAuthoritativeMapping(record: MappingRecord): Promise<void> {
  requireMappingMutations()
  const localDeviceId = getLocalIdentityId()
  const targetDeviceId = otherParticipant(record.mapping, localDeviceId)
  await engine.request("mapping.remove", {
    id: record.mapping.id,
    deletingDeviceId: localDeviceId,
    deliveryTargetDeviceId: targetDeviceId,
    expectedRevision: record.revision,
    occurredAt: new Date().toISOString(),
  })
  await refreshAuthoritativeMappings()
}

function otherParticipant(mapping: MappingConfiguration, localDeviceId: string): string {
  if (mapping.initiatorDeviceId === localDeviceId) return mapping.responderDeviceId
  if (mapping.responderDeviceId === localDeviceId) return mapping.initiatorDeviceId
  throw new Error("This computer is not a participant in the mapping.")
}

async function flushPendingConfigurationDeliveries(): Promise<void> {
  if (!peerSessions || !pairing || snapshot.mappingStore.status !== "ready") return
  let deliveries: MappingDelivery[]
  const previousPendingCount = snapshot.mappingStore.pendingDeliveryCount
  try {
    deliveries = await engine.request<MappingDelivery[]>("mapping.listPendingDelivery")
    snapshot.mappingStore.pendingDeliveryCount = deliveries.length
  } catch (error) {
    console.warn("[mapping-index] unable to read pending configuration deliveries", error)
    return
  }

  let acknowledgedAny = false
  for (const delivery of deliveries) {
    const key = `${delivery.eventId}:${delivery.targetDeviceId}`
    if (configurationDeliveriesInFlight.has(key)) continue
    const peer = getPairedDevice(delivery.targetDeviceId)
    if (!peer || peer.status !== "online") continue
    configurationDeliveriesInFlight.add(key)
    try {
      const acknowledgement = await requirePeerSessions().request<MappingAcknowledgement>(peer.id, {
        type: "mapping-config",
        event: delivery.event,
      })
      if (
        acknowledgement.mappingId !== delivery.mappingId ||
        acknowledgement.eventId !== delivery.eventId ||
        acknowledgement.revision !== delivery.revision
      ) {
        throw new Error("The peer acknowledgement did not identify the exact mapping event.")
      }
      await engine.request("mapping.acknowledgeDelivery", {
        ...acknowledgement,
        authenticatedPeerDeviceId: peer.id,
        acknowledgedAt: new Date().toISOString(),
      })
      if (delivery.event.kind === "active") {
        snapshot.mappings.incoming = snapshot.mappings.incoming.filter(
          (request) => request.id !== delivery.mappingId || request.status !== "approved-awaiting-delivery",
        )
      }
      acknowledgedAny = true
    } catch (error) {
      console.warn(`[mapping-index] delivery ${delivery.eventId} remains pending`, error)
    } finally {
      configurationDeliveriesInFlight.delete(key)
    }
  }
  if (acknowledgedAny) {
    await refreshAuthoritativeMappings()
    await persistState()
    broadcastSnapshot()
  } else if (previousPendingCount !== snapshot.mappingStore.pendingDeliveryCount) {
    broadcastSnapshot()
  }
}

function previewsEqual(left: FolderMappingPreview, right: FolderMappingPreview): boolean {
  const canonical = (preview: FolderMappingPreview) => ({
    ...preview,
    invalidWindowsNames: [...preview.invalidWindowsNames].sort(),
    caseCollisions: [...preview.caseCollisions].sort(),
    samples: [...preview.samples].sort((a, b) => `${a.category}:${a.path}`.localeCompare(`${b.category}:${b.path}`)),
  })
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
}

async function previewFolderMapping(input: PreviewFolderMappingInput): Promise<FolderMappingPreview> {
  validateMappingInput(input)
  const peer = getPairedDevice(input.remoteDeviceId)
  if (!peer) throw new Error("Pair a trusted computer before previewing a folder mapping.")
  if (peer.status !== "online") throw new Error(`${peer.name} must be online to compare the folders.`)
  const localPath = path.resolve(input.localPath)
  const localManifest = await scanFolder(localPath, input.ignorePatterns)
  const remoteManifest = await requirePeerSessions().request<FileManifest>(peer.id, {
    type: "scan-manifest",
    path: input.remotePath,
    ignorePatterns: input.ignorePatterns,
  }, 5 * 60_000)
  return compareManifests(localManifest, remoteManifest, {
    mode: input.mode,
    localPlatform: platform(),
    remotePlatform: peer.platform,
  })
}

async function requestFolderMapping(input: RequestFolderMappingInput): Promise<AppSnapshot> {
  requireMappingMutations()
  validateMappingInput(input)
  const peer = getPairedDevice(input.remoteDeviceId)
  if (!peer) throw new Error("Pair a trusted computer before requesting a folder mapping.")
  if (peer.status !== "online") throw new Error(`${peer.name} must be online to approve the mapping.`)
  const authoritativePreview = await previewFolderMapping(input)
  if (!previewsEqual(authoritativePreview, input.preview)) {
    throw new Error("The folders changed after the preview. Review the initial merge again before requesting approval.")
  }
  if (authoritativePreview.invalidWindowsNames.length > 0 || authoritativePreview.caseCollisions.length > 0) {
    throw new Error("Resolve Windows-invalid names and case-only collisions before requesting approval.")
  }
  const localPath = path.resolve(input.localPath)
  const localStat = await stat(localPath)
  if (!localStat.isDirectory()) throw new Error("The local path is not a folder.")
  const identity = requirePairingService().getLocalSessionIdentity()
  const proposal: FolderMappingProposal = {
    id: randomUUID(),
    name: input.name.trim() || path.basename(localPath) || "Synced folder",
    initiatorDeviceId: identity.id,
    initiatorDeviceName: identity.name,
    responderDeviceId: peer.id,
    initiatorPath: localPath,
    responderPath: input.remotePath,
    mode: input.mode,
    ignorePatterns: input.ignorePatterns,
    historyDays: input.historyDays,
    historyMaxBytes: input.historyMaxBytes,
    preview: authoritativePreview,
    createdAt: new Date().toISOString(),
  }

  snapshot.mappings.outgoing = [
    ...snapshot.mappings.outgoing.filter((request) => request.id !== proposal.id),
    {
      id: proposal.id,
      toDeviceId: peer.id,
      toDeviceName: peer.name,
      proposal,
      status: "pending",
      message: `Waiting for approval on ${peer.name}.`,
    },
  ]
  pushActivity("Folder approval requested", `${peer.name} must approve ${proposal.name} before the mapping is created.`, "info")
  await persistState()
  broadcastSnapshot()

  try {
    await requirePeerSessions().request(peer.id, { type: "mapping-propose", proposal })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to send the mapping request."
    snapshot.mappings.outgoing = snapshot.mappings.outgoing.map((request) =>
      request.id === proposal.id ? { ...request, status: "failed", message } : request,
    )
    pushActivity("Folder approval request failed", message, "error")
    await persistState()
    broadcastSnapshot()
    throw error
  }
  return snapshot
}

async function buildIncomingMappingPreview(
  request: IncomingMappingRequest,
  destinationPath: string,
): Promise<FolderMappingPreview> {
  const peer = getPairedDevice(request.fromDeviceId)
  if (!peer) throw new Error("The requesting computer is no longer trusted.")
  if (peer.status !== "online") throw new Error(`${peer.name} must be online to compare the folders.`)
  const target = path.resolve(destinationPath)
  const targetStat = await stat(target)
  if (!targetStat.isDirectory()) throw new Error("The selected destination is not a folder.")
  const initiatorManifest = await requirePeerSessions().request<FileManifest>(peer.id, {
    type: "scan-manifest",
    path: request.proposal.initiatorPath,
    ignorePatterns: request.proposal.ignorePatterns,
  }, 5 * 60_000)
  const responderManifest = await scanFolder(target, request.proposal.ignorePatterns)
  return compareManifests(initiatorManifest, responderManifest, {
    mode: request.proposal.mode,
    localPlatform: peer.platform,
    remotePlatform: platform(),
  })
}

async function refreshIncomingMappingPreview(input: RefreshIncomingMappingPreviewInput): Promise<AppSnapshot> {
  const request = snapshot.mappings.incoming.find((item) => item.id === input.requestId && item.status === "pending")
  if (!request) throw new Error("The folder mapping request is no longer available.")
  const destinationPath = path.resolve(input.destinationPath)
  const preview = await buildIncomingMappingPreview(request, destinationPath)
  snapshot.mappings.incoming = snapshot.mappings.incoming.map((item) =>
    item.id === request.id
      ? {
          ...item,
          selectedDestinationPath: destinationPath,
          proposal: { ...item.proposal, responderPath: destinationPath, preview },
          message: "The initial comparison was refreshed for this destination.",
        }
      : item,
  )
  await persistState()
  return broadcastSnapshot()
}

async function approveFolderMapping(input: ApproveFolderMappingInput): Promise<AppSnapshot> {
  requireMappingMutations()
  const request = snapshot.mappings.incoming.find((item) => item.id === input.requestId)
  if (!request) throw new Error("The folder mapping request is no longer available.")
  const destinationPath = path.resolve(input.destinationPath)
  if (destinationPath !== path.resolve(request.proposal.responderPath)) {
    throw new Error("Refresh the initial comparison for the new destination before approving.")
  }
  const refreshedPreview = await buildIncomingMappingPreview(request, destinationPath)
  if (!previewsEqual(refreshedPreview, request.proposal.preview)) {
    snapshot.mappings.incoming = snapshot.mappings.incoming.map((item) =>
      item.id === request.id
        ? { ...item, proposal: { ...item.proposal, preview: refreshedPreview }, message: "The folders changed. Review the refreshed comparison before approving." }
        : item,
    )
    await persistState()
    broadcastSnapshot()
    throw new Error("The folders changed since the preview. Review the updated comparison and approve again.")
  }

  const proposal = request.proposal
  const localIdentity = requirePairingService().getLocalSessionIdentity()
  const configuration = mappingConfigurationFromProposal(proposal, {
    responderDeviceName: localIdentity.name,
    responderPath: destinationPath,
    setupStatus: "ready-for-initial-sync",
    now: new Date().toISOString(),
  })
  const record = await upsertAuthoritativeMapping(configuration, request.fromDeviceId, null)
  const projected = folderFromMappingRecord(record, localIdentity.id)
  if (!projected) throw new Error("The committed mapping does not include this computer.")
  const folder = { ...projected, fileCount: proposal.preview.remoteFiles }
  snapshot.folders = snapshot.folders.map((item) => (item.id === folder.id ? { ...item, ...folder } : item))
  snapshot.mappings.incoming = snapshot.mappings.incoming.map((item) =>
    item.id === request.id
      ? { ...item, status: "approved-awaiting-delivery", selectedDestinationPath: destinationPath, message: "Approval is being delivered." }
      : item,
  )
  pushActivity("Folder mapping approved", `${proposal.name} is configured locally and waiting for the other computer to acknowledge it.`, "success", folder.id)
  await persistState()
  broadcastSnapshot()
  void flushPendingConfigurationDeliveries()
  return snapshot
}

async function rejectFolderMapping(requestId: string): Promise<AppSnapshot> {
  const request = snapshot.mappings.incoming.find((item) => item.id === requestId)
  if (!request) return snapshot
  snapshot.mappings.incoming = snapshot.mappings.incoming.map((item) =>
    item.id === requestId ? { ...item, status: "rejected", message: "You declined this mapping request." } : item,
  )
  pushActivity("Folder mapping rejected", `${request.proposal.name} was not added.`, "warning")
  await persistState()
  broadcastSnapshot()
  await deliverMappingDecision(requestId)
  return snapshot
}

async function deliverMappingDecision(requestId: string): Promise<void> {
  if (decisionDeliveriesInFlight.has(requestId)) return
  const request = snapshot.mappings.incoming.find((item) => item.id === requestId)
  if (!request) return
  const peer = getPairedDevice(request.fromDeviceId)
  if (!peer || peer.status !== "online") return
  decisionDeliveriesInFlight.add(requestId)
  try {
    await requirePeerSessions().request(peer.id, {
      type: "mapping-decision",
      proposalId: request.proposal.id,
      approved: false,
      reason: "The mapping was declined on the other computer.",
    })
    snapshot.mappings.incoming = snapshot.mappings.incoming.filter((item) => item.id !== requestId)
    await persistState()
    broadcastSnapshot()
  } catch (error) {
    snapshot.mappings.incoming = snapshot.mappings.incoming.map((item) =>
      item.id === requestId
        ? { ...item, message: error instanceof Error ? error.message : "Approval delivery will be retried." }
        : item,
    )
    await persistState()
    broadcastSnapshot()
  } finally {
    decisionDeliveriesInFlight.delete(requestId)
  }
}

async function flushPendingMappingDecisions(): Promise<void> {
  if (!peerSessions || !pairing || !snapshot) return
  for (const request of snapshot.mappings.incoming) {
    if (request.status === "rejected") await deliverMappingDecision(request.id)
  }
}

function updateFolder(folderId: string, patch: Partial<FolderSummary>): void {
  snapshot.folders = snapshot.folders.map((item) => (item.id === folderId ? { ...item, ...patch } : item))
}

async function startInitialSync(folderId: string): Promise<AppSnapshot> {
  requireMappingMutations()
  if (initialSyncInFlight.has(folderId)) return snapshot
  const folder = snapshot.folders.find((item) => item.id === folderId)
  if (!folder) throw new Error("This folder is no longer configured.")
  if (folder.setupStatus !== "ready-for-initial-sync") throw new Error("This folder has already completed its initial sync.")
  if (folder.paused || snapshot.paused) throw new Error("Resume this folder before starting the initial sync.")
  const peer = getPairedDevice(folder.remoteDeviceId)
  if (!peer) throw new Error("The paired computer for this folder is no longer trusted.")
  if (peer.status !== "online") throw new Error(`${peer.name} must be online to sync.`)

  initialSyncInFlight.add(folderId)
  updateFolder(folderId, { status: "syncing", currentAction: "Comparing folders…", progress: 0 })
  broadcastSnapshot()

  try {
    const localManifest = await scanFolder(folder.localPath, folder.ignorePatterns)
    const remoteManifest = await requirePeerSessions().request<FileManifest>(
      peer.id,
      { type: "scan-manifest", path: folder.remotePath, ignorePatterns: folder.ignorePatterns },
      5 * 60_000,
    )

    const plan = computeSyncPlan(localManifest, remoteManifest, folder.mode)
    const total = plan.toPull.length
    let completed = 0
    let bytesCopied = 0
    const startedAt = Date.now()

    for (const entry of plan.toPull) {
      const current = snapshot.folders.find((item) => item.id === folderId)
      if (!current || current.paused || snapshot.paused) throw new Error("Syncing was paused before it finished.")

      updateFolder(folderId, {
        currentAction: `Copying ${entry.path} (${completed + 1}/${total})`,
        progress: total > 0 ? completed / total : 1,
      })
      broadcastSnapshot()

      const result = await requirePeerSessions().request<{ digest: string; size: number; contentBase64: string }>(peer.id, {
        type: "pull-file",
        folderId,
        relativePath: entry.path,
      })
      const buffer = Buffer.from(result.contentBase64, "base64")
      const digest = createHash("sha256").update(buffer).digest("hex")
      if (digest !== result.digest || buffer.length !== result.size) {
        plan.skipped.push({ path: entry.path, reason: "The transferred content failed integrity verification." })
        continue
      }
      await writeFileAtomic(folder.localPath, entry.path, buffer)
      completed += 1
      bytesCopied += buffer.length
    }

    const elapsedSeconds = Math.max((Date.now() - startedAt) / 1000, 0.001)
    const currentRecord = mappingRecords.get(folderId)
    if (!currentRecord) throw new Error("The mapping was removed before its configuration update could commit.")
    const updatedAt = new Date().toISOString()
    await upsertAuthoritativeMapping(
      { ...currentRecord.mapping, setupStatus: "active", updatedAt },
      otherParticipant(currentRecord.mapping, getLocalIdentityId()),
      currentRecord.revision,
    )
    updateFolder(folderId, {
      setupStatus: "active",
      status: idleFolderStatus(),
      progress: 1,
      bytesPerSecond: Math.round(bytesCopied / elapsedSeconds),
      fileCount: localManifest.files.length + completed,
      lastSyncedAt: updatedAt,
      currentAction:
        plan.skipped.length > 0
          ? `Synced ${completed} file${completed === 1 ? "" : "s"}. ${plan.skipped.length} skipped — see activity log.`
          : `Synced ${completed} file${completed === 1 ? "" : "s"}.`,
    })
    pushActivity(
      "Initial sync completed",
      `${folder.name}: copied ${completed} file${completed === 1 ? "" : "s"}${plan.skipped.length > 0 ? `, skipped ${plan.skipped.length}` : ""}.`,
      plan.skipped.length > 0 ? "warning" : "success",
      folderId,
    )
    for (const skip of plan.skipped.slice(0, 20)) pushActivity(`Skipped ${skip.path}`, skip.reason, "warning", folderId)
    void flushPendingConfigurationDeliveries()
  } catch (error) {
    const message = error instanceof Error ? error.message : "The initial sync failed."
    updateFolder(folderId, { status: "needs-attention", currentAction: message })
    pushActivity("Initial sync failed", `${folder.name}: ${message}`, "error", folderId)
  } finally {
    initialSyncInFlight.delete(folderId)
    await persistState()
    broadcastSnapshot()
  }
  return snapshot
}

async function handlePeerRequest(context: PeerRequestContext, request: PeerRequest): Promise<unknown> {
  if (request.type === "browse-directory") {
    return browseHostDirectory(
      typeof request.path === "string" ? request.path : undefined,
      Boolean(request.includeHidden),
      getLocalIdentityId(),
      os.hostname(),
      true,
    )
  }
  if (request.type === "scan-manifest") {
    if (typeof request.path !== "string" || !Array.isArray(request.ignorePatterns)) {
      throw new Error("The manifest request is invalid.")
    }
    return scanFolder(request.path, request.ignorePatterns.filter((item): item is string => typeof item === "string"))
  }
  if (request.type === "mapping-propose") {
    const proposal = request.proposal as FolderMappingProposal | undefined
    if (!proposal || proposal.initiatorDeviceId !== context.peerId || proposal.responderDeviceId !== getLocalIdentityId()) {
      throw new Error("The folder mapping proposal identity is invalid.")
    }
    const target = path.resolve(proposal.responderPath)
    const targetStat = await stat(target)
    if (!targetStat.isDirectory()) throw new Error("The requested destination is not a folder.")
    if (!snapshot.mappings.incoming.some((item) => item.id === proposal.id) && !snapshot.folders.some((item) => item.id === proposal.id)) {
      const incoming: IncomingMappingRequest = {
        id: proposal.id,
        fromDeviceId: context.peerId,
        fromDeviceName: context.peerName,
        proposal: { ...proposal, responderPath: target },
        status: "pending",
        selectedDestinationPath: target,
        message: "Review the paths, rules and initial comparison before approving.",
      }
      snapshot.mappings.incoming = [...snapshot.mappings.incoming, incoming]
      pushActivity("Folder mapping approval needed", `${context.peerName} wants to sync ${proposal.name}.`, "info")
      await persistState()
      broadcastSnapshot()
      showMainWindow()
    }
    return { accepted: true }
  }
  if (request.type === "mapping-config") {
    requireMappingMutations()
    const event = request.event as MappingEvent | undefined
    if (!event || (event.kind !== "active" && event.kind !== "tombstone")) {
      throw new Error("The mapping configuration event is invalid.")
    }
    const mappingId = event.kind === "active" ? event.record.mapping.id : event.tombstone.mappingId
    const previous = mappingRecords.get(mappingId)
    const outcome = await engine.request<MappingApplyOutcome>("mapping.applyRemote", {
      event,
      authenticatedPeerDeviceId: context.peerId,
      localDeviceId: getLocalIdentityId(),
    })
    await refreshAuthoritativeMappings()
    if (event.kind === "active") {
      snapshot.mappings.outgoing = snapshot.mappings.outgoing.map((item) =>
        item.id === outcome.mappingId && item.toDeviceId === context.peerId
          ? { ...item, status: "approved", message: `${context.peerName} approved the mapping.` }
          : item,
      )
      if (outcome.status === "applied") {
        pushActivity(
          "Folder mapping configured",
          `${event.record.mapping.name} is now configured on both computers.`,
          "success",
          outcome.mappingId,
        )
      }
    } else if (outcome.status === "applied") {
      pushActivity(
        "Folder mapping removed",
        `${previous?.mapping.name ?? "A folder mapping"} was removed by ${context.peerName}. Existing files were left untouched.`,
        "warning",
        outcome.mappingId,
      )
    }
    await persistState()
    broadcastSnapshot()
    return {
      mappingId: outcome.mappingId,
      eventId: outcome.eventId,
      revision: outcome.revision,
    } satisfies MappingAcknowledgement
  }
  if (request.type === "pull-file") {
    const folderId = typeof request.folderId === "string" ? request.folderId : ""
    const relativePath = typeof request.relativePath === "string" ? request.relativePath : ""
    const folder = snapshot.folders.find((item) => item.id === folderId)
    if (!folder || folder.remoteDeviceId !== context.peerId) {
      throw new Error("This folder is not shared with the requesting computer.")
    }
    if (folder.mode === "receive-only") {
      throw new Error("This folder is receive-only on this computer and cannot serve files.")
    }
    const absolutePath = resolveWithinRoot(folder.localPath, relativePath)
    const fileStat = await stat(absolutePath)
    if (!fileStat.isFile()) throw new Error("The requested path is not a file.")
    if (fileStat.size > MAX_TRANSFER_FILE_BYTES) throw new Error("The requested file exceeds the initial-sync size limit.")
    const buffer = await readFile(absolutePath)
    return { digest: createHash("sha256").update(buffer).digest("hex"), size: buffer.length, contentBase64: buffer.toString("base64") }
  }
  if (request.type === "mapping-decision") {
    const proposalId = typeof request.proposalId === "string" ? request.proposalId : ""
    const outgoing = snapshot.mappings.outgoing.find((item) => item.id === proposalId && item.toDeviceId === context.peerId)
    if (!outgoing) throw new Error("The original mapping request was not found.")
    const approved = Boolean(request.approved)
    if (approved) {
      requireMappingMutations()
      const destinationPath = typeof request.destinationPath === "string" ? request.destinationPath : outgoing.proposal.responderPath
      if (!mappingRecords.has(proposalId)) {
        await upsertAuthoritativeMapping(
          mappingConfigurationFromProposal(outgoing.proposal, {
            responderDeviceName: context.peerName,
            responderPath: destinationPath,
            setupStatus: "ready-for-initial-sync",
            now: new Date().toISOString(),
          }),
          null,
          null,
        )
      }
      snapshot.mappings.outgoing = snapshot.mappings.outgoing.map((item) =>
        item.id === proposalId ? { ...item, status: "approved", message: `${context.peerName} approved the mapping.` } : item,
      )
      pushActivity("Folder mapping approved", `${outgoing.proposal.name} is now configured on both computers.`, "success", proposalId)
    } else {
      snapshot.mappings.outgoing = snapshot.mappings.outgoing.map((item) =>
        item.id === proposalId
          ? { ...item, status: "rejected", message: typeof request.reason === "string" ? request.reason : "The other computer declined the mapping." }
          : item,
      )
      pushActivity("Folder mapping declined", `${context.peerName} declined ${outgoing.proposal.name}.`, "warning")
    }
    await persistState()
    broadcastSnapshot()
    return { received: true }
  }
  throw new Error("This secure peer request is not supported.")
}

function registerIpc(): void {
  ipcMain.handle("app:get-snapshot", () => snapshot)
  ipcMain.handle("mapping-store:retry", async () => {
    snapshot.mappingStore = {
      ...snapshot.mappingStore,
      status: "loading",
      detail: undefined,
      mutationsEnabled: false,
    }
    broadcastSnapshot()
    await engine.restart()
    return snapshot
  })
  ipcMain.handle("app:pause-all", () => setAllPaused(true))
  ipcMain.handle("app:resume-all", () => setAllPaused(false))
  ipcMain.handle("filesystem:browse-directory", (_event, input: BrowseDirectoryInput) => browseDirectory(input))
  ipcMain.handle("filesystem:create-directory", (_event, input: CreateDirectoryInput) => createLocalDirectory(input))
  ipcMain.handle("folders:preview-mapping", (_event, input: PreviewFolderMappingInput) => previewFolderMapping(input))
  ipcMain.handle("folders:request-mapping", (_event, input: RequestFolderMappingInput) => requestFolderMapping(input))
  ipcMain.handle("folders:refresh-incoming-preview", (_event, input: RefreshIncomingMappingPreviewInput) => refreshIncomingMappingPreview(input))
  ipcMain.handle("folders:approve-mapping", (_event, input: ApproveFolderMappingInput) => approveFolderMapping(input))
  ipcMain.handle("folders:reject-mapping", (_event, requestId: string) => rejectFolderMapping(requestId))
  ipcMain.handle("folders:start-initial-sync", (_event, folderId: string) => startInitialSync(folderId))

  ipcMain.handle("folders:add", async (_event: Electron.IpcMainInvokeEvent, _input: AddFolderInput) => {
    throw new Error("Folder mappings now require an initial comparison and approval on the other computer.")
  })

  ipcMain.handle("folders:set-paused", async (_event: Electron.IpcMainInvokeEvent, folderId: string, paused: boolean) => {
    requireMappingMutations()
    const record = mappingRecords.get(folderId)
    if (!record) throw new Error("The mapping no longer exists in the authoritative database.")
    const targetDeviceId = otherParticipant(record.mapping, getLocalIdentityId())
    await upsertAuthoritativeMapping(
      { ...record.mapping, paused, updatedAt: new Date().toISOString() },
      targetDeviceId,
      record.revision,
    )
    pushActivity(
      paused ? "Folder paused" : "Folder resumed",
      `${record.mapping.name} was ${paused ? "paused" : "resumed"}.`,
      paused ? "warning" : "success",
      folderId,
    )
    await persistState()
    broadcastSnapshot()
    void flushPendingConfigurationDeliveries()
    return snapshot
  })

  ipcMain.handle("folders:remove", async (_event: Electron.IpcMainInvokeEvent, folderId: string) => {
    requireMappingMutations()
    const record = mappingRecords.get(folderId)
    if (!record) throw new Error("The mapping no longer exists in the authoritative database.")
    // This commits a configuration tombstone only. No path in the mapping is dereferenced and no
    // file inside either mapped directory is read, moved, rewritten, or deleted.
    await removeAuthoritativeMapping(record)
    pushActivity(
      "Folder removed",
      `${record.mapping.name} is no longer managed. Existing files were left untouched.`,
      "warning",
      folderId,
    )
    await persistState()
    broadcastSnapshot()
    void flushPendingConfigurationDeliveries()
    return snapshot
  })

  ipcMain.handle("shell:reveal-path", async (_event: Electron.IpcMainInvokeEvent, targetPath: string) => {
    if (targetPath) await shell.openPath(targetPath)
  })

  ipcMain.handle("settings:update", async (_event: Electron.IpcMainInvokeEvent, key: AppSettingKey, value: AppSettings[AppSettingKey]) =>
    mutate(() => {
      snapshot.settings = { ...snapshot.settings, [key]: value }
      if (key === "launchAtLogin") app.setLoginItemSettings({ openAtLogin: Boolean(value), openAsHidden: snapshot.settings.startMinimised })
      if (key === "startMinimised" && snapshot.settings.launchAtLogin) app.setLoginItemSettings({ openAtLogin: true, openAsHidden: Boolean(value) })
    }),
  )

  ipcMain.handle("pairing:set-available", (_event, enabled: boolean) => {
    requirePairingService().setPairingAvailable(Boolean(enabled))
    return syncPairingSnapshot()
  })
  ipcMain.handle("pairing:start", (_event, deviceId: string) => {
    requirePairingService().startPairing(deviceId)
    return syncPairingSnapshot()
  })
  ipcMain.handle("pairing:confirm", (_event, sessionId: string) => {
    requirePairingService().confirmPairing(sessionId)
    return syncPairingSnapshot()
  })
  ipcMain.handle("pairing:cancel", (_event, sessionId: string) => {
    requirePairingService().cancelPairing(sessionId)
    return syncPairingSnapshot()
  })
  ipcMain.handle("pairing:approve", (_event, requestId: string) => {
    requirePairingService().approvePairing(requestId)
    return syncPairingSnapshot()
  })
  ipcMain.handle("pairing:reject", (_event, requestId: string) => {
    requirePairingService().rejectPairing(requestId)
    return syncPairingSnapshot()
  })
  ipcMain.handle("pairing:revoke", async (_event, deviceId: string) => {
    await requirePairingService().revokeDevice(deviceId)
    return syncPairingSnapshot()
  })
  ipcMain.handle("window:show", () => showMainWindow())
  ipcMain.handle("updates:check", () => {
    if (!app.isPackaged) return
    void autoUpdater.checkForUpdates()
  })
  ipcMain.handle("updates:download", () => {
    void autoUpdater.downloadUpdate()
  })
  ipcMain.handle("updates:install", () => {
    isQuitting = true
    autoUpdater.quitAndInstall()
  })
}

function resolveResourcePath(name: string): string {
  const packagedPath = path.join(process.resourcesPath, name)
  if (app.isPackaged && existsSync(packagedPath)) return packagedPath
  return path.resolve(__dirname, "../../resources", name)
}

function resolveEngineExecutable(): string | null {
  const override = process.env.FOLDERSYNC_ENGINE_PATH
  if (override && existsSync(override)) return override
  const binaryName = process.platform === "win32" ? "sync-engine.exe" : "sync-engine"
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, "engine", binaryName)]
    : [path.resolve(__dirname, "../../../../target/debug", binaryName), path.resolve(__dirname, "../../../../target/release", binaryName)]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

function startEngine(): void {
  engine.on("state", (state: EngineState) => {
    snapshot.engineStatus = state.status
    snapshot.engineMessage = state.message
    if (state.status === "starting") {
      snapshot.mappingStore = {
        ...snapshot.mappingStore,
        status: "loading",
        mutationsEnabled: false,
      }
    } else if (state.status !== "ready") {
      snapshot.mappingStore = {
        ...snapshot.mappingStore,
        status: "unavailable",
        detail: state.message,
        mutationsEnabled: false,
      }
    }
    broadcastSnapshot()
    if (state.status === "ready") void initializeAuthoritativeMappings(state.mappingStore)
  })
  const executable = resolveEngineExecutable()
  if (!executable) {
    engine.markUnavailable("Build the engine with `cargo build -p sync-engine`, then restart Tethera.")
    return
  }
  engine.start({ command: executable, env: { TETHERA_DATA_DIR: app.getPath("userData") } })
}

function setUpdateState(update: UpdateState): void {
  snapshot.update = update
  broadcastSnapshot()
}

function setUpAutoUpdater(): void {
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on("checking-for-update", () => setUpdateState({ status: "checking" }))
  autoUpdater.on("update-available", (info) => setUpdateState({ status: "available", version: info.version }))
  autoUpdater.on("update-not-available", () => setUpdateState({ status: "not-available" }))
  autoUpdater.on("error", (error) => setUpdateState({ status: "error", message: error.message }))
  autoUpdater.on("download-progress", (progress) =>
    setUpdateState({ status: "downloading", progressPercent: Math.round(progress.percent) }),
  )
  autoUpdater.on("update-downloaded", (info) => setUpdateState({ status: "downloaded", version: info.version }))
}

function createWindow(): void {
  if (mainWindow) return
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 960,
    minHeight: 650,
    show: false,
    title: "Tethera",
    backgroundColor: "#0b0d12",
    icon: resolveResourcePath("icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  mainWindow.webContents.on("will-navigate", (event: Electron.Event, url: string) => {
    const isDevServer = process.env.ELECTRON_RENDERER_URL && url.startsWith(process.env.ELECTRON_RENDERER_URL)
    if (!isDevServer && !url.startsWith("file:")) event.preventDefault()
  })
  if (process.env.ELECTRON_RENDERER_URL) void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"))
  mainWindow.once("ready-to-show", () => {
    if (!snapshot.settings.startMinimised) mainWindow?.show()
  })
  mainWindow.on("close", (event: Electron.Event) => {
    if (!isQuitting && snapshot.settings.closeToTray) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })
  mainWindow.on("closed", () => {
    mainWindow = null
  })
}

function showMainWindow(): void {
  if (!mainWindow) createWindow()
  mainWindow?.show()
  mainWindow?.focus()
}

function createTray(): void {
  const iconPath = resolveResourcePath("tray.png")
  const image = existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty()
  tray = new Tray(image.resize({ width: 18, height: 18 }))
  tray.setToolTip("Tethera")
  tray.on("click", showMainWindow)
  rebuildTrayMenu()
}

function rebuildTrayMenu(): void {
  if (!tray || !snapshot) return
  const template: MenuItemConstructorOptions[] = [
    { label: "Open Tethera", click: showMainWindow },
    { type: "separator" },
    snapshot.paused
      ? { label: "Resume all", click: () => void setAllPaused(false) }
      : { label: "Pause all", click: () => void setAllPaused(true) },
    { type: "separator" },
    snapshot.update.status === "downloaded"
      ? { label: "Restart to update", click: () => { isQuitting = true; autoUpdater.quitAndInstall() } }
      : { label: "Check for updates", click: () => void autoUpdater.checkForUpdates(), enabled: app.isPackaged },
    { type: "separator" },
    { label: "Quit", click: () => { isQuitting = true; app.quit() } },
  ]
  tray.setContextMenu(Menu.buildFromTemplate(template))
}

app.whenReady().then(async () => {
  await loadState()
  registerIpc()
  createWindow()
  createTray()
  setUpAutoUpdater()
  if (app.isPackaged) void autoUpdater.checkForUpdates()
  try {
    await startNetworkServices()
  } catch (error) {
    pushActivity("Network services unavailable", error instanceof Error ? error.message : "Unable to start LAN services.", "error")
    broadcastSnapshot()
  }
  startEngine()
  app.on("activate", showMainWindow)
})

app.on("before-quit", () => { isQuitting = true })
app.on("window-all-closed", () => {
  if (process.platform === "darwin" || snapshot?.settings.closeToTray) return
  app.quit()
})
app.on("will-quit", () => {
  if (decisionRetryTimer) clearInterval(decisionRetryTimer)
  void peerSessions?.stop()
  void pairing?.stop()
  void engine.stop()
})
