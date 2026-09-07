import { z } from "zod"
import { isSha256HexDigest } from "./file-transfer"
import type { ArchiveHistory, ArchivedVersion } from "../shared/contracts"

export const ARCHIVE_HISTORY_LIMIT = 200

export interface ArchiveHistoryRpc {
  request<T>(method: string, params?: unknown): Promise<T>
}

const sha256DigestSchema = z.string().refine(isSha256HexDigest, "The archive version history is invalid.")

const archiveHistoryEntrySchema = z.object({
  id: z.string().min(1),
  mappingId: z.string().min(1),
  path: z.string().min(1),
  kind: z.enum(["sync", "restore"]),
  syncOperationId: z.number().int().positive().nullable().optional(),
  oldDigest: z.union([sha256DigestSchema, z.null()]).optional(),
  oldSize: z.number().int().nonnegative().nullable().optional(),
  replacementDigest: sha256DigestSchema,
  replacementSize: z.number().int().nonnegative(),
  archiveDigest: z.union([sha256DigestSchema, z.null()]).optional(),
  archiveObjectKey: z.union([z.string().min(1), z.null()]).optional(),
  restoredFromJournalId: z.union([z.string().min(1), z.null()]).optional(),
  state: z.enum(["planned", "archived", "installed", "completed", "aborted", "recovery-required", "integrity-failed"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable().optional(),
  lastError: z.string().nullable().optional(),
  localRoot: z.string().min(1),
  archiveState: z.enum(["available", "missing", "corrupt"]).nullable().optional(),
  archiveVerifiedAt: z.string().nullable().optional(),
  archiveError: z.string().nullable().optional(),
})

const archiveHistoryResponseSchema = z.array(archiveHistoryEntrySchema)
type ArchiveHistoryEntryState = z.infer<typeof archiveHistoryEntrySchema>["state"]

function toUnavailableReason(
  availability: ArchivedVersion["availability"],
  state: ArchiveHistoryEntryState,
  archiveObjectKey: string | null | undefined,
  archiveDigest: string | null | undefined,
): string | undefined {
  if (availability === "missing") {
    return "The archived content is missing."
  }
  if (availability === "corrupt") {
    return "The archived content is corrupt."
  }
  switch (state) {
    case "recovery-required":
    case "integrity-failed":
      return "This replacement needs recovery before its archived version can be restored."
    case "planned":
    case "archived":
    case "installed":
      return "This replacement is still in progress."
    case "completed":
    case "aborted":
      break
  }
  if (archiveObjectKey == null || archiveDigest == null) {
    return "The archived content could not be verified."
  }
  return undefined
}

function mapArchivedVersion(entry: z.infer<typeof archiveHistoryEntrySchema>): ArchivedVersion | undefined {
  if (entry.oldSize == null) return undefined
  const availability = entry.archiveState ?? "missing"
  const restorable =
    availability === "available" &&
    (entry.state === "completed" || entry.state === "aborted") &&
    entry.archiveObjectKey != null &&
    entry.archiveDigest != null
  const unavailableReason = restorable
    ? undefined
    : toUnavailableReason(availability, entry.state, entry.archiveObjectKey, entry.archiveDigest)
  return {
    entryId: entry.id,
    path: entry.path,
    archivedAt: entry.createdAt,
    replacedSize: entry.oldSize,
    replacementSize: entry.replacementSize,
    origin: entry.kind,
    availability,
    restorable,
    unavailableReason,
  }
}

/**
 * Lists archived versions for one mapping. One extra row is requested so truncation can be
 * detected, and the returned model deliberately omits archive roots, object keys, and digests so
 * the renderer never receives them.
 */
export async function listArchivedVersions(
  rpc: ArchiveHistoryRpc,
  mappingId: string,
  folderName: string,
  limit?: number,
): Promise<ArchiveHistory> {
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) {
    throw new Error("The archive history limit is invalid.")
  }
  const effectiveLimit = limit ?? ARCHIVE_HISTORY_LIMIT
  const response = await rpc.request<unknown>("archive.listVersions", { id: mappingId, limit: effectiveLimit + 1 })
  const parsed = archiveHistoryResponseSchema.safeParse(response)
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0]
    const path = firstIssue.path.length > 0 ? `versions.${firstIssue.path.join(".")}` : "versions"
    throw new Error(`The archive version history could not be read (invalid field "${path}": ${firstIssue.code}).`)
  }
  const truncated = parsed.data.length > effectiveLimit
  const versions = parsed.data
    .slice(0, effectiveLimit)
    .map(mapArchivedVersion)
    .filter((version): version is ArchivedVersion => version !== undefined)
  return {
    mappingId,
    folderName,
    versions,
    truncated,
  }
}
