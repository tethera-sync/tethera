import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  ScanCancelledError,
  compareManifests,
  folderManifestTestHelpers,
  scanFolder,
} from "../src/main/folder-manifest"
import { ScanCoordinator } from "../src/main/scan-coordinator"
import { runPairedScans } from "../src/main/paired-scan"
import { manifest } from "./helpers"

describe("scan cancellation", () => {
  test("an already-aborted signal fails without touching the filesystem counts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tethera-cancel-pre-"))
    try {
      await writeFile(path.join(root, "file.txt"), "data")
      const controller = new AbortController()
      controller.abort()
      await expect(scanFolder(root, [], { signal: controller.signal })).rejects.toBeInstanceOf(ScanCancelledError)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("abort escapes per-file catch blocks instead of counting unreadable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tethera-cancel-mid-"))
    try {
      for (let index = 0; index < 200; index += 1) {
        await writeFile(path.join(root, `file-${index}.txt`), "x".repeat(100))
      }
      const controller = new AbortController()
      const scan = scanFolder(root, [], {
        hashAllFiles: true,
        signal: controller.signal,
        onActivity: () => controller.abort(),
      })
      await expect(scan).rejects.toBeInstanceOf(ScanCancelledError)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a cancelled scan can be retried immediately", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tethera-cancel-retry-"))
    try {
      await writeFile(path.join(root, "file.txt"), "data")
      const controller = new AbortController()
      controller.abort()
      await expect(scanFolder(root, [], { signal: controller.signal })).rejects.toBeInstanceOf(ScanCancelledError)
      const retry = await scanFolder(root, [], {})
      expect(retry.files.map((entry) => entry.path)).toEqual(["file.txt"])
      expect(retry.unreadable).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a failing peer sibling aborts the local scan", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tethera-cancel-sibling-"))
    try {
      for (let index = 0; index < 100; index += 1) {
        await writeFile(path.join(root, `file-${index}.txt`), "data")
      }
      let localStarted = false
      await expect(runPairedScans(
        async (signal) => {
          localStarted = true
          return scanFolder(root, [], { signal })
        },
        async () => {
          throw new Error("peer disconnected")
        },
      )).rejects.toThrow("peer disconnected")
      expect(localStarted).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a failing local scan aborts the peer wait", async () => {
    let peerAborted = false
    await expect(runPairedScans(
      async () => {
        throw new Error("local disk vanished")
      },
      async (signal) => {
        signal.addEventListener("abort", () => {
          peerAborted = true
        })
        await new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(new ScanCancelledError()), { once: true })
        })
        return { rootPath: "/peer", files: [], ignored: 0, unreadable: 0, unreadableEntries: [], truncated: false }
      },
    )).rejects.toThrow("local disk vanished")
    expect(peerAborted).toBe(true)
  })
})

describe("scan admission", () => {
  test("bounds active scans and queues, releasing slots in finally", async () => {
    const coordinator = new ScanCoordinator()
    const gate = new Promise<void>((resolve) => setTimeout(resolve, 20))
    const active = Array.from({ length: 4 }, (_, index) => coordinator.run(`scan-${index}`, () => gate.then(() => index)))
    expect(coordinator.activeScans).toBe(4)
    const queued = coordinator.run("queued", () => Promise.resolve("queued"))
    expect(coordinator.queuedScans).toBe(1)
    await expect(Promise.all(active)).resolves.toHaveLength(4)
    await expect(queued).resolves.toBe("queued")
    expect(coordinator.activeScans).toBe(0)
    expect(coordinator.queuedScans).toBe(0)
  })

  test("rejects beyond the bounded pending queue and cancels queued scans", async () => {
    const coordinator = new ScanCoordinator()
    const gate = new Promise<void>((resolve) => setTimeout(resolve, 30))
    const active = Array.from({ length: 4 }, (_, index) => coordinator.run(`active-${index}`, () => gate))
    const queued = Array.from({ length: 16 }, (_, index) => coordinator.run(`queued-${index}`, () => Promise.resolve(index)))
    await expect(coordinator.run("overflow", () => Promise.resolve(0))).rejects.toThrow("maximum number of folder scans")
    coordinator.cancelQueued()
    // Queued entries reject with cancellation; active entries still resolve.
    const queuedResults = await Promise.allSettled(queued)
    expect(queuedResults.every((result) => result.status === "rejected")).toBe(true)
    await Promise.all(active)
    expect(coordinator.activeScans).toBe(0)
  })

  test("an aborted queued scan never starts its task", async () => {
    const coordinator = new ScanCoordinator()
    const gate = new Promise<void>((resolve) => setTimeout(resolve, 20))
    const active = Array.from({ length: 4 }, () => coordinator.run("active", () => gate))
    let started = false
    const controller = new AbortController()
    const queued = coordinator.run("queued", () => {
      started = true
      return Promise.resolve(0)
    }, controller.signal)
    controller.abort()
    await expect(queued).rejects.toBeInstanceOf(ScanCancelledError)
    await Promise.all(active)
    expect(started).toBe(false)
  })
})

