import { z } from "zod"
import type {
  AddFolderInput,
  AppSettings,
  BrowseDirectoryInput,
  ConflictCopyExpectation,
  ConflictInspection,
  ConflictInspectionInput,
  CreateDirectoryInput,
  ResolveFileConflictInput,
  SyncMode,
  UpdateFolderMappingInput,
} from "../shared/contracts"
import type { ExactConflictChoice, FileSyncDirection, PeerFileOperationIdentity } from "./continuous-sync"
import { FileChangedError, isSha256HexDigest, type TransferFileDescriptor } from "./file-transfer"
import type { FileManifest } from "./folder-manifest"
import type { InitialSyncPassResult } from "./initial-sync"
import { isTetheraStagingPath } from "./path-safety"
import type { PeerRequest } from "./peer-session-service"
import { MAX_LEGACY_MANIFEST_ENCODED_BYTES } from "../shared/sync-capacity"

/**
 * Runtime validators for the renderer/IPC and peer/message boundaries.
 *
 * A compile-time TypeScript type on one side of IPC does not validate the
 * payload arriving from the other side, so every handler below parses its
 * input before acting on it. The ignore-pattern envelope mirrors the
 * `manifest.scan` limits in the Rust engine: anything our own UI can send
 * passes, anything it could never send fails closed.
 */
export const MAX_SCAN_PATH_LENGTH = 4096
export const MAX_IGNORE_PATTERNS = 256
export const MAX_IGNORE_PATTERN_LENGTH = 512
export { MAX_LEGACY_MANIFEST_ENCODED_BYTES }

const pathString = z
  .string()
  .min(1)
  .max(MAX_SCAN_PATH_LENGTH)
  .refine((value) => !value.includes("\0"), "The path is invalid.")

const archiveHistoryRequestSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => !value.includes("\0"), "Choose a valid folder.")

const ignorePattern = z
  .string()
  .max(MAX_IGNORE_PATTERN_LENGTH)
  .refine((value) => !value.includes("\0"), "An ignore pattern is invalid or too long.")

export const ignorePatternsSchema = z.array(ignorePattern).max(MAX_IGNORE_PATTERNS)

/** Shape check for `shell:reveal-path`, which must never receive an unbounded string. */
export const revealPathSchema = pathString

export function parseRevealPath(value: unknown): string {
  const parsed = revealPathSchema.safeParse(value)
  if (!parsed.success) throw new Error("The selected path is invalid.")
  return parsed.data
}

/** The browser may omit or blank the starting path to mean "this computer's home folder". */
const optionalBrowsePath = z
  .string()
  .max(MAX_SCAN_PATH_LENGTH)
  .refine((value) => !value.includes("\0"), "The folder path is invalid.")
  .optional()

const deviceIdString = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !value.includes("\0"), "The folder browser request is invalid.")

const browseDirectoryInputSchema = z.object({
  deviceId: deviceIdString,
  path: optionalBrowsePath,
  includeHidden: z.boolean().optional(),
})

const createDirectoryInputSchema = z.object({
  deviceId: deviceIdString,
  parentPath: pathString.refine((value) => value.trim().length > 0, "The parent path is invalid."),
  name: z
    .string()
    .min(1)
    .max(255)
    .refine((value) => !value.includes("\0")),
})

/**
 * Validates the folder-picker payloads before they reach the filesystem. The
 * picker is intentionally free to browse anywhere, so these bounds exist to
 * keep the request shape and length predictable, not to confine the path.
 */
export function parseBrowseDirectoryInput(value: unknown): BrowseDirectoryInput {
  const parsed = browseDirectoryInputSchema.safeParse(value)
  if (!parsed.success) throw new Error("The folder browser request is invalid.")
  return parsed.data
}

export function parseCreateDirectoryInput(value: unknown): CreateDirectoryInput {
  const parsed = createDirectoryInputSchema.safeParse(value)
  if (!parsed.success) throw new Error("The new folder request is invalid.")
  return parsed.data
}

export function parseArchiveHistoryRequest(input: unknown): string {
  const parsed = archiveHistoryRequestSchema.safeParse(input)
  if (!parsed.success) throw new Error("Choose a valid folder.")
  return parsed.data
}

const settingUpdateSchema = z.discriminatedUnion("key", [
  z.object({ key: z.literal("closeToTray"), value: z.boolean() }),
  z.object({ key: z.literal("launchAtLogin"), value: z.boolean() }),
  z.object({ key: z.literal("startMinimised"), value: z.boolean() }),
  z.object({ key: z.literal("pauseOnMetered"), value: z.boolean() }),
  z.object({ key: z.literal("theme"), value: z.enum(["system", "light", "dark"]) }),
])

