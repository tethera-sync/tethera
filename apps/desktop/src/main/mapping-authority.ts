import path from "node:path"
import {
  buildLegacyImportBundle,
  canonicalJson,
  ensureLegacyBackup,
  retireLegacyMappingFields,
  type LegacyStateSource,
} from "./legacy-mapping-migration"
import { writeJsonAtomic } from "./desktop-state-storage"
import type {
  LegacyImportOutcome,
  LegacyMigrationStatus,
  MappingRecord,
} from "./mapping-index"

export interface MappingRpcClient {
  request<T>(method: string, params?: unknown): Promise<T>
}

export interface MappingAuthorityOptions {
  rpc: MappingRpcClient
  statePath: string
  legacySource: LegacyStateSource
  localDeviceId: string
  localDeviceName: string
  remoteDeviceName(deviceId: string): string
  now?: string
  retireLegacyState?(request: LegacyStateRetirement): Promise<Record<string, unknown>>
}

export interface LegacyStateRetirement {
  sourceFingerprint: string
  backupFileName: string | null
  retiredAt: string
}

export interface MappingAuthorityResult {
  records: MappingRecord[]
  migration: LegacyMigrationStatus
  stateDocument: Record<string, unknown> | null
  cleanupWarning?: string
}

export class MappingAuthorityInitializationError extends Error {
  constructor(
    message: string,
    readonly migrationState: "pending" | "failed",
  ) {
    super(message)
    this.name = "MappingAuthorityInitializationError"
  }
}

/**
 * Opens the one-time authority gate. A legacy snapshot is imported as one Rust transaction and
 * is retired only after the committed SQLite records have been read back and compared.
 */
