import { describe, expect, test } from "bun:test"
import type { ScanMetrics } from "../src/main/folder-manifest"
import { ScanLedger, scanStageForKey } from "../src/main/scan-ledger"

function metrics(overrides: Partial<ScanMetrics> = {}): ScanMetrics {
  return { files: 0, reusedFiles: 0, hashedFiles: 0, unhashedFiles: 0, ignored: 0, unreadable: 0, truncated: false, ...overrides }
}

describe("scanStageForKey", () => {
  test("maps workflow keys to stages without matching prefixes loosely", () => {
    expect(scanStageForKey("preview:/tmp/a")).toBe("preview")
    expect(scanStageForKey("incoming:/tmp/b")).toBe("incoming")
    expect(scanStageForKey("initial:m1")).toBe("initial")
    expect(scanStageForKey("verify:m1")).toBe("verify")
    expect(scanStageForKey("inbound:preview")).toBe("inbound")
    expect(scanStageForKey("continuous:m1")).toBe("continuous")
    expect(scanStageForKey("preview-extra")).toBe("other")
    expect(scanStageForKey("mystery")).toBe("other")
  })
})

describe("ScanLedger", () => {
  test("records stage and counters and can be reset", () => {
    let now = 5
    const ledger = new ScanLedger(() => now++)
    ledger.record("preview", "preview:/tmp/a", metrics({ files: 3, hashedFiles: 3 }))
    ledger.record("initial", "initial:m1", metrics({ files: 3, reusedFiles: 2, hashedFiles: 1 }))
    expect(ledger.snapshot().map((entry) => `${entry.stage}:${entry.files}/${entry.reusedFiles}/${entry.hashedFiles}`)).toEqual([
      "preview:3/0/3",
      "initial:3/2/1",
    ])
    ledger.reset()
    expect(ledger.snapshot()).toEqual([])
  })

  test("caps retained entries", () => {
    const ledger = new ScanLedger(() => 0)
    for (let index = 0; index < 520; index += 1) ledger.record("other", `k${index}`, metrics())
    const snapshot = ledger.snapshot()
    expect(snapshot).toHaveLength(500)
    expect(snapshot[0]?.key).toBe("k20")
  })
})