export type SettingUpdate = z.infer<typeof settingUpdateSchema>

export function parseSettingUpdate(key: unknown, value: unknown): SettingUpdate {
  const parsed = settingUpdateSchema.safeParse({ key, value })
  if (!parsed.success) throw new Error("The requested setting change is invalid.")
  return parsed.data
}

/** Applies an already-validated update. The switch is exhaustive on purpose: adding a setting to the schema without handling it here is a compile error. */
export function applySettingUpdate(settings: AppSettings, update: SettingUpdate): AppSettings {
  switch (update.key) {
    case "closeToTray":
      return { ...settings, closeToTray: update.value }
    case "launchAtLogin":
      return { ...settings, launchAtLogin: update.value }
    case "startMinimised":
      return { ...settings, startMinimised: update.value }
    case "pauseOnMetered":
      return { ...settings, pauseOnMetered: update.value }
    case "theme":
      return { ...settings, theme: update.value }
    default: {
      const unexpected: never = update
      throw new Error(`Unsupported setting: ${JSON.stringify(unexpected)}`)
    }
  }
}

/**
 * Rebuilds settings from an untrusted persisted value. A known setting is kept
 * only when it passes the same validation as a live update; anything missing,
 * mistyped or retired (such as the old scan file limit) falls back to the
 * default or is dropped.
 */
export function restorePersistedSettings(value: unknown, defaults: AppSettings): AppSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ...defaults }
  const stored = new Map<string, unknown>(Object.entries(value))
  let settings = { ...defaults }
  for (const key of Object.keys(defaults)) {
    const parsed = settingUpdateSchema.safeParse({ key, value: stored.get(key) })
    if (parsed.success) settings = applySettingUpdate(settings, parsed.data)
  }
  return settings
}

/** Validates a folder-mapping draft before any preview, scan, or peer request. Moved out of `index.ts` unchanged apart from sharing the envelope constants above. */
export function validateMappingInput(input: AddFolderInput): void {
  if (!input.localPath?.trim() || !input.remotePath?.trim()) throw new Error("Choose both folders before continuing.")
  if (!input.remoteDeviceId?.trim()) throw new Error("Choose a paired computer.")
  validateMappingRules(input)
}

/**
 * Shape check only; `validateMappingRules` then applies the shared domain
 * bounds so create and edit report the same errors.
 */
const folderUpdateInputSchema = z.object({
  folderId: deviceIdString,
  name: z.string(),
  mode: z.enum(["two-way", "send-only", "receive-only"]),
  ignorePatterns: z.array(z.string()),
  historyDays: z.number(),
  historyMaxBytes: z.number(),
})

/** Validates the settings of an existing mapping arriving over `folders:update`. */
export function parseFolderUpdateInput(value: unknown): UpdateFolderMappingInput {
  const parsed = folderUpdateInputSchema.safeParse(value)
  if (!parsed.success) throw new Error("The folder settings are invalid.")
  validateMappingRules(parsed.data)
  return parsed.data
}

/** The rule envelope every mapping configuration shares, whether created or edited. */
function validateMappingRules(input: {
  name: string
  mode: SyncMode
  ignorePatterns: string[]
  historyDays: number
  historyMaxBytes: number
}): void {
  if (!(["two-way", "send-only", "receive-only"] as const).includes(input.mode)) throw new Error("The sync direction is invalid.")
  if (!Number.isInteger(input.historyDays) || input.historyDays < 1 || input.historyDays > 3_650) {
    throw new Error("Version history must be between 1 and 3,650 days.")
  }
  if (!Number.isSafeInteger(input.historyMaxBytes) || input.historyMaxBytes < 1024 ** 3 || input.historyMaxBytes > 4 * 1024 ** 4) {
    throw new Error("The history storage cap must be between 1 GB and 4 TB.")
  }
  if (!Array.isArray(input.ignorePatterns) || input.ignorePatterns.length > MAX_IGNORE_PATTERNS) {
    throw new Error("Use no more than 256 ignore patterns.")
  }
  if (
    input.ignorePatterns.some(
      (pattern) => typeof pattern !== "string" || pattern.length > MAX_IGNORE_PATTERN_LENGTH || pattern.includes("\0"),
    )
  ) {
    throw new Error("An ignore pattern is invalid or too long.")
  }
  if (input.name.length > 120) throw new Error("The folder name must be 120 characters or fewer.")
}

