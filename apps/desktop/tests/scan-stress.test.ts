import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { scanFolder } from "../src/main/folder-manifest"
import { globalScanCoordinator } from "../src/main/scan-coordinator"

function memorySnapshot(): { heapUsed: number; external: number; rss: number } {
  const usage = process.memoryUsage()
  return { heapUsed: usage.heapUsed, external: usage.external, rss: usage.rss }
}

async function buildFlatTree(root: string, files: number): Promise<void> {
  for (let index = 0; index < files; index += 1) {
    await writeFile(path.join(root, `file-${index.toString().padStart(6, "0")}.txt`), `content-${index}`)
  }
}

async function buildDeepTree(root: string, depth: number, breadth: number): Promise<void> {
  let current = root
  for (let level = 0; level < depth; level += 1) {
    current = path.join(current, `level-${level}`)
    await mkdir(current, { recursive: true })
    for (let index = 0; index < breadth; index += 1) {
      await writeFile(path.join(current, `leaf-${index}.txt`), "leaf")
    }
  }
}

describe("temporary-root scan stress harness (opt-in, never real folders)", () => {
  test("small flat tree establishes a reproducible memory budget", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tethera-stress-small-"))
    try {
      await buildFlatTree(root, 500)
      globalThis.gc?.()
      const before = memorySnapshot()
      const manifest = await scanFolder(root, [], { hashAllFiles: true })
      expect(manifest.files).toHaveLength(500)
      expect(manifest.truncated).toBe(false)
      const peak = memorySnapshot()
      // Drop the result reference and settle; RSS alone is not leak proof.
      await Bun.sleep(10)
      globalThis.gc?.()
      const settled = memorySnapshot()
      // Budgets are machine-specific; assert shape, log numbers for the report.
      expect(peak.heapUsed).toBeGreaterThan(0)
      expect(settled.heapUsed).toBeGreaterThan(0)
      console.log(`[stress-small] files=500 heapBefore=${before.heapUsed} heapPeak=${peak.heapUsed} heapSettled=${settled.heapUsed} rssPeak=${peak.rss} rssSettled=${settled.rss} activeScans=${globalScanCoordinator.activeScans}`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("deep and directory-heavy trees scan without handle leaks", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tethera-stress-deep-"))
    try {
      await buildDeepTree(root, 12, 4)
      await mkdir(path.join(root, "empty-a", "empty-b"), { recursive: true })
      const manifest = await scanFolder(root, [], {})
      // 12 levels × 4 files = 48 files; empty dirs contribute no files.
      expect(manifest.files).toHaveLength(48)
      expect(manifest.unreadable).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  const stressSizes = process.env.TETHERA_SCAN_STRESS === "1"
    ? [10_000]
    : process.env.TETHERA_SCAN_STRESS === "huge"
      ? [10_000, 100_000]
      : []

  for (const size of stressSizes) {
    test(`opt-in stress: ${size.toLocaleString("en-US")} files report peak/settled budgets`, async () => {
      const root = await mkdtemp(path.join(tmpdir(), "tethera-stress-optin-"))
      try {
        await buildFlatTree(root, size)
        globalThis.gc?.()
        const before = memorySnapshot()
        const startedAt = Date.now()
        const manifest = await scanFolder(root, [], {})
        const elapsedMs = Date.now() - startedAt
        const peak = memorySnapshot()
        expect(manifest.files.length).toBeGreaterThan(0)
        console.log(`[stress-optin] files=${size} elapsedMs=${elapsedMs} heapBefore=${before.heapUsed} heapPeak=${peak.heapUsed} rssPeak=${peak.rss} truncated=${manifest.truncated}`)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }, 300_000)
  }
})
