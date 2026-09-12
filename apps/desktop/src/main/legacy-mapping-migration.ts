import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { mkdir, open, readFile } from "node:fs/promises"
import path from "node:path"
import type { FolderMappingPreview, FolderSetupStatus, FolderSummary, SyncMode } from "../shared/contracts"
import { isFolderScanIssue, MAX_UNREADABLE_REPORTED } from "./folder-manifest"
import {
  mappingConfigurationFromLegacyFolder,
  type LegacyImportRecord,
  type LegacyImportRequest,
} from "./mapping-index"
import { syncDirectory } from "./fs-durability"

export type LegacyStateSource =
  | { kind: "missing"; document: Record<string, unknown>; modifiedAt: string }
  | { kind: "readable"; document: Record<string, unknown>; modifiedAt: string }
  | { kind: "unreadable"; detail: string }

export interface LegacyImportBuildOptions {
  localDeviceId: string
  localDeviceName: string
  importedAt: string
  remoteDeviceName(deviceId: string): string
}

export interface LegacyImportBundle {
  request: LegacyImportRequest
  backupPayload: Record<string, unknown>
  hadLegacyMappingFields: boolean
}

export class LegacyMappingValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LegacyMappingValidationError"
  }
}

export async function readLegacyState(statePath: string, now = new Date().toISOString()): Promise<LegacyStateSource> {
  try {
    const handle = await open(statePath, "r")
    let contents: string
    let metadata
    try {
      contents = await handle.readFile("utf8")
      metadata = await handle.stat()
    } finally {
      await handle.close()
    }
    const parsed: unknown = JSON.parse(contents)
    if (!isRecord(parsed)) throw new Error("state.json must contain a JSON object")
    return { kind: "readable", document: parsed, modifiedAt: metadata.mtime.toISOString() }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "missing", document: {}, modifiedAt: now }
    }
    return {
      kind: "unreadable",
      detail:
        error instanceof SyntaxError
          ? `state.json contains invalid JSON (${error.message})`
          : `state.json could not be read${(error as NodeJS.ErrnoException).code ? ` (${(error as NodeJS.ErrnoException).code})` : ""}`,
    }
  }
}

export function buildLegacyImportBundle(
  source: Exclude<LegacyStateSource, { kind: "unreadable" }>,
  options: LegacyImportBuildOptions,
): LegacyImportBundle {
  const rawFolders = source.document.folders
  if (rawFolders !== undefined && !Array.isArray(rawFolders)) {
    throw new LegacyMappingValidationError("Legacy mapping field folders must be an array.")
  }
  const folders = rawFolders ?? []
  const ids = new Set<string>()
  const records: LegacyImportRecord[] = folders.map((raw, index) => {
    const folder = parseLegacyFolder(raw, index)
    if (ids.has(folder.id)) {
      throw new LegacyMappingValidationError(`Legacy mappings contain duplicate id ${JSON.stringify(folder.id)}.`)
    }
    ids.add(folder.id)
    const remoteDeviceId = folder.remoteDeviceId
    if (!remoteDeviceId || remoteDeviceId === options.localDeviceId) {
      throw new LegacyMappingValidationError(
        `Legacy mapping ${JSON.stringify(folder.id)} does not identify a different paired device.`,
      )
    }
    const rawRecord = raw as Record<string, unknown>
    const createdAt = validTimestamp(rawRecord.createdAt) ?? source.modifiedAt
    const updatedAt =
      validTimestamp(rawRecord.updatedAt) ?? validTimestamp(folder.lastSyncedAt) ?? createdAt
    return {
      mapping: mappingConfigurationFromLegacyFolder(
        folder,
        remoteDeviceId,
        options.localDeviceId,
        options.localDeviceName,
        options.remoteDeviceName(remoteDeviceId),
        createdAt,
        updatedAt,
        previewForMapping(source.document, folder.id),
      ),
      pendingDeliveryTargetDeviceId: pendingTargetForMapping(source.document, folder.id, remoteDeviceId),
    }
  })
  const backupPayload = legacyBackupPayload(source.document)
  return {
    request: {
      sourceFingerprint: fingerprintLegacyPayload(backupPayload),
      importingDeviceId: options.localDeviceId,
      importedAt: options.importedAt,
      records,
    },
    backupPayload,
    hadLegacyMappingFields: Object.hasOwn(source.document, "folders"),
  }
}