/** Envelope for a peer-requested `scan-manifest`: same limits our own UI enforces before sending one. */
const peerScanManifestSchema = z.object({
  path: pathString,
  ignorePatterns: ignorePatternsSchema,
})

export function parsePeerScanManifest(request: unknown): { path: string; ignorePatterns: string[] } {
  const parsed = peerScanManifestSchema.safeParse(request)
  if (!parsed.success) throw new Error("The manifest request is invalid.")
  return parsed.data
}

/**
 * Pure peer/payload parsers, moved out of `index.ts` unchanged. Each takes an
 * untrusted value and either returns a fully typed result or throws a
 * user-presentable error; none touches module state, the filesystem, or the
 * network, which is what makes them safe to unit-test in isolation.
 */
export function validateConflictInput(input: ConflictInspectionInput): void {
  if (!input || typeof input.mappingId !== "string" || !input.mappingId || typeof input.path !== "string" || !input.path) {
    throw new Error("Choose a valid file conflict.")
  }
  if (input.mappingId.length > 200 || input.path.length > 4_096 || input.mappingId.includes("\0") || input.path.includes("\0")) {
    throw new Error("The selected file conflict is invalid.")
  }
}

export function parseConflictCopyExpectation(value: unknown): ConflictCopyExpectation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The inspected conflict copy is invalid.")
  }
  const candidate = value as Partial<ConflictCopyExpectation>
  if (
    typeof candidate.deviceId !== "string" || !candidate.deviceId || candidate.deviceId.length > 200 ||
    !isSha256HexDigest(candidate.digest) ||
    typeof candidate.size !== "number" || !Number.isSafeInteger(candidate.size) || candidate.size < 0
  ) {
    throw new Error("The inspected conflict copy is invalid.")
  }
  return { deviceId: candidate.deviceId, digest: candidate.digest, size: candidate.size }
}

export function parseResolveFileConflictInput(value: unknown): ResolveFileConflictInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Choose a valid file conflict.")
  }
  const candidate = value as Partial<ResolveFileConflictInput>
  const mappingId = candidate.mappingId
  const conflictPath = candidate.path
  if (typeof mappingId !== "string" || typeof conflictPath !== "string") {
    throw new Error("Choose a valid file conflict.")
  }
  validateConflictInput({ mappingId, path: conflictPath })
  if (typeof candidate.winnerDeviceId !== "string" || !candidate.winnerDeviceId) {
    throw new Error("Choose which computer's copy to keep.")
  }
  if (!Array.isArray(candidate.inspectedCopies) || candidate.inspectedCopies.length !== 2) {
    throw new Error("Refresh both conflict copies before choosing a version.")
  }
  const inspectedCopies = candidate.inspectedCopies.map(parseConflictCopyExpectation) as [
    ConflictCopyExpectation,
    ConflictCopyExpectation,
  ]
  if (
    inspectedCopies[0].deviceId === inspectedCopies[1].deviceId ||
    !inspectedCopies.some((copy) => copy.deviceId === candidate.winnerDeviceId)
  ) {
    throw new Error("The inspected conflict copies do not match this folder's participants.")
  }
  return {
    mappingId,
    path: conflictPath,
    winnerDeviceId: candidate.winnerDeviceId,
    inspectedCopies,
  }
}

export function requireUnchangedInspectedCopies(
  input: ResolveFileConflictInput,
  inspection: ConflictInspection,
): void {
  const expectedByDevice = new Map(input.inspectedCopies.map((copy) => [copy.deviceId, copy]))
  for (const copy of [inspection.local, inspection.remote]) {
    const expected = expectedByDevice.get(copy.deviceId)
    if (!expected || copy.digest !== expected.digest || copy.size !== expected.size) {
      throw new Error("One of the conflict copies changed since you reviewed it. Refresh both versions before choosing again.")
    }
  }
}

export interface PeerConflictCopy {
  present: boolean
  size?: number
  modifiedMs?: number
  digest?: string
  /** Only when the request asked for it and the copy is text; see `describeTextFile`. */
  textDigest?: string
}

