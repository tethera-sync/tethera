import { z } from "zod"
import type { FolderScanIssue, SyncMode } from "../shared/contracts"

/**
 * TypeScript mirror of the engine's read-only additive merge plan. Every value
 * the engine returns across that boundary is validated here before it can plan
 * a copy; a compile-time type on one side never validates the runtime payload
 * on the other.
 */

export const ADDITIVE_PLAN_MAX_PAGE = 1_000
export const ADDITIVE_PLAN_PAGE_ENTRIES = 500
/** Matches the engine's bound; a larger local report fails the pass closed. */
export const MAX_INITIAL_MERGE_BLOCKED_PATHS = 10_000

/** One destination path the merge must not write to because it could not be read. */
export interface AdditivePlanBlockedPath {
  path: string
  directory: boolean
}

export interface AdditivePlanAddition {
  path: string
  size: number
  digest: string
}

/** Exact whole-plan totals, present only on the first page (no cursor). */
export interface AdditivePlanTotals {
  additions: number
  additionBytes: number
  conflicts: number
  occupied: number
  /** Bounded case-only alias samples; empty unless the plan asked for them. */
  caseCollisions: string[]
}

export interface AdditivePlanPage {
  additions: AdditivePlanAddition[]
  conflicts: string[]
  occupied: string[]
  nextCursor?: string
  totals?: AdditivePlanTotals
}

export interface AdditivePlanRequest {
  mappingId: string
  /** The receiving computer's sealed generation. */
  localGenerationId: string
  /** The sending computer's sealed generation. */
  remoteGenerationId: string
  mode: SyncMode
  ignorePatterns: string[]
  blockedPaths: AdditivePlanBlockedPath[]
  checkCaseCollisions: boolean
}

/** Narrow engine RPC surface, so callers can drive planning without a child process. */
export interface AdditivePlanRpc {
  request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T>
}

/**
 * Converts one computer's complete scan-issue report into destination block
 * paths for the plan: a file blocks exactly its path, a directory blocks
 * itself and everything beneath it, and a root directory issue fails the plan
 * instead of blocking the tree.
 *
 * An unreadable folder root means nothing could be enumerated, so every
 * addition would be blocked and both plan directions would look converged
 * without copying anything. That silent no-op is never a merge, so it fails
 * closed. An empty file path can never match a relative path and is dropped.
 *
 * An over-long path is dropped too: every staged plan path is within the
 * engine's 4096-byte bound, so such a path can neither equal a plan path nor
 * be an ancestor of one (an ancestor is always shorter), and keeping it would
 * only make the engine reject the whole request.
 */
export function blockedPathsFromScanIssues(
  computer: string,
  issues: readonly FolderScanIssue[],
): AdditivePlanBlockedPath[] {
  if (issues.length > MAX_INITIAL_MERGE_BLOCKED_PATHS) {
    throw new Error(
      `${computer} has ${issues.length.toLocaleString("en-GB")} unreadable items, more than the initial merge can plan around safely. Fix access or add ignore rules, then retry.`,
    )
  }
  const blocked: AdditivePlanBlockedPath[] = []
  for (const issue of issues) {
    if (issue.path === "") {
      if (issue.kind === "file") continue
      throw new Error(`${computer}'s folder root could not be read, so the merge cannot be planned safely. Fix access to the folder, then retry.`)
    }
    if (Buffer.byteLength(issue.path, "utf8") > 4_096) continue
    blocked.push({ path: issue.path, directory: issue.kind === "directory" })
  }
  return blocked
}

const planPathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => !value.includes("\0"), "plan path must be NUL-free")

/**
 * One collision description holds two full prefixed paths plus the ` ↔ `
 * separator. A staged path is at most 4096 bytes and never more UTF-16 code
 * units, so this covers the engine's largest sample.
 */
const MAX_CASE_COLLISION_DESCRIPTION_CHARS = 4_096 * 2 + 16

