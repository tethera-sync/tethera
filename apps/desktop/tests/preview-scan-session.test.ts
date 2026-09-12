import { describe, expect, test } from "bun:test"
import { previewScanKey, PreviewScanSessions } from "../src/main/preview-scan-session"
import { manifest } from "./helpers"

const baseInput = {
  kind: "local" as const,
  rootPath: "/tmp/root",
  ignorePatterns: ["*.tmp"],
  hashAllFiles: false,
  maxFiles: 10_000,
}

describe("PreviewScanSessions", () => {
  test("reuses a recorded scan for the same session and inputs", () => {
    const sessions = new PreviewScanSessions()
    const scan = manifest([{ path: "a.txt", size: 1, modifiedMs: 1 }])
    sessions.record("op-1", previewScanKey(baseInput), scan)
    expect(sessions.lookup("op-1", previewScanKey(baseInput))).toBe(scan)
  })

  test("misses when the session, root, rules, hash mode, limit or peer changes", () => {
    const sessions = new PreviewScanSessions()
    const scan = manifest([{ path: "a.txt", size: 1, modifiedMs: 1 }])
    sessions.record("op-1", previewScanKey(baseInput), scan)
    expect(sessions.lookup("op-2", previewScanKey(baseInput))).toBeUndefined()
    expect(sessions.lookup("op-1", previewScanKey({ ...baseInput, rootPath: "/tmp/other" }))).toBeUndefined()
    expect(sessions.lookup("op-1", previewScanKey({ ...baseInput, ignorePatterns: ["*.bak"] }))).toBeUndefined()
    expect(sessions.lookup("op-1", previewScanKey({ ...baseInput, hashAllFiles: true }))).toBeUndefined()
    expect(sessions.lookup("op-1", previewScanKey({ ...baseInput, maxFiles: 5_000 }))).toBeUndefined()
    const remoteKey = previewScanKey({ ...baseInput, kind: "remote", peerId: "peer-1", maxFiles: null })
    sessions.record("op-1", remoteKey, scan)
    expect(sessions.lookup("op-1", previewScanKey({ ...baseInput, kind: "remote", peerId: "peer-2", maxFiles: null }))).toBeUndefined()
    expect(sessions.lookup("op-1", remoteKey)).toBe(scan)
  })

  test("expires a session after the reuse window", () => {
    let now = 1_000
    const sessions = new PreviewScanSessions(() => now)
    const key = previewScanKey(baseInput)
    sessions.record("op-1", key, manifest([{ path: "a.txt", size: 1, modifiedMs: 1 }]))
    now += 10 * 60_000 - 1
    expect(sessions.lookup("op-1", key)).toBeDefined()
    now += 1
    expect(sessions.lookup("op-1", key)).toBeUndefined()
  })

  test("does not cache oversized manifests and can drop a session", () => {
    const sessions = new PreviewScanSessions()
    const key = previewScanKey(baseInput)
    const oversized = manifest(Array.from({ length: 50_001 }, (_, index) => ({ path: `f${index}`, size: 0, modifiedMs: 0 })))
    sessions.record("op-1", key, oversized)
    expect(sessions.lookup("op-1", key)).toBeUndefined()

    const scan = manifest([{ path: "a.txt", size: 1, modifiedMs: 1 }])
    sessions.record("op-2", key, scan)
    sessions.drop("op-2")
    expect(sessions.lookup("op-2", key)).toBeUndefined()
  })

  test("never retains more than eight sessions", () => {
    const sessions = new PreviewScanSessions(() => 0)
    const key = previewScanKey(baseInput)
    for (let index = 0; index < 9; index += 1) {
      sessions.record(`op-${index}`, key, manifest([{ path: `f${index}`, size: 0, modifiedMs: 0 }]))
    }
    // The ninth record evicts the oldest session, keeping the newest eight.
    expect(sessions.lookup("op-0", key)).toBeUndefined()
    expect(sessions.lookup("op-1", key)).toBeDefined()
    expect(sessions.lookup("op-8", key)).toBeDefined()
  })
})
