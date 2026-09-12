import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { CachedFileDigest, FileManifest, ScanMetrics } from "../src/main/folder-manifest"
import { scanFolder } from "../src/main/folder-manifest"
import { previewScanKey, PreviewScanSessions } from "../src/main/preview-scan-session"
import { ScanLedger, type ScanStage } from "../src/main/scan-ledger"

/**
 * Mirrors the folder-setup sequence with the same scan primitives the main
 * process uses: preview, request approval (session reuse), consent, merge and
 * verification. It asserts the walk budget explicitly, so a future change
 * that adds another full re-read of unchanged data fails here and is visible
 * in the ledger rather than only in elapsed time.
 *
 * The real stages are driven from Electron main; this test locks the scan and
 * session behaviour those stages depend on (settled-identity reuse,
 * identity-checked invalidation, no-walk comparison reuse, and metrics).
 */
describe("folder setup walk budget", () => {
  test("reuses unchanged digests across consent, merge and verification walks", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tethera-walk-budget-"))
    try {
      await writeFile(path.join(root, "a.txt"), "alpha")
      await writeFile(path.join(root, "b.txt"), "bravo")
      await writeFile(path.join(root, "c.txt"), "charlie")
      await Bun.sleep(2_100)

      const ledger = new ScanLedger(() => 0)
      const seed = new Map<string, CachedFileDigest>()
      const walk = async (
        stage: ScanStage,
        options: Parameters<typeof scanFolder>[2] = {},
      ): Promise<{ metrics: ScanMetrics; manifest: FileManifest }> => {
        let captured: ScanMetrics | undefined
        const manifest = await scanFolder(root, [], {
          ...options,
          onSettledDigest: (relativePath, digest) => seed.set(relativePath, digest),
          onMetrics: (metrics) => {
            captured = metrics
            ledger.record(stage, `${stage}:${root}`, metrics)
          },
        })
        if (!captured) throw new Error("scan produced no metrics")
        return { metrics: captured, manifest }
      }

      // Stage 1: preview walk, which hashes every file under the preview ceiling.
      const preview = await walk("preview")
      expect(preview.metrics).toMatchObject({ files: 3, reusedFiles: 0, hashedFiles: 3 })

      // Stage 2: request approval answers from the recorded comparison with no walk.
      const sessions = new PreviewScanSessions(() => 0)
      const scanKey = previewScanKey({
        kind: "local",
        rootPath: root,
        ignorePatterns: [],
        hashAllFiles: false,
        maxFiles: null,
      })
      sessions.record("operation-1", scanKey, preview.manifest)
      expect(sessions.lookup("operation-1", scanKey)).toBeDefined()
      expect(ledger.snapshot()).toHaveLength(1)

      // Stage 3: the consent walk reuses every settled preview digest.
      const consent = await walk("incoming", { reuse: seed })
      expect(consent.metrics).toMatchObject({ files: 3, reusedFiles: 3, hashedFiles: 0 })

      // Stage 4: the full-integrity merge walk reads no unchanged bytes.
      const merge = await walk("initial", { hashAllFiles: true, reuse: seed })
      expect(merge.metrics).toMatchObject({ files: 3, reusedFiles: 3, hashedFiles: 0 })

      // Stage 5: verification reads only the file that changed.
      await writeFile(path.join(root, "b.txt"), "BRAVO")
      await Bun.sleep(2_100)
      const verify = await walk("verify", { hashAllFiles: true, reuse: seed })
      expect(verify.metrics).toMatchObject({ files: 3, reusedFiles: 2, hashedFiles: 1 })

      expect(ledger.snapshot().map((entry) => `${entry.stage}:${entry.reusedFiles}/${entry.hashedFiles}`)).toEqual([
        "preview:0/3",
        "incoming:3/0",
        "initial:3/0",
        "verify:2/1",
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
