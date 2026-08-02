import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { mkdir, open, rename, unlink } from "node:fs/promises"
import path from "node:path"
import type { ActivityEvent, AppSettings, MappingState } from "../shared/contracts"

export interface PersistedDesktopProjection {
  paused: boolean
  mappings: MappingState
  activity: ActivityEvent[]
  settings: AppSettings
}

const TRANSIENT_STATE_FIELDS = [
  "status",
  "route",
  "engineStatus",
  "engineMessage",
  "mappingStore",
  "peerName",
  "devices",
  "pairing",
  "update",
] as const

/** Builds the preference/proposal document without dropping unimported legacy mappings. */
export function buildPersistedDesktopState(
  current: Record<string, unknown>,
  projection: PersistedDesktopProjection,
  mappingOwnershipRetired: boolean,
): Record<string, unknown> {
  const persisted: Record<string, unknown> = {
    ...current,
    paused: projection.paused,
    mappings: projection.mappings,
    activity: projection.activity,
    settings: projection.settings,
  }
  for (const field of TRANSIENT_STATE_FIELDS) delete persisted[field]
  if (mappingOwnershipRetired) delete persisted.folders
  return persisted
}

type JsonWriter = (targetPath: string, document: Record<string, unknown>) => Promise<void>

/** Serializes state writes so every updater observes the last successfully committed document. */
export class DesktopStateStore {
  #document: Record<string, unknown>
  #writeTail: Promise<void> = Promise.resolve()

  constructor(
    readonly path: string,
    initialDocument: Record<string, unknown>,
    readonly writesEnabled: boolean,
    private readonly writer: JsonWriter = writeJsonAtomic,
  ) {
    this.#document = initialDocument
  }

  get document(): Record<string, unknown> {
    return this.#document
  }

  update(
    updater: (current: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!this.writesEnabled) {
      return Promise.reject(new Error("state.json is unreadable; refusing to overwrite it"))
    }
    const operation = this.#writeTail.then(async () => {
      const next = updater(this.#document)
      await this.writer(this.path, next)
      this.#document = next
      return next
    })
    this.#writeTail = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }
}

export async function writeJsonAtomic(targetPath: string, document: Record<string, unknown>): Promise<void> {
  const directory = path.dirname(targetPath)
  const temporaryPath = path.join(directory, `.${path.basename(targetPath)}.${randomUUID()}.tmp`)
  await mkdir(directory, { recursive: true })
  try {
    const handle = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporaryPath, targetPath)
    await syncDirectory(directory)
  } catch (error) {
    try {
      await unlink(temporaryPath)
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("[state] unable to remove an incomplete temporary state file", cleanupError)
      }
    }
    throw error
  }
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return
  const handle = await open(directory, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}