export function parsePeerConflictCopy(value: unknown): PeerConflictCopy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The paired computer returned invalid conflict metadata.")
  }
  const candidate = value as Partial<PeerConflictCopy>
  if (typeof candidate.present !== "boolean") {
    throw new Error("The paired computer returned invalid conflict availability.")
  }
  if (!candidate.present) return { present: false }
  if (
    !Number.isSafeInteger(candidate.size) || (candidate.size ?? -1) < 0 ||
    !Number.isFinite(candidate.modifiedMs) ||
    !isSha256HexDigest(candidate.digest) ||
    (candidate.textDigest !== undefined && !isSha256HexDigest(candidate.textDigest))
  ) {
    throw new Error("The paired computer returned invalid conflict file metadata.")
  }
  return {
    present: true,
    size: candidate.size,
    modifiedMs: candidate.modifiedMs,
    digest: candidate.digest,
    ...(candidate.textDigest === undefined ? {} : { textDigest: candidate.textDigest }),
  }
}

export function parseExactConflictChoice(request: PeerRequest): ExactConflictChoice {
  const direction = request.direction
  const localDigest = request.localDigest
  const localSize = request.localSize
  const remoteDigest = request.remoteDigest
  const remoteSize = request.remoteSize
  if (
    (direction !== "pull-remote" && direction !== "push-local") ||
    !isSha256HexDigest(localDigest) ||
    typeof localSize !== "number" || !Number.isSafeInteger(localSize) || localSize < 0 ||
    !isSha256HexDigest(remoteDigest) ||
    typeof remoteSize !== "number" || !Number.isSafeInteger(remoteSize) || remoteSize < 0
  ) {
    throw new Error("The paired computer sent an invalid exact conflict choice.")
  }
  return {
    direction,
    localDigest,
    localSize,
    remoteDigest,
    remoteSize,
  }
}

export function isAllowedConflictDirection(mode: SyncMode, direction: FileSyncDirection): boolean {
  return !((direction === "push-local" && mode === "receive-only") || (direction === "pull-remote" && mode === "send-only"))
}

export function requireAllowedConflictDirection(mode: SyncMode, direction: FileSyncDirection): void {
  if (!isAllowedConflictDirection(mode, direction)) {
    throw new Error("That version conflicts with this folder's one-way direction.")
  }
}

export function validateTransferDescriptor(entry: FileManifest["files"][number], value: TransferFileDescriptor): void {
  if (
    !Number.isSafeInteger(value.size) ||
    value.size < 0 ||
    !Number.isFinite(value.modifiedMs) ||
    !isSha256HexDigest(value.digest)
  ) {
    throw new Error(`The peer returned invalid transfer metadata for ${entry.path}.`)
  }
  if (value.size !== entry.size || value.digest !== entry.digest) {
    throw new FileChangedError(`${entry.path} changed after the folders were compared. Retry the initial merge.`)
  }
}

/** A source's reply, to a requester that sent `reportUnavailable`, for a file that vanished or changed since the scan. */
export interface SourceUnavailableResponse {
  unavailable: true
}

export function isSourceUnavailableResponse(value: unknown): value is SourceUnavailableResponse {
  return value !== null && typeof value === "object" && (value as { unavailable?: unknown }).unavailable === true
}

const freeSpaceResponseSchema = z.object({ availableBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })

export function parseFreeSpaceResponse(value: unknown): number {
  const parsed = freeSpaceResponseSchema.safeParse(value)
  if (!parsed.success) throw new Error("The other computer reported its free space in an invalid form. Update Tethera on both computers and retry.")
  return parsed.data.availableBytes
}

/** Bounds shared by every persisted or peer-supplied skip list. */
export const MAX_PERSISTED_SKIP_ENTRIES = 10_000
export const MAX_PERSISTED_SKIP_PATH_LENGTH = 4_096
export const MAX_PERSISTED_SKIP_REASON_LENGTH = 1_024

export function isBoundedSkipArray(value: unknown): value is Array<{ path: string; reason: string }> {
  return Array.isArray(value) &&
    value.length <= MAX_PERSISTED_SKIP_ENTRIES &&
    value.every((item) =>
      item !== null && typeof item === "object" &&
      typeof (item as { path?: unknown }).path === "string" && (item as { path: string }).path.length <= MAX_PERSISTED_SKIP_PATH_LENGTH &&
      typeof (item as { reason?: unknown }).reason === "string" && (item as { reason: string }).reason.length <= MAX_PERSISTED_SKIP_REASON_LENGTH
    )
}

