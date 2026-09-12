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
import { mkdir, readdir, realpath, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import type {
  AddFolderInput,
  AppSettings,
  AppSnapshot,
  ApproveFolderMappingInput,
  BrowseDirectoryInput,
  ConflictInspection,
  ConflictInspectionInput,
  CreateDirectoryInput,
  DeviceSummary,
  DirectoryEntry,
  DirectoryListing,
  DirectoryLocation,
  FolderMappingProposal,
  FolderMappingPreview,
  FolderPreviewProgress,
  FolderScanIssue,
  FolderScanIssueReport,
  FolderSummary,
  IncomingMappingRequest,
  MappingState,
  PairingState,
  PreviewFolderMappingInput,
  RequestFolderMappingInput,
  RefreshIncomingMappingPreviewInput,
  RecoveryConflict,
  RecoveryState,
  ResolveFileConflictInput,
  UpdateState,
} from "../shared/contracts"
import {
  EngineRpcError,
  EngineSupervisor,
  type EngineState,
  type MappingStoreHealth,
} from "./engine-supervisor"
import {
  compareManifests, DEFAULT_MAX_MANIFEST_FILES, filesystemSupportsDigestReuse, isManifestPathIgnored, isPathBlockedByScanIssue, parsePeerManifest, ScanCancelledError, scanFolder, assertManifestWithinLegacyByteBudget, statFileIdentity, type CachedFileDigest, type FileManifest, type ScanDigestCache, type ScanMetrics, fingerprintFolder, type FolderFingerprint,
} from "./folder-manifest"
import { globalScanCoordinator } from "./scan-coordinator"
import { runPairedScans } from "./paired-scan"
import { previewScanKey, PreviewScanSessions } from "./preview-scan-session"
import { ScanLedger, scanStageForKey } from "./scan-ledger"
import { ScanReuseStore } from "./scan-reuse-store"
import { scanIssueReportCovers } from "../shared/folder-scan-issues"
import { SCAN_GENERATION_CAPABILITY, SCAN_PAGE_MAX_ENTRIES } from "./scan-generation"
import {
  assessInitialMergeConvergence,
  computeSyncPlan,
  type InitialSyncPassResult,
  runCoordinatedInitialMerge,
  type SyncSkip,
  writeFileChunksAtomic,
} from "./initial-sync"
import {
  describeTransferFile,
  readTransferFileChunk,
  TRANSFER_CHUNK_BYTES,
  type TransferFileDescriptor,
} from "./file-transfer"
import {
  folderFromMappingRecord,
  invertMode,
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
  type PersistedInitialSyncOutcome,
} from "./desktop-state-storage"
import { PairingService } from "./pairing-service"
import { CHUNKED_FRAMES_CAPABILITY, measurePeerRequest, PeerSessionService, type PeerRequest, type PeerRequestContext } from "./peer-session-service"
import { requestPeerCapabilities } from "./peer-capabilities"
import { requestPeerPreview } from "./peer-preview"
import { PEER_SCAN_PROGRESS_CAPABILITY } from "./peer-scan-progress"
import { folderComparisonResult } from "../shared/folder-comparison-result"
import { isTetheraStagingPath, resolveWithinRoot } from "./path-safety"
import {
  applySettingUpdate,
  normalizePersistedScanLimit,
  parseArchiveHistoryRequest,
  parseExactConflictChoice,
  parsePeerConflictCopy,
  parsePeerFileOperations,
  parsePeerScanManifest,
  parseResolveFileConflictInput,
  parseRevealPath,
  parseSettingUpdate,
  requireAllowedConflictDirection,
  requireUnchangedInspectedCopies,
  validateConflictInput,
  validateContinuousOperationRequest,
  validateInitialSyncPassResult,
  validateMappingInput,
  validatePeerOperationId,
  validateTransferDescriptor,
  type PeerConflictCopy,
} from "./ipc-validation"
import {
  canSkipUnchangedCycle,
  conflictKey,
  CONTINUOUS_FINGERPRINT_CAPABILITY,
  isUnchangedScanReply,
  type QuietReconcile,
  conflictSummary,
  findMirroredPeerOperation,
  FolderChangeMonitor,
  mirrorConflictChoice,
  observedFiles,
  replayableOperations,
  type FileSyncConflict,
  type FileSyncDirection,
  type FileSyncOperation,
  type PeerFileOperationIdentity,
  type FileSyncState,
  type ExactConflictChoice,
  type ReconcileFilesResult,
} from "./continuous-sync"
import { fingerprintObservation, isObservationFingerprint } from "./observation-fingerprint"
import { listArchivedVersions } from "./archive-history"
import { DigestCacheVerifier, EngineScanDigestCache } from "./digest-cache"
import {
  recoverStagedArchiveObject,
  removePublishedArchiveStage,
  inspectReplacementRecovery,
  VERSION_ARCHIVE_DIRECTORY,
  type ReplacementJournalEntry,
} from "./version-archive"
import { restoreArchivedVersion } from "./archive-restore"
import {
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_STARTUP_DELAY_MS,
  canDownloadUpdate,
  canInstallUpdate,
  clampProgressPercent,
  formatUpdateError,
  isUpdateBusy,
  normalizeReleaseNotes,
  nowIso,
  parsePreviewProgressToken,
  shouldBroadcastProgress,
  shouldPreserveDownloadedOnError,
  runUpdateDownload,
  toOptionalFiniteNumber,
} from "./update-manager"

interface TransferChunkResponse {
  offset: number
  contentBase64: string
}

interface PlannedFileResult {
  bytes: number
  replacementJournalId?: string
  completedDuringRecovery?: boolean
}

interface FileApplicationAuthorization {
  operationId?: number
  alreadyVerified: boolean
}

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
let snapshot: AppSnapshot
let decisionRetryTimer: NodeJS.Timeout | null = null
const decisionDeliveriesInFlight = new Set<string>()
const configurationDeliveriesInFlight = new Set<string>()
const initialSyncInFlight = new Set<string>()
const initialSyncCompletions = new Map<string, { promise: Promise<void>; resolve: () => void }>()
const initialSyncForwarded = new Set<string>()
const archiveRestoreInFlight = new Set<string>()
const conflictResolutionInFlight = new Set<string>()
const conflictHashingInFlight = new Set<string>()
const peerFileOperationsInFlight = new Set<string>()
const initialSyncPeerLeases = new Map<string, { peerId: string; expiresAt: number }>()
const continuousSyncInFlight = new Set<string>()
const continuousSyncQueued = new Set<string>()
const continuousSyncBlocked = new Set<string>()
const continuousSyncMonitors = new Map<string, FolderChangeMonitor>()
const continuousSyncRetryTimers = new Map<string, NodeJS.Timeout>()
const continuousSyncNotificationsInFlight = new Set<string>()
const continuousConflictFingerprints = new Map<string, string>()
const continuousLastErrors = new Map<string, string>()
const INITIAL_SYNC_LEASE_MS = 35 * 60_000
const INITIAL_SYNC_HEARTBEAT_MS = 5 * 60_000
const MAX_CONCURRENT_CONTINUOUS_CYCLES = 2
const CONTINUOUS_SYNC_RPC_TIMEOUT_MS = 5 * 60_000
const CONFLICT_RESOLUTION_CONFIRM_TIMEOUT_MS = 15_000
const CONTINUOUS_SYNC_RETRY_MS = 5_000
const CONTINUOUS_SYNC_CAPACITY_RETRY_MS = 1_000
const PROGRESS_BROADCAST_INTERVAL_MS = 100
const mappingRecords = new Map<string, MappingRecord>()
let initialSyncOutcomes: Record<string, PersistedInitialSyncOutcome> = {}
let legacyStateSource: LegacyStateSource = { kind: "missing", document: {}, modifiedAt: new Date(0).toISOString() }
let desktopStateStore: DesktopStateStore
let mappingOwnershipRetired = false
let mappingAuthorityInitialization: Promise<void> | null = null

const engine = new EngineSupervisor()
let pairing: PairingService | null = null
let peerSessions: PeerSessionService | null = null
let continuousCyclesInProgress = 0
const execFileAsync = promisify(execFile)

function hasConflictResolutionInFlight(folderId?: string): boolean {
  if (!folderId) return conflictResolutionInFlight.size > 0
  const prefix = `${folderId}\0`
  return [...conflictResolutionInFlight].some((key) => key.startsWith(prefix))
}

async function withConflictHashing<T>(folderId: string, operation: () => Promise<T>): Promise<T> {
  if (conflictHashingInFlight.has(folderId)) {
    throw new Error("The current conflict copies are already being inspected.")
  }
  if (conflictHashingInFlight.size >= MAX_CONCURRENT_CONTINUOUS_CYCLES) {
    throw new Error("Tethera is already inspecting its maximum number of conflict copies. Retry shortly.")
  }
  conflictHashingInFlight.add(folderId)
  try {
    return await operation()
  } finally {
    conflictHashingInFlight.delete(folderId)
  }
}

const emptyPairingState: PairingState = {
  localFingerprint: "Loading…",
  acceptingPairing: false,
  discoveredDevices: [],
  incomingRequests: [],
}

const emptyMappingState: MappingState = { incoming: [], outgoing: [] }
const idleUpdateState: UpdateState = { status: "idle" }
let updateCheckTimer: NodeJS.Timeout | null = null
let lastUpdateProgressPercent: number | null = null
let lastUpdateProgressAt: number | null = null

function currentAppVersion(): string {
  try {
    return app.getVersion()
  } catch {
    return "unknown"
  }
}

function idleUpdateStateWithVersion(): UpdateState {
  return { status: "idle", currentVersion: currentAppVersion() }
}

const defaultSettings: AppSettings = {
  closeToTray: true,
  launchAtLogin: false,
  startMinimised: false,
  pauseOnMetered: true,
  theme: "system",
  maxScanFiles: DEFAULT_MAX_MANIFEST_FILES,
}

/**
 * The scan ceiling in force on this machine. Every local scan — including
 * scans run on a peer's behalf — uses this value; a peer never supplies
 * its own limit, so a paired device cannot dictate our memory allocation.
 */
function currentScanLimit(): number | null {
  return snapshot.settings.maxScanFiles
}

/**
 * Cooperative scan lifetime. Preview supersession, folder pause/removal and
 * app shutdown abort their scans at the next checkpoint; a paired-scan
 * failure aborts its sibling. Slots are held only for the local walk, never
 * across a peer wait, so two devices cannot deadlock holding a slot each.
 */
const previewScanControllers = new Map<string, AbortController>()
const folderScanControllers = new Map<string, Set<AbortController>>()
const shutdownScanController = new AbortController()

/** Scans captured for a renderer comparison, reused by its verification steps. */
const previewScanSessions = new PreviewScanSessions()

/**
 * Verified identities from scans that ran before a mapping existed, so the
 * first full-integrity merge walk can reuse digests instead of reading every
 * unchanged file again. Keyed by root path and ignore rules; bounded by TTL
 * and total entries. See `ScanReuseStore` for the exact identity guarantee.
 */
const scanReuseSeeds = new ScanReuseStore()

/**
 * Records every admitted local walk with its reuse/hash counters, so a stage
 * that silently re-scans a tree is visible instead of only slow.
 */
const scanLedger = new ScanLedger()

/** A full-integrity initial-merge scan held while the user decides about inaccessible items. */
interface PreparedInitialSyncScan {
  capturedAt: number
  signature: string
  /** Canonical digest of the inaccessible-path report the user is reviewing. */
  issuesSignature: string
  /** Manifests are omitted when retaining them would be too large; the signature still honours the decision. */
  localManifest?: FileManifest
  remoteManifest?: FileManifest
}

/** Prepared scans stay usable for a short decision window, then the merge rescans. */
const PREPARED_INITIAL_SYNC_TTL_MS = 5 * 60_000
/** Above this combined file count the manifests are not retained; verification falls back to comparing issue reports. */
const MAX_PREPARED_SCAN_FILES = 200_000
const preparedInitialSyncScans = new Map<string, PreparedInitialSyncScan>()

/**
 * Releases the retained manifests of expired prepared scans while keeping the
 * accepted issue signature, so "Continue anyway" after the window still
 * honours the reviewed report. This runs on its own timer: an abandoned review
 * dialog may never touch the map again, and the window can be hidden in the
 * tray for hours while the process stays alive.
 */
function releaseExpiredPreparedScans(now = Date.now()): void {
  for (const [folderId, prepared] of preparedInitialSyncScans) {
    if (prepared.localManifest === undefined && prepared.remoteManifest === undefined) continue
    if (now - prepared.capturedAt < PREPARED_INITIAL_SYNC_TTL_MS) continue
    preparedInitialSyncScans.set(folderId, {
      capturedAt: prepared.capturedAt,
      signature: prepared.signature,
      issuesSignature: prepared.issuesSignature,
    })
  }
}

const preparedInitialSyncSweepTimer = setInterval(
  () => releaseExpiredPreparedScans(),
  Math.min(PREPARED_INITIAL_SYNC_TTL_MS, 60_000),
)
preparedInitialSyncSweepTimer.unref()

/** Raised after the folder has been put into its "review inaccessible items" state. */
class InitialSyncUnreadableError extends Error {
  constructor() {
    super("The initial merge paused because some items could not be read.")
    this.name = "InitialSyncUnreadableError"
  }
}

function trackFolderScan(folderId: string | undefined, controller: AbortController): () => void {
  if (!folderId) return () => undefined
  let set = folderScanControllers.get(folderId)
  if (!set) {
    set = new Set()
    folderScanControllers.set(folderId, set)
  }
  set.add(controller)
  return () => {
    set?.delete(controller)
    if (set?.size === 0) folderScanControllers.delete(folderId)
  }
}

function abortFolderScans(folderId: string): void {
  const set = folderScanControllers.get(folderId)
  if (!set) return
  for (const controller of [...set]) controller.abort()
}

/**
 * Runs one local folder walk under process-wide scan admission, aborting it on
 * app shutdown or the caller's signal. Admission covers only the local walk;
 * the caller releases it before any peer wait by awaiting the walk inside
 * runPairedScans separately.
 */
function runAdmittedScan<T>(key: string, folderId: string | undefined, signal: AbortSignal | null, walk: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  if (signal?.aborted || shutdownScanController.signal.aborted) controller.abort()
  const forwardShutdown = (): void => controller.abort()
  const forwardOuter = (): void => controller.abort()
  shutdownScanController.signal.addEventListener("abort", forwardShutdown, { once: true })
  signal?.addEventListener("abort", forwardOuter, { once: true })
  const untrack = trackFolderScan(folderId, controller)
  return globalScanCoordinator.run(key, () => {
    const effective = AbortSignal.any([controller.signal, shutdownScanController.signal, ...(signal ? [signal] : [])])
    return walk(effective)
  }, controller.signal).finally(() => {
    shutdownScanController.signal.removeEventListener("abort", forwardShutdown)
    signal?.removeEventListener("abort", forwardOuter)
    untrack()
  })
}

function runLocalScan(
  key: string,
  rootPath: string,
  ignorePatterns: string[],
  options: {
    hashAllFiles?: boolean
    maxFiles?: number | null
    onActivity?: (activity: import("../shared/contracts").FolderScanActivity) => void
    onMetrics?: (metrics: ScanMetrics) => void
    onSettledDigest?: (relativePath: string, digest: CachedFileDigest) => void
    reuse?: ReadonlyMap<string, CachedFileDigest>
    folderId?: string
    digestCache?: ScanDigestCache
  },
  signal: AbortSignal | null,
): Promise<FileManifest> {
  return runAdmittedScan(key, options.folderId, signal, (effective) => scanFolder(rootPath, ignorePatterns, {
    hashAllFiles: options.hashAllFiles,
    maxFiles: options.maxFiles,
    onActivity: options.onActivity,
    onMetrics: (metrics) => {
      scanLedger.record(scanStageForKey(key), key, metrics)
      options.onMetrics?.(metrics)
    },
    onSettledDigest: options.onSettledDigest,
    reuse: options.reuse,
    signal: effective,
    digestCache: options.digestCache,
  }))
}

const digestCacheVerifier = new DigestCacheVerifier()

/**
 * Runs one full-integrity pass over an active folder through the digest
 * cache, so files whose exact identity is unchanged since an earlier sweep
 * are not read again.
 */
async function withFolderDigestCache<T extends { truncated: boolean }>(
  folderId: string,
  pass: (digestCache: ScanDigestCache) => Promise<T>,
): Promise<T> {
  const startedAt = Date.now()
  const deep = digestCacheVerifier.requiresDeepSweep(folderId, startedAt)
  const digestCache = new EngineScanDigestCache(engine, folderId, { deep })
  const result = await pass(digestCache)
  const complete = !result.truncated
  await digestCache.finish({ complete })
  if (deep && complete) digestCacheVerifier.completedDeepSweep(folderId, startedAt)
  return result
}

type ActiveFolderScanTarget = Pick<FolderSummary, "id" | "localPath" | "ignorePatterns">

/** Full-integrity scan of an active folder, reusing the digests of unchanged files. */
function runCachedFolderScan(
  key: string,
  folder: ActiveFolderScanTarget,
  maxFiles: number | null,
  signal: AbortSignal | null,
  reuse?: ReadonlyMap<string, CachedFileDigest>,
): Promise<FileManifest> {
  return withFolderDigestCache(folder.id, (digestCache) =>
    runLocalScan(key, folder.localPath, folder.ignorePatterns, { hashAllFiles: true, maxFiles, folderId: folder.id, digestCache, reuse }, signal))
}

/** The same pass reduced to an observation fingerprint, holding no file list in memory. */
function runCachedFolderFingerprint(key: string, folder: ActiveFolderScanTarget, maxFiles: number | null, signal: AbortSignal | null): Promise<FolderFingerprint> {
  return withFolderDigestCache(folder.id, (digestCache) =>
    runAdmittedScan(key, folder.id, signal, (effective) => fingerprintFolder(folder.localPath, folder.ignorePatterns, { maxFiles, signal: effective, digestCache })))
}

function requestPeerManifest(peerId: string, payload: PeerRequest, timeoutMs: number, signal: AbortSignal, chunked: boolean): Promise<FileManifest> {
  return requirePeerSessions().request<unknown>(peerId, payload, timeoutMs, { signal, chunked }).then((raw) => parsePeerManifest(raw))
}

/** A peer's optional features change only when its app updates, so a short cache saves a round trip per sync cycle. */
const PEER_CAPABILITY_TTL_MS = 10 * 60_000
const peerCapabilityCache = new Map<string, { capabilities: ReadonlySet<string>; fetchedAt: number }>()

async function cachedPeerCapabilities(peerId: string): Promise<ReadonlySet<string>> {
  const cached = peerCapabilityCache.get(peerId)
  if (cached && Date.now() - cached.fetchedAt < PEER_CAPABILITY_TTL_MS) return cached.capabilities
  const capabilities = await requestPeerCapabilities(requirePeerSessions(), peerId)
  peerCapabilityCache.set(peerId, { capabilities, fetchedAt: Date.now() })
  return capabilities
}

/** Whether manifests and observations can cross to this peer as chunks larger than one frame. */
async function peerSupportsChunkedFrames(peerId: string): Promise<boolean> {
  return (await cachedPeerCapabilities(peerId)).has(CHUNKED_FRAMES_CAPABILITY)
}

/** Per folder, the last continuous reconcile that queued nothing. Lost on restart, so the first cycle always reconciles. */
const quietReconciles = new Map<string, QuietReconcile>()

/**
 * Asks the peer for its continuous-sync observation, offering the fingerprint
 * it had at the last quiet reconcile so a supporting peer can answer that
 * nothing changed instead of sending it.
 */
async function requestPeerContinuousScan(
  peerId: string,
  folderId: string,
  knownFingerprint: string,
  signal: AbortSignal,
  chunked: boolean,
): Promise<FileManifest | { unchanged: true }> {
  const raw = await requirePeerSessions().request<unknown>(peerId, { type: "continuous-sync-scan", folderId, knownFingerprint }, CONTINUOUS_SYNC_RPC_TIMEOUT_MS, { signal, chunked })
  return isUnchangedScanReply(raw) ? raw : parsePeerManifest(raw)
}

/**
 * Fails closed before a manifest crosses the peer channel. A chunked exchange
 * is bounded exactly by the transport; a single-frame exchange with an older
 * peer keeps the legacy encoded-byte budget.
 */
function assertManifestFitsExchange(manifest: FileManifest, computer: string, chunked: boolean): void {
  if (!chunked) assertManifestWithinLegacyByteBudget(manifest, computer)
}

/** Fails closed before reconcile when both observations would not fit in the observe exchange sent to the peer. */
function assertObservationExchangeSendable(request: PeerRequest, peerName: string, chunked: boolean): void {
  const { bytes, limit, fits } = measurePeerRequest(request, { chunked })
  if (fits) return
  const remedy = chunked
    ? "Add ignore rules to exclude large generated folders"
    : "Update Tethera on both computers to sync larger folders, or add ignore rules"
  throw new Error(
    `Together, this computer and ${peerName} list too many files to exchange in one sync (about ${(bytes / 1_048_576).toFixed(1)} MiB, above the ${(limit / 1_048_576).toFixed(0)} MiB limit). ${remedy}; no incomplete observation was reconciled.`,
  )
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

function hasInitialSyncPeerLease(folderId: string, peerId?: string): boolean {
  const lease = initialSyncPeerLeases.get(folderId)
  if (!lease) return false
  if (lease.expiresAt <= Date.now()) {
    initialSyncPeerLeases.delete(folderId)
    return false
  }
  return peerId ? lease.peerId === peerId : true
}

function hasAnyInitialSyncPeerLease(): boolean {
  for (const folderId of initialSyncPeerLeases.keys()) {
    if (hasInitialSyncPeerLease(folderId)) return true
  }
  return false
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
    update: idleUpdateStateWithVersion(),
  }
}

function stateFilePath(): string {
  return path.join(app.getPath("userData"), "state.json")
}

function versionArchiveObjectRoot(): string {
  return path.join(app.getPath("userData"), VERSION_ARCHIVE_DIRECTORY, "objects")
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
    initialSyncOutcomes = parseInitialSyncOutcomes(loadedDocument.initialSyncOutcomes)
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
      settings: {
        ...defaultSettings,
        ...(parsed.settings ?? {}),
        maxScanFiles: normalizePersistedScanLimit((parsed.settings as Partial<AppSettings> | undefined)?.maxScanFiles),
      },
      update: idleUpdateStateWithVersion(),
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
        initialSyncOutcomes,
      },
      mappingOwnershipRetired,
    ),
  )
}

