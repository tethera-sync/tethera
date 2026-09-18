import { describe, expect, test } from "bun:test"
import {
  ADDITIVE_PLAN_PAGE_ENTRIES,
  blockedPathsFromScanIssues,
  continueAdditivePlan,
  MAX_INITIAL_MERGE_BLOCKED_PATHS,
  parseAdditivePlanPage,
  requestAdditivePlanPage,
  type AdditivePlanRequest,
  type AdditivePlanRpc,
} from "../src/main/initial-merge-plan"

interface RecordedCall {
  method: string
  params: Record<string, unknown>
}

function fakeRpc(pages: unknown[]): AdditivePlanRpc & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  let index = 0
  return {
    calls,
    async request<T>(method: string, params?: unknown): Promise<T> {
      calls.push({ method, params: params as Record<string, unknown> })
      const page = pages[Math.min(index, pages.length - 1)]
      index += 1
      return page as T
    },
  }
}

function request(overrides: Partial<AdditivePlanRequest> = {}): AdditivePlanRequest {
  return {
    mappingId: "mapping-1",
    localGenerationId: "gen-local",
    remoteGenerationId: "gen-remote",
    mode: "two-way",
    ignorePatterns: [],
    blockedPaths: [],
    checkCaseCollisions: false,
    ...overrides,
  }
}

const EMPTY_TOTALS = { additions: 0, additionBytes: 0, conflicts: 0, occupied: 0 }

describe("additive merge plan contract", () => {
  test("parses a page and defaults the collision sample", () => {
    const page = parseAdditivePlanPage({
      additions: [{ path: "a.txt", size: 4, digest: "a".repeat(64) }],
      conflicts: ["conflict.txt"],
      occupied: ["empty-dir"],
      nextCursor: "conflict.txt",
      totals: { ...EMPTY_TOTALS, additions: 1, additionBytes: 4, conflicts: 1, occupied: 1 },
    })
    expect(page.additions[0]?.path).toBe("a.txt")
    expect(page.conflicts).toEqual(["conflict.txt"])
    expect(page.occupied).toEqual(["empty-dir"])
    expect(page.nextCursor).toBe("conflict.txt")
    expect(page.totals?.caseCollisions).toEqual([])
  })

  test("rejects malformed or unknown page fields", () => {
    const base = { additions: [], conflicts: [], occupied: [] }
    expect(() => parseAdditivePlanPage({ ...base, extra: true })).toThrow("invalid additive merge plan")
    expect(() => parseAdditivePlanPage({ ...base, additions: [{ path: "a", size: 4, digest: "nope" }] })).toThrow("invalid additive merge plan")
    expect(() => parseAdditivePlanPage({ ...base, additions: [{ path: "a", size: -1, digest: "a".repeat(64) }] })).toThrow("invalid additive merge plan")
    expect(() => parseAdditivePlanPage({ ...base, additions: [{ path: "", size: 4, digest: "a".repeat(64) }] })).toThrow("invalid additive merge plan")
    expect(() => parseAdditivePlanPage({ ...base, nextCursor: "" })).toThrow("invalid additive merge plan")
    expect(() => parseAdditivePlanPage({ ...base, totals: { ...EMPTY_TOTALS, extra: 1 } })).toThrow("invalid additive merge plan")
    // The engine bounds its collision sample; a larger one is not trusted.
    expect(() =>
      parseAdditivePlanPage({
        ...base,
        totals: { ...EMPTY_TOTALS, caseCollisions: Array.from({ length: 11 }, (_value, index) => `a/${index} ↔ a/${index}`) },
      }),
    ).toThrow("invalid additive merge plan")
    expect(() => parseAdditivePlanPage("page")).toThrow("invalid additive merge plan")
  })

  test("refuses a page larger than the engine's bound", () => {
    const additions = Array.from({ length: 1_001 }, (_value, index) => ({
      path: `file-${index}.txt`,
      size: 1,
      digest: "a".repeat(64),
    }))
    expect(() => parseAdditivePlanPage({ additions, conflicts: [], occupied: [] })).toThrow("invalid additive merge plan")
  })

  test("accepts a case-collision description covering two full paths", () => {
    const description = `${"a".repeat(4_096)} ↔ ${"b".repeat(4_096)}`
    const page = parseAdditivePlanPage({
      additions: [],
      conflicts: [],
      occupied: [],
      totals: { ...EMPTY_TOTALS, caseCollisions: [description] },
    })
    expect(page.totals?.caseCollisions).toEqual([description])
  })

  test("sends the exact engine request and requires totals on the first page", async () => {
    const rpc = fakeRpc([{ additions: [], conflicts: [], occupied: [], totals: EMPTY_TOTALS }])
    await requestAdditivePlanPage(rpc, request({ blockedPaths: [{ path: "dir", directory: true }], checkCaseCollisions: true }))
    expect(rpc.calls[0]?.method).toBe("fileSync.planAdditiveGenerations")
    expect(rpc.calls[0]?.params).toMatchObject({
      mappingId: "mapping-1",
      localGenerationId: "gen-local",
      remoteGenerationId: "gen-remote",
      mode: "two-way",
      blockedPaths: [{ path: "dir", directory: true }],
      checkCaseCollisions: true,
      cursor: null,
      limit: ADDITIVE_PLAN_PAGE_ENTRIES,
    })

    const missingTotals = fakeRpc([{ additions: [], conflicts: [], occupied: [] }])
    await expect(requestAdditivePlanPage(missingTotals, request())).rejects.toThrow("without its totals")
  })

  test("refuses an oversized blocked-path list before it reaches the engine", async () => {
    const rpc = fakeRpc([{ additions: [], conflicts: [], occupied: [], totals: EMPTY_TOTALS }])
    const blockedPaths = Array.from({ length: MAX_INITIAL_MERGE_BLOCKED_PATHS + 1 }, (_value, index) => ({
      path: `unreadable-${index}`,
      directory: false,
    }))
    await expect(requestAdditivePlanPage(rpc, request({ blockedPaths }))).rejects.toThrow("blocked-path bound")
    expect(rpc.calls).toHaveLength(0)
  })
})