export function validateInitialSyncPassResult(value: unknown): InitialSyncPassResult {
  if (!value || typeof value !== "object") throw new Error("The peer returned an invalid initial-merge result.")
  const result = value as Partial<InitialSyncPassResult>
  if (
    typeof result.copiedFiles !== "number" || !Number.isSafeInteger(result.copiedFiles) || result.copiedFiles < 0 ||
    typeof result.copiedBytes !== "number" || !Number.isSafeInteger(result.copiedBytes) || result.copiedBytes < 0 ||
    typeof result.fileCount !== "number" || !Number.isSafeInteger(result.fileCount) || result.fileCount < 0 ||
    !isBoundedSkipArray(result.skipped) ||
    // Older peers do not report skipped inaccessible items; that is an empty
    // list, never an invalid result.
    (result.unreadableSkipped !== undefined && !isBoundedSkipArray(result.unreadableSkipped)) ||
    // Older peers omit the total; when present it must cover the retained sample.
    (result.skippedTotal !== undefined &&
      (typeof result.skippedTotal !== "number" || !Number.isSafeInteger(result.skippedTotal) || result.skippedTotal < result.skipped.length))
  ) {
    throw new Error("The peer returned an invalid initial-merge result.")
  }
  return {
    copiedFiles: result.copiedFiles,
    copiedBytes: result.copiedBytes,
    fileCount: result.fileCount,
    skipped: result.skipped,
    unreadableSkipped: result.unreadableSkipped ?? [],
    ...(result.skippedTotal !== undefined ? { skippedTotal: result.skippedTotal } : {}),
  }
}

export function validateContinuousOperationRequest(request: PeerRequest): {
  folderId: string
  path: string
  digest: string
  size: number
  expectedDestinationDigest?: string
} {
  const folderId = typeof request.folderId === "string" ? request.folderId : ""
  const relativePath = typeof request.path === "string" ? request.path : ""
  const digest = typeof request.digest === "string" ? request.digest : ""
  const size = typeof request.size === "number" ? request.size : Number.NaN
  const expectedDestinationDigest = peerExpectedDestinationDigest(request.expectedDestinationDigest)
  if (
    !folderId ||
    !relativePath ||
    isTetheraStagingPath(relativePath) ||
    !isSha256HexDigest(digest) ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    (expectedDestinationDigest !== undefined && !isSha256HexDigest(expectedDestinationDigest))
  ) {
    throw new Error("The continuous-sync file operation is invalid.")
  }
  return { folderId, path: relativePath, digest, size, expectedDestinationDigest }
}

/**
 * An absent destination digest means no file is expected there yet. Peers up
 * to 0.1.22 send it as `null`; any other non-string becomes "", which then
 * fails the digest check.
 */
function peerExpectedDestinationDigest(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  return typeof value === "string" ? value : ""
}

/** Matches the largest file list a sync check accepts, so a big change set is never refused. */
const MAX_PEER_OPERATIONS = 1_000_000

export function parsePeerFileOperations(value: unknown): PeerFileOperationIdentity[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The paired computer returned invalid durable operation state.")
  }
  const operations = (value as { operations?: unknown }).operations
  if (!Array.isArray(operations) || operations.length > MAX_PEER_OPERATIONS) {
    throw new Error("The paired computer returned invalid durable operation state.")
  }
  return operations.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("The paired computer returned an invalid durable operation.")
    }
    const operation = value as Partial<Omit<PeerFileOperationIdentity, "expectedDestinationDigest">>
    const expectedDestinationDigest = peerExpectedDestinationDigest((value as { expectedDestinationDigest?: unknown }).expectedDestinationDigest)
    if (
      typeof operation.id !== "number" || !Number.isSafeInteger(operation.id) || operation.id <= 0 ||
      typeof operation.path !== "string" || !operation.path || operation.path.length > 4_096 ||
      isTetheraStagingPath(operation.path) ||
      (operation.direction !== "pull-remote" && operation.direction !== "push-local") ||
      !isSha256HexDigest(operation.sourceDigest) ||
      typeof operation.sourceSize !== "number" || !Number.isSafeInteger(operation.sourceSize) || operation.sourceSize < 0 ||
      (expectedDestinationDigest !== undefined && !isSha256HexDigest(expectedDestinationDigest))
    ) {
      throw new Error("The paired computer returned an invalid durable operation.")
    }
    return {
      id: operation.id,
      path: operation.path,
      direction: operation.direction,
      sourceDigest: operation.sourceDigest,
      sourceSize: operation.sourceSize,
      expectedDestinationDigest,
    }
  })
}

export function validatePeerOperationId(request: PeerRequest): number {
  if (typeof request.operationId !== "number" || !Number.isSafeInteger(request.operationId) || request.operationId <= 0) {
    throw new Error("The continuous-sync operation identity is invalid.")
  }
  return request.operationId
}