async function persistStateDurably(): Promise<void> {
  if (!desktopStateStore.writesEnabled) {
    throw new Error("Desktop state is unreadable, so Tethera cannot durably record the initial-merge outcome.")
  }
  await persistState()
}

function isPersistedSkipArray(value: unknown): value is Array<{ path: string; reason: string }> {
  return Array.isArray(value) &&
    value.length <= 10_000 &&
    value.every((item) =>
      item !== null && typeof item === "object" &&
      typeof (item as { path?: unknown }).path === "string" && (item as { path: string }).path.length <= 4_096 &&
      typeof (item as { reason?: unknown }).reason === "string" && (item as { reason: string }).reason.length <= 1_024
    )
}

function parseInitialSyncOutcomes(value: unknown): Record<string, PersistedInitialSyncOutcome> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const outcomes: Record<string, PersistedInitialSyncOutcome> = {}
  for (const [folderId, candidate] of Object.entries(value)) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue
    const outcome = candidate as Partial<PersistedInitialSyncOutcome>
    const { completedAt, copiedFiles, fileCount, conflicts, unreadableSkipped } = outcome
    if (
      typeof completedAt !== "string" ||
      typeof copiedFiles !== "number" || !Number.isSafeInteger(copiedFiles) || copiedFiles < 0 ||
      typeof fileCount !== "number" || !Number.isSafeInteger(fileCount) || fileCount < 0 ||
      !isPersistedSkipArray(conflicts) ||
      (unreadableSkipped !== undefined && !isPersistedSkipArray(unreadableSkipped))
    ) continue
    outcomes[folderId] = {
      completedAt,
      copiedFiles,
      fileCount,
      conflicts,
      ...(unreadableSkipped ? { unreadableSkipped } : {}),
    }
  }
  return outcomes
}