const additionSchema = z
  .object({
    path: planPathSchema,
    size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()

const totalsSchema = z
  .object({
    additions: z.number().int().nonnegative().max(1_000_000),
    additionBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    conflicts: z.number().int().nonnegative().max(1_000_000),
    occupied: z.number().int().nonnegative().max(1_000_000),
    caseCollisions: z.array(z.string().max(MAX_CASE_COLLISION_DESCRIPTION_CHARS)).max(10).optional(),
  })
  .strict()

const pageSchema = z
  .object({
    additions: z.array(additionSchema).max(ADDITIVE_PLAN_MAX_PAGE),
    conflicts: z.array(planPathSchema).max(ADDITIVE_PLAN_MAX_PAGE),
    occupied: z.array(planPathSchema).max(ADDITIVE_PLAN_MAX_PAGE),
    nextCursor: planPathSchema.optional(),
    // Totals accompany only the first page; the caller requires them there.
    totals: totalsSchema.optional(),
  })
  .strict()

export function parseAdditivePlanPage(value: unknown): AdditivePlanPage {
  const parsed = pageSchema.safeParse(value)
  if (!parsed.success) throw new Error("The engine returned an invalid additive merge plan.")
  return {
    additions: parsed.data.additions,
    conflicts: parsed.data.conflicts,
    occupied: parsed.data.occupied,
    ...(parsed.data.nextCursor !== undefined ? { nextCursor: parsed.data.nextCursor } : {}),
    ...(parsed.data.totals !== undefined
      ? {
          totals: {
            additions: parsed.data.totals.additions,
            additionBytes: parsed.data.totals.additionBytes,
            conflicts: parsed.data.totals.conflicts,
            occupied: parsed.data.totals.occupied,
            caseCollisions: parsed.data.totals.caseCollisions ?? [],
          },
        }
      : {}),
  }
}

interface PlanPageOptions {
  cursor?: string
  limit?: number
  timeoutMs?: number
}

export async function requestAdditivePlanPage(
  rpc: AdditivePlanRpc,
  request: AdditivePlanRequest,
  options: PlanPageOptions = {},
): Promise<AdditivePlanPage> {
  const limit = options.limit ?? ADDITIVE_PLAN_PAGE_ENTRIES
  if (limit <= 0 || limit > ADDITIVE_PLAN_MAX_PAGE) throw new Error("The additive plan page size is invalid.")
  if (request.blockedPaths.length > MAX_INITIAL_MERGE_BLOCKED_PATHS) {
    throw new Error("The additive merge plan exceeds the supported blocked-path bound.")
  }
  const raw = await rpc.request<unknown>("fileSync.planAdditiveGenerations", {
    mappingId: request.mappingId,
    localGenerationId: request.localGenerationId,
    remoteGenerationId: request.remoteGenerationId,
    mode: request.mode,
    ignorePatterns: request.ignorePatterns,
    blockedPaths: request.blockedPaths,
    checkCaseCollisions: request.checkCaseCollisions,
    cursor: options.cursor ?? null,
    limit,
  }, options.timeoutMs)
  const page = parseAdditivePlanPage(raw)
  if (options.cursor === undefined && page.totals === undefined) {
    throw new Error("The engine returned an additive merge plan without its totals.")
  }
  return page
}

/**
 * Streams the rest of a plan whose first page was already read, so a caller
 * can inspect the totals before consuming the remaining pages. The cursor must
 * advance strictly in byte order, matching the engine's `BINARY` path
 * ordering; a repeated or regressing cursor fails closed rather than looping.
 */
export async function* continueAdditivePlan(
  rpc: AdditivePlanRpc,
  request: AdditivePlanRequest,
  firstPage: AdditivePlanPage,
  options: { limit?: number; timeoutMs?: number; signal?: AbortSignal | null } = {},
): AsyncGenerator<AdditivePlanPage, void, void> {
  let cursor = firstPage.nextCursor
  while (cursor) {
    if (options.signal?.aborted) throw new Error("The merge was cancelled.")
    const page = await requestAdditivePlanPage(rpc, request, {
      cursor,
      limit: options.limit,
      timeoutMs: options.timeoutMs,
    })
    const next = page.nextCursor
    if (next !== undefined && Buffer.compare(Buffer.from(next), Buffer.from(cursor)) <= 0) {
      throw new Error("The engine returned an additive merge plan that does not advance.")
    }
    yield page
    cursor = next
  }
}
