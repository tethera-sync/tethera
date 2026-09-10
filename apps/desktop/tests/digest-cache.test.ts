import { describe, expect, test } from "bun:test"
import { DIGEST_CACHE_DEEP_VERIFY_MS, DigestCacheVerifier, EngineScanDigestCache, type DigestCacheRpc } from "../src/main/digest-cache"

const identity = {
  device: "66306",
  inode: "18446744073709551615",
  size: 4,
  modifiedNs: "-1500000000",
  changedNs: "1789048883261853018",
  digest: "a".repeat(64),
}

function fakeRpc(respond: (method: string, params: unknown) => unknown = () => ({})) {
  const calls: Array<{ method: string; params: unknown }> = []
  const rpc: DigestCacheRpc = {
    async request<T>(method: string, params?: unknown): Promise<T> {
      calls.push({ method, params })
      // The adapter only ever asks for `unknown`; the fake answers as the engine would.
      return respond(method, params) as T
    },
  }
  return { rpc, calls }
}

function paramsOf(call: { params: unknown } | undefined): Record<string, unknown> {
  const params = call?.params
  if (typeof params !== "object" || params === null) throw new Error("expected RPC params")
  return Object.fromEntries(Object.entries(params))
}

describe("engine digest cache", () => {
  test("returns requested, well-formed entries and nothing for unknown paths", async () => {
    const { rpc, calls } = fakeRpc(() => ({ entries: [{ path: "a.txt", ...identity }] }))
    const found = await new EngineScanDigestCache(rpc, "mapping-1", { deep: false }).lookup(["a.txt", "b.txt"])
    expect(calls).toEqual([{ method: "digestCache.lookup", params: { mappingId: "mapping-1", paths: ["a.txt", "b.txt"] } }])
    expect(found.get("a.txt")).toEqual(identity)
    expect(found.has("b.txt")).toBe(false)
  })

  test("trusts nothing from a response that is malformed, names unrequested paths, or repeats one", async () => {
    const responses: unknown[] = [
      { entries: [{ path: "a.txt", ...identity, inode: "12a" }] },
      { entries: [{ path: "a.txt", ...identity, digest: "not-a-digest" }] },
      { entries: [{ path: "a.txt", ...identity }, { path: "elsewhere.txt", ...identity }] },
      { entries: [{ path: "a.txt", ...identity }, { path: "a.txt", ...identity, inode: "7" }] },
    ]
    for (const response of responses) {
      const { rpc } = fakeRpc(() => response)
      const found = await new EngineScanDigestCache(rpc, "mapping-1", { deep: false }).lookup(["a.txt"])
      expect(found.size).toBe(0)
    }
  })

  test("a failed lookup falls back to hashing instead of failing the scan", async () => {
    const { rpc } = fakeRpc(() => {
      throw new Error("engine restarting")
    })
    const found = await new EngineScanDigestCache(rpc, "mapping-1", { deep: false }).lookup(["a.txt"])
    expect(found.size).toBe(0)
  })

  test("a deep sweep looks nothing up", async () => {
    const { rpc, calls } = fakeRpc()
    const found = await new EngineScanDigestCache(rpc, "mapping-1", { deep: true }).lookup(["a.txt"])
    expect(found.size).toBe(0)
    expect(calls).toHaveLength(0)
  })

  test("records flush in engine-sized batches under one sweep id and an ordinary sweep never prunes", async () => {
    const { rpc, calls } = fakeRpc()
    const cache = new EngineScanDigestCache(rpc, "mapping-1", { deep: false })
    for (let index = 0; index < 2_500; index += 1) cache.record(`file-${index}.txt`, identity)
    await cache.finish({ complete: true })
    const records = calls.filter((call) => call.method === "digestCache.record").map(paramsOf)
    expect(records.map((params) => (Array.isArray(params.entries) ? params.entries.length : -1))).toEqual([1_000, 1_000, 500])
    expect(new Set(records.map((params) => params.sweepId)).size).toBe(1)
    expect(calls.some((call) => call.method === "digestCache.prune")).toBe(false)
  })

  test("only a complete deep sweep whose records all landed prunes, keeping its own sweep", async () => {
    const complete = fakeRpc()
    const deep = new EngineScanDigestCache(complete.rpc, "mapping-1", { deep: true })
    deep.record("a.txt", identity)
    await deep.finish({ complete: true })
    const recordedSweep = paramsOf(complete.calls.find((call) => call.method === "digestCache.record")).sweepId
    expect(paramsOf(complete.calls.find((call) => call.method === "digestCache.prune"))).toEqual({ mappingId: "mapping-1", keepSweepId: recordedSweep })

    const truncated = fakeRpc()
    const partial = new EngineScanDigestCache(truncated.rpc, "mapping-1", { deep: true })
    partial.record("a.txt", identity)
    await partial.finish({ complete: false })
    expect(truncated.calls.some((call) => call.method === "digestCache.prune")).toBe(false)

    const failing = fakeRpc((method) => {
      if (method === "digestCache.record") throw new Error("database busy")
      return {}
    })
    const lost = new EngineScanDigestCache(failing.rpc, "mapping-1", { deep: true })
    lost.record("a.txt", identity)
    await lost.finish({ complete: true })
    expect(failing.calls.some((call) => call.method === "digestCache.prune")).toBe(false)
  })
})

describe("digest cache verifier", () => {
  test("the first sweep after launch is deep, then one at least every day", () => {
    const verifier = new DigestCacheVerifier()
    const start = Date.UTC(2026, 8, 11)
    expect(verifier.requiresDeepSweep("mapping-1", start)).toBe(true)
    verifier.completedDeepSweep("mapping-1", start)
    expect(verifier.requiresDeepSweep("mapping-1", start + 60 * 60 * 1_000)).toBe(false)
    expect(verifier.requiresDeepSweep("mapping-2", start)).toBe(true)
    expect(verifier.requiresDeepSweep("mapping-1", start + DIGEST_CACHE_DEEP_VERIFY_MS)).toBe(true)
  })
})