function idleFolderStatus(
  remoteDeviceId?: string,
  setupStatus: FolderSummary["setupStatus"] = "active",
): FolderSummary["status"] {
  const peer = remoteDeviceId ? getPairedDevice(remoteDeviceId) : getPairedDevices()[0]
  if (!peer) return "needs-attention"
  if (peer.status !== "online") return "offline"
  return setupStatus === "ready-for-initial-sync" ? "needs-attention" : "up-to-date"
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
  const previousStatuses = new Map(snapshot.folders.map((folder) => [folder.id, folder.status]))
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
    if (initialSyncInFlight.has(folder.id) || initialSyncForwarded.has(folder.id) || hasInitialSyncPeerLease(folder.id)) return folder
    if (!folder.remoteDeviceId || !trustedDevices.some((device) => device.id === folder.remoteDeviceId)) {
      return { ...folder, status: "needs-attention" }
    }
    if (
      folder.status === "needs-attention" &&
      (folder.currentAction?.includes("conflict") || folder.currentAction?.includes("retry"))
    ) return folder
    return { ...folder, status: idleFolderStatus(folder.remoteDeviceId, folder.setupStatus) }
  })
  void flushPendingMappingDecisions()
  void flushPendingConfigurationDeliveries()
  void refreshContinuousSyncMonitors()
  for (const folder of snapshot.folders) {
    if (folder.setupStatus === "active" && previousStatuses.get(folder.id) === "offline" && folder.status !== "offline") {
      scheduleContinuousSync(folder.id)
    }
  }
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
  if (paused && (initialSyncInFlight.size > 0 || initialSyncForwarded.size > 0 || archiveRestoreInFlight.size > 0 || hasConflictResolutionInFlight() || hasAnyInitialSyncPeerLease() || continuousSyncInFlight.size > 0)) {
    throw new Error("Wait for active file transfers to finish before pausing all folders.")
  }
  const next = await mutate(() => {
    snapshot.paused = paused
    snapshot.folders = snapshot.folders.map((folder) => ({
      ...folder,
      status: paused || folder.paused ? "paused" : idleFolderStatus(folder.remoteDeviceId, folder.setupStatus),
    }))
    pushActivity(
      paused ? "Syncing paused" : "Syncing resumed",
      paused ? "All configured folders were paused." : "Configured folders can sync when the paired device is online.",
      paused ? "warning" : "success",
    )
  })
  await refreshContinuousSyncMonitors()
  if (!paused) for (const folder of snapshot.folders) scheduleContinuousSync(folder.id)
  return next
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
  initialSyncOutcomes = Object.fromEntries(
    Object.entries(initialSyncOutcomes).filter(([folderId]) => mappingRecords.has(folderId)),
  )
  for (const folderId of continuousConflictFingerprints.keys()) {
    if (!mappingRecords.has(folderId)) continuousConflictFingerprints.delete(folderId)
  }
  for (const folderId of continuousLastErrors.keys()) {
    if (!mappingRecords.has(folderId)) continuousLastErrors.delete(folderId)
  }
  const previous = new Map(snapshot.folders.map((folder) => [folder.id, folder]))
  const localDeviceId = getLocalIdentityId()
  snapshot.folders = records.flatMap((record) => {
    const projected = folderFromMappingRecord(record, localDeviceId)
    if (!projected) return []
    const runtime = previous.get(projected.id)
    const outcome = initialSyncOutcomes[projected.id]
    const conflicts = outcome?.conflicts ?? []
    const conflictCount = Math.max(runtime?.conflictCount ?? 0, conflicts.length)
    const recoveryIssueCount = runtime?.recoveryIssueCount ?? 0
    const peer = projected.remoteDeviceId ? getPairedDevice(projected.remoteDeviceId) : undefined
    return [
      {
        ...projected,
        ...(runtime
          ? {
              progress: runtime.progress,
              bytesPerSecond: runtime.bytesPerSecond,
              fileCount: runtime.fileCount ?? outcome?.fileCount,
              lastSyncedAt: runtime.lastSyncedAt ?? outcome?.completedAt,
              currentAction: runtime.scanIssues
                ? runtime.currentAction ?? projected.currentAction
                : conflictCount > 0 || recoveryIssueCount > 0
                  ? runtime.currentAction ?? projected.currentAction
                  : projected.currentAction ?? runtime.currentAction,
              conflictCount,
              recoveryIssueCount,
              scanIssues: runtime.scanIssues,
            }
          : {
              fileCount: outcome?.fileCount,
              lastSyncedAt: outcome?.completedAt,
              currentAction: conflicts.length > 0
                ? `${conflicts.length} same-path conflict${conflicts.length === 1 ? " needs" : "s need"} attention; neither copy was changed.`
                : projected.currentAction,
              conflictCount,
            }),
        status:
          projected.paused || snapshot.paused
            ? "paused"
            : record.pendingDelivery || conflictCount > 0 || recoveryIssueCount > 0
              ? "needs-attention"
              : peer
                ? idleFolderStatus(projected.remoteDeviceId, projected.setupStatus)
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
      await refreshAuthoritativeMappings()
      await recoverIncompleteReplacements()
      snapshot.mappingStore = {
        status: "ready",
        schemaVersion: health.schemaVersion,
        migrationState: result.migration.state,
        journalMode: health.journalMode,
        mutationsEnabled: true,
        pendingDeliveryCount: result.records.filter((record) => record.pendingDelivery).length,
        cleanupWarning: result.cleanupWarning,
      }
      await Promise.all(snapshot.folders.map((folder) => refreshContinuousSyncState(folder.id)))
      await refreshContinuousSyncMonitors()
      for (const folder of snapshot.folders) scheduleContinuousSync(folder.id)
      await persistState()
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
  await refreshContinuousSyncMonitors()
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
  await refreshContinuousSyncMonitors()
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
  const acknowledgedMappings = new Set<string>()
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
      acknowledgedMappings.add(delivery.mappingId)
    } catch (error) {
      console.warn(`[mapping-index] delivery ${delivery.eventId} remains pending`, error)
    } finally {
      configurationDeliveriesInFlight.delete(key)
    }
  }
  if (acknowledgedAny) {
    await refreshAuthoritativeMappings()
    for (const mappingId of acknowledgedMappings) applyInitialSyncOutcomeStatus(mappingId)
    await refreshContinuousSyncMonitors()
    await persistState()
    broadcastSnapshot()
  } else if (previousPendingCount !== snapshot.mappingStore.pendingDeliveryCount) {
    broadcastSnapshot()
  }
}

async function requireExactMappingDeliveryAcknowledgement(record: MappingRecord, targetDeviceId: string): Promise<void> {
  const key = `${record.eventId}:${targetDeviceId}`
  const deadline = Date.now() + 60_000
  while (configurationDeliveriesInFlight.has(key) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
  }
  if (configurationDeliveriesInFlight.has(key)) {
    throw new Error("The files were merged, but another activation delivery did not finish in time. Tethera will keep retrying safely.")
  }
  await flushPendingConfigurationDeliveries()
  let pending: MappingDelivery[]
  try {
    pending = await engine.request<MappingDelivery[]>("mapping.listPendingDelivery")
  } catch (error) {
    throw new Error("The files were merged, but Tethera could not verify the peer's activation acknowledgement.", { cause: error })
  }
  if (pending.some((delivery) => delivery.eventId === record.eventId && delivery.targetDeviceId === targetDeviceId)) {
    throw new Error("The files were merged, but the other computer has not acknowledged activation yet. Tethera will keep retrying safely.")
  }
}

function previewsEqual(left: FolderMappingPreview, right: FolderMappingPreview): boolean {
  // The bounded issue lists are additive detail added after the original
  // contract. A preview from an older peer lacks them, so comparing them
  // would report a change that did not happen; the original counts still
  // have to match exactly.
  const canonical = (preview: FolderMappingPreview) => {
    const {
      unreadableLocal: _unreadableLocal,
      unreadableRemote: _unreadableRemote,
      unreadableLocalCount: _unreadableLocalCount,
      unreadableRemoteCount: _unreadableRemoteCount,
      ...rest
    } = preview
    return {
      ...rest,
      invalidWindowsNames: [...preview.invalidWindowsNames].sort(),
      caseCollisions: [...preview.caseCollisions].sort(),
      samples: [...preview.samples].sort((a, b) => `${a.category}:${a.path}`.localeCompare(`${b.category}:${b.path}`)),
    }
  }
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
}

function emitPreviewProgress(operationId: string | undefined, phase: FolderPreviewProgress["phase"], scannedFiles?: number, activity?: FolderPreviewProgress["activity"], reused?: boolean): void {
  if (!operationId || !mainWindow) return
  const progress: FolderPreviewProgress = { operationId, phase, scannedFiles, activity, ...(reused ? { reused: true } : {}) }
  try {
    if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return
    mainWindow.webContents.send("folders:preview-progress", progress)
  } catch {
    // Progress is advisory. Window teardown must not fail the scan or mapping request.
  }
}

async function previewFolderMapping(input: PreviewFolderMappingInput, progressOperationId?: unknown): Promise<FolderMappingPreview> {
  validateMappingInput(input)
  const peer = getPairedDevice(input.remoteDeviceId)
  if (!peer) throw new Error("Pair a trusted computer before previewing a folder mapping.")
  if (peer.status !== "online") throw new Error(`${peer.name} must be online to compare the folders.`)
  const operationId = parsePreviewProgressToken(progressOperationId)
  // Supersession: a repeated preview token cancels the previous scan.
  if (operationId) previewScanControllers.get(operationId)?.abort()
  const controller = new AbortController()
  if (operationId) previewScanControllers.set(operationId, controller)
  const onShutdown = (): void => controller.abort()
  shutdownScanController.signal.addEventListener("abort", onShutdown, { once: true })
  try {
    const localPath = path.resolve(input.localPath)
    const scanLimit = currentScanLimit()
    // Settled identities from this scan let the consent and merge walks reuse
    // digests for unchanged files instead of reading them again.
    const settled = new Map<string, CachedFileDigest>()
    emitPreviewProgress(operationId, "scan-local", 0)
    // Local slot is held only for the walk; the subsequent peer wait runs
    // without it so two devices cannot deadlock holding a slot each.
    const localManifest = await runLocalScan(`preview:${localPath}`, localPath, input.ignorePatterns, {
      maxFiles: scanLimit,
      reuse: scanReuseSeeds.lookup(localPath, input.ignorePatterns),
      onSettledDigest: (relativePath, digest) => settled.set(relativePath, digest),
      onActivity: (activity) => emitPreviewProgress(operationId, "scan-local", activity.scannedFiles, activity),
    }, controller.signal)
    scanReuseSeeds.remember(localPath, input.ignorePatterns, settled)
    if (operationId) {
      previewScanSessions.record(operationId, previewScanKey({
        kind: "local",
        rootPath: localPath,
        ignorePatterns: input.ignorePatterns,
        hashAllFiles: false,
        maxFiles: scanLimit,
      }), localManifest)
    }
    if (controller.signal.aborted) throw new ScanCancelledError()
    emitPreviewProgress(operationId, "scan-remote")
    const remoteManifest = await requestPeerPreview(requirePeerSessions(), peer, {
      path: input.remotePath,
      ignorePatterns: input.ignorePatterns,
    }, controller.signal, (progress) => emitPreviewProgress(operationId, "scan-remote", progress.scannedFiles, { ...progress, currentPath: "" }))
    if (operationId) previewScanSessions.record(operationId, remotePreviewScanKey(peer.id, input.remotePath, input.ignorePatterns), remoteManifest)
    if (controller.signal.aborted) throw new ScanCancelledError()
    emitPreviewProgress(operationId, "compare")
    // Truncated previews stay explicit partial results; sync paths fail closed elsewhere.
    return compareManifests(localManifest, remoteManifest, {
      mode: input.mode,
      localPlatform: platform(),
      remotePlatform: peer.platform,
    })
  } finally {
    shutdownScanController.signal.removeEventListener("abort", onShutdown)
    if (operationId && previewScanControllers.get(operationId) === controller) previewScanControllers.delete(operationId)
  }
}

function remotePreviewScanKey(peerId: string, remotePath: string, ignorePatterns: string[]): string {
  return previewScanKey({ kind: "remote", peerId, rootPath: remotePath, ignorePatterns, hashAllFiles: false, maxFiles: null })
}

/** The lookup side reads the current limit so captures taken under a different limit safely miss. */
function localPreviewScanKey(localPath: string, ignorePatterns: string[], maxFiles: number | null = currentScanLimit()): string {
  return previewScanKey({ kind: "local", rootPath: localPath, ignorePatterns, hashAllFiles: false, maxFiles })
}

/** Both scans captured during a renderer's review step, if still cached and unchanged. */
function lookupPreviewScanPair(operationId: string, localPath: string, remotePath: string, peerId: string, ignorePatterns: string[]): { local: FileManifest; remote: FileManifest } | undefined {
  const local = previewScanSessions.lookup(operationId, localPreviewScanKey(localPath, ignorePatterns))
  const remote = previewScanSessions.lookup(operationId, remotePreviewScanKey(peerId, remotePath, ignorePatterns))
  return local && remote ? { local, remote } : undefined
}

async function requestFolderMapping(input: RequestFolderMappingInput, progressOperationId?: unknown): Promise<AppSnapshot> {
  requireMappingMutations()
  validateMappingInput(input)
  const peer = getPairedDevice(input.remoteDeviceId)
  if (!peer) throw new Error("Pair a trusted computer before requesting a folder mapping.")
  if (peer.status !== "online") throw new Error(`${peer.name} must be online to approve the mapping.`)
  const operationId = parsePreviewProgressToken(progressOperationId)
  const localPath = path.resolve(input.localPath)
  // Reuse the scans the renderer just reviewed instead of walking both folder
  // trees a second time. The responder still re-scans before approving, so
  // filesystem drift is caught by the consent gate; the merge below scans
  // again before copying anything. A missing or expired capture rescans here.
  const captured = operationId
    ? lookupPreviewScanPair(operationId, localPath, input.remotePath, peer.id, input.ignorePatterns)
    : undefined
  let authoritativePreview: FolderMappingPreview
  if (captured) {
    emitPreviewProgress(operationId, "compare", undefined, undefined, true)
    authoritativePreview = compareManifests(captured.local, captured.remote, {
      mode: input.mode,
      localPlatform: platform(),
      remotePlatform: peer.platform,
    })
  } else {
    authoritativePreview = await previewFolderMapping(input, progressOperationId)
  }
  if (!previewsEqual(authoritativePreview, input.preview)) {
    throw new Error("The folders changed after the preview. Review the initial merge again before requesting approval.")
  }
  if (authoritativePreview.invalidWindowsNames.length > 0 || authoritativePreview.caseCollisions.length > 0) {
    throw new Error("Resolve Windows-invalid names and case-only collisions before requesting approval.")
  }
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
    maxFileBytes: input.maxFileBytes ?? null,
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
  if (operationId) previewScanSessions.drop(operationId)
  return snapshot
}

/**
 * Runs the responder's independent two-sided comparison at approval time.
 *
 * The walk is deliberately not replaceable by the initiator's preview: the
 * proposal carries only a summary, approval is the authorization gate, and
 * the responder must consent to both trees as they exist now, under its own
 * scan limits, unreadable-path report and ignore rules. Settled setup digests
 * are reused, so only changed, new or above-preview-ceiling files are read.
 */
async function buildIncomingMappingPreview(
  request: IncomingMappingRequest,
  destinationPath: string,
  progressOperationId?: unknown,
): Promise<FolderMappingPreview> {
  const peer = getPairedDevice(request.fromDeviceId)
  if (!peer) throw new Error("The requesting computer is no longer trusted.")
  if (peer.status !== "online") throw new Error(`${peer.name} must be online to compare the folders.`)
  const operationId = parsePreviewProgressToken(progressOperationId)
  if (operationId) previewScanControllers.get(operationId)?.abort()
  const controller = new AbortController()
  if (operationId) previewScanControllers.set(operationId, controller)
  const onShutdown = (): void => controller.abort()
  shutdownScanController.signal.addEventListener("abort", onShutdown, { once: true })
  try {
    const target = path.resolve(destinationPath)
    const targetStat = await stat(target)
    if (!targetStat.isDirectory()) throw new Error("The selected destination is not a folder.")
    emitPreviewProgress(operationId, "scan-remote")
    const initiatorManifest = await requestPeerPreview(requirePeerSessions(), peer, {
      path: request.proposal.initiatorPath,
      ignorePatterns: request.proposal.ignorePatterns,
    }, controller.signal, (progress) => emitPreviewProgress(operationId, "scan-remote", progress.scannedFiles, { ...progress, currentPath: "" }))
    if (operationId) previewScanSessions.record(operationId, remotePreviewScanKey(peer.id, request.proposal.initiatorPath, request.proposal.ignorePatterns), initiatorManifest)
    if (controller.signal.aborted) throw new ScanCancelledError()
    emitPreviewProgress(operationId, "scan-local", 0)
    // This is the responder's first look at its own destination folder. Its
    // settled identities seed the local inverse merge walk after approval.
    const settled = new Map<string, CachedFileDigest>()
    // One limit for the scan and its cache key: if the setting changes during
    // the walk, the manifest must not later be reused under the new limit.
    const scanLimit = currentScanLimit()
    const responderManifest = await runLocalScan(`incoming:${target}`, target, request.proposal.ignorePatterns, {
      maxFiles: scanLimit,
      reuse: scanReuseSeeds.lookup(target, request.proposal.ignorePatterns),
      onSettledDigest: (relativePath, digest) => settled.set(relativePath, digest),
      onActivity: (activity) => emitPreviewProgress(operationId, "scan-local", activity.scannedFiles, activity),
    }, controller.signal)
    scanReuseSeeds.remember(target, request.proposal.ignorePatterns, settled)
    if (operationId) previewScanSessions.record(operationId, localPreviewScanKey(target, request.proposal.ignorePatterns, scanLimit), responderManifest)
    if (controller.signal.aborted) throw new ScanCancelledError()
    emitPreviewProgress(operationId, "compare")
    return compareManifests(initiatorManifest, responderManifest, {
      mode: request.proposal.mode,
      localPlatform: peer.platform,
      remotePlatform: platform(),
    })
  } finally {
    shutdownScanController.signal.removeEventListener("abort", onShutdown)
    if (operationId && previewScanControllers.get(operationId) === controller) previewScanControllers.delete(operationId)
  }
}

async function refreshIncomingMappingPreview(input: RefreshIncomingMappingPreviewInput, progressOperationId?: unknown): Promise<AppSnapshot> {
  const request = snapshot.mappings.incoming.find((item) => item.id === input.requestId && item.status === "pending")
  if (!request) throw new Error("The folder mapping request is no longer available.")
  const destinationPath = path.resolve(input.destinationPath)
  const preview = await buildIncomingMappingPreview(request, destinationPath, progressOperationId)
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

async function approveFolderMapping(input: ApproveFolderMappingInput, progressOperationId?: unknown): Promise<AppSnapshot> {
  requireMappingMutations()
  const request = snapshot.mappings.incoming.find((item) => item.id === input.requestId)
  if (!request) throw new Error("The folder mapping request is no longer available.")
  const destinationPath = path.resolve(input.destinationPath)
  if (destinationPath !== path.resolve(request.proposal.responderPath)) {
    throw new Error("Refresh the initial comparison for the new destination before approving.")
  }
  const peer = getPairedDevice(request.fromDeviceId)
  if (!peer) throw new Error("The requesting computer is no longer trusted.")
  const operationId = parsePreviewProgressToken(progressOperationId)
  // Reuse the scans from the refresh step when the destination has not changed
  // since; otherwise this is the only scan and no cache entry exists.
  const captured = operationId
    ? lookupPreviewScanPair(operationId, destinationPath, request.proposal.initiatorPath, peer.id, request.proposal.ignorePatterns)
    : undefined
  const refreshedPreview = captured && peer.status === "online"
    ? (emitPreviewProgress(operationId, "compare", undefined, undefined, true), compareManifests(captured.remote, captured.local, {
        mode: request.proposal.mode,
        localPlatform: peer.platform,
        remotePlatform: platform(),
      }))
    : await buildIncomingMappingPreview(request, destinationPath, progressOperationId)
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

function continuousCoordinatorId(record: MappingRecord): string {
  return [record.mapping.initiatorDeviceId, record.mapping.responderDeviceId].sort()[0]
}

function isLocalContinuousCoordinator(record: MappingRecord): boolean {
  return continuousCoordinatorId(record) === getLocalIdentityId()
}

function applyFileSyncStateToFolder(folderId: string, state: FileSyncState, syncedAt?: string): void {
  const folder = snapshot.folders.find((item) => item.id === folderId)
  if (!folder) return
  const peer = getPairedDevice(folder.remoteDeviceId)
  const durablePaths = new Set(state.conflicts.map((conflict) => conflict.path))
  const legacyConflictCount = (initialSyncOutcomes[folderId]?.conflicts ?? [])
    .filter((conflict) => !durablePaths.has(conflict.path)).length
  const conflictCount = state.conflicts.length + legacyConflictCount
  const hasConflicts = conflictCount > 0
  const hasRecoveryIssues = state.recoveryIssues.length > 0
  updateFolder(folderId, {
    status: folder.paused || snapshot.paused
      ? "paused"
      : hasConflicts || hasRecoveryIssues
        ? "needs-attention"
        : peer?.status === "online"
          ? "up-to-date"
          : "offline",
    currentAction: hasRecoveryIssues
      ? state.recoveryIssues[0]?.lastError ?? `${state.recoveryIssues.length} file replacement${state.recoveryIssues.length === 1 ? " requires" : "s require"} recovery.`
      : hasConflicts
      ? state.conflicts.length > 0
        ? conflictSummary(state.conflicts)
        : `${legacyConflictCount} initial-merge conflict${legacyConflictCount === 1 ? " needs" : "s need"} an authoritative two-sided scan.`
      : state.operations.length > 0
        ? `${state.operations.length} change${state.operations.length === 1 ? " is" : "s are"} waiting to retry.`
        : "Watching for changes.",
    progress: undefined,
    bytesPerSecond: undefined,
    lastSyncedAt: syncedAt ?? folder.lastSyncedAt,
    fileCount: state.baselineCount,
    conflictCount,
    recoveryIssueCount: state.recoveryIssues.length,
  })
}

function conflictDetail(conflict: FileSyncConflict): string {
  if (conflict.kind === "simultaneous-modification") {
    return "Both computers changed this file since the last verified copy. Neither version was replaced."
  }
  if (conflict.kind === "deletion-not-propagated") {
    return "This file is missing on one computer. Tethera does not propagate deletions yet, so the remaining copy was preserved."
  }
  if (conflict.kind === "direction-blocked") {
    return "The detected change conflicts with this folder's one-way sync direction. Neither version was replaced."
  }
  return "The computers did not have a verified common baseline for this path. Neither version was replaced."
}

function recoveryConflict(
  folder: FolderSummary,
  conflict: FileSyncConflict,
  operations: FileSyncOperation[],
): RecoveryConflict {
  const peer = getPairedDevice(folder.remoteDeviceId)
  return {
    mappingId: folder.id,
    folderName: folder.name,
    path: conflict.path,
    kind: conflict.kind,
    detectedAt: conflict.detectedAt,
    localDeviceId: getLocalIdentityId(),
    localDeviceName: os.hostname(),
    localDigest: conflict.localDigest,
    remoteDeviceId: peer?.id ?? folder.remoteDeviceId ?? "unavailable-peer",
    remoteDeviceName: peer?.name ?? "Paired computer",
    remoteDigest: conflict.remoteDigest,
    resolutionQueued: operations.some((operation) => operation.path === conflict.path),
    detail: conflictDetail(conflict),
  }
}

function requireRecoveryFolder(mappingId: string): { folder: FolderSummary; peer: DeviceSummary; record: MappingRecord } {
  const folder = snapshot.folders.find((candidate) => candidate.id === mappingId)
  const record = mappingRecords.get(mappingId)
  if (!folder || !record || folder.setupStatus !== "active") {
    throw new Error("This conflict's folder is no longer active.")
  }
  const peer = getPairedDevice(folder.remoteDeviceId)
  if (!peer) throw new Error("The paired computer for this conflict is no longer trusted.")
  return { folder, peer, record }
}

async function getRecoveryState(): Promise<RecoveryState> {
  if (engine.state.status !== "ready" || snapshot.mappingStore.status !== "ready") {
    throw new Error("Recovery information is unavailable until the mapping database is ready.")
  }
  const activeFolders = snapshot.folders.filter((folder) => folder.setupStatus === "active")
  const states = await Promise.all(
    activeFolders.map(async (folder) => ({
      folder,
      state: await engine.request<FileSyncState>("fileSync.getState", { id: folder.id }),
    })),
  )
  const conflicts: RecoveryConflict[] = []
  const issues: RecoveryState["issues"] = []
  for (const { folder, state } of states) {
    const durablePaths = new Set(state.conflicts.map((conflict) => conflict.path))
    conflicts.push(...state.conflicts.map((conflict) => recoveryConflict(folder, conflict, state.operations)))
    const peer = getPairedDevice(folder.remoteDeviceId)
    for (const conflict of initialSyncOutcomes[folder.id]?.conflicts ?? []) {
      if (durablePaths.has(conflict.path)) continue
      conflicts.push({
        mappingId: folder.id,
        folderName: folder.name,
        path: conflict.path,
        kind: "initial-merge",
        detectedAt: initialSyncOutcomes[folder.id]?.completedAt,
        localDeviceId: getLocalIdentityId(),
        localDeviceName: os.hostname(),
        remoteDeviceId: peer?.id ?? folder.remoteDeviceId ?? "unavailable-peer",
        remoteDeviceName: peer?.name ?? "Paired computer",
        resolutionQueued: false,
        detail: "The initial merge preserved different copies. Tethera is waiting for an authoritative two-sided scan before a version can be selected.",
      })
    }
    issues.push(...state.recoveryIssues.map((issue) => ({
      id: issue.id,
      mappingId: folder.id,
      folderName: folder.name,
      path: issue.path,
      state: issue.state,
      detail: issue.lastError ?? "The replacement journal needs manual recovery before this path can sync.",
    })))
  }
  conflicts.sort((left, right) => left.folderName.localeCompare(right.folderName) || left.path.localeCompare(right.path))
  issues.sort((left, right) => left.folderName.localeCompare(right.folderName) || left.path.localeCompare(right.path))
  return { conflicts, issues }
}

async function describeConflictCopy(
  rootPath: string,
  relativePath: string,
  expectedDigest: string | undefined,
): Promise<PeerConflictCopy> {
  try {
    const descriptor = await describeTransferFile(rootPath, relativePath)
    if (!expectedDigest || descriptor.digest !== expectedDigest) {
      throw new Error("The file changed after this conflict was recorded. Refresh the conflict before choosing a version.")
    }
    return { present: true, ...descriptor }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && expectedDigest === undefined) {
      return { present: false }
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("A conflict copy is no longer present. Tethera will rescan before offering another choice.", { cause: error })
    }
    throw error
  }
}

async function inspectFileConflict(input: ConflictInspectionInput): Promise<ConflictInspection> {
  validateConflictInput(input)
  const { folder, peer } = requireRecoveryFolder(input.mappingId)
  if (folder.paused || snapshot.paused) throw new Error("Resume this folder before inspecting its conflict copies.")
  if (peer.status !== "online") throw new Error(`${peer.name} must be online to inspect both copies.`)
  return withConflictHashing(folder.id, async () => {
    const state = await engine.request<FileSyncState>("fileSync.getState", { id: folder.id })
    const durable = state.conflicts.find((conflict) => conflict.path === input.path)
    if (!durable) {
      if (initialSyncOutcomes[folder.id]?.conflicts.some((conflict) => conflict.path === input.path)) {
        await notifyContinuousSyncCoordinator(folder.id)
        throw new Error("Tethera is refreshing this initial-merge conflict. Try again after the next two-sided scan.")
      }
      throw new Error("This file conflict no longer exists.")
    }
    const [local, remoteValue] = await Promise.all([
      describeConflictCopy(folder.localPath, durable.path, durable.localDigest),
      requirePeerSessions().request<unknown>(peer.id, {
        type: "continuous-sync-inspect-conflict",
        folderId: folder.id,
        path: durable.path,
      }, CONTINUOUS_SYNC_RPC_TIMEOUT_MS),
    ])
    const remote = parsePeerConflictCopy(remoteValue)
    if (remote.digest !== durable.remoteDigest || remote.present !== (durable.remoteDigest !== undefined)) {
      await notifyContinuousSyncCoordinator(folder.id)
      throw new Error("The paired copy changed after this conflict was recorded. Tethera will rescan it before another choice.")
    }
    const conflict = recoveryConflict(folder, durable, state.operations)
    return {
      conflict,
      local: {
        deviceId: conflict.localDeviceId,
        deviceName: conflict.localDeviceName,
        location: "this-computer",
        present: local.present,
        digest: local.digest,
        size: local.size,
        modifiedAt: local.modifiedMs === undefined ? undefined : new Date(local.modifiedMs).toISOString(),
      },
      remote: {
        deviceId: conflict.remoteDeviceId,
        deviceName: conflict.remoteDeviceName,
        location: "paired-computer",
        present: remote.present,
        digest: remote.digest,
        size: remote.size,
        modifiedAt: remote.modifiedMs === undefined ? undefined : new Date(remote.modifiedMs).toISOString(),
      },
    }
  })
}

async function resolveFileConflictLocally(input: ResolveFileConflictInput): Promise<AppSnapshot> {
  validateConflictInput(input)
  requireMappingMutations()
  const { folder, peer, record } = requireRecoveryFolder(input.mappingId)
  if (!isLocalContinuousCoordinator(record)) {
    throw new Error("Only the elected synchronization coordinator can record a conflict choice.")
  }
  if (typeof input.winnerDeviceId !== "string" || !input.winnerDeviceId) {
    throw new Error("Choose which computer's copy to keep.")
  }
  if (folder.paused || snapshot.paused) throw new Error("Resume this folder before resolving a conflict.")
  if (peer.status !== "online") throw new Error(`${peer.name} must be online to resolve this conflict.`)
  if (continuousSyncInFlight.has(folder.id) || initialSyncInFlight.has(folder.id) || archiveRestoreInFlight.has(folder.id)) {
    throw new Error("Wait for the current folder operation to finish before resolving this conflict.")
  }
  const key = `${folder.id}\0${input.path}`
  if (conflictResolutionInFlight.has(key)) throw new Error("This conflict resolution is already being prepared.")
  conflictResolutionInFlight.add(key)
  try {
    const inspection = await inspectFileConflict(input)
    requireUnchangedInspectedCopies(input, inspection)
    if (!inspection.local.present || !inspection.remote.present) {
      throw new Error("Deletion conflicts remain protected until deletion propagation has a recovery-safe design.")
    }
    if (
      inspection.local.digest === undefined || inspection.local.size === undefined ||
      inspection.remote.digest === undefined || inspection.remote.size === undefined
    ) {
      throw new Error("Both conflict copies must have verified size and digest metadata before resolution.")
    }
    const localWins = input.winnerDeviceId === inspection.local.deviceId
    const remoteWins = input.winnerDeviceId === inspection.remote.deviceId
    if (!localWins && !remoteWins) throw new Error("The selected version does not belong to this folder's participants.")
    const direction: FileSyncDirection = localWins ? "push-local" : "pull-remote"
    requireAllowedConflictDirection(folder.mode, direction)
    const state = await engine.request<FileSyncState>("fileSync.resolveConflict", {
      mappingId: folder.id,
      path: input.path,
      direction,
      localDigest: inspection.local.digest,
      localSize: inspection.local.size,
      remoteDigest: inspection.remote.digest,
      remoteSize: inspection.remote.size,
      requestedAt: new Date().toISOString(),
    })
    applyFileSyncStateToFolder(folder.id, state)
    pushActivity(
      "Conflict resolution queued",
      `${folder.name}: ${input.path} will use ${localWins ? "this computer's" : `${peer.name}'s`} copy; the replaced copy will be archived first.`,
      "info",
      folder.id,
    )
    await persistState()
    scheduleContinuousSync(folder.id)
    return broadcastSnapshot()
  } finally {
    conflictResolutionInFlight.delete(key)
  }
}

async function resolveFileConflict(value: unknown): Promise<AppSnapshot> {
  const input = parseResolveFileConflictInput(value)
  requireMappingMutations()
  const { folder, peer, record } = requireRecoveryFolder(input.mappingId)
  if (isLocalContinuousCoordinator(record)) return resolveFileConflictLocally(input)
  if (continuousSyncInFlight.has(folder.id) || initialSyncInFlight.has(folder.id) || archiveRestoreInFlight.has(folder.id)) {
    throw new Error("Wait for the current folder operation to finish before resolving this conflict.")
  }
  if (peer.id !== continuousCoordinatorId(record) || peer.status !== "online") {
    throw new Error("The coordinating computer must be online to resolve this conflict.")
  }
  const localExpectation = input.inspectedCopies.find((copy) => copy.deviceId === getLocalIdentityId())
  const remoteExpectation = input.inspectedCopies.find((copy) => copy.deviceId === peer.id)
  if (!localExpectation || !remoteExpectation) {
    throw new Error("The inspected conflict copies do not match this folder's participants.")
  }
  const key = `${folder.id}\0${input.path}`
  if (conflictResolutionInFlight.has(key)) throw new Error("This conflict resolution is already being prepared.")
  conflictResolutionInFlight.add(key)
  const requestResolution = async (timeoutMs: number): Promise<void> => {
    const response = await requirePeerSessions().request<{ accepted: boolean }>(peer.id, {
      type: "continuous-sync-resolve-conflict",
      folderId: folder.id,
      path: input.path,
      winnerDeviceId: input.winnerDeviceId,
      inspectedCopies: input.inspectedCopies,
    }, timeoutMs)
    if (response.accepted !== true) throw new Error("The coordinating computer did not accept the conflict choice.")
  }
  try {
    await requestResolution(CONTINUOUS_SYNC_RPC_TIMEOUT_MS)
  } catch {
    const direction: FileSyncDirection = input.winnerDeviceId === getLocalIdentityId() ? "push-local" : "pull-remote"
    const selected = direction === "push-local" ? localExpectation : remoteExpectation
    const replaced = direction === "push-local" ? remoteExpectation : localExpectation
    try {
      await requestResolution(CONFLICT_RESOLUTION_CONFIRM_TIMEOUT_MS)
    } catch (retryError) {
      const state = await engine.request<FileSyncState>("fileSync.getState", { id: folder.id }).catch(() => undefined)
      const exactWorkExists = state?.operations.some((operation) =>
        operation.path === input.path &&
        operation.direction === direction &&
        operation.sourceDigest === selected.digest &&
        operation.sourceSize === selected.size &&
        operation.expectedDestinationDigest === replaced.digest,
      ) ?? false
      let completed = false
      if (state && !state.conflicts.some((conflict) => conflict.path === input.path)) {
        const live = await describeTransferFile(folder.localPath, input.path).catch(() => undefined)
        completed = live?.digest === selected.digest && live.size === selected.size
      }
      if (!exactWorkExists && !completed) throw retryError
    }
  } finally {
    conflictResolutionInFlight.delete(key)
  }
  pushActivity(
    "Conflict resolution requested",
    `${folder.name}: the coordinating computer accepted the selected version for ${input.path}.`,
    "info",
    folder.id,
  )
  await persistState()
  return broadcastSnapshot()
}

function recordContinuousConflicts(folder: FolderSummary, conflicts: FileSyncConflict[]): void {
  const fingerprint = conflicts
    .map((conflict) => `${conflict.path}\0${conflict.kind}\0${conflict.localDigest ?? ""}\0${conflict.remoteDigest ?? ""}`)
    .sort()
    .join("\n")
  if (continuousConflictFingerprints.get(folder.id) === fingerprint) return
  if (fingerprint) {
    pushActivity("Sync conflict needs attention", `${folder.name}: ${conflictSummary(conflicts)}`, "warning", folder.id)
    for (const conflict of conflicts.slice(0, 20)) {
      pushActivity(`Conflict left untouched: ${conflict.path}`, conflictDetail(conflict), "warning", folder.id)
    }
    continuousConflictFingerprints.set(folder.id, fingerprint)
  } else {
    continuousConflictFingerprints.delete(folder.id)
  }
}

async function refreshContinuousSyncState(folderId: string): Promise<void> {
  if (engine.state.status !== "ready" || snapshot.mappingStore.status !== "ready") return
  const folder = snapshot.folders.find((item) => item.id === folderId)
  if (!folder || folder.setupStatus !== "active") return
  try {
    const state = await engine.request<FileSyncState>("fileSync.getState", { id: folderId })
    applyFileSyncStateToFolder(folderId, state)
    const current = snapshot.folders.find((item) => item.id === folderId)
    if (current) recordContinuousConflicts(current, state.conflicts)
    broadcastSnapshot()
  } catch (error) {
    console.warn(`[continuous-sync] unable to restore durable state for ${folderId}`, error)
  }
}

function scheduleContinuousSync(folderId: string): void {
  if (continuousSyncBlocked.has(folderId)) return
  const retry = continuousSyncRetryTimers.get(folderId)
  if (retry) clearTimeout(retry)
  continuousSyncRetryTimers.delete(folderId)
  continuousSyncQueued.add(folderId)
  if (continuousSyncInFlight.has(folderId)) return
  queueMicrotask(() => void flushContinuousSync(folderId))
}

function scheduleContinuousSyncRetry(folderId: string, delayMs: number, callback: () => void): void {
  if (continuousSyncRetryTimers.has(folderId) || continuousSyncBlocked.has(folderId)) return
  const retry = setTimeout(() => {
    continuousSyncRetryTimers.delete(folderId)
    callback()
  }, delayMs)
  retry.unref()
  continuousSyncRetryTimers.set(folderId, retry)
}

async function notifyContinuousSyncCoordinator(folderId: string): Promise<void> {
  const record = mappingRecords.get(folderId)
  const folder = snapshot.folders.find((item) => item.id === folderId)
  if (!record || !folder || continuousSyncBlocked.has(folderId)) return
  if (isLocalContinuousCoordinator(record)) {
    scheduleContinuousSync(folderId)
    return
  }
  if (continuousSyncNotificationsInFlight.has(folderId)) return
  const peer = getPairedDevice(folder.remoteDeviceId)
  if (!peer || peer.status !== "online") {
    updateFolder(folderId, { status: "offline", currentAction: "Waiting for the paired computer to reconnect." })
    broadcastSnapshot()
    return
  }
  continuousSyncNotificationsInFlight.add(folderId)
  try {
    await requirePeerSessions().request(peer.id, { type: "continuous-sync-notify", folderId })
  } catch (error) {
    console.warn(`[continuous-sync] unable to notify coordinator for ${folderId}`, error)
  } finally {
    continuousSyncNotificationsInFlight.delete(folderId)
  }
}

async function refreshContinuousSyncMonitors(): Promise<void> {
  if (!snapshot) return
  const wanted = new Set<string>()
  for (const folder of snapshot.folders) {
    const record = mappingRecords.get(folder.id)
    if (
      !record ||
      record.pendingDelivery ||
      continuousSyncBlocked.has(folder.id) ||
      folder.setupStatus !== "active" ||
      folder.paused ||
      snapshot.paused ||
      snapshot.mappingStore.status !== "ready"
    ) continue
    wanted.add(folder.id)
    if (continuousSyncMonitors.has(folder.id)) continue
    const monitor = new FolderChangeMonitor(folder.localPath, folder.ignorePatterns, () => {
      void notifyContinuousSyncCoordinator(folder.id)
    })
    continuousSyncMonitors.set(folder.id, monitor)
    void monitor.start().then(
      () => void notifyContinuousSyncCoordinator(folder.id),
      (error: unknown) => {
        if (continuousSyncMonitors.get(folder.id) !== monitor) return
        monitor.close()
        continuousSyncMonitors.delete(folder.id)
        const message = error instanceof Error ? error.message : "The synchronized folder could not be watched."
        updateFolder(folder.id, { status: "needs-attention", currentAction: message })
        pushActivity("Folder watch failed", `${folder.name}: ${message}`, "error", folder.id)
        broadcastSnapshot()
      },
    )
  }
  for (const [folderId, monitor] of continuousSyncMonitors) {
    if (wanted.has(folderId)) continue
    monitor.close()
    continuousSyncMonitors.delete(folderId)
    continuousSyncQueued.delete(folderId)
    const retry = continuousSyncRetryTimers.get(folderId)
    if (retry) clearTimeout(retry)
    continuousSyncRetryTimers.delete(folderId)
    if (!mappingRecords.has(folderId)) continuousConflictFingerprints.delete(folderId)
  }
}

async function retireInitialConflictProjection(folderId: string, state: FileSyncState): Promise<void> {
  const outcome = initialSyncOutcomes[folderId]
  if (!state.initialized || !outcome || outcome.conflicts.length === 0) return
  initialSyncOutcomes = {
    ...initialSyncOutcomes,
    [folderId]: { ...outcome, conflicts: [] },
  }
  await persistState()
}

async function executeContinuousOperations(
  folder: FolderSummary,
  peer: DeviceSummary,
  remoteManifest: FileManifest,
  operations: FileSyncOperation[],
  peerOperations: PeerFileOperationIdentity[],
): Promise<number> {
  const remoteFilesByPath = new Map(remoteManifest.files.map((entry) => [entry.path, entry]))
  const totalBytes = operations.reduce((total, operation) => total + operation.sourceSize, 0)
  let copiedBytes = 0
  let copiedFiles = 0
  const startedAt = Date.now()
  let lastProgressBroadcastAt = 0
  for (const operation of operations) {
    const current = snapshot.folders.find((item) => item.id === folder.id)
    if (!current || current.paused || snapshot.paused) throw new Error("Syncing was paused before it finished.")
    const reportProgress = (fileBytes: number) => {
      const transferred = copiedBytes + fileBytes
      updateFolder(folder.id, {
        status: "syncing",
        currentAction: `Syncing ${operation.path} (${copiedFiles + 1}/${operations.length})`,
        progress: totalBytes > 0 ? Math.min(transferred / totalBytes, 1) : 1,
        bytesPerSecond: Math.round(transferred / Math.max((Date.now() - startedAt) / 1_000, 0.001)),
      })
      const now = Date.now()
      if (now - lastProgressBroadcastAt >= PROGRESS_BROADCAST_INTERVAL_MS || transferred >= totalBytes) {
        lastProgressBroadcastAt = now
        broadcastSnapshot()
      }
    }
    try {
      reportProgress(0)
      if (operation.direction === "pull-remote") {
        const peerOperation = findMirroredPeerOperation(operation, peerOperations)
        if (!peerOperation) {
          throw new Error(`${operation.path} has no exact durable operation on the paired computer.`)
        }
        const entry = remoteFilesByPath.get(operation.path)
        if (!entry || entry.digest !== operation.sourceDigest || entry.size !== operation.sourceSize) {
          throw new Error(`${operation.path} changed after reconciliation; it will be retried.`)
        }
        const transfer = await pullPlannedFile(
          folder,
          peer,
          entry,
          reportProgress,
          operation.expectedDestinationDigest,
          operation.id,
        )
        if (!transfer.completedDuringRecovery) {
          await engine.request("fileSync.complete", {
            operationId: operation.id,
            digest: operation.sourceDigest,
            size: operation.sourceSize,
            verifiedAt: new Date().toISOString(),
            replacementJournalId: transfer.replacementJournalId,
          })
        }
        await requirePeerSessions().request(peer.id, {
          type: "continuous-sync-verified",
          folderId: folder.id,
          operationId: peerOperation.id,
          path: operation.path,
          digest: operation.sourceDigest,
          size: operation.sourceSize,
          expectedDestinationDigest: operation.expectedDestinationDigest,
        })
      } else {
        const response = await requirePeerSessions().request<{ applied: boolean }>(peer.id, {
          type: "continuous-sync-apply",
          folderId: folder.id,
          path: operation.path,
          digest: operation.sourceDigest,
          size: operation.sourceSize,
          expectedDestinationDigest: operation.expectedDestinationDigest,
        }, CONTINUOUS_SYNC_RPC_TIMEOUT_MS)
        if (response.applied !== true) throw new Error(`The peer did not apply ${operation.path}.`)
        await engine.request("fileSync.complete", {
          operationId: operation.id,
          digest: operation.sourceDigest,
          size: operation.sourceSize,
          verifiedAt: new Date().toISOString(),
        })
      }
      copiedFiles += 1
      copiedBytes += operation.sourceSize
    } catch (error) {
      const detail = error instanceof Error ? error.message : "The transfer failed."
      await engine.request("fileSync.fail", {
        operationId: operation.id,
        detail,
        failedAt: new Date().toISOString(),
      }).catch((recordError) => console.warn("[continuous-sync] unable to persist transfer failure", recordError))
      throw error
    }
  }
  return copiedFiles
}

async function recordPeerConflictChoice(
  folder: FolderSummary,
  peer: DeviceSummary,
  path: string,
  exactChoice: ExactConflictChoice,
): Promise<PeerFileOperationIdentity[]> {
  const response = await requirePeerSessions().request<unknown>(peer.id, {
    type: "continuous-sync-record-conflict-choice",
    folderId: folder.id,
    path,
    ...mirrorConflictChoice(exactChoice),
  }, CONTINUOUS_SYNC_RPC_TIMEOUT_MS)
  if (!response || typeof response !== "object" || Array.isArray(response) || (response as { recorded?: unknown }).recorded !== true) {
    throw new Error(`The peer did not durably record the selected version for ${path}.`)
  }
  return parsePeerFileOperations(response)
}

async function flushContinuousSync(folderId: string): Promise<void> {
  if (!continuousSyncQueued.has(folderId) || continuousSyncInFlight.has(folderId)) return
  continuousSyncQueued.delete(folderId)
  const record = mappingRecords.get(folderId)
  const folder = snapshot.folders.find((item) => item.id === folderId)
  if (hasConflictResolutionInFlight(folderId) || conflictHashingInFlight.has(folderId)) {
    continuousSyncQueued.add(folderId)
    scheduleContinuousSyncRetry(folderId, CONTINUOUS_SYNC_CAPACITY_RETRY_MS, () => void flushContinuousSync(folderId))
    return
  }
  if (
    !record ||
    record.pendingDelivery ||
    continuousSyncBlocked.has(folderId) ||
    !folder ||
    !isLocalContinuousCoordinator(record) ||
    folder.setupStatus !== "active" ||
    folder.paused ||
    snapshot.paused ||
    engine.state.status !== "ready" ||
    snapshot.mappingStore.status !== "ready"
  ) return
  const peer = getPairedDevice(folder.remoteDeviceId)
  if (!peer || peer.status !== "online") {
    updateFolder(folderId, { status: "offline", progress: undefined, bytesPerSecond: undefined, currentAction: "Waiting for the paired computer to reconnect." })
    broadcastSnapshot()
    return
  }
  if (continuousCyclesInProgress >= MAX_CONCURRENT_CONTINUOUS_CYCLES) {
    continuousSyncQueued.add(folderId)
    scheduleContinuousSyncRetry(folderId, CONTINUOUS_SYNC_CAPACITY_RETRY_MS, () => void flushContinuousSync(folderId))
    return
  }

  continuousCyclesInProgress += 1
  continuousSyncInFlight.add(folderId)
  updateFolder(folderId, { status: "syncing", progress: 0, bytesPerSecond: 0, currentAction: `Checking for changes with ${peer.name}…` })
  broadcastSnapshot()
  let reconciledState: ReconcileFilesResult | undefined
  try {
    const durableBeforeReconcile = await engine.request<FileSyncState>("fileSync.getState", { id: folderId })
    if (durableBeforeReconcile.recoveryIssues.length > 0) {
      applyFileSyncStateToFolder(folderId, durableBeforeReconcile)
      throw new Error("A replacement recovery issue must be repaired before this folder can synchronize.")
    }
    const observedAt = new Date().toISOString()
    // One limit for the whole flow: rereading the setting after the awaited
    // scans could validate against a ceiling the scans never used.
    const scanLimit = currentScanLimit()
    const capabilities = await cachedPeerCapabilities(peer.id)
    const chunked = capabilities.has(CHUNKED_FRAMES_CAPABILITY)
    const quiet = quietReconciles.get(folderId)
    let knownPeerManifest: FileManifest | undefined
    if (capabilities.has(CONTINUOUS_FINGERPRINT_CAPABILITY) && canSkipUnchangedCycle(quiet, durableBeforeReconcile, record.revision, Date.now())) {
      // Cheap first pass: fingerprints only, with no file list held on either computer.
      const { local: localPass, peer: peerReply } = await runPairedScans(
        (signal) => runCachedFolderFingerprint(`continuous:${folderId}`, folder, scanLimit, signal),
        (signal) => requestPeerContinuousScan(peer.id, folderId, quiet.remoteFingerprint, signal, chunked),
      )
      const localUnchanged = !localPass.truncated && localPass.unreadable === 0 && localPass.fingerprint === quiet.localFingerprint
      if (localUnchanged && isUnchangedScanReply(peerReply)) {
        applyFileSyncStateToFolder(folderId, durableBeforeReconcile, new Date().toISOString())
        continuousLastErrors.delete(folderId)
        recordContinuousConflicts(folder, durableBeforeReconcile.conflicts)
        return
      }
      if (!isUnchangedScanReply(peerReply)) knownPeerManifest = peerReply
    }
    // Only a clean quiet reconcile below may leave a skip record behind.
    quietReconciles.delete(folderId)
    const { local: localManifest, peer: remoteManifest } = await runPairedScans(
      (signal) => runCachedFolderScan(`continuous:${folderId}`, folder, scanLimit, signal),
      (signal) => knownPeerManifest
        ? Promise.resolve(knownPeerManifest)
        : requestPeerManifest(peer.id, { type: "continuous-sync-scan", folderId }, CONTINUOUS_SYNC_RPC_TIMEOUT_MS, signal, chunked),
    )
    assertCompleteTransferManifest(localManifest, "This computer", scanLimit)
    assertCompleteTransferManifest(remoteManifest, peer.name)
    assertManifestFitsExchange(localManifest, "This computer", chunked)
    assertManifestFitsExchange(remoteManifest, peer.name, chunked)
    const localObservation = observedFiles(localManifest)
    const remoteObservation = observedFiles(remoteManifest)

    const replayable = replayableOperations(
      durableBeforeReconcile.operations,
      localObservation,
      remoteObservation,
    )
    if (replayable.length > 0) {
      let peerOperations = parsePeerFileOperations(await requirePeerSessions().request<unknown>(peer.id, {
        type: "continuous-sync-get-operations",
        folderId,
      }, CONTINUOUS_SYNC_RPC_TIMEOUT_MS))
      const conflictPaths = new Set(durableBeforeReconcile.conflicts.map((conflict) => conflict.path))
      const localByPath = new Map(localObservation.map((file) => [file.path, file]))
      const remoteByPath = new Map(remoteObservation.map((file) => [file.path, file]))
      for (const operation of replayable) {
        if (!conflictPaths.has(operation.path)) continue
        const local = localByPath.get(operation.path)
        const remote = remoteByPath.get(operation.path)
        if (!local || !remote) {
          throw new Error(`Both exact copies of ${operation.path} are required to resume its conflict resolution.`)
        }
        peerOperations = await recordPeerConflictChoice(folder, peer, operation.path, {
          direction: operation.direction,
          localDigest: local.digest,
          localSize: local.size,
          remoteDigest: remote.digest,
          remoteSize: remote.size,
        })
      }
      const copiedFiles = await executeContinuousOperations(folder, peer, remoteManifest, replayable, peerOperations)
      const state = await engine.request<FileSyncState>("fileSync.getState", { id: folderId })
      await retireInitialConflictProjection(folderId, state)
      applyFileSyncStateToFolder(folderId, state, new Date().toISOString())
      continuousLastErrors.delete(folderId)
      const resolvedConflicts = replayable.filter((operation) => conflictPaths.has(operation.path)).length
      pushActivity(
        resolvedConflicts > 0 ? "Conflict resolution completed" : "Folder changes synchronized",
        resolvedConflicts > 0
          ? `${folder.name}: applied ${resolvedConflicts} selected file version${resolvedConflicts === 1 ? "" : "s"}; each replaced copy was archived first.`
          : `${folder.name}: safely retried ${copiedFiles} file${copiedFiles === 1 ? "" : "s"} with ${peer.name}.`,
        "success",
        folderId,
      )
      recordContinuousConflicts(folder, state.conflicts)
      continuousSyncQueued.add(folderId)
      return
    }

    // Both observations travel to the peer in one frame. Check it fits before
    // reconciling, so no local state is committed for a cycle that cannot finish.
    const observeRequest: PeerRequest = {
      type: "continuous-sync-observe",
      folderId,
      local: remoteObservation,
      remote: localObservation,
      mode: invertMode(folder.mode),
      observedAt,
    }
    assertObservationExchangeSendable(observeRequest, peer.name, chunked)
    const result = await engine.request<ReconcileFilesResult>("fileSync.reconcile", {
      mappingId: folderId,
      local: localObservation,
      remote: remoteObservation,
      mode: folder.mode,
      observedAt,
      queueOperations: true,
    }, CONTINUOUS_SYNC_RPC_TIMEOUT_MS)
    reconciledState = result
    await retireInitialConflictProjection(folderId, result)
    if (result.conflicts.length > 0) {
      applyFileSyncStateToFolder(folderId, result)
      recordContinuousConflicts(folder, result.conflicts)
      broadcastSnapshot()
    }
    const peerResult = await requirePeerSessions().request<unknown>(peer.id, observeRequest, CONTINUOUS_SYNC_RPC_TIMEOUT_MS, { chunked })

    const peerOperations = parsePeerFileOperations(peerResult)
    const copiedFiles = await executeContinuousOperations(
      folder,
      peer,
      remoteManifest,
      result.operations,
      peerOperations,
    )

    const state = await engine.request<FileSyncState>("fileSync.getState", { id: folderId })
    const completedAt = new Date().toISOString()
    if (result.operations.length === 0 && peerOperations.length === 0 && state.operations.length === 0) {
      quietReconciles.set(folderId, {
        revision: record.revision,
        localFingerprint: fingerprintObservation(localObservation),
        remoteFingerprint: fingerprintObservation(remoteObservation),
        baselineCount: state.baselineCount,
        conflictKey: conflictKey(state.conflicts),
        reconciledAt: Date.now(),
      })
    }
    applyFileSyncStateToFolder(folderId, state, completedAt)
    continuousLastErrors.delete(folderId)
    if (copiedFiles > 0) {
      pushActivity(
        "Folder changes synchronized",
        `${folder.name}: copied ${copiedFiles} file${copiedFiles === 1 ? "" : "s"} safely with ${peer.name}.`,
        "success",
        folderId,
      )
    }
    recordContinuousConflicts(folder, state.conflicts)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Continuous synchronization failed."
    const online = getPairedDevice(folder.remoteDeviceId)?.status === "online"
    const durableConflicts = reconciledState?.conflicts ?? []
    const latestState = await engine.request<FileSyncState>("fileSync.getState", { id: folderId }).catch((stateError) => {
      console.warn(`[continuous-sync] unable to refresh durable file-sync state for ${folderId}`, stateError)
      return undefined
    })
    if (latestState) {
      recordContinuousConflicts(folder, latestState.conflicts)
      if (latestState.conflicts.length > 0 || latestState.recoveryIssues.length > 0) {
        applyFileSyncStateToFolder(folderId, latestState)
      } else {
        updateFolder(folderId, {
          status: online ? "needs-attention" : "offline",
          progress: undefined,
          bytesPerSecond: undefined,
          currentAction: online ? `${message} Tethera will retry.` : "Waiting for the paired computer to reconnect.",
          fileCount: latestState.baselineCount,
        })
      }
    } else if (durableConflicts.length > 0) {
      updateFolder(folderId, {
        status: "needs-attention",
        progress: undefined,
        bytesPerSecond: undefined,
        currentAction: conflictSummary(durableConflicts),
      })
    } else {
      updateFolder(folderId, {
        status: online ? "needs-attention" : "offline",
        progress: undefined,
        bytesPerSecond: undefined,
        currentAction: online ? `${message} Tethera will retry.` : "Waiting for the paired computer to reconnect.",
      })
    }
    if (continuousLastErrors.get(folderId) !== message) {
      pushActivity("Folder sync interrupted", `${folder.name}: ${message}`, "error", folderId)
      continuousLastErrors.set(folderId, message)
    }
    if ((latestState?.recoveryIssues.length ?? 0) === 0) {
      scheduleContinuousSyncRetry(folderId, CONTINUOUS_SYNC_RETRY_MS, () => scheduleContinuousSync(folderId))
    }
  } finally {
    continuousSyncInFlight.delete(folderId)
    continuousCyclesInProgress -= 1
    broadcastSnapshot()
    if (continuousSyncQueued.has(folderId)) queueMicrotask(() => void flushContinuousSync(folderId))
  }
}

function blockContinuousSync(folderId: string): () => void {
  continuousSyncBlocked.add(folderId)
  continuousSyncQueued.delete(folderId)
  // Pause/removal/configuration changes cancel queued and in-flight
  // read-only scans for the folder at their next checkpoint.
  abortFolderScans(folderId)
  const retry = continuousSyncRetryTimers.get(folderId)
  if (retry) clearTimeout(retry)
  continuousSyncRetryTimers.delete(folderId)
  const monitor = continuousSyncMonitors.get(folderId)
  monitor?.close()
  continuousSyncMonitors.delete(folderId)
  return () => {
    continuousSyncBlocked.delete(folderId)
    void refreshContinuousSyncMonitors()
  }
}

async function withContinuousSyncBlocked<T>(folderId: string, operation: () => Promise<T>): Promise<T> {
  const release = blockContinuousSync(folderId)
  try {
    return await operation()
  } finally {
    release()
  }
}

function requireInitialSyncContext(folderId: string, expectedPeerId?: string): {
  folder: FolderSummary
  peer: DeviceSummary
} {
  const folder = snapshot.folders.find((item) => item.id === folderId)
  if (!folder) throw new Error("This folder is no longer configured.")
  if (folder.setupStatus !== "ready-for-initial-sync") throw new Error("This folder has already completed its initial sync.")
  if (folder.paused || snapshot.paused) throw new Error("Resume this folder before starting the initial sync.")
  const peer = getPairedDevice(folder.remoteDeviceId)
  if (!peer || (expectedPeerId && peer.id !== expectedPeerId)) {
    throw new Error("The paired computer for this folder is no longer trusted.")
  }
  if (peer.status !== "online") throw new Error(`${peer.name} must be online to sync.`)
  return { folder, peer }
}

/**
 * Fails closed on a truncated or unreadable transfer manifest. Local scans
 * pass this machine's limit so the error can name the number; peer scans
 * pass nothing — the peer's limit is its own business and is never supplied
 * by (or requested from) the peer — so the error points at that computer's
 * Settings instead of inventing a number.
 *
 * `allowUnreadable` is used only by the initial merge after the user has been
 * shown exactly which paths are inaccessible and chosen to continue. The
 * blocked paths are excluded from the plan by the caller and reported in the
 * merge outcome, never silently dropped.
 */
function assertCompleteTransferManifest(manifest: FileManifest, computer: string, originScanLimit?: number | null, options: { allowUnreadable?: boolean } = {}): void {
  if (manifest.truncated) {
    if (originScanLimit === undefined) {
      throw new Error(
        `${computer}'s folder exceeded its configured scan limit. Raise the limit in Settings on ${computer} or add ignore rules, then retry. No incomplete merge was marked active.`,
      )
    }
    const ceiling = originScanLimit === null
      ? "the configured scan limit"
      : `the configured scan limit of ${originScanLimit.toLocaleString("en-GB")} files`
    throw new Error(
      `${computer}'s folder lists more than ${ceiling}. Raise the limit in Settings or add ignore rules, then retry. No incomplete merge was marked active.`,
    )
  }
  if (!options.allowUnreadable && manifest.unreadable > 0) {
    throw new Error(
      `${computer}'s folder has ${manifest.unreadable} unreadable item${manifest.unreadable === 1 ? "" : "s"}: ${describeUnreadableIssues(manifest.unreadableEntries, manifest.unreadable)}. Fix access and retry.`,
    )
  }
  if (manifest.files.some((entry) => !entry.digest)) {
    throw new Error(`${computer}'s transfer manifest is missing a full-file integrity digest.`)
  }
}

/** Names up to three inaccessible paths for an error message, never an absolute one. */
function describeUnreadableIssues(issues: readonly FolderScanIssue[], total: number): string {
  if (issues.length === 0) return "the paths could not be listed"
  const shown = issues.slice(0, 3).map((issue) => `${issue.path || "(folder root)"} (${issue.reason})`)
  const remaining = total - shown.length
  return remaining > 0 ? `${shown.join(", ")} and ${remaining} more` : shown.join(", ")
}

async function pullPlannedFile(
  folder: FolderSummary,
  peer: DeviceSummary,
  entry: FileManifest["files"][number],
  onProgress: (fileBytes: number) => void,
  expectedDestinationDigest?: string,
  syncOperationId?: number,
): Promise<PlannedFileResult> {
  const descriptor = await requirePeerSessions().request<TransferFileDescriptor>(peer.id, {
    type: "pull-file-descriptor",
    folderId: folder.id,
    relativePath: entry.path,
  }, 5 * 60_000)
  validateTransferDescriptor(entry, descriptor)

  let journal: ReplacementJournalEntry | undefined
  let expectedDestinationSize: number | undefined
  if (expectedDestinationDigest !== undefined) {
    const current = await describeTransferFile(folder.localPath, entry.path)
    if (current.digest !== expectedDestinationDigest) {
      throw new Error("The destination changed after reconciliation; its local copy was preserved.")
    }
    expectedDestinationSize = current.size
    const journalId = randomUUID()
    const localRoot = await realpath(folder.localPath)
    const request = {
      id: journalId,
      mappingId: folder.id,
      path: entry.path,
      syncOperationId,
      oldDigest: current.digest,
      oldSize: current.size,
      replacementDigest: descriptor.digest,
      replacementSize: descriptor.size,
      localRoot,
      createdAt: new Date().toISOString(),
    }
    try {
      journal = await engine.request<ReplacementJournalEntry>("archive.prepareReplacement", request)
    } catch {
      journal = await engine.request<ReplacementJournalEntry>("archive.get", { entryId: journalId })
    }
  }
  const journalId = journal?.id

  async function* chunks(): AsyncGenerator<Buffer> {
    let offset = 0
    while (offset < descriptor.size) {
      const length = Math.min(TRANSFER_CHUNK_BYTES, descriptor.size - offset)
      const response = await requirePeerSessions().request<TransferChunkResponse>(peer.id, {
        type: "pull-file-chunk",
        folderId: folder.id,
        relativePath: entry.path,
        expectedSize: descriptor.size,
        expectedModifiedMs: descriptor.modifiedMs,
        offset,
        length,
      })
      if (response.offset !== offset || typeof response.contentBase64 !== "string") {
        throw new Error(`The peer returned an invalid chunk for ${entry.path}.`)
      }
      const chunk = Buffer.from(response.contentBase64, "base64")
      if (chunk.length !== length) throw new Error(`The peer returned a truncated chunk for ${entry.path}.`)
      offset += chunk.length
      yield chunk
    }
  }

  try {
    await writeFileChunksAtomic(
      folder.localPath,
      entry.path,
      descriptor.size,
      descriptor.digest,
      chunks(),
      {
        onChunk: onProgress,
        expectedDestinationDigest,
        expectedDestinationSize,
        replacement: journalId
          ? {
              journalId,
              archiveRoot: versionArchiveObjectRoot(),
              markArchived: async (archive) => {
                await engine.request<ReplacementJournalEntry>("archive.markArchived", {
                  entryId: journalId,
                  archiveDigest: archive.digest,
                  archiveSize: archive.size,
                  objectKey: archive.objectKey,
                  archivedAt: new Date().toISOString(),
                })
              },
              markInstalled: async () => {
                await engine.request<ReplacementJournalEntry>("archive.markInstalled", {
                  entryId: journalId,
                  occurredAt: new Date().toISOString(),
                })
              },
            }
          : undefined,
      },
    )
  } catch (error) {
    if (journal) {
      const recovered = await reconcileReplacementAfterFailure(folder, journal)
      if (recovered.state === "completed") {
        return { bytes: descriptor.size, replacementJournalId: recovered.id, completedDuringRecovery: true }
      }
    }
    throw error
  }
  return { bytes: descriptor.size, replacementJournalId: journalId }
}

async function refreshRecoverableArchiveMetadata(
  entry: ReplacementJournalEntry,
): Promise<ReplacementJournalEntry> {
  if (entry.oldDigest == null || entry.oldSize == null || entry.archiveObjectKey) return entry
  const recovered = await recoverStagedArchiveObject(
    versionArchiveObjectRoot(),
    entry.id,
    entry.oldDigest,
    entry.oldSize,
  )
  if (!recovered) return entry
  const updated = await engine.request<ReplacementJournalEntry>("archive.markArchived", {
    entryId: entry.id,
    archiveDigest: recovered.digest,
    archiveSize: recovered.size,
    objectKey: recovered.objectKey,
    archivedAt: new Date().toISOString(),
  })
  await removePublishedArchiveStage(versionArchiveObjectRoot(), entry.id, entry.oldDigest)
  return updated
}

async function reconcileReplacementAfterFailure(
  folder: FolderSummary,
  initialEntry: ReplacementJournalEntry,
  refreshEntry = true,
): Promise<ReplacementJournalEntry> {
  const durable = refreshEntry
    ? await engine.request<ReplacementJournalEntry>("archive.get", { entryId: initialEntry.id })
    : initialEntry
  const entry = await refreshRecoverableArchiveMetadata(durable)
  try {
    if (await realpath(folder.localPath) !== entry.localRoot) {
      throw new Error("The replacement journal belongs to a different configured folder root.")
    }
    const inspection = await inspectReplacementRecovery(
      folder.localPath,
      versionArchiveObjectRoot(),
      entry,
    )
    return await engine.request<ReplacementJournalEntry>("archive.recover", {
      entryId: entry.id,
      liveDigest: inspection.liveDigest,
      archiveAvailable: inspection.archiveAvailable,
      recoveredAt: new Date().toISOString(),
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Replacement recovery could not determine a safe state."
    await engine.request("archive.recordIssue", {
      entryId: entry.id,
      integrityFailure: false,
      detail,
      occurredAt: new Date().toISOString(),
    }).catch((recordError) => console.error(
      `[archive] unable to persist recovery failure for ${entry.id} (${entry.mappingId}:${entry.path})`,
      recordError,
    ))
    throw error
  }
}

async function recoverIncompleteReplacements(): Promise<void> {
  const entries = await engine.request<ReplacementJournalEntry[]>("archive.listIncomplete")
  const foldersById = new Map(snapshot.folders.map((folder) => [folder.id, folder]))
  for (const initialEntry of entries) {
    const folder = foldersById.get(initialEntry.mappingId)
    if (!folder) {
      const detail = "The archived replacement belongs to a mapping that is no longer active; automatic recovery was stopped."
      await engine.request("archive.recordIssue", {
        entryId: initialEntry.id,
        integrityFailure: false,
        detail,
        occurredAt: new Date().toISOString(),
      })
      pushActivity("File replacement needs recovery", `${initialEntry.path}: ${detail}`, "error", initialEntry.mappingId)
      continue
    }
    try {
      const recovered = await reconcileReplacementAfterFailure(folder, initialEntry, false)
      if (recovered.state === "recovery-required" || recovered.state === "integrity-failed") {
        updateFolder(folder.id, {
          status: "needs-attention",
          currentAction: recovered.lastError ?? `Recovery is required for ${recovered.path}.`,
        })
        pushActivity(
          recovered.state === "integrity-failed" ? "Archived version failed integrity check" : "File replacement needs recovery",
          `${folder.name}: ${recovered.path}. ${recovered.lastError ?? "No file was overwritten."}`,
          "error",
          folder.id,
        )
      } else if (recovered.state === "completed" || recovered.state === "aborted") {
        pushActivity(
          recovered.state === "completed" ? "File replacement recovered" : "Interrupted replacement cancelled safely",
          `${folder.name}: ${recovered.path} (${recovered.id}).`,
          "info",
          folder.id,
        )
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Replacement recovery failed."
      updateFolder(folder.id, { status: "needs-attention", currentAction: detail })
      pushActivity("File replacement recovery stopped", `${folder.name}: ${detail}`, "error", folder.id)
    }
  }
}

// Main-process copy of the renderer byte formatter. Main must not import
// renderer modules, but the initial-sync status string is built here so it
// needs the same human-readable byte shape the comparison view uses.
function formatScanHashedBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** exponent
  return `${value >= 10 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`
}

function initialSyncScanSignature(folder: FolderSummary): string {
  return JSON.stringify([folder.localPath, folder.remotePath, folder.mode, folder.ignorePatterns, folder.maxFileBytes ?? null, currentScanLimit()])
}

function scanIssueReportOf(localManifest: FileManifest, remoteManifest: FileManifest): FolderScanIssueReport {
  return {
    local: localManifest.unreadableEntries,
    remote: remoteManifest.unreadableEntries,
    localCount: localManifest.unreadable,
    remoteCount: remoteManifest.unreadable,
  }
}

function scanIssueTotal(report: FolderScanIssueReport): number {
  return report.localCount + report.remoteCount
}

/** Canonical digest of an inaccessible-path report, used to match a decision to a fresh scan. */
function scanIssueSignature(report: FolderScanIssueReport): string {
  // Serialise each triple so the sort compares whole records, not the default
  // comma-joined coercion of nested arrays: a path or reason containing a
  // comma must not tie two different issues and fall back to walk order.
  const canonical = JSON.stringify({
    local: report.local.map((issue) => JSON.stringify([issue.kind, issue.path, issue.reason])).sort(),
    remote: report.remote.map((issue) => JSON.stringify([issue.kind, issue.path, issue.reason])).sort(),
    localCount: report.localCount,
    remoteCount: report.remoteCount,
  })
  return createHash("sha256").update(canonical).digest("hex")
}

/** Matches the persistence bound applied by `isBoundedSkipArray` and `isPersistedSkipArray`. */
const MAX_PERSISTED_SKIP_REASON_LENGTH = 1_024

function scanIssueSkips(report: FolderScanIssueReport, localName: string, remoteName: string): SyncSkip[] {
  // A peer's display name is not length-bounded, so the formatted reason must
  // be clamped: an over-long reason would make the whole persisted outcome
  // fail validation and disappear on restart.
  const toSkips = (issues: FolderScanIssue[], computer: string): SyncSkip[] => issues.map((issue) => {
    const reason = `${computer} could not read this item (${issue.reason}); it was left out of the merge.`
    return {
      path: issue.path || "(folder root)",
      reason: reason.length > MAX_PERSISTED_SKIP_REASON_LENGTH
        ? `${reason.slice(0, MAX_PERSISTED_SKIP_REASON_LENGTH - 1)}…`
        : reason,
    }
  })
  return [...toSkips(report.local, localName), ...toSkips(report.remote, remoteName)]
}

/**
 * The unreadable items from the comparison the user approved, oriented to
 * this computer. `undefined` means the proposal predates issue reporting, so
 * no fresh issue can be treated as already acknowledged.
 */
function approvedInitialSyncIssues(folderId: string): FolderScanIssueReport | undefined {
  const record = mappingRecords.get(folderId)
  const preview = record?.mapping.preview
  if (!record || !preview) return undefined
  const fieldsPresent = preview.unreadableLocal !== undefined || preview.unreadableRemote !== undefined ||
    preview.unreadableLocalCount !== undefined || preview.unreadableRemoteCount !== undefined
  if (!fieldsPresent) return undefined
  const initiator = preview.unreadableLocal ?? []
  const responder = preview.unreadableRemote ?? []
  const initiatorCount = preview.unreadableLocalCount ?? initiator.length
  const responderCount = preview.unreadableRemoteCount ?? responder.length
  const localIsInitiator = record.mapping.initiatorDeviceId === getLocalIdentityId()
  return localIsInitiator
    ? { local: initiator, remote: responder, localCount: initiatorCount, remoteCount: responderCount }
    : { local: responder, remote: initiator, localCount: responderCount, remoteCount: initiatorCount }
}

function reportCoversApproved(report: FolderScanIssueReport, approved: FolderScanIssueReport | undefined): boolean {
  if (!approved) return false
  return scanIssueReportCovers(approved.local, report.local, approved.localCount, report.localCount) &&
    scanIssueReportCovers(approved.remote, report.remote, approved.remoteCount, report.remoteCount)
}

interface InitialSyncRunOptions {
  /** The user reviewed the fresh inaccessible-path report and chose to continue. */
  allowUnreadable: boolean
  /** A full scan captured while the user reviewed inaccessible items. */
  prepared?: PreparedInitialSyncScan
  /** Report the user already accepted; a fresh scan matching it proceeds without re-asking. */
  acknowledgedIssuesSignature?: string
}

async function runInitialSyncPass(folder: FolderSummary, peer: DeviceSummary, options: InitialSyncRunOptions): Promise<InitialSyncPassResult> {
  // A seed from the comparison this mapping was approved from lets the first
  // full-integrity walk reuse settled digests instead of reading every
  // unchanged file. The walk still re-checks each identity, so this only
  // removes duplicate reads, never a staleness check.
  const reuse = scanReuseSeeds.lookup(folder.localPath, folder.ignorePatterns)
  updateFolder(folder.id, {
    status: "syncing",
    currentAction: reuse
      ? `Checking your folder for changes since the comparison; unchanged files keep their verified digests with ${peer.name}…`
      : `Starting a read-only scan on both computers: applying ignore rules and hashing file contents with ${peer.name}…`,
    progress: undefined,
    bytesPerSecond: 0,
    scanIssues: undefined,
  })
  broadcastSnapshot()

  // One limit for the whole pass: rereading the setting after the awaited
  // scans could validate against a ceiling the scans never used.
  const scanLimit = currentScanLimit()
  let localManifest: FileManifest
  let remoteManifest: FileManifest
  // The caller has already made the single freshness decision (signature and
  // TTL) that selected these manifests; re-evaluating it here with a second
  // clock read could accept a reviewer decision the manifests no longer
  // support. An absent prepared scan always falls through to a fresh walk.
  const prepared = options.prepared
  if (prepared?.localManifest && prepared.remoteManifest) {
    localManifest = prepared.localManifest
    remoteManifest = prepared.remoteManifest
  } else {
    const chunked = await peerSupportsChunkedFrames(peer.id)
    let scanning = true
    const result = await runPairedScans(
      (signal) => withFolderDigestCache(folder.id, (digestCache) =>
        runLocalScan(`initial:${folder.id}`, folder.localPath, folder.ignorePatterns, {
          hashAllFiles: true,
          maxFiles: scanLimit,
          folderId: folder.id,
          digestCache,
          reuse,
          onActivity: (activity) => {
            if (!scanning) return
            const action = { listing: "Listing", inspecting: "Checking", hashing: "Hashing", complete: "Local scan complete" }[activity.stage]
            updateFolder(folder.id, {
              currentAction: `${action}${activity.currentPath ? `: ${activity.currentPath}` : ""} · ${activity.scannedFiles.toLocaleString("en-GB")} files checked · ${formatScanHashedBytes(activity.hashedBytes)} hashed · ${activity.ignoredEntries.toLocaleString("en-GB")} excluded entries · ${activity.unreadableEntries.toLocaleString("en-GB")} unreadable. Comparing with ${peer.name} before copying.`,
            })
            broadcastSnapshot()
          },
        }, signal)),
      (signal) => requestPeerManifest(peer.id, {
        type: "scan-manifest",
        folderId: folder.id,
        path: folder.remotePath,
        ignorePatterns: folder.ignorePatterns,
        hashAllFiles: true,
      }, 5 * 60_000, signal, chunked),
    ).finally(() => { scanning = false })
    localManifest = result.local
    remoteManifest = result.peer
    assertManifestFitsExchange(localManifest, "This computer", chunked)
    assertManifestFitsExchange(remoteManifest, peer.name, chunked)
  }

  const issues = scanIssueReportOf(localManifest, remoteManifest)
  const issueTotal = scanIssueTotal(issues)
  const issuesSignature = scanIssueSignature(issues)
  const alreadyAcknowledged = options.allowUnreadable || options.acknowledgedIssuesSignature === issuesSignature
  if (issueTotal > 0 && !alreadyAcknowledged && !reportCoversApproved(issues, approvedInitialSyncIssues(folder.id))) {
    // Hold the scan so "Continue anyway" reuses it instead of walking both
    // folders again, then surface the exact paths for the user's decision.
    // Oversized manifests are dropped; the report signature still lets a
    // matching fresh scan proceed after the user continues.
    const totalFiles = localManifest.files.length + remoteManifest.files.length
    preparedInitialSyncScans.set(folder.id, {
      capturedAt: Date.now(),
      signature: initialSyncScanSignature(folder),
      issuesSignature,
      ...(totalFiles <= MAX_PREPARED_SCAN_FILES ? { localManifest, remoteManifest } : {}),
    })
    updateFolder(folder.id, {
      status: "needs-attention",
      progress: undefined,
      bytesPerSecond: undefined,
      scanIssues: issues,
      currentAction: `${issueTotal === 1 ? "1 item" : `${issueTotal.toLocaleString("en-GB")} items`} could not be read. Review the list, then choose Continue anyway to skip them or cancel to fix access.`,
    })
    broadcastSnapshot()
    throw new InitialSyncUnreadableError()
  }
  preparedInitialSyncScans.delete(folder.id)
  updateFolder(folder.id, { scanIssues: undefined })
  // The decision above already accounted for unreadable items; blocked paths
  // are excluded from the plan and reported in the outcome rather than
  // failing the whole merge.
  assertCompleteTransferManifest(localManifest, "This computer", scanLimit, { allowUnreadable: true })
  assertCompleteTransferManifest(remoteManifest, peer.name, undefined, { allowUnreadable: true })

  const plan = computeSyncPlan(localManifest, remoteManifest, folder.mode, { destinationBlocked: localManifest.unreadableEntries })
  const totalBytes = plan.toPull.reduce((total, entry) => total + entry.size, 0)
  const totalFiles = plan.toPull.length
  let copiedFiles = 0
  let copiedBytes = 0
  const startedAt = Date.now()
  let lastBroadcastAt = 0

  const reportProgress = (entryPath: string, fileBytes: number, force = false) => {
    const now = Date.now()
    if (!force && now - lastBroadcastAt < 100) return
    lastBroadcastAt = now
    const transferred = copiedBytes + fileBytes
    const elapsedSeconds = Math.max((now - startedAt) / 1_000, 0.001)
    const progress = totalBytes > 0
      ? transferred / totalBytes
      : totalFiles > 0
        ? copiedFiles / totalFiles
        : 1
    updateFolder(folder.id, {
      status: "syncing",
      currentAction: `Copying ${entryPath} (${copiedFiles + 1}/${totalFiles})`,
      progress: Math.min(progress, 1),
      bytesPerSecond: Math.round(transferred / elapsedSeconds),
    })
    broadcastSnapshot()
  }

  // Copied files are verified with their full digest during transfer; record
  // that identity so the post-merge verification can reuse it instead of
  // reading every copied file again. Filesystems without strong identity
  // evidence (FAT/exFAT) never record, so verification rehashes there.
  const transferDigests = await filesystemSupportsDigestReuse(folder.localPath)
    ? new EngineScanDigestCache(engine, folder.id, { deep: false })
    : undefined
  try {
    for (const entry of plan.toPull) {
      const current = snapshot.folders.find((item) => item.id === folder.id)
      if (!current || current.paused || snapshot.paused) throw new Error("Syncing was paused before it finished.")
      reportProgress(entry.path, 0, true)
      const { bytes } = await pullPlannedFile(folder, peer, entry, (fileBytes) => reportProgress(entry.path, fileBytes))
      copiedFiles += 1
      copiedBytes += bytes
      if (transferDigests && entry.digest) {
        try {
          const identity = await statFileIdentity(resolveWithinRoot(folder.localPath, entry.path))
          if (identity) transferDigests.record(entry.path, { ...identity, digest: entry.digest })
        } catch {
          // Losing a cache record only costs one extra read during verification.
        }
      }
      reportProgress(entry.path, 0, true)
    }
  } finally {
    await transferDigests?.finish({ complete: false })
  }

  return {
    copiedFiles,
    copiedBytes,
    fileCount: localManifest.files.length + copiedFiles,
    skipped: plan.skipped,
    unreadableSkipped: scanIssueSkips(issues, "This computer", peer.name),
  }
}

async function verifyInitialMergeQuiescent(
  folder: FolderSummary,
  peer: DeviceSummary,
): Promise<{ skipped: SyncSkip[]; unreadableSkipped: SyncSkip[] }> {
  updateFolder(folder.id, { currentAction: "Verifying that neither folder changed during the merge…" })
  broadcastSnapshot()
  // One limit for the whole check, as above: the scans and their validation
  // must agree even if the setting changes mid-flight.
  const scanLimit = currentScanLimit()
  const chunked = await peerSupportsChunkedFrames(peer.id)
  const { local: localManifest, peer: remoteManifest } = await runPairedScans(
    (signal) => runCachedFolderScan(`verify:${folder.id}`, folder, scanLimit, signal),
    (signal) => requestPeerManifest(peer.id, {
      type: "scan-manifest",
      folderId: folder.id,
      path: folder.remotePath,
      ignorePatterns: folder.ignorePatterns,
      hashAllFiles: true,
    }, 5 * 60_000, signal, chunked),
  )
  // The merge already applied the unreadable-path decision; verification must
  // not fail on the same inaccessible items. Fresh issues are reported through
  // the outcome instead of being silently dropped.
  assertCompleteTransferManifest(localManifest, "This computer", scanLimit, { allowUnreadable: true })
  assertCompleteTransferManifest(remoteManifest, peer.name, undefined, { allowUnreadable: true })
  assertManifestFitsExchange(localManifest, "This computer", chunked)
  assertManifestFitsExchange(remoteManifest, peer.name, chunked)
  const convergence = assessInitialMergeConvergence(localManifest, remoteManifest, folder.mode, {
    localBlocked: localManifest.unreadableEntries,
    remoteBlocked: remoteManifest.unreadableEntries,
  })
  if (!convergence.complete) {
    throw new Error("A folder changed while the initial merge was running. The copied files are safe; retry to include the new changes.")
  }
  return {
    skipped: convergence.skipped,
    unreadableSkipped: scanIssueSkips(scanIssueReportOf(localManifest, remoteManifest), "This computer", peer.name),
  }
}

function uniqueSkips(...groups: SyncSkip[][]): SyncSkip[] {
  const byPath = new Map<string, SyncSkip>()
  for (const skip of groups.flat()) byPath.set(`${skip.path}\0${skip.reason}`, skip)
  return [...byPath.values()]
}

function recordInitialSyncOutcome(folder: FolderSummary, copiedFiles: number, skipped: SyncSkip[], unreadableSkipped: SyncSkip[]): void {
  const conflictNote = skipped.length > 0
    ? `; ${skipped.length} same-path conflict${skipped.length === 1 ? " was" : "s were"} left untouched`
    : ""
  const inaccessibleNote = unreadableSkipped.length > 0
    ? `; ${unreadableSkipped.length} inaccessible item${unreadableSkipped.length === 1 ? " was" : "s were"} skipped`
    : ""
  pushActivity(
    "Initial merge completed",
    `${folder.name}: safely copied ${copiedFiles} file${copiedFiles === 1 ? "" : "s"} across both computers${conflictNote}${inaccessibleNote}.`,
    skipped.length > 0 || unreadableSkipped.length > 0 ? "warning" : "success",
    folder.id,
  )
  for (const skip of skipped.slice(0, 20)) pushActivity(`Conflict left untouched: ${skip.path}`, skip.reason, "warning", folder.id)
  for (const skip of unreadableSkipped.slice(0, 20)) pushActivity(`Inaccessible item skipped: ${skip.path}`, skip.reason, "warning", folder.id)
}

function persistInitialSyncOutcome(
  folderId: string,
  completedAt: string,
  copiedFiles: number,
  fileCount: number,
  conflicts: SyncSkip[],
  unreadableSkipped: SyncSkip[] = [],
): void {
  initialSyncOutcomes = {
    ...initialSyncOutcomes,
    [folderId]: { completedAt, copiedFiles, fileCount, conflicts, unreadableSkipped },
  }
}

function initialSyncAttentionSummary(conflicts: number, unreadable: number): string | undefined {
  const parts: string[] = []
  if (conflicts > 0) parts.push(`${conflicts} same-path conflict${conflicts === 1 ? "" : "s"}`)
  if (unreadable > 0) parts.push(`${unreadable} inaccessible item${unreadable === 1 ? "" : "s"} that could not be read`)
  if (parts.length === 0) return undefined
  return `${parts.join(" and ")} need attention; affected paths were left untouched.`
}

function applyInitialSyncOutcomeStatus(folderId: string): void {
  const outcome = initialSyncOutcomes[folderId]
  const folder = snapshot.folders.find((item) => item.id === folderId)
  if (!outcome || !folder) return
  const conflicts = outcome.conflicts
  const unreadable = outcome.unreadableSkipped ?? []
  const attention = initialSyncAttentionSummary(conflicts.length, unreadable.length)
  updateFolder(folderId, {
    setupStatus: "active",
    status: attention ? "needs-attention" : idleFolderStatus(folder.remoteDeviceId, "active"),
    progress: undefined,
    bytesPerSecond: undefined,
    fileCount: outcome.fileCount,
    lastSyncedAt: outcome.completedAt,
    currentAction: attention ?? "Initial merge completed safely on both computers.",
  })
}

function dismissInitialSyncIssues(folderId: string): AppSnapshot {
  preparedInitialSyncScans.delete(folderId)
  const folder = snapshot.folders.find((item) => item.id === folderId)
  if (folder?.scanIssues) {
    updateFolder(folderId, {
      status: idleFolderStatus(folder.remoteDeviceId, folder.setupStatus),
      scanIssues: undefined,
      currentAction: "Access was not changed. Fix the inaccessible paths, then start the initial merge again.",
    })
    broadcastSnapshot()
  }
  return snapshot
}

async function startInitialSync(folderId: string, acknowledgeUnreadable = false): Promise<AppSnapshot> {
  const record = mappingRecords.get(folderId)
  if (!record) throw new Error("This folder is no longer configured.")
  const localDeviceId = getLocalIdentityId()
  const coordinatorId = [record.mapping.initiatorDeviceId, record.mapping.responderDeviceId].sort()[0]
  if (coordinatorId !== localDeviceId) {
    if (initialSyncForwarded.has(folderId)) return snapshot
    const knownFolder = snapshot.folders.find((item) => item.id === folderId)
    if (!knownFolder) throw new Error("This folder is no longer configured.")
    const peer = getPairedDevice(knownFolder.remoteDeviceId)
    if (!peer || peer.id !== coordinatorId || peer.status !== "online") {
      throw new Error("The coordinating computer must be online to start the initial merge.")
    }
    initialSyncForwarded.add(folderId)
    updateFolder(folderId, { status: "syncing", progress: 0, currentAction: `Asking ${peer.name} to coordinate the initial merge…` })
    broadcastSnapshot()
    try {
      const response = await requirePeerSessions().request<{ completed: boolean; error?: string }>(
        peer.id,
        { type: "initial-sync-coordinate", folderId, allowUnreadable: acknowledgeUnreadable },
        30 * 60_000,
      )
      if (response.completed !== true) {
        throw new Error(response.error ?? "The coordinating computer did not complete the initial merge.")
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "The coordinating computer could not start the merge."
      updateFolder(folderId, { status: "needs-attention", progress: undefined, bytesPerSecond: undefined, currentAction: message })
      pushActivity("Initial merge failed", `${knownFolder.name}: ${message}`, "error", folderId)
      await persistState()
      broadcastSnapshot()
    } finally {
      initialSyncForwarded.delete(folderId)
    }
    return snapshot
  }
  if (initialSyncInFlight.has(folderId)) return snapshot
  const knownFolder = snapshot.folders.find((item) => item.id === folderId)
  if (!knownFolder) throw new Error("This folder is no longer configured.")
  initialSyncInFlight.add(folderId)
  let leaseHeartbeat: NodeJS.Timeout | null = null
  let resolveCompletion!: () => void
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve
  })
  initialSyncCompletions.set(folderId, { promise: completion, resolve: resolveCompletion })

  try {
    requireMappingMutations()
    const { folder, peer } = requireInitialSyncContext(folderId)
    const preparation = await requirePeerSessions().request<{ prepared: boolean }>(peer.id, {
      type: "initial-sync-prepare",
      folderId,
    })
    if (preparation.prepared !== true) throw new Error("The peer did not prepare its folder for the initial merge.")
    leaseHeartbeat = setInterval(() => {
      void requirePeerSessions().request(peer.id, { type: "initial-sync-renew", folderId }).catch((error) => {
        console.warn("[initial-sync] unable to renew the peer merge lease", error)
      })
    }, INITIAL_SYNC_HEARTBEAT_MS)
    let skipped: SyncSkip[] = []
    let unreadableSkipped: SyncSkip[] = []
    let completedAt = ""
    const prepared = preparedInitialSyncScans.get(folderId)
    // Single freshness decision: it selects both the manifests that may be
    // reused and whether the reviewed unreadable report still authorises
    // skipping. Once false, the pass gets no prepared scan and no blanket
    // allowance, so a fresh report is checked against the accepted signature.
    const preparedStillHolds = prepared !== undefined &&
      prepared.localManifest !== undefined &&
      prepared.remoteManifest !== undefined &&
      prepared.signature === initialSyncScanSignature(folder) &&
      Date.now() - prepared.capturedAt <= PREPARED_INITIAL_SYNC_TTL_MS
    const allowUnreadable = acknowledgeUnreadable && preparedStillHolds
    const acknowledgedIssuesSignature = acknowledgeUnreadable ? prepared?.issuesSignature : undefined
    const reusablePrepared = preparedStillHolds ? prepared : undefined
    let peerAllowUnreadable = allowUnreadable
    const { local: localResult, peer: remoteResult } = await runCoordinatedInitialMerge(
      async () => {
        const result = await runInitialSyncPass(folder, peer, { allowUnreadable, prepared: reusablePrepared, acknowledgedIssuesSignature })
        // The local pass only returns after the unreadable-path decision was
        // accepted (or none were found), so the peer's inverse pass may skip
        // the same acknowledged items instead of failing on them.
        if (result.unreadableSkipped.length > 0) peerAllowUnreadable = true
        return result
      },
      async () => {
        updateFolder(folderId, { currentAction: `Asking ${peer.name} to merge files in the other direction…` })
        broadcastSnapshot()
        return validateInitialSyncPassResult(
          await requirePeerSessions().request<InitialSyncPassResult>(peer.id, {
            type: "initial-sync-run",
            folderId,
            allowUnreadable: peerAllowUnreadable,
          }, 30 * 60_000),
        )
      },
      async (local, remote) => {
        const verification = await verifyInitialMergeQuiescent(folder, peer)
        skipped = uniqueSkips(local.skipped, remote.skipped, verification.skipped)
        unreadableSkipped = uniqueSkips(local.unreadableSkipped, remote.unreadableSkipped, verification.unreadableSkipped)
        const currentRecord = mappingRecords.get(folderId)
        if (!currentRecord) throw new Error("The mapping was removed before its completion could be committed.")
        completedAt = new Date().toISOString()
        const outcomeAcknowledgement = await requirePeerSessions().request<{ recorded: boolean }>(peer.id, {
          type: "initial-sync-outcome",
          folderId,
          completedAt,
          copiedFiles: remote.copiedFiles,
          fileCount: remote.fileCount,
          conflicts: skipped,
          unreadableSkipped,
        })
        if (outcomeAcknowledgement.recorded !== true) {
          throw new Error("The peer did not confirm its durable initial-merge outcome.")
        }
        persistInitialSyncOutcome(
          folderId,
          completedAt,
          local.copiedFiles + remote.copiedFiles,
          local.fileCount,
          skipped,
          unreadableSkipped,
        )
        // Commit the structured outcome before activating SQLite so a crash can never
        // leave an active mapping whose preserved conflicts are invisible after restart.
        await persistStateDurably()
        const targetDeviceId = otherParticipant(currentRecord.mapping, getLocalIdentityId())
        const completionRecord = await upsertAuthoritativeMapping(
          { ...currentRecord.mapping, setupStatus: "active", updatedAt: completedAt },
          targetDeviceId,
          currentRecord.revision,
        )
        await requireExactMappingDeliveryAcknowledgement(completionRecord, targetDeviceId)
      },
    )
    updateFolder(folderId, {
      setupStatus: "active",
      status: skipped.length > 0 || unreadableSkipped.length > 0 ? "needs-attention" : idleFolderStatus(folder.remoteDeviceId, "active"),
      progress: undefined,
      bytesPerSecond: undefined,
      fileCount: localResult.fileCount,
      lastSyncedAt: completedAt,
      currentAction: initialSyncAttentionSummary(skipped.length, unreadableSkipped.length) ?? "Initial merge completed safely on both computers.",
    })
    recordInitialSyncOutcome(folder, localResult.copiedFiles + remoteResult.copiedFiles, skipped, unreadableSkipped)
    // The durable digest cache now holds everything the merge verified; the
    // pre-mapping seed has done its job.
    scanReuseSeeds.forget(folder.localPath, folder.ignorePatterns)
  } catch (error) {
    if (error instanceof InitialSyncUnreadableError) {
      // runInitialSyncPass already projected the review state onto the folder.
    } else {
      const message = error instanceof Error ? error.message : "The initial merge failed."
      updateFolder(folderId, {
        status: "needs-attention",
        progress: undefined,
        bytesPerSecond: undefined,
        currentAction: message,
      })
      pushActivity("Initial merge failed", `${knownFolder.name}: ${message}`, "error", folderId)
    }
  } finally {
    if (leaseHeartbeat) clearInterval(leaseHeartbeat)
    initialSyncInFlight.delete(folderId)
    initialSyncCompletions.get(folderId)?.resolve()
    initialSyncCompletions.delete(folderId)
    const peer = getPairedDevice(knownFolder.remoteDeviceId)
    if (peer?.status === "online") {
      await requirePeerSessions().request(peer.id, { type: "initial-sync-release", folderId }).catch((error) => {
        console.warn("[initial-sync] unable to release the peer merge lease; it will expire automatically", error)
      })
    }
    await persistState()
    broadcastSnapshot()
  }
  return snapshot
}

async function runPeerInitialSync(context: PeerRequestContext, folderId: string, allowUnreadable: boolean): Promise<InitialSyncPassResult> {
  requireMappingMutations()
  if (initialSyncInFlight.has(folderId)) throw new Error("An initial merge is already running for this folder.")
  const record = mappingRecords.get(folderId)
  if (!record) throw new Error("This folder is no longer configured.")
  const coordinatorId = [record.mapping.initiatorDeviceId, record.mapping.responderDeviceId].sort()[0]
  if (context.peerId !== coordinatorId) throw new Error("Only the elected coordinator can request the inverse merge pass.")
  const { folder, peer } = requireInitialSyncContext(folderId, context.peerId)
  initialSyncInFlight.add(folderId)
  try {
    const result = await runInitialSyncPass(folder, peer, { allowUnreadable })
    scanReuseSeeds.forget(folder.localPath, folder.ignorePatterns)
    persistInitialSyncOutcome(
      folderId,
      new Date().toISOString(),
      result.copiedFiles,
      result.fileCount,
      result.skipped,
      result.unreadableSkipped,
    )
    updateFolder(folderId, {
      status: "syncing",
      progress: undefined,
      bytesPerSecond: undefined,
      fileCount: result.fileCount,
      currentAction: initialSyncAttentionSummary(result.skipped.length, result.unreadableSkipped.length)
        ?? `Initial files merged; waiting for ${peer.name} to commit completion.`,
    })
    return result
  } catch (error) {
    if (error instanceof InitialSyncUnreadableError) {
      // runInitialSyncPass already projected the review state onto the folder.
    } else {
      const message = error instanceof Error ? error.message : "The peer-initiated merge failed."
      updateFolder(folderId, { status: "needs-attention", progress: undefined, bytesPerSecond: undefined, currentAction: message })
      pushActivity("Initial merge failed", `${folder.name}: ${message}`, "error", folderId)
    }
    throw error
  } finally {
    initialSyncInFlight.delete(folderId)
    await persistState()
    broadcastSnapshot()
  }
}

function requireSharedFolder(context: PeerRequestContext, folderId: string): FolderSummary {
  const folder = snapshot.folders.find((item) => item.id === folderId)
  if (!folder || folder.remoteDeviceId !== context.peerId) {
    throw new Error("This folder is not shared with the requesting computer.")
  }
  return folder
}

function requireSharedInitialSyncFolder(context: PeerRequestContext, folderId: string): FolderSummary {
  const folder = requireSharedFolder(context, folderId)
  if (folder.setupStatus !== "ready-for-initial-sync") {
    throw new Error("Initial file access is no longer enabled for this folder.")
  }
  if (folder.paused || snapshot.paused) throw new Error("This folder is paused.")
  if (!initialSyncInFlight.has(folderId) && !hasInitialSyncPeerLease(folderId, context.peerId)) {
    throw new Error("No coordinated initial merge currently authorizes file access for this folder.")
  }
  return folder
}

function requireSharedFileSource(context: PeerRequestContext, folderId: string, relativePath: string): FolderSummary {
  const folder = requireSharedFolder(context, folderId)
  const initialAccess = folder.setupStatus === "ready-for-initial-sync" &&
    (initialSyncInFlight.has(folderId) || hasInitialSyncPeerLease(folderId, context.peerId))
  const record = mappingRecords.get(folderId)
  const continuousAccess = folder.setupStatus === "active" && record !== undefined &&
    (continuousSyncInFlight.has(folderId) || continuousCoordinatorId(record) === context.peerId)
  if (folder.paused || snapshot.paused) throw new Error("This folder is paused.")
  if (!initialAccess && !continuousAccess) {
    throw new Error("No authorized synchronization currently permits file access for this folder.")
  }
  if (folder.mode === "receive-only") {
    throw new Error("This folder is receive-only on this computer and cannot serve files.")
  }
  if (isManifestPathIgnored(relativePath, folder.ignorePatterns)) {
    throw new Error("The requested file is excluded by this folder's sync rules.")
  }
  if (isTetheraStagingPath(relativePath)) {
    throw new Error("Tethera staging paths are reserved and cannot be synchronized.")
  }
  return folder
}

function requireSharedActiveFolder(context: PeerRequestContext, folderId: string): FolderSummary {
  const folder = requireSharedFolder(context, folderId)
  const record = mappingRecords.get(folderId)
  if (!record || folder.setupStatus !== "active") throw new Error("This folder has not completed its initial merge.")
  if (continuousSyncBlocked.has(folderId)) throw new Error("This folder's configuration is changing. Retry shortly.")
  if (folder.paused || snapshot.paused) throw new Error("This folder is paused.")
  if (continuousCoordinatorId(record) !== context.peerId) {
    throw new Error("Only the elected synchronization coordinator can request this operation.")
  }
  return folder
}

function requireContinuousSyncNotification(context: PeerRequestContext, folderId: string): void {
  const folder = requireSharedFolder(context, folderId)
  const record = mappingRecords.get(folderId)
  if (!record || record.pendingDelivery || folder.setupStatus !== "active") {
    throw new Error("This folder has not completed its shared configuration.")
  }
  if (folder.paused || snapshot.paused) throw new Error("This folder is paused.")
  if (!isLocalContinuousCoordinator(record)) {
    throw new Error("Only the non-coordinator participant can report a local folder change.")
  }
}

async function withPeerFileOperation<T>(context: PeerRequestContext, folderId: string, operation: () => Promise<T>): Promise<T> {
  const key = `${context.peerId}:${folderId}`
  if (peerFileOperationsInFlight.has(key)) {
    throw new Error("Another file operation is already running for this shared folder.")
  }
  peerFileOperationsInFlight.add(key)
  try {
    return await operation()
  } finally {
    peerFileOperationsInFlight.delete(key)
  }
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
    // The envelope our own UI enforces before sending a scan; anything else
    // fails closed here instead of reaching the folder walker. The ceiling
    // always comes from this machine's setting — a peer-supplied limit is
    // never accepted, so a paired device cannot dictate our memory use.
    // The peer socket close/deadline aborts the walk via context.signal.
    const { path: requestedPath, ignorePatterns } = parsePeerScanManifest(request)
    const hashAllFiles = request.hashAllFiles === true
    if (hashAllFiles) {
      const folderId = typeof request.folderId === "string" ? request.folderId : ""
      const folder = requireSharedInitialSyncFolder(context, folderId)
      if (path.resolve(requestedPath) !== path.resolve(folder.localPath)) {
        throw new Error("A full-integrity scan is restricted to the approved shared folder.")
      }
      if (
        ignorePatterns.length !== folder.ignorePatterns.length ||
        ignorePatterns.some((pattern, index) => pattern !== folder.ignorePatterns[index])
      ) {
        throw new Error("A full-integrity scan must use the approved folder's sync rules.")
      }
      return withPeerFileOperation(context, folderId, async () => {
        // An approved folder's full-integrity scans share the durable digest
        // cache, and a setup seed from this computer's own comparison, so the
        // inverse merge pass and the coordinator's verification do not re-read
        // files whose exact identity is unchanged.
        const manifest = await runCachedFolderScan(
          `inbound:${folderId}`,
          folder,
          currentScanLimit(),
          context.signal,
          scanReuseSeeds.lookup(folder.localPath, folder.ignorePatterns),
        )
        assertManifestFitsExchange(manifest, "This computer", context.chunkedResponse)
        return manifest
      })
    }
    const manifest = await runLocalScan("inbound:preview", requestedPath, ignorePatterns, {
      hashAllFiles,
      maxFiles: currentScanLimit(),
      // Read-only lookup only; a peer request never grows the local seed store.
      reuse: scanReuseSeeds.lookup(path.resolve(requestedPath), ignorePatterns),
      // The wire progress schema is strict and older peers reject unknown
      // fields, so the reuse counter stays local.
      onActivity: context.reportProgress ? ({ stage, scannedFiles, ignoredEntries, unreadableEntries, hashedBytes }) => {
        context.reportProgress?.({ stage, scannedFiles, ignoredEntries, unreadableEntries, hashedBytes })
      } : undefined,
    }, context.signal)
    assertManifestFitsExchange(manifest, "This computer", context.chunkedResponse)
    return manifest
  }
  if (request.type === "continuous-sync-scan") {
    const folderId = typeof request.folderId === "string" ? request.folderId : ""
    const folder = requireSharedActiveFolder(context, folderId)
    // A malformed fingerprint is treated as absent, never as a match.
    const knownFingerprint = isObservationFingerprint(request.knownFingerprint) ? request.knownFingerprint : undefined
    return withPeerFileOperation(context, folderId, async () => {
      const scanLimit = currentScanLimit()
      if (knownFingerprint !== undefined) {
        const pass = await runCachedFolderFingerprint(`inbound:${folderId}`, folder, scanLimit, context.signal)
        if (!pass.truncated && pass.unreadable === 0 && pass.fingerprint === knownFingerprint) {
          const state = await engine.request<FileSyncState>("fileSync.getState", { id: folderId })
          if (state.operations.length === 0 && state.recoveryIssues.length === 0) return { unchanged: true }
        }
      }
      const manifest = await runCachedFolderScan(`inbound:${folderId}`, folder, scanLimit, context.signal)
      assertManifestFitsExchange(manifest, "This computer", context.chunkedResponse)
      return manifest
    })
  }
  if (request.type === "scan-capabilities") {
    return { capabilities: [SCAN_GENERATION_CAPABILITY, PEER_SCAN_PROGRESS_CAPABILITY, CHUNKED_FRAMES_CAPABILITY, CONTINUOUS_FINGERPRINT_CAPABILITY] }
  }
  if (request.type === "scan-generation-read-page") {
    const folderId = typeof request.folderId === "string" ? request.folderId : ""
    const generationId = typeof request.generationId === "string" ? request.generationId : ""
    const cursor = request.cursor === undefined || request.cursor === null ? undefined : typeof request.cursor === "string" ? request.cursor : ""
    const limit = typeof request.limit === "number" ? request.limit : 200
    requireSharedActiveFolder(context, folderId)
    if (!generationId || cursor === "") throw new Error("The scan generation page request is invalid.")
    return withPeerFileOperation(context, folderId, async () => {
      if (context.signal.aborted) throw new ScanCancelledError()
      const page = await engine.request<{ entries: Array<{ path: string; size: number; digest?: string }>; nextCursor?: string }>(
        "scanGeneration.readPage",
        { mappingId: folderId, generationId, cursor, limit },
      )
      // Bound the served page even if the engine contract widens later.
      if (page.entries.length > SCAN_PAGE_MAX_ENTRIES) throw new Error("The staged scan page exceeds the supported bound.")
      return { ...page, generationId }
    })
  }
  if (request.type === "continuous-sync-get-operations") {
    const folderId = typeof request.folderId === "string" ? request.folderId : ""
    requireSharedActiveFolder(context, folderId)
    return withPeerFileOperation(context, folderId, async () => {
      const state = await engine.request<FileSyncState>("fileSync.getState", { id: folderId })
      return { operations: state.operations }
    })
  }
  if (request.type === "continuous-sync-inspect-conflict") {
    const folderId = typeof request.folderId === "string" ? request.folderId : ""
    const relativePath = typeof request.path === "string" ? request.path : ""
    const folder = requireSharedFolder(context, folderId)
    if (folder.setupStatus !== "active" || folder.paused || snapshot.paused) {
      throw new Error("This folder is not available for conflict inspection.")
    }
    if (isManifestPathIgnored(relativePath, folder.ignorePatterns) || isTetheraStagingPath(relativePath)) {
      throw new Error("The requested conflict path is not eligible for synchronization.")
    }
    return withPeerFileOperation(context, folderId, () => withConflictHashing(folderId, async () => {
      const state = await engine.request<FileSyncState>("fileSync.getState", { id: folderId })
      const conflict = state.conflicts.find((candidate) => candidate.path === relativePath)
      if (!conflict) throw new Error("This file conflict no longer exists on the paired computer.")
      return describeConflictCopy(folder.localPath, relativePath, conflict.localDigest)
    }))
  }
  if (request.type === "continuous-sync-resolve-conflict") {
    const input = parseResolveFileConflictInput({
      mappingId: request.folderId,
      path: request.path,
      winnerDeviceId: request.winnerDeviceId,
      inspectedCopies: request.inspectedCopies,
    })
    const folderId = input.mappingId
    const folder = requireSharedFolder(context, folderId)
    const record = mappingRecords.get(folderId)
    if (!record || !isLocalContinuousCoordinator(record) || context.peerId === getLocalIdentityId()) {
      throw new Error("This computer is not the elected conflict-resolution coordinator.")
    }
    await resolveFileConflictLocally(input)
    return { accepted: true }
  }
  if (request.type === "continuous-sync-record-conflict-choice") {
    requireMappingMutations()
    const folderId = typeof request.folderId === "string" ? request.folderId : ""
    const relativePath = typeof request.path === "string" ? request.path : ""
    validateConflictInput({ mappingId: folderId, path: relativePath })
    const folder = requireSharedActiveFolder(context, folderId)
    const record = mappingRecords.get(folderId)
    if (!record || isLocalContinuousCoordinator(record) || context.peerId !== continuousCoordinatorId(record)) {
      throw new Error("Only this folder's elected coordinator can record its conflict choice.")
    }
    if (initialSyncInFlight.has(folderId) || archiveRestoreInFlight.has(folderId) || continuousSyncInFlight.has(folderId)) {
      throw new Error("Wait for the current folder operation to finish before recording a conflict choice.")
    }
    return withPeerFileOperation(context, folderId, () => withConflictHashing(folderId, async () => {
      const choice = parseExactConflictChoice(request)
      requireAllowedConflictDirection(folder.mode, choice.direction)
      const local = await describeConflictCopy(folder.localPath, relativePath, choice.localDigest)
      if (!local.present || local.size !== choice.localSize) {
        throw new Error("The local conflict copy no longer matches the coordinator's exact choice.")
      }
      const state = await engine.request<FileSyncState>("fileSync.resolveConflict", {
        mappingId: folderId,
        path: relativePath,
        ...choice,
        requestedAt: new Date().toISOString(),
      })
      applyFileSyncStateToFolder(folderId, state)
      broadcastSnapshot()
      return { recorded: true, operations: state.operations }
    }))
  }
  if (request.type === "continuous-sync-notify") {
    const folderId = typeof request.folderId === "string" ? request.folderId : ""
    requireContinuousSyncNotification(context, folderId)
    scheduleContinuousSync(folderId)
    return { queued: true }
  }
  if (request.type === "continuous-sync-observe") {
    requireMappingMutations()
    const folderId = typeof request.folderId === "string" ? request.folderId : ""
    requireSharedActiveFolder(context, folderId)
    return withPeerFileOperation(context, folderId, async () => {
      const state = await engine.request<ReconcileFilesResult>("fileSync.reconcile", {
        mappingId: folderId,
        local: request.local,
        remote: request.remote,
        mode: request.mode,
        observedAt: request.observedAt,
        queueOperations: true,
      }, 5 * 60_000)
      await retireInitialConflictProjection(folderId, state)
      applyFileSyncStateToFolder(folderId, state, new Date().toISOString())
      const folder = snapshot.folders.find((item) => item.id === folderId)
      if (folder) recordContinuousConflicts(folder, state.conflicts)
      broadcastSnapshot()
      return state
    })
  }
  if (request.type === "continuous-sync-apply") {
    requireMappingMutations()
    const operation = validateContinuousOperationRequest(request)
    return withPeerFileOperation(context, operation.folderId, async () => {
      if (continuousCyclesInProgress >= MAX_CONCURRENT_CONTINUOUS_CYCLES) {
        throw new Error("This computer is already handling its maximum number of synchronization cycles. Retry shortly.")
      }
      const folder = requireSharedActiveFolder(context, operation.folderId)
      if (isManifestPathIgnored(operation.path, folder.ignorePatterns)) {
        throw new Error("The requested file is excluded by this folder's sync rules.")
      }
      if (folder.mode === "send-only") {
        throw new Error("This folder is send-only on this computer and cannot receive files.")
      }
      const peer = getPairedDevice(context.peerId)
      if (!peer) throw new Error("The synchronization coordinator is no longer trusted.")
      const authorization = await engine.request<FileApplicationAuthorization>("fileSync.authorizeApply", {
        mappingId: operation.folderId,
        path: operation.path,
        digest: operation.digest,
        size: operation.size,
        expectedDestinationDigest: operation.expectedDestinationDigest,
      })
      if (authorization.alreadyVerified) {
        const current = await describeTransferFile(folder.localPath, operation.path)
        if (current.digest !== operation.digest || current.size !== operation.size) {
          throw new Error("The verified baseline no longer matches the live destination file.")
        }
        return { applied: true }
      }
      if (authorization.operationId === undefined) {
        throw new Error("The incoming file application has no durable operation identity.")
      }
      continuousCyclesInProgress += 1
      continuousSyncInFlight.add(operation.folderId)
      updateFolder(operation.folderId, { status: "syncing", currentAction: `Receiving ${operation.path} from ${peer.name}…` })
      broadcastSnapshot()
      try {
        const entry: FileManifest["files"][number] = {
          path: operation.path,
          size: operation.size,
          modifiedMs: 0,
          digest: operation.digest,
        }
        const transfer = await pullPlannedFile(
          folder,
          peer,
          entry,
          () => undefined,
          operation.expectedDestinationDigest,
          authorization.operationId,
        )
        const state = transfer.completedDuringRecovery
          ? await engine.request<FileSyncState>("fileSync.getState", { id: operation.folderId })
          : await engine.request<FileSyncState>("fileSync.applyVerified", {
              operationId: authorization.operationId,
              mappingId: operation.folderId,
              path: operation.path,
              digest: operation.digest,
              size: operation.size,
              verifiedAt: new Date().toISOString(),
              replacementJournalId: transfer.replacementJournalId,
            })
        await retireInitialConflictProjection(operation.folderId, state)
        applyFileSyncStateToFolder(operation.folderId, state, new Date().toISOString())
        broadcastSnapshot()
        return { applied: true }
      } finally {
        continuousSyncInFlight.delete(operation.folderId)
        continuousCyclesInProgress -= 1
      }
    })
  }
  if (request.type === "continuous-sync-verified") {
    requireMappingMutations()
    const operation = validateContinuousOperationRequest(request)
    const operationId = validatePeerOperationId(request)
    requireSharedActiveFolder(context, operation.folderId)
    return withPeerFileOperation(context, operation.folderId, async () => {
      const current = await engine.request<FileSyncState>("fileSync.getState", { id: operation.folderId })
      const exact = current.operations.find((candidate) =>
        candidate.id === operationId &&
        candidate.path === operation.path &&
        candidate.direction === "push-local" &&
        candidate.sourceDigest === operation.digest &&
        candidate.sourceSize === operation.size &&
        candidate.expectedDestinationDigest === operation.expectedDestinationDigest,
      )
      if (!exact) throw new Error("The verification did not match the exact durable push operation.")
      await engine.request("fileSync.complete", {
        operationId,
        digest: operation.digest,
        size: operation.size,
        verifiedAt: new Date().toISOString(),
      })
      const state = await engine.request<FileSyncState>("fileSync.getState", { id: operation.folderId })
      await retireInitialConflictProjection(operation.folderId, state)
      applyFileSyncStateToFolder(operation.folderId, state, new Date().toISOString())
      broadcastSnapshot()
      return { recorded: true }
    })
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
    return withContinuousSyncBlocked(mappingId, async () => {
    const isCoordinatorCompletion = event.kind === "active" &&
      event.record.mapping.setupStatus === "active" &&
      !event.record.mapping.paused &&
      Boolean(initialSyncOutcomes[mappingId]) &&
      context.peerId === [event.record.mapping.initiatorDeviceId, event.record.mapping.responderDeviceId].sort()[0]
    const peerLeaseBlocksEvent =
      hasInitialSyncPeerLease(mappingId) &&
      !isCoordinatorCompletion
    const localOperationBlocksEvent =
      (initialSyncInFlight.has(mappingId) || initialSyncForwarded.has(mappingId) || archiveRestoreInFlight.has(mappingId) || hasConflictResolutionInFlight(mappingId) || continuousSyncInFlight.has(mappingId)) &&
      !isCoordinatorCompletion
    if (localOperationBlocksEvent || peerLeaseBlocksEvent) {
      throw new Error("Wait for the initial merge to finish before changing or removing this mapping.")
    }
    const previous = mappingRecords.get(mappingId)
    const outcome = await engine.request<MappingApplyOutcome>("mapping.applyRemote", {
      event,
      authenticatedPeerDeviceId: context.peerId,
      localDeviceId: getLocalIdentityId(),
    })
    await refreshAuthoritativeMappings()
    await refreshContinuousSyncMonitors()
    if (event.kind === "active") {
      applyInitialSyncOutcomeStatus(outcome.mappingId)
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
      const { [outcome.mappingId]: _removedOutcome, ...remainingOutcomes } = initialSyncOutcomes
      initialSyncOutcomes = remainingOutcomes
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
    })
  }
  if (request.type === "initial-sync-run") {
    const folderId = typeof request.folderId === "string" ? request.folderId : ""
    return runPeerInitialSync(context, folderId, request.allowUnreadable === true)
  }
  if (request.type === "initial-sync-prepare") {
    const folderId = typeof request.folderId === "string" ? request.folderId : ""
    const folder = requireSharedFolder(context, folderId)
    if (folder.setupStatus !== "ready-for-initial-sync" || folder.paused || snapshot.paused) {
      throw new Error("This folder is not ready for an initial merge.")
    }
    const record = mappingRecords.get(folderId)
    if (!record) throw new Error("This folder is no longer configured.")
    const coordinatorId = [record.mapping.initiatorDeviceId, record.mapping.responderDeviceId].sort()[0]
    if (context.peerId !== coordinatorId) throw new Error("Only the elected coordinator can prepare this merge.")
    initialSyncPeerLeases.set(folderId, { peerId: context.peerId, expiresAt: Date.now() + INITIAL_SYNC_LEASE_MS })
    updateFolder(folderId, { status: "syncing", progress: 0, currentAction: `${context.peerName} is coordinating the initial merge…` })
    broadcastSnapshot()
    return { prepared: true }
  }
  if (request.type === "initial-sync-renew") {
    const folderId = typeof request.folderId === "string" ? request.folderId : ""
    requireSharedFolder(context, folderId)
    if (!hasInitialSyncPeerLease(folderId, context.peerId)) throw new Error("The initial-merge lease is no longer active.")
    initialSyncPeerLeases.set(folderId, { peerId: context.peerId, expiresAt: Date.now() + INITIAL_SYNC_LEASE_MS })
    return { renewed: true }
  }
  if (request.type === "initial-sync-release") {
    const folderId = typeof request.folderId === "string" ? request.folderId : ""
    const folder = requireSharedFolder(context, folderId)
    if (hasInitialSyncPeerLease(folderId, context.peerId)) initialSyncPeerLeases.delete(folderId)
    if (folder.setupStatus === "ready-for-initial-sync" && !initialSyncInFlight.has(folderId)) {
      updateFolder(folderId, {
        status: "needs-attention",
        progress: undefined,
        bytesPerSecond: undefined,
        currentAction: "The initial merge stopped before activation. Retry when both computers are ready.",
      })
      broadcastSnapshot()
    }
    return { released: true }
  }
  if (request.type === "initial-sync-coordinate") {
    const folderId = typeof request.folderId === "string" ? request.folderId : ""
    const folder = requireSharedFolder(context, folderId)
    if (folder.setupStatus !== "ready-for-initial-sync" || folder.paused || snapshot.paused) {
      throw new Error("This folder is not ready for an initial merge.")
    }
    const record = mappingRecords.get(folder.id)
    if (!record) throw new Error("This folder is no longer configured.")
    const coordinatorId = [record.mapping.initiatorDeviceId, record.mapping.responderDeviceId].sort()[0]
    if (coordinatorId !== getLocalIdentityId()) throw new Error("This computer is not the elected merge coordinator.")
    const existingCompletion = initialSyncCompletions.get(folderId)
    if (existingCompletion) await existingCompletion.promise
    else await startInitialSync(folderId, request.allowUnreadable === true)
    const completedRecord = mappingRecords.get(folderId)
    if (completedRecord?.mapping.setupStatus !== "active" || completedRecord.pendingDelivery) {
      const current = snapshot.folders.find((item) => item.id === folderId)
      return { completed: false, error: current?.currentAction ?? "The coordinating computer did not complete activation." }
    }
    return { completed: true }
  }
  if (request.type === "initial-sync-outcome") {
    const folderId = typeof request.folderId === "string" ? request.folderId : ""
    requireSharedInitialSyncFolder(context, folderId)
    const record = mappingRecords.get(folderId)
    if (!record) throw new Error("This folder is no longer configured.")
    const coordinatorId = [record.mapping.initiatorDeviceId, record.mapping.responderDeviceId].sort()[0]
    if (context.peerId !== coordinatorId) throw new Error("Only the elected coordinator can commit the merge outcome.")
    if (typeof request.completedAt !== "string" || !Number.isFinite(Date.parse(request.completedAt))) {
      throw new Error("The initial-merge outcome timestamp is invalid.")
    }
    const result = validateInitialSyncPassResult({
      copiedFiles: request.copiedFiles,
      copiedBytes: 0,
      fileCount: request.fileCount,
      skipped: request.conflicts,
      unreadableSkipped: request.unreadableSkipped,
    })
    persistInitialSyncOutcome(folderId, request.completedAt, result.copiedFiles, result.fileCount, result.skipped, result.unreadableSkipped)
    await persistStateDurably()
    return { recorded: true }
  }
  if (request.type === "pull-file-descriptor") {
    const folderId = typeof request.folderId === "string" ? request.folderId : ""
    const relativePath = typeof request.relativePath === "string" ? request.relativePath : ""
    const folder = requireSharedFileSource(context, folderId, relativePath)
    return withPeerFileOperation(context, folderId, () => describeTransferFile(folder.localPath, relativePath))
  }
  if (request.type === "pull-file-chunk") {
    const folderId = typeof request.folderId === "string" ? request.folderId : ""
    const relativePath = typeof request.relativePath === "string" ? request.relativePath : ""
    const folder = requireSharedFileSource(context, folderId, relativePath)
    const expectedSize = typeof request.expectedSize === "number" ? request.expectedSize : Number.NaN
    const expectedModifiedMs = typeof request.expectedModifiedMs === "number" ? request.expectedModifiedMs : Number.NaN
    const offset = typeof request.offset === "number" ? request.offset : Number.NaN
    const length = typeof request.length === "number" ? request.length : Number.NaN
    const content = await withPeerFileOperation(context, folderId, () => readTransferFileChunk(
        folder.localPath,
        relativePath,
        { size: expectedSize, modifiedMs: expectedModifiedMs },
        offset,
        length,
      ))
    return { offset, contentBase64: content.toString("base64") } satisfies TransferChunkResponse
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
    if (archiveRestoreInFlight.size > 0 || hasConflictResolutionInFlight()) {
      throw new Error("Wait for the current recovery operation to finish before restarting storage.")
    }
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
  ipcMain.handle("recovery:get-state", async (event) => {
    requireTrustedMainRenderer(event)
    return getRecoveryState()
  })
  ipcMain.handle("recovery:inspect-conflict", async (event, input: ConflictInspectionInput) => {
    requireTrustedMainRenderer(event)
    return inspectFileConflict(input)
  })
  ipcMain.handle("recovery:resolve-conflict", async (event, input: unknown) => {
    requireTrustedMainRenderer(event)
    return resolveFileConflict(input)
  })
  ipcMain.handle("recovery:reveal-conflict-file", async (event, input: ConflictInspectionInput) => {
    requireTrustedMainRenderer(event)
    validateConflictInput(input)
    const { folder } = requireRecoveryFolder(input.mappingId)
    const state = await engine.request<FileSyncState>("fileSync.getState", { id: folder.id })
    if (!state.conflicts.some((conflict) => conflict.path === input.path)) {
      throw new Error("This file conflict no longer exists.")
    }
    shell.showItemInFolder(resolveWithinRoot(folder.localPath, input.path))
  })
  ipcMain.handle("archive:restore", async (event, entryId: string) => {
    requireTrustedMainRenderer(event)
    requireMappingMutations()
    if (typeof entryId !== "string" || !entryId) throw new Error("Choose an archived version to restore.")
    const source = await engine.request<ReplacementJournalEntry>("archive.get", { entryId })
    const folder = snapshot.folders.find((candidate) => candidate.id === source.mappingId)
    if (!folder) throw new Error("The archived version's folder mapping is no longer active.")
    if (
      continuousSyncInFlight.has(folder.id) ||
      initialSyncInFlight.has(folder.id) ||
      archiveRestoreInFlight.has(folder.id) ||
      hasConflictResolutionInFlight(folder.id) ||
      conflictHashingInFlight.has(folder.id)
    ) {
      throw new Error("Wait for the current folder operation to finish before restoring a version.")
    }
    archiveRestoreInFlight.add(folder.id)
    try {
      const restored = await withContinuousSyncBlocked(folder.id, () =>
        restoreArchivedVersion(engine, folder.localPath, versionArchiveObjectRoot(), entryId),
      )
      updateFolder(folder.id, {
        status: "needs-attention",
        currentAction: `${restored.path} was restored safely and will be reconciled with the paired computer.`,
      })
      pushActivity("Archived version restored", `${folder.name}: restored ${restored.path}.`, "success", folder.id)
      scheduleContinuousSync(folder.id)
      return broadcastSnapshot()
    } finally {
      archiveRestoreInFlight.delete(folder.id)
    }
  })
  ipcMain.handle("archive:list-versions", async (event, mappingId: unknown) => {
    requireTrustedMainRenderer(event)
    const requestedMappingId = parseArchiveHistoryRequest(mappingId)
    if (engine.state.status !== "ready" || snapshot.mappingStore.status !== "ready") {
      throw new Error("Version history is unavailable until the mapping database is ready.")
    }
    const folder = snapshot.folders.find((candidate) => candidate.id === requestedMappingId)
    if (!folder) {
      throw new Error("The archived version history's folder mapping is no longer active.")
    }
    if (folder.setupStatus !== "active") {
      throw new Error("The archived version history is only available for active folders.")
    }
    return listArchivedVersions(engine, folder.id, folder.name)
  })
  ipcMain.handle("app:pause-all", () => setAllPaused(true))
  ipcMain.handle("app:resume-all", () => setAllPaused(false))
  ipcMain.handle("filesystem:browse-directory", (_event, input: BrowseDirectoryInput) => browseDirectory(input))
  ipcMain.handle("filesystem:create-directory", (_event, input: CreateDirectoryInput) => createLocalDirectory(input))
  ipcMain.handle("folders:preview-mapping", (event, input: PreviewFolderMappingInput, progressOperationId: unknown) => {
    requireTrustedMainRenderer(event)
    return folderComparisonResult(() => previewFolderMapping(input, progressOperationId))
  })
  ipcMain.handle("folders:request-mapping", (event, input: RequestFolderMappingInput, progressOperationId: unknown) => {
    requireTrustedMainRenderer(event)
    return folderComparisonResult(() => requestFolderMapping(input, progressOperationId))
  })
  ipcMain.handle("folders:refresh-incoming-preview", (event, input: RefreshIncomingMappingPreviewInput, progressOperationId: unknown) => {
    requireTrustedMainRenderer(event)
    return folderComparisonResult(() => refreshIncomingMappingPreview(input, progressOperationId))
  })
  ipcMain.handle("folders:approve-mapping", (event, input: ApproveFolderMappingInput, progressOperationId: unknown) => {
    requireTrustedMainRenderer(event)
    return folderComparisonResult(() => approveFolderMapping(input, progressOperationId))
  })
  ipcMain.handle("folders:cancel-preview", (event, progressOperationId: unknown) => {
    requireTrustedMainRenderer(event)
    const operationId = parsePreviewProgressToken(progressOperationId)
    if (!operationId) throw new Error("Choose an active comparison to cancel.")
    previewScanControllers.get(operationId)?.abort()
  })
  ipcMain.handle("folders:reject-mapping", (_event, requestId: string) => rejectFolderMapping(requestId))
  ipcMain.handle("folders:start-initial-sync", (_event, folderId: string, acknowledgeUnreadable: unknown) =>
    startInitialSync(folderId, acknowledgeUnreadable === true))
  ipcMain.handle("folders:dismiss-initial-sync-issues", (_event, folderId: string) => dismissInitialSyncIssues(folderId))

  ipcMain.handle("folders:add", async (_event: Electron.IpcMainInvokeEvent, _input: AddFolderInput) => {
    throw new Error("Folder mappings now require an initial comparison and approval on the other computer.")
  })

  ipcMain.handle("folders:set-paused", async (_event: Electron.IpcMainInvokeEvent, folderId: string, paused: boolean) => {
    requireMappingMutations()
    const release = blockContinuousSync(folderId)
    try {
      if (paused && (initialSyncInFlight.has(folderId) || initialSyncForwarded.has(folderId) || archiveRestoreInFlight.has(folderId) || hasConflictResolutionInFlight(folderId) || hasInitialSyncPeerLease(folderId) || continuousSyncInFlight.has(folderId))) {
        throw new Error("Wait for the active file transfer to finish before pausing this folder.")
      }
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
      if (paused) {
        preparedInitialSyncScans.delete(folderId)
        updateFolder(folderId, { scanIssues: undefined })
        scanReuseSeeds.forget(record.mapping.initiatorPath, record.mapping.ignorePatterns)
        scanReuseSeeds.forget(record.mapping.responderPath, record.mapping.ignorePatterns)
      }
      await persistState()
      broadcastSnapshot()
      void flushPendingConfigurationDeliveries()
      return snapshot
    } finally {
      release()
    }
  })

  ipcMain.handle("folders:remove", async (_event: Electron.IpcMainInvokeEvent, folderId: string) => {
    requireMappingMutations()
    const release = blockContinuousSync(folderId)
    try {
      if (initialSyncInFlight.has(folderId) || initialSyncForwarded.has(folderId) || archiveRestoreInFlight.has(folderId) || hasConflictResolutionInFlight(folderId) || hasInitialSyncPeerLease(folderId) || continuousSyncInFlight.has(folderId)) {
        throw new Error("Wait for the active file transfer to finish before removing this folder.")
      }
      const record = mappingRecords.get(folderId)
      if (!record) throw new Error("The mapping no longer exists in the authoritative database.")
      // This commits a configuration tombstone only. No path in the mapping is dereferenced and no
      // file inside either mapped directory is read, moved, rewritten, or deleted.
      await removeAuthoritativeMapping(record)
      const { [folderId]: _removedOutcome, ...remainingOutcomes } = initialSyncOutcomes
      initialSyncOutcomes = remainingOutcomes
      preparedInitialSyncScans.delete(folderId)
      scanReuseSeeds.forget(record.mapping.initiatorPath, record.mapping.ignorePatterns)
      scanReuseSeeds.forget(record.mapping.responderPath, record.mapping.ignorePatterns)
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
    } finally {
      release()
    }
  })

  ipcMain.handle("shell:reveal-path", async (event: Electron.IpcMainInvokeEvent, targetPath: unknown) => {
    requireTrustedMainRenderer(event)
    await shell.openPath(parseRevealPath(targetPath))
  })

  ipcMain.handle("settings:update", async (event: Electron.IpcMainInvokeEvent, key: unknown, value: unknown) =>
    mutate(() => {
      const update = parseSettingUpdate(key, value)
      snapshot.settings = applySettingUpdate(snapshot.settings, update)
      if (update.key === "launchAtLogin") app.setLoginItemSettings({ openAtLogin: update.value, openAsHidden: snapshot.settings.startMinimised })
      if (update.key === "startMinimised" && snapshot.settings.launchAtLogin) app.setLoginItemSettings({ openAtLogin: true, openAsHidden: update.value })
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
  ipcMain.handle("updates:check", async (event) => {
    requireTrustedMainRenderer(event)
    await requestUpdateCheck("ipc")
  })
  ipcMain.handle("updates:download", async (event) => {
    requireTrustedMainRenderer(event)
    await requestUpdateDownload()
  })
  ipcMain.handle("updates:install", async (event) => {
    requireTrustedMainRenderer(event)
    requestUpdateInstall()
  })
}

function requireTrustedMainRenderer(event: Electron.IpcMainInvokeEvent): void {
  if (
    !mainWindow ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== mainWindow.webContents.mainFrame ||
    !isTrustedRendererUrl(event.senderFrame.url)
  ) {
    throw new Error("This action can only be performed from Tethera's main window.")
  }
}

function isTrustedRendererUrl(url: string): boolean {
  const developmentUrl = process.env.ELECTRON_RENDERER_URL
  if (developmentUrl) {
    try {
      return new URL(url).origin === new URL(developmentUrl).origin
    } catch {
      return false
    }
  }
  return url === pathToFileURL(path.join(__dirname, "../renderer/index.html")).href
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
    void refreshContinuousSyncMonitors()
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

function updateBaseFields(): { currentVersion: string; lastCheckedAt?: string } {
  return { currentVersion: currentAppVersion(), lastCheckedAt: snapshot.update.lastCheckedAt }
}

function updateVersionHint(): string | undefined {
  const current = snapshot.update
  return "version" in current && typeof current.version === "string" ? current.version : undefined
}

async function requestUpdateCheck(source: "ipc" | "tray" | "startup" | "schedule"): Promise<void> {
  if (!app.isPackaged) {
    if (source === "ipc") {
      setUpdateState({
        status: "error",
        message: "Automatic updates are only available in installed builds of Tethera.",
        currentVersion: currentAppVersion(),
      })
    }
    return
  }
  if (isUpdateBusy(snapshot.update)) return
  if (snapshot.update.status === "downloaded") return
  lastUpdateProgressPercent = null
  lastUpdateProgressAt = null
  try {
    await autoUpdater.checkForUpdates()
  } catch (error) {
    console.error("[updater] check failed", error)
    if (shouldPreserveDownloadedOnError(snapshot.update)) return
    setUpdateState({
      status: "error",
      message: formatUpdateError(error),
      version: updateVersionHint(),
      currentVersion: currentAppVersion(),
      lastCheckedAt: nowIso(),
    })
  }
}

async function requestUpdateDownload(): Promise<void> {
  if (!app.isPackaged) throw new Error("Automatic updates are only available in installed builds of Tethera.")
  if (!canDownloadUpdate(snapshot.update)) {
    throw new Error(
      snapshot.update.status === "downloaded"
        ? "This update is already downloaded."
        : "Check for updates before downloading.",
    )
  }
  lastUpdateProgressPercent = null
  lastUpdateProgressAt = null
  try {
    await runUpdateDownload(snapshot.update, async () => {
      await autoUpdater.downloadUpdate()
    }, setUpdateState)
  } catch (error) {
    console.error("[updater] download failed", error)
    const message = formatUpdateError(error)
    setUpdateState({
      status: "error",
      message,
      version: updateVersionHint(),
      currentVersion: currentAppVersion(),
      lastCheckedAt: nowIso(),
    })
    throw new Error(message)
  }
}

function requestUpdateInstall(): void {
  if (!canInstallUpdate(snapshot.update)) {
    throw new Error("No downloaded update is ready to install yet.")
  }
  try {
    isQuitting = true
    autoUpdater.quitAndInstall()
  } catch (error) {
    isQuitting = false
    console.error("[updater] install failed", error)
    throw new Error(formatUpdateError(error))
  }
}

function scheduleUpdateChecks(): void {
  if (!app.isPackaged) return
  if (updateCheckTimer) clearInterval(updateCheckTimer)
  updateCheckTimer = setInterval(() => {
    if (isUpdateBusy(snapshot.update) || snapshot.update.status === "downloaded") return
    void requestUpdateCheck("schedule")
  }, UPDATE_CHECK_INTERVAL_MS)
  if (typeof updateCheckTimer.unref === "function") updateCheckTimer.unref()
}

function setUpAutoUpdater(): void {
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowDowngrade = false
  autoUpdater.allowPrerelease = false
  autoUpdater.logger = {
    debug: (...args: unknown[]) => console.debug("[updater]", ...args),
    info: (...args: unknown[]) => console.info("[updater]", ...args),
    warn: (...args: unknown[]) => console.warn("[updater]", ...args),
    error: (...args: unknown[]) => console.error("[updater]", ...args),
  }

  autoUpdater.on("checking-for-update", () => {
    setUpdateState({ status: "checking", ...updateBaseFields() })
  })
  autoUpdater.on("update-available", (info) => {
    lastUpdateProgressPercent = null
    lastUpdateProgressAt = null
    setUpdateState({
      status: "available",
      version: info.version,
      releaseNotes: normalizeReleaseNotes(info.releaseNotes),
      releaseDate: typeof info.releaseDate === "string" ? info.releaseDate : undefined,
      currentVersion: currentAppVersion(),
      lastCheckedAt: nowIso(),
    })
  })
  autoUpdater.on("update-not-available", () => {
    setUpdateState({ status: "not-available", currentVersion: currentAppVersion(), lastCheckedAt: nowIso() })
  })
  autoUpdater.on("error", (error) => {
    console.error("[updater] error", error)
    if (shouldPreserveDownloadedOnError(snapshot.update)) return
    setUpdateState({
      status: "error",
      message: formatUpdateError(error),
      version: updateVersionHint(),
      currentVersion: currentAppVersion(),
      lastCheckedAt: nowIso(),
    })
  })
  autoUpdater.on("download-progress", (progress) => {
    const progressPercent = clampProgressPercent(progress.percent)
    const now = Date.now()
    if (!shouldBroadcastProgress(lastUpdateProgressPercent, lastUpdateProgressAt, progressPercent, now)) return
    lastUpdateProgressPercent = progressPercent
    lastUpdateProgressAt = now
    setUpdateState({
      status: "downloading",
      version: updateVersionHint() ?? currentAppVersion(),
      progressPercent,
      bytesPerSecond: toOptionalFiniteNumber(progress.bytesPerSecond),
      transferredBytes: toOptionalFiniteNumber(progress.transferred),
      totalBytes: toOptionalFiniteNumber(progress.total),
      currentVersion: currentAppVersion(),
      lastCheckedAt: snapshot.update.lastCheckedAt,
    })
  })
  autoUpdater.on("update-downloaded", (info) => {
    lastUpdateProgressPercent = null
    lastUpdateProgressAt = null
    setUpdateState({
      status: "downloaded",
      version: info.version,
      releaseNotes: normalizeReleaseNotes(info.releaseNotes),
      releaseDate: typeof info.releaseDate === "string" ? info.releaseDate : undefined,
      currentVersion: currentAppVersion(),
      lastCheckedAt: nowIso(),
    })
  })
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
    // Tethera's navigation lives in the renderer sidebar and tray menu; the
    // default Electron menu bar would be dead weight (and on Windows it
    // renders a native File/Edit/View strip above the custom UI).
    autoHideMenuBar: true,
    icon: resolveResourcePath("icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  mainWindow.setMenu(null)
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  mainWindow.webContents.on("will-navigate", (event: Electron.Event, url: string) => {
    if (!isTrustedRendererUrl(url)) event.preventDefault()
  })
  if (process.env.ELECTRON_RENDERER_URL) void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"))
  mainWindow.once("ready-to-show", () => {
    if (!snapshot.settings.startMinimised) mainWindow?.show()
  })
  mainWindow.on("close", (event: Electron.Event) => {
    // Only hide to the tray when a live tray instance exists to reopen the
    // window. When tray creation was skipped or failed, closing must destroy
    // the window so the app can quit instead of stranding a hidden window.
    if (!isQuitting && snapshot.settings.closeToTray && tray) {
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
  const source = existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty()
  if (source.isEmpty()) {
    console.error(`[tray] tray icon missing or unreadable at ${iconPath}; skipping tray creation`)
    return
  }
  try {
    tray = new Tray(source.resize({ width: 18, height: 18 }))
  } catch (error) {
    console.error("[tray] tray creation failed", error)
    tray = null
    return
  }
  tray.setToolTip("Tethera")
  tray.on("click", showMainWindow)
  rebuildTrayMenu()
}

function updateTrayEntry(): MenuItemConstructorOptions {
  const update = snapshot.update
  if (update.status === "downloaded") {
    return {
      label: `Restart to install v${update.version}`,
      click: () => {
        try {
          requestUpdateInstall()
        } catch (error) {
          console.error("[updater] tray install failed", error)
        }
      },
    }
  }
  if (update.status === "downloading") {
    return { label: `Downloading update… ${update.progressPercent}%`, enabled: false }
  }
  if (update.status === "checking") {
    return { label: "Checking for updates…", enabled: false }
  }
  if (update.status === "available") {
    return { label: `Download Tethera v${update.version}`, click: () => void requestUpdateDownload().catch(() => {}) }
  }
  if (update.status === "error") {
    return { label: "Retry update check", click: () => void requestUpdateCheck("tray"), enabled: app.isPackaged }
  }
  return { label: "Check for updates", click: () => void requestUpdateCheck("tray"), enabled: app.isPackaged }
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
    updateTrayEntry(),
    { type: "separator" },
    { label: "Quit", click: () => { isQuitting = true; app.quit() } },
  ]
  tray.setContextMenu(Menu.buildFromTemplate(template))
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()
app.on("second-instance", showMainWindow)

if (hasSingleInstanceLock) void app.whenReady().then(async () => {
  await loadState()
  registerIpc()
  createWindow()
  createTray()
  setUpAutoUpdater()
  if (app.isPackaged && !process.argv.includes("--squirrel-firstrun")) {
    setTimeout(() => void requestUpdateCheck("startup"), UPDATE_STARTUP_DELAY_MS)
    scheduleUpdateChecks()
  }
  try {
    await startNetworkServices()
  } catch (error) {
    pushActivity("Network services unavailable", error instanceof Error ? error.message : "Unable to start LAN services.", "error")
    broadcastSnapshot()
  }
  startEngine()
  app.on("activate", showMainWindow)
})

app.on("before-quit", () => {
  isQuitting = true
  // Cooperative shutdown: read-only scans abort at their next checkpoint.
  // Commit/recovery sequences never take a scan signal, so they are unaffected.
  shutdownScanController.abort()
  globalScanCoordinator.cancelQueued("Tethera is shutting down.")
})
app.on("window-all-closed", () => {
  // Staying alive with no window is only useful when the tray can reopen it.
  if (process.platform === "darwin" || (snapshot?.settings.closeToTray && tray)) return
  app.quit()
})
app.on("will-quit", () => {
  clearInterval(preparedInitialSyncSweepTimer)
  if (updateCheckTimer) clearInterval(updateCheckTimer)
  if (decisionRetryTimer) clearInterval(decisionRetryTimer)
  for (const retry of continuousSyncRetryTimers.values()) clearTimeout(retry)
  continuousSyncRetryTimers.clear()
  for (const monitor of continuousSyncMonitors.values()) monitor.close()
  continuousSyncMonitors.clear()
  void peerSessions?.stop()
  void pairing?.stop()
  void engine.stop()
})
