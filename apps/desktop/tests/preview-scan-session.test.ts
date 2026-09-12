import { describe, expect, test } from "bun:test"
import { previewsEqual, previewScanKey, PreviewScanSessions, type PreviewScanKeyInput } from "../src/main/preview-scan-session"
import { compareManifests } from "../src/main/folder-manifest"
import { manifest } from "./helpers"

const baseInput: PreviewScanKeyInput = {
  direction: "outgoing", localPath: "/tmp/root", remotePath: "D:\\coding", peerId: "peer-1",
  localPlatform: "linux", remotePlatform: "windows", ignorePatterns: ["*.tmp"], mode: "two-way", maxFiles: null,
}
const key = previewScanKey(baseInput)
const preview = compareManifests(manifest([]), manifest([]), { mode: "two-way", localPlatform: "linux", remotePlatform: "windows" })

describe("PreviewScanSessions", () => {
  test("reuses a bounded summary even for a comparison above the old 50k-file cap", () => {
    const sessions = new PreviewScanSessions()
    const large = { ...preview, localFiles: 250_000, remoteFiles: 300_000 }
    sessions.record("op-1", key, large)
    expect(sessions.lookup("op-1", key)).toEqual(large)
    // The retained value has no file manifests and cannot be changed by its callers.
    large.localFiles = 0
    const returned = sessions.lookup("op-1", key)
    if (!returned) throw new Error("comparison must be cached")
    returned.samples.push({ path: "changed", category: "different" })
    expect(sessions.lookup("op-1", key)?.localFiles).toBe(250_000)
    expect(sessions.lookup("op-1", key)?.samples).toEqual([])
  })

  test("misses for another operation or any changed comparison input", () => {
    const sessions = new PreviewScanSessions()
    sessions.record("op-1", key, preview)
    expect(sessions.lookup("op-2", key)).toBeUndefined()
    const changes: Partial<PreviewScanKeyInput>[] = [
      { direction: "incoming" }, { localPath: "/tmp/other" }, { remotePath: "E:\\coding" },
      { peerId: "peer-2" }, { localPlatform: "windows" }, { remotePlatform: "linux" },
      { ignorePatterns: ["*.bak"] }, { mode: "send-only" }, { maxFiles: 5_000 },
    ]
    for (const change of changes) {
      expect(sessions.lookup("op-1", previewScanKey({ ...baseInput, ...change }))).toBeUndefined()
    }
  })

  test("expires and replaces entire comparisons, never mixing scans", () => {
    let now = 1_000
    const sessions = new PreviewScanSessions(() => now)
    sessions.record("op-1", key, preview)
    now += 10 * 60_000 - 1
    expect(sessions.lookup("op-1", key)).toBeDefined()
    now += 1
    expect(sessions.lookup("op-1", key)).toBeUndefined()
    sessions.record("op-1", key, preview)
    const otherKey = previewScanKey({ ...baseInput, localPath: "/tmp/other" })
    sessions.record("op-1", otherKey, preview)
    expect(sessions.lookup("op-1", key)).toBeUndefined()
    expect(sessions.lookup("op-1", otherKey)).toBeDefined()
    sessions.drop("op-1")
    expect(sessions.lookup("op-1", otherKey)).toBeUndefined()
  })

  test("never retains more than eight bounded summaries", () => {
    const sessions = new PreviewScanSessions(() => 0)
    for (let index = 0; index < 9; index++) sessions.record(`op-${index}`, key, preview)
    expect(sessions.lookup("op-0", key)).toBeUndefined()
    expect(sessions.lookup("op-1", key)).toBeDefined()
    expect(sessions.lookup("op-8", key)).toBeDefined()
    sessions.record("op-8", key, { ...preview, invalidWindowsNames: ["x".repeat(2 * 1024 * 1024)] })
    expect(sessions.lookup("op-8", key)).toBeUndefined()
  })
})

describe("reviewed scan issues", () => {
  test("requires another review when an inaccessible path changes without changing totals", () => {
    const reviewed = { ...preview, unreadableLocal: [{ path: "a.txt", reason: "Locked", kind: "file" as const }], unreadableLocalCount: 1 }
    const changed = { ...reviewed, unreadableLocal: [{ path: "b.txt", reason: "Locked", kind: "file" as const }] }
    expect(previewsEqual(reviewed, changed)).toBe(false)
    expect(previewsEqual(reviewed, structuredClone(reviewed))).toBe(true)
  })

  test("ignores issue traversal order and accepts previews from older peers", () => {
    const reviewed = { ...preview, unreadableLocal: [
      { path: "a.txt", reason: "Locked", kind: "file" as const },
      { path: "b", reason: "Access denied", kind: "directory" as const },
    ], unreadableLocalCount: 2 }
    expect(previewsEqual(reviewed, { ...reviewed, unreadableLocal: [...reviewed.unreadableLocal].reverse() })).toBe(true)
    const { unreadableLocal, unreadableRemote, unreadableLocalCount, unreadableRemoteCount, ...old } = reviewed
    expect(previewsEqual(reviewed, old)).toBe(true)
    expect(previewsEqual(reviewed, { ...old, localFiles: old.localFiles + 1 })).toBe(false)
  })
})
