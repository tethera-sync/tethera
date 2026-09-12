import { describe, expect, test } from "bun:test"
import type { CachedFileDigest } from "../src/main/folder-manifest"
import { ScanReuseStore } from "../src/main/scan-reuse-store"

function digest(seed: number): CachedFileDigest {
  return {
    device: "1",
    inode: String(seed),
    size: 1,
    modifiedNs: String(seed),
    changedNs: String(seed),
    digest: String(seed).padStart(64, "0"),
  }
}

function entries(count: number, prefix = "f"): Map<string, CachedFileDigest> {
  return new Map(Array.from({ length: count }, (_, index) => [`${prefix}${index}`, digest(index)]))
}

describe("ScanReuseStore", () => {
  test("returns seeded digests only for the exact root and rules", () => {
    const store = new ScanReuseStore()
    const seeded = entries(3)
    store.remember("/tmp/root", ["*.tmp"], seeded)
    expect(store.lookup("/tmp/root", ["*.tmp"])).toEqual(seeded)
    expect(store.lookup("/tmp/other", ["*.tmp"])).toBeUndefined()
    expect(store.lookup("/tmp/root", ["*.bak"])).toBeUndefined()
  })

  test("expires a seed after the reuse window", () => {
    let now = 1_000
    const store = new ScanReuseStore(() => now, 60_000)
    store.remember("/tmp/root", [], entries(2))
    now += 59_999
    expect(store.lookup("/tmp/root", [])).toBeDefined()
    now += 1
    expect(store.lookup("/tmp/root", [])).toBeUndefined()
  })

  test("replacing a seed updates the retained entry count", () => {
    let now = 1_000
    const store = new ScanReuseStore(() => now, 60_000, 10)
    store.remember("/tmp/root", [], entries(4))
    now += 1
    store.remember("/tmp/root", [], entries(2))
    expect(store.lookup("/tmp/root", [])?.size).toBe(2)
    // The two released entries leave room for another four-entry seed.
    store.remember("/tmp/other", [], entries(4, "o"))
    expect(store.lookup("/tmp/other", [])?.size).toBe(4)
  })

  test("evicts the oldest seed to stay within the entry budget", () => {
    let now = 1_000
    const store = new ScanReuseStore(() => now, 60_000, 5)
    store.remember("/tmp/old", [], entries(3, "a"))
    now += 1
    store.remember("/tmp/new", [], entries(3, "b"))
    expect(store.lookup("/tmp/old", [])).toBeUndefined()
    expect(store.lookup("/tmp/new", [])?.size).toBe(3)
  })

  test("refuses a seed larger than the whole budget", () => {
    const store = new ScanReuseStore(() => 0, 60_000, 4)
    store.remember("/tmp/huge", [], entries(5))
    expect(store.lookup("/tmp/huge", [])).toBeUndefined()
  })

  test("forget drops a seed without touching others", () => {
    const store = new ScanReuseStore()
    store.remember("/tmp/root", [], entries(1, "a"))
    store.remember("/tmp/root", ["x"], entries(1, "b"))
    store.forget("/tmp/root", [])
    expect(store.lookup("/tmp/root", [])).toBeUndefined()
    expect(store.lookup("/tmp/root", ["x"])?.size).toBe(1)
  })
})