describe("comparison equivalence and peer validation", () => {
  test("two-pass comparison matches union semantics with identical top-14 samples", () => {
    const local = manifest([
      { path: "same.txt", size: 3, modifiedMs: 1, digest: "same" },
      { path: "local.txt", size: 10, modifiedMs: 2, digest: "local" },
      { path: "changed.txt", size: 8, modifiedMs: 5, digest: "new" },
    ])
    const remote = manifest([
      { path: "same.txt", size: 3, modifiedMs: 1, digest: "same" },
      { path: "remote.txt", size: 20, modifiedMs: 2, digest: "remote" },
      { path: "changed.txt", size: 7, modifiedMs: 4, digest: "old" },
    ])
    const preview = compareManifests(local, remote, { mode: "two-way", localPlatform: "linux", remotePlatform: "linux" })
    expect(preview).toMatchObject({ identicalFiles: 1, localOnlyFiles: 1, remoteOnlyFiles: 1, differentFiles: 1, bytesToRemote: 10, bytesToLocal: 20 })
    // Reversed insertion order must not change the deterministic sample order.
    const reversed = compareManifests(
      { ...local, files: [...local.files].reverse() },
      { ...remote, files: [...remote.files].reverse() },
      { mode: "two-way", localPlatform: "linux", remotePlatform: "linux" },
    )
    expect(reversed.samples).toEqual(preview.samples)
  })

  test("case-collision semantics are preserved without retaining full warning arrays", () => {
    const preview = folderManifestTestHelpers.compareManifests(
      manifest([
        { path: "Readme.md", size: 1, modifiedMs: 1 },
        { path: "README.md", size: 1, modifiedMs: 1 },
      ]),
      manifest([]),
      { mode: "two-way", localPlatform: "linux", remotePlatform: "windows" },
    )
    // Remote is windows and mode allows pull, so the local collision surfaces.
    expect(preview.caseCollisions).toEqual(["Readme.md ↔ README.md"])
    expect(preview.samples.some((sample) => sample.category === "case-collision")).toBe(true)
  })

  test("peer manifests reject duplicates, bad sizes and bad digests but keep truncation explicit", () => {
    const base = { rootPath: "/peer", files: [{ path: "a.txt", size: 1, modifiedMs: 1, digest: "a".repeat(64) }], ignored: 0, unreadable: 0, unreadableEntries: [], truncated: true }
    expect(folderManifestTestHelpers.parsePeerManifest(base).truncated).toBe(true)
    expect(() => folderManifestTestHelpers.parsePeerManifest({
      ...base,
      files: [...base.files, ...base.files],
    })).toThrow("duplicate")
    expect(() => folderManifestTestHelpers.parsePeerManifest({
      ...base,
      files: [{ path: "a.txt", size: -1, modifiedMs: 1 }],
    })).toThrow("invalid")
    expect(() => folderManifestTestHelpers.parsePeerManifest({
      ...base,
      files: [{ path: "a.txt", size: 1, modifiedMs: 1, digest: "NOT-HEX" }],
    })).toThrow("invalid")
  })

  test("encoded-byte budgets fail closed before serialization", () => {
    const small = { rootPath: "/local", files: [{ path: "a.txt", size: 1, modifiedMs: 1, digest: "a".repeat(64) }], ignored: 0, unreadable: 0, unreadableEntries: [], truncated: false }
    expect(folderManifestTestHelpers.estimateManifestEncodedBytes(small)).toBeLessThan(12 * 1024 * 1024)
    const hugePath = "p".repeat(4000)
    const many = {
      rootPath: "/local",
      files: Array.from({ length: 10_001 }, (_, index) => ({ path: `${hugePath}-${index}`, size: 1, modifiedMs: 1, digest: "a".repeat(64) })),
      ignored: 0,
      unreadable: 0,
      truncated: false,
    }
    // The removed fixed-count ceiling used to trigger first; the byte budget is now the only ceiling.
    expect(folderManifestTestHelpers.estimateManifestEncodedBytes(many)).toBeGreaterThan(12 * 1024 * 1024)
    expect(() => folderManifestTestHelpers.assertManifestWithinLegacyByteBudget(many, "This computer")).toThrow("MiB legacy budget")
  })

  // Regression: a C0 control character serializes as a six-byte \u00XX JSON
  // escape, so raw UTF-8 length times two undercounts the true wire size and
  // let such manifests pass the budget check before serialization rejected
  // them at the 16 MiB line limit.
  test("control-character paths count their six-byte JSON escapes toward the byte budget", () => {
    const files = Array.from({ length: 6500 }, (_, index) => ({
      path: `${"\u0001".repeat(200)}-${index}`,
      size: 1,
      modifiedMs: 1,
      digest: "a".repeat(64),
    }))
    const manifest = { rootPath: "/local", files, ignored: 0, unreadable: 0, unreadableEntries: [], truncated: false }
    const plaintextBytes = Buffer.byteLength(JSON.stringify(files), "utf8")
    const estimated = folderManifestTestHelpers.estimateManifestEncodedBytes(manifest)
    expect(estimated).toBeGreaterThan(Math.ceil(plaintextBytes * 1.37) + 512)
    expect(() => folderManifestTestHelpers.assertManifestWithinLegacyByteBudget(manifest, "This computer")).toThrow("MiB legacy budget")
  })

  // Regression for the fixed 10,000-files-per-side ceiling that used to fail closed
  // no matter how high the "Scan file limit" setting allowed: a manifest with well
  // over 10,000 short-path files must sync as long as it stays under the real
  // encoded-byte budget for one legacy full-manifest peer frame.
  test("a manifest with far more than 10,000 files stays within the byte budget when paths are short", () => {
    const files = Array.from({ length: 15_000 }, (_, index) => ({
      path: `f/${String(index).padStart(5, "0")}.txt`,
      size: 1,
      modifiedMs: 1,
    }))
    const manifest = { rootPath: "/local", files, ignored: 0, unreadable: 0, unreadableEntries: [], truncated: false }
    const estimated = folderManifestTestHelpers.estimateManifestEncodedBytes(manifest)
    expect(estimated).toBeLessThan(12 * 1024 * 1024)
    expect(() => folderManifestTestHelpers.assertManifestWithinLegacyByteBudget(manifest, "This computer")).not.toThrow()
  })

  test("a manifest just over the encoded-byte budget throws even with far fewer than 10,000 files", () => {
    const files = Array.from({ length: 41_000 }, (_, index) => ({
      path: `${"a".repeat(46)}-${String(index).padStart(5, "0")}`,
      size: 1,
      modifiedMs: 1,
    }))
    const manifest = { rootPath: "/local", files, ignored: 0, unreadable: 0, unreadableEntries: [], truncated: false }
    const estimated = folderManifestTestHelpers.estimateManifestEncodedBytes(manifest)
    expect(estimated).toBeGreaterThan(12 * 1024 * 1024)
    expect(() => folderManifestTestHelpers.assertManifestWithinLegacyByteBudget(manifest, "This computer")).toThrow("MiB legacy budget")
  })
})

