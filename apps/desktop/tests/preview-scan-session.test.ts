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
})