export function legacyBackupPayload(document: Record<string, unknown>): Record<string, unknown> {
  const mappings = isRecord(document.mappings) ? document.mappings : {}
  return {
    format: "tethera-legacy-mapping-backup-v1",
    folders: Array.isArray(document.folders)
      ? document.folders.filter(isRecord).map(sanitiseLegacyFolderForBackup)
      : [],
    mappingRequests: {
      incoming: Array.isArray(mappings.incoming)
        ? mappings.incoming.filter(isRecord).map(sanitiseMappingRequestForBackup)
        : [],
      outgoing: Array.isArray(mappings.outgoing)
        ? mappings.outgoing.filter(isRecord).map(sanitiseMappingRequestForBackup)
        : [],
    },
  }
}

export function fingerprintLegacyPayload(payload: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex")
}

/** Writes a mapping-only, secret-free backup once and verifies its bytes before import. */
export async function ensureLegacyBackup(
  statePath: string,
  payload: Record<string, unknown>,
  fingerprint: string,
): Promise<string> {
  const directory = path.dirname(statePath)
  const backupPath = path.join(directory, `legacy-mappings-${fingerprint}.json`)
  const body = `${JSON.stringify(payload, null, 2)}\n`
  await mkdir(directory, { recursive: true })
  let created = false
  try {
    const handle = await open(backupPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    created = true
    try {
      await handle.writeFile(body, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
  if (created) await syncDirectory(directory)
  const verified = JSON.parse(await readFile(backupPath, "utf8")) as unknown
  if (!isRecord(verified) || fingerprintLegacyPayload(verified) !== fingerprint) {
    throw new Error("The legacy mapping backup could not be verified; migration was not started.")
  }
  return backupPath
}

/** Removes only active mapping ownership while preserving every unrelated state.json field. */
export function retireLegacyMappingFields(
  document: Record<string, unknown>,
  sourceFingerprint: string,
  backupFileName: string | null,
  retiredAt: string,
): Record<string, unknown> {
  const retired = { ...document }
  delete retired.folders
  if (isRecord(retired.mappings)) {
    const incoming = Array.isArray(retired.mappings.incoming) ? retired.mappings.incoming : []
    const outgoing = Array.isArray(retired.mappings.outgoing) ? retired.mappings.outgoing : []
    retired.mappings = {
      ...retired.mappings,
      // Durable active events and their pending acknowledgements now live in SQLite. Proposal
      // and rejection workflow state remains temporary desktop state.
      incoming: incoming.filter(
        (item) => !isRecord(item) || !["approved", "approved-awaiting-delivery"].includes(String(item.status)),
      ),
      outgoing: outgoing.filter((item) => !isRecord(item) || item.status !== "approved"),
    }
  }
  retired.mappingIndexMigration = {
    state: "completed",
    sourceFingerprint,
    retiredAt,
    ...(backupFileName ? { backupFileName } : {}),
  }
  return retired
}

function parseLegacyFolder(raw: unknown, index: number): FolderSummary {
  if (!isRecord(raw)) throw invalid(index, "record must be an object")
  const id = requiredString(raw.id, index, "id", 200)
  const name = requiredString(raw.name, index, "name", 200)
  const localPath = requiredString(raw.localPath, index, "localPath", 4_096)
  const remotePath = requiredString(raw.remotePath, index, "remotePath", 4_096)
  const remoteDeviceId = requiredString(raw.remoteDeviceId, index, "remoteDeviceId", 200)
  const mode = enumValue(raw.mode, ["two-way", "send-only", "receive-only"] as const, index, "mode")
  const paused = optionalBoolean(raw.paused, false, index, "paused")
  const setupStatus = enumValue(
    raw.setupStatus ?? "ready-for-initial-sync",
    ["pending-approval", "ready-for-initial-sync", "active"] as const,
    index,
    "setupStatus",
  )
  const ignorePatterns = optionalStringArray(raw.ignorePatterns, index, "ignorePatterns")
  const historyDays = optionalInteger(raw.historyDays, 30, 0, 3_650, index, "historyDays")
  const historyMaxBytes = optionalInteger(raw.historyMaxBytes, 10 * 1024 ** 3, 0, 2 ** 50, index, "historyMaxBytes")
  return {
    id,
    name,
    localPath,
    remotePath,
    remoteDeviceId,
    status: "offline",
    setupStatus: setupStatus as FolderSetupStatus,
    mode: mode as SyncMode,
    paused,
    ignorePatterns,
    historyDays,
    historyMaxBytes,
    ...(typeof raw.lastSyncedAt === "string" ? { lastSyncedAt: raw.lastSyncedAt } : {}),
  }
}

function previewForMapping(document: Record<string, unknown>, mappingId: string): FolderMappingPreview | null {
  const request = findMappingRequest(document, mappingId)
  const proposal = request && isRecord(request.proposal) ? request.proposal : null
  if (!proposal || proposal.preview === undefined) return null
  if (!isPreview(proposal.preview)) {
    throw new LegacyMappingValidationError(
      `Legacy mapping ${JSON.stringify(mappingId)} contains a malformed comparison preview.`,
    )
  }
  return proposal.preview
}

function pendingTargetForMapping(
  document: Record<string, unknown>,
  mappingId: string,
  remoteDeviceId: string,
): string | null {
  const mappings = isRecord(document.mappings) ? document.mappings : null
  const incoming = mappings && Array.isArray(mappings.incoming) ? mappings.incoming : []
  return incoming.some(
    (item) => isRecord(item) && item.id === mappingId && item.status === "approved-awaiting-delivery",
  )
    ? remoteDeviceId
    : null
}

function findMappingRequest(document: Record<string, unknown>, mappingId: string): Record<string, unknown> | null {
  const mappings = isRecord(document.mappings) ? document.mappings : null
  if (!mappings) return null
  for (const key of ["incoming", "outgoing"] as const) {
    const requests = Array.isArray(mappings[key]) ? mappings[key] : []
    const match = requests.find((item) => isRecord(item) && item.id === mappingId)
    if (isRecord(match)) return match
  }
  return null
}

function isPreview(value: unknown): value is FolderMappingPreview {
  if (!isRecord(value)) return false
  const numeric = [
    "localFiles",
    "remoteFiles",
    "identicalFiles",
    "differentFiles",
    "localOnlyFiles",
    "remoteOnlyFiles",
    "ignoredLocal",
    "ignoredRemote",
    "bytesToRemote",
    "bytesToLocal",
  ]
  return (
    numeric.every((key) => Number.isSafeInteger(value[key]) && (value[key] as number) >= 0) &&
    typeof value.truncated === "boolean" &&
    isBoundedPathArray(value.invalidWindowsNames) &&
    isBoundedPathArray(value.caseCollisions) &&
    Array.isArray(value.samples) &&
    value.samples.length <= 10_000 &&
    value.samples.every(
      (sample) =>
        isRecord(sample) &&
        isBoundedPath(sample.path) &&
        ["local-only", "remote-only", "different", "invalid-name", "case-collision"].includes(
          String(sample.category),
        ) &&
        (sample.size === undefined || (Number.isSafeInteger(sample.size) && (sample.size as number) >= 0)),
    ) &&
    // Optional scan-issue detail: a malformed value must fail validation here,
    // not throw later in `sanitisePreviewForBackup`.
    isOptionalScanIssueArray(value.unreadableLocal) &&
    isOptionalScanIssueArray(value.unreadableRemote) &&
    isOptionalScanIssueCount(value.unreadableLocalCount) &&
    isOptionalScanIssueCount(value.unreadableRemoteCount)
  )
}

/** One persisted scan issue, validated with the same rules as a peer-supplied report. */
function isOptionalScanIssueArray(value: unknown): boolean {
  return value === undefined || (
    Array.isArray(value) &&
    value.length <= MAX_UNREADABLE_REPORTED &&
    value.every(isFolderScanIssue)
  )
}

/** Totals are not capped like the detail list; they only have to be non-negative safe integers. */
function isOptionalScanIssueCount(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
}

function sanitiseLegacyFolderForBackup(folder: Record<string, unknown>): Record<string, unknown> {
  return pickKnownFields(folder, {
    strings: [
      "id",
      "name",
      "localPath",
      "remotePath",
      "remoteDeviceId",
      "setupStatus",
      "mode",
      "lastSyncedAt",
      "createdAt",
      "updatedAt",
    ],
    booleans: ["paused"],
    numbers: ["historyDays", "historyMaxBytes"],
    stringArrays: ["ignorePatterns"],
  })
}

function sanitiseMappingRequestForBackup(request: Record<string, unknown>): Record<string, unknown> {
  const sanitised = pickKnownFields(request, {
    strings: [
      "id",
      "fromDeviceId",
      "fromDeviceName",
      "toDeviceId",
      "toDeviceName",
      "status",
      "selectedDestinationPath",
      "message",
    ],
  })
  if (isRecord(request.proposal)) sanitised.proposal = sanitiseProposalForBackup(request.proposal)
  return sanitised
}

function sanitiseProposalForBackup(proposal: Record<string, unknown>): Record<string, unknown> {
  const sanitised = pickKnownFields(proposal, {
    strings: [
      "id",
      "name",
      "initiatorDeviceId",
      "initiatorDeviceName",
      "responderDeviceId",
      "initiatorPath",
      "responderPath",
      "mode",
      "createdAt",
    ],
    numbers: ["historyDays", "historyMaxBytes"],
    stringArrays: ["ignorePatterns"],
  })
  if (isPreview(proposal.preview)) sanitised.preview = sanitisePreviewForBackup(proposal.preview)
  return sanitised
}

function sanitisePreviewForBackup(preview: FolderMappingPreview): Record<string, unknown> {
  return {
    localFiles: preview.localFiles,
    remoteFiles: preview.remoteFiles,
    identicalFiles: preview.identicalFiles,
    differentFiles: preview.differentFiles,
    localOnlyFiles: preview.localOnlyFiles,
    remoteOnlyFiles: preview.remoteOnlyFiles,
    ignoredLocal: preview.ignoredLocal,
    ignoredRemote: preview.ignoredRemote,
    bytesToRemote: preview.bytesToRemote,
    bytesToLocal: preview.bytesToLocal,
    invalidWindowsNames: [...preview.invalidWindowsNames],
    caseCollisions: [...preview.caseCollisions],
    truncated: preview.truncated,
    samples: preview.samples.map((sample) => ({
      path: sample.path,
      category: sample.category,
      ...(sample.size === undefined ? {} : { size: sample.size }),
    })),
    ...(preview.unreadableLocal
      ? { unreadableLocal: preview.unreadableLocal.map((issue) => ({ path: issue.path, reason: issue.reason, kind: issue.kind })) }
      : {}),
    ...(preview.unreadableRemote
      ? { unreadableRemote: preview.unreadableRemote.map((issue) => ({ path: issue.path, reason: issue.reason, kind: issue.kind })) }
      : {}),
    ...(preview.unreadableLocalCount === undefined ? {} : { unreadableLocalCount: preview.unreadableLocalCount }),
    ...(preview.unreadableRemoteCount === undefined ? {} : { unreadableRemoteCount: preview.unreadableRemoteCount }),
  }
}

function pickKnownFields(
  source: Record<string, unknown>,
  fields: {
    strings?: string[]
    booleans?: string[]
    numbers?: string[]
    stringArrays?: string[]
  },
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const field of fields.strings ?? []) {
    if (typeof source[field] === "string") result[field] = source[field]
  }
  for (const field of fields.booleans ?? []) {
    if (typeof source[field] === "boolean") result[field] = source[field]
  }
  for (const field of fields.numbers ?? []) {
    if (typeof source[field] === "number") result[field] = source[field]
  }
  for (const field of fields.stringArrays ?? []) {
    if (Array.isArray(source[field])) {
      result[field] = (source[field] as unknown[]).filter((item): item is string => typeof item === "string")
    }
  }
  return result
}

function isBoundedPathArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 10_000 && value.every(isBoundedPath)
}

function isBoundedPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096 && !value.includes("\0")
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requiredString(
  value: unknown,
  index: number,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength || value.includes("\0")) {
    throw invalid(index, `${field} must be a non-empty NUL-free string of at most ${maxLength} characters`)
  }
  return value
}

function optionalBoolean(value: unknown, fallback: boolean, index: number, field: string): boolean {
  if (value === undefined) return fallback
  if (typeof value !== "boolean") throw invalid(index, `${field} must be a boolean`)
  return value
}

function optionalStringArray(value: unknown, index: number, field: string): string[] {
  if (value === undefined) return []
  if (
    !Array.isArray(value) ||
    value.length > 1_000 ||
    value.some((item) => typeof item !== "string" || item.length > 1_024 || item.includes("\0"))
  ) {
    throw invalid(index, `${field} must contain at most 1,000 bounded strings`)
  }
  return [...value]
}

function optionalInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  index: number,
  field: string,
): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw invalid(index, `${field} must be an integer between ${minimum} and ${maximum}`)
  }
  return value as number
}

function enumValue<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  index: number,
  field: string,
): T[number] {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw invalid(index, `${field} must be one of ${allowed.join(", ")}`)
  }
  return value
}

function validTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null
  return new Date(value).toISOString()
}

function invalid(index: number, detail: string): LegacyMappingValidationError {
  return new LegacyMappingValidationError(`Legacy mapping at index ${index} is malformed: ${detail}.`)
}