describe("watcher and peer resource cleanup", () => {
  test("closing a monitor cancels its directory collection", async () => {
    const { collectWatchDirectories, FolderChangeMonitor } = await import("../src/main/continuous-sync")
    const { mkdtemp, rm } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const path = (await import("node:path")).default
    const root = await mkdtemp(path.join(tmpdir(), "tethera-watch-cancel-"))
    try {
      const controller = new AbortController()
      controller.abort()
      await expect(collectWatchDirectories(root, [], controller.signal)).rejects.toThrow("cancelled")
      const monitor = new FolderChangeMonitor(root, [], () => {})
      await monitor.start()
      monitor.close()
      monitor.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a cancelled peer request never reports success", async () => {
    const { PeerSessionService } = await import("../src/main/peer-session-service")
    const { generateKeyPairSync } = await import("node:crypto")
    const keys = generateKeyPairSync("ed25519")
    const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64")
    const service = new PeerSessionService({
      pairing: {
        getLocalSessionIdentity: () => ({ id: "local", name: "local", platform: "linux" as const, publicKey, fingerprint: "local" }),
        getTrustedSessionPeer: () => undefined,
        signSessionPayload: () => "",
        verifyTrustedSessionPayload: () => false,
      },
      onRequest: async () => undefined,
      port: 0,
    })
    const controller = new AbortController()
    controller.abort()
    await expect(service.request("missing-peer", { type: "ping" }, 1_000, { signal: controller.signal })).rejects.toThrow()
  })
})