describe("blocked merge paths from scan issues", () => {
  test("maps file and directory issues and drops an empty file path", () => {
    const blocked = blockedPathsFromScanIssues("This computer", [
      { path: "a.txt", reason: "denied", kind: "file" },
      { path: "private", reason: "denied", kind: "directory" },
      { path: "", reason: "root unreadable", kind: "file" },
      { path: "x".repeat(4_097), reason: "too long", kind: "directory" },
    ])
    expect(blocked).toEqual([
      { path: "a.txt", directory: false },
      { path: "private", directory: true },
    ])
  })

  test("fails closed on an unreadable folder root instead of blocking every addition", () => {
    expect(() =>
      blockedPathsFromScanIssues("This computer", [{ path: "", reason: "root unreadable", kind: "directory" }]),
    ).toThrow("folder root could not be read")
  })

  test("fails closed above the engine's bound", () => {
    const issues = Array.from({ length: MAX_INITIAL_MERGE_BLOCKED_PATHS + 1 }, (_value, index) => ({
      path: `unreadable-${index}`,
      reason: "denied",
      kind: "file" as const,
    }))
    expect(() => blockedPathsFromScanIssues("This computer", issues)).toThrow("more than the initial merge can plan around safely")
  })
})

describe("additive merge plan paging", () => {
  test("streams the remaining pages in cursor order", async () => {
    const rpc = fakeRpc([
      { additions: [{ path: "b.txt", size: 1, digest: "b".repeat(64) }], conflicts: [], occupied: [], nextCursor: "a.txt", totals: EMPTY_TOTALS },
      { additions: [{ path: "c.txt", size: 1, digest: "c".repeat(64) }], conflicts: [], occupied: [] },
    ])
    const first = await requestAdditivePlanPage(rpc, request())
    const pages = [first]
    for await (const page of continueAdditivePlan(rpc, request(), first, { timeoutMs: 1_000 })) {
      pages.push(page)
    }
    expect(pages.map((page) => page.additions[0]?.path)).toEqual(["b.txt", "c.txt"])
    expect(rpc.calls[1]?.params.cursor).toBe("a.txt")
  })

  test("fails closed when the engine repeats a cursor", async () => {
    const rpc = fakeRpc([
      { additions: [], conflicts: [], occupied: [], nextCursor: "a.txt", totals: EMPTY_TOTALS },
      { additions: [], conflicts: [], occupied: [], nextCursor: "a.txt" },
    ])
    const first = await requestAdditivePlanPage(rpc, request())
    const pages = continueAdditivePlan(rpc, request(), first)
    await expect(pages.next()).rejects.toThrow("does not advance")
  })

  test("stops without another request when the first page is complete", async () => {
    const rpc = fakeRpc([{ additions: [], conflicts: [], occupied: [], totals: EMPTY_TOTALS }])
    const first = await requestAdditivePlanPage(rpc, request())
    const pages = continueAdditivePlan(rpc, request(), first)
    expect(await pages.next()).toEqual({ done: true, value: undefined })
    expect(rpc.calls).toHaveLength(1)
  })
})