export async function initializeMappingAuthority(
  options: MappingAuthorityOptions,
): Promise<MappingAuthorityResult> {
  const now = options.now ?? new Date().toISOString()
  let migration = await options.rpc.request<LegacyMigrationStatus>("mapping.getMigrationStatus")

  if (migration.state === "completed") {
    const records = await options.rpc.request<MappingRecord[]>("mapping.list")
    return await finishPreviouslyCommittedMigration(options, records, migration, now)
  }

  if (options.legacySource.kind === "unreadable") {
    const detail = `Legacy mapping import is blocked because ${options.legacySource.detail}`
    migration = await recordMigrationFailure(options.rpc, detail, migration)
    throw new MappingAuthorityInitializationError(detail, migration.state === "failed" ? "failed" : "pending")
  }

  let bundle
  try {
    bundle = buildLegacyImportBundle(options.legacySource, {
      localDeviceId: options.localDeviceId,
      localDeviceName: options.localDeviceName,
      importedAt: now,
      remoteDeviceName: options.remoteDeviceName,
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Legacy mapping validation failed."
    migration = await recordMigrationFailure(options.rpc, detail, migration)
    throw new MappingAuthorityInitializationError(detail, migration.state === "failed" ? "failed" : "pending")
  }

  let backupPath: string | null = null
  if (bundle.hadLegacyMappingFields) {
    try {
      backupPath = await ensureLegacyBackup(
        options.statePath,
        bundle.backupPayload,
        bundle.request.sourceFingerprint,
      )
    } catch (error) {
      const detail = error instanceof Error ? error.message : "The legacy mapping backup failed."
      migration = await recordMigrationFailure(options.rpc, detail, migration)
      throw new MappingAuthorityInitializationError(detail, migration.state === "failed" ? "failed" : "pending")
    }
  }

  const outcome = await options.rpc.request<LegacyImportOutcome>("mapping.importLegacy", bundle.request)
  migration = outcome.status
  if (migration.state !== "completed") {
    throw new MappingAuthorityInitializationError(
      "The authoritative mapping transaction did not report completion.",
      migration.state === "failed" ? "failed" : "pending",
    )
  }

  const records = await options.rpc.request<MappingRecord[]>("mapping.list")
  verifyImportedRecords(records, bundle.request.records.map((record) => record.mapping))

  let stateDocument: Record<string, unknown> | null = options.legacySource.document
  if (bundle.hadLegacyMappingFields) {
    stateDocument = await retireLegacyState(options, {
      sourceFingerprint: bundle.request.sourceFingerprint,
      backupFileName: backupPath ? path.basename(backupPath) : null,
      retiredAt: now,
    })
  }

  return { records, migration, stateDocument }
}

async function finishPreviouslyCommittedMigration(
  options: MappingAuthorityOptions,
  records: MappingRecord[],
  migration: LegacyMigrationStatus,
  now: string,
): Promise<MappingAuthorityResult> {
  if (options.legacySource.kind === "unreadable") {
    return {
      records,
      migration,
      stateDocument: null,
      cleanupWarning: "SQLite is authoritative, but state.json could not be read for legacy-field cleanup.",
    }
  }
  if (!Object.hasOwn(options.legacySource.document, "folders")) {
    return { records, migration, stateDocument: options.legacySource.document }
  }

  let bundle
  try {
    bundle = buildLegacyImportBundle(options.legacySource, {
      localDeviceId: options.localDeviceId,
      localDeviceName: options.localDeviceName,
      importedAt: migration.completedAt ?? now,
      remoteDeviceName: options.remoteDeviceName,
    })
  } catch {
    return {
      records,
      migration,
      stateDocument: options.legacySource.document,
      cleanupWarning: "SQLite is authoritative; malformed leftover legacy mapping fields were retained for manual recovery.",
    }
  }

  if (migration.sourceFingerprint !== bundle.request.sourceFingerprint) {
    return {
      records,
      migration,
      stateDocument: options.legacySource.document,
      cleanupWarning: "SQLite is authoritative; changed legacy mapping fields were not imported or removed.",
    }
  }

  verifyImportedRecords(records, bundle.request.records.map((record) => record.mapping))
  const backupPath = await ensureLegacyBackup(
    options.statePath,
    bundle.backupPayload,
    bundle.request.sourceFingerprint,
  )
  const stateDocument = await retireLegacyState(options, {
    sourceFingerprint: bundle.request.sourceFingerprint,
    backupFileName: path.basename(backupPath),
    retiredAt: now,
  })
  return { records, migration, stateDocument }
}

async function retireLegacyState(
  options: MappingAuthorityOptions,
  request: LegacyStateRetirement,
): Promise<Record<string, unknown>> {
  if (options.retireLegacyState) return await options.retireLegacyState(request)
  const retired = retireLegacyMappingFields(
    options.legacySource.kind === "unreadable" ? {} : options.legacySource.document,
    request.sourceFingerprint,
    request.backupFileName,
    request.retiredAt,
  )
  await writeJsonAtomic(options.statePath, retired)
  return retired
}

function verifyImportedRecords(
  records: MappingRecord[],
  intended: MappingRecord["mapping"][],
): void {
  const actualById = new Map(records.map((record) => [record.mapping.id, record.mapping]))
  if (actualById.size !== intended.length) {
    throw new Error("The committed mapping count did not match the complete legacy snapshot; state.json was not cleaned up.")
  }
  for (const mapping of intended) {
    const actual = actualById.get(mapping.id)
    if (!actual || canonicalJson(actual) !== canonicalJson(mapping)) {
      throw new Error(
        `The committed mapping ${JSON.stringify(mapping.id)} did not match its legacy source; state.json was not cleaned up.`,
      )
    }
  }
}

async function recordMigrationFailure(
  rpc: MappingRpcClient,
  detail: string,
  fallback: LegacyMigrationStatus,
): Promise<LegacyMigrationStatus> {
  try {
    return await rpc.request<LegacyMigrationStatus>("mapping.recordMigrationFailure", { detail })
  } catch {
    return fallback
  }
}
