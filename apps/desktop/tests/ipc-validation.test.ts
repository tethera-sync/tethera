import { describe, expect, test } from "bun:test"
import {
  applySettingUpdate,
  MAX_IGNORE_PATTERN_LENGTH,
  MAX_IGNORE_PATTERNS,
  normalizePersistedScanLimit,
  parseArchiveHistoryRequest,
  parseConflictCopyExpectation,
  parseExactConflictChoice,
  parsePeerConflictCopy,
  parsePeerFileOperations,
  parsePeerScanManifest,
  parseResolveFileConflictInput,
  parseRevealPath,
  parseSettingUpdate,
  requireAllowedConflictDirection,
  requireUnchangedInspectedCopies,
  validateConflictInput,
  validateContinuousOperationRequest,
  validateInitialSyncPassResult,
  validateMappingInput,
  validatePeerOperationId,
  validateTransferDescriptor,
} from "../src/main/ipc-validation"
import type {
  AddFolderInput,
  AppSettings,
  ConflictInspection,
  ResolveFileConflictInput,
} from "../src/shared/contracts"

const DIGEST = "a".repeat(64)
const OTHER_DIGEST = "b".repeat(64)

const settings: AppSettings = {
  closeToTray: true,
  launchAtLogin: false,
  startMinimised: false,
  pauseOnMetered: true,
  theme: "system",
  maxScanFiles: 10_000,
}

describe("reveal-path validation", () => {
  test("accepts the mapping roots the renderer reveals", () => {
    expect(parseRevealPath("/home/tommy/Projects")).toBe("/home/tommy/Projects")
    expect(parseRevealPath("C:\\Users\\tommy\\Projects")).toBe("C:\\Users\\tommy\\Projects")
  })

  test("rejects empty, unbounded, and NUL-carrying paths", () => {
    expect(() => parseRevealPath("")).toThrow("The selected path is invalid.")
    expect(() => parseRevealPath(42)).toThrow("The selected path is invalid.")
    expect(() => parseRevealPath("a".repeat(4097))).toThrow("The selected path is invalid.")
    expect(() => parseRevealPath("/tmp/bad\0path")).toThrow("The selected path is invalid.")
  })
})

describe("archive-history request validation", () => {
  test("accepts and trims a valid mapping id", () => {
    expect(parseArchiveHistoryRequest(" mapping-1 ")).toBe("mapping-1")
  })

  test("rejects empty, whitespace, mistyped, and missing ids", () => {
    expect(() => parseArchiveHistoryRequest("")).toThrow("Choose a valid folder.")
    expect(() => parseArchiveHistoryRequest("   ")).toThrow("Choose a valid folder.")
    expect(() => parseArchiveHistoryRequest(1)).toThrow("Choose a valid folder.")
    expect(() => parseArchiveHistoryRequest(null)).toThrow("Choose a valid folder.")
    expect(() => parseArchiveHistoryRequest(undefined)).toThrow("Choose a valid folder.")
  })
})

describe("settings-update validation", () => {
  test("accepts every supported key with a correctly typed value", () => {
    expect(parseSettingUpdate("closeToTray", false)).toEqual({ key: "closeToTray", value: false })
    expect(parseSettingUpdate("launchAtLogin", true)).toEqual({ key: "launchAtLogin", value: true })
    expect(parseSettingUpdate("startMinimised", true)).toEqual({ key: "startMinimised", value: true })
    expect(parseSettingUpdate("pauseOnMetered", false)).toEqual({ key: "pauseOnMetered", value: false })
    expect(parseSettingUpdate("theme", "dark")).toEqual({ key: "theme", value: "dark" })
    expect(parseSettingUpdate("maxScanFiles", 10_000)).toEqual({ key: "maxScanFiles", value: 10_000 })
    expect(parseSettingUpdate("maxScanFiles", null)).toEqual({ key: "maxScanFiles", value: null })
  })

  test("rejects scan limits outside the supported envelope", () => {
    expect(() => parseSettingUpdate("maxScanFiles", 999)).toThrow("The requested setting change is invalid.")
    expect(() => parseSettingUpdate("maxScanFiles", 1_000_001)).toThrow("The requested setting change is invalid.")
    expect(() => parseSettingUpdate("maxScanFiles", 10.5)).toThrow("The requested setting change is invalid.")
    expect(() => parseSettingUpdate("maxScanFiles", "10000")).toThrow("The requested setting change is invalid.")
    expect(() => parseSettingUpdate("maxScanFiles", undefined)).toThrow("The requested setting change is invalid.")
  })

  test("rejects unknown keys and mistyped values", () => {
    expect(() => parseSettingUpdate("theme", "neon")).toThrow("The requested setting change is invalid.")
    expect(() => parseSettingUpdate("closeToTray", "yes")).toThrow("The requested setting change is invalid.")
    expect(() => parseSettingUpdate("launchAtLogin", 1)).toThrow("The requested setting change is invalid.")
    expect(() => parseSettingUpdate("preferences", {})).toThrow("The requested setting change is invalid.")
    expect(() => parseSettingUpdate(undefined, true)).toThrow("The requested setting change is invalid.")
  })

  test("applies validated updates without touching unrelated settings", () => {
    expect(applySettingUpdate(settings, { key: "theme", value: "dark" })).toEqual({ ...settings, theme: "dark" })
    expect(applySettingUpdate(settings, { key: "launchAtLogin", value: true })).toEqual({
      ...settings,
      launchAtLogin: true,
    })
    expect(applySettingUpdate(settings, { key: "maxScanFiles", value: null })).toEqual({
      ...settings,
      maxScanFiles: null,
    })
    expect(applySettingUpdate(settings, { key: "maxScanFiles", value: 50_000 })).toEqual({
      ...settings,
      maxScanFiles: 50_000,
    })
  })

  test("falls back to the default scan limit for missing or corrupt persisted values", () => {
    expect(normalizePersistedScanLimit(undefined)).toBe(10_000)
    expect(normalizePersistedScanLimit("10000")).toBe(10_000)
    expect(normalizePersistedScanLimit(999)).toBe(10_000)
    expect(normalizePersistedScanLimit(1_000_001)).toBe(10_000)
    expect(normalizePersistedScanLimit(null)).toBeNull()
    expect(normalizePersistedScanLimit(50_000)).toBe(50_000)
  })
})

describe("mapping-input validation", () => {
  const draft: AddFolderInput = {
    name: "Projects",
    localPath: "/home/tommy/Projects",
    remotePath: "C:\\Users\\tommy\\Projects",
    remoteDeviceId: "win-box",
    mode: "two-way",
    ignorePatterns: ["node_modules/"],
    historyDays: 30,
    historyMaxBytes: 5_000_000_000,
  }

  test("accepts a well-formed draft", () => {
    expect(() => validateMappingInput(draft)).not.toThrow()
  })

  test("rejects drafts outside the shared envelope with the existing user-facing messages", () => {
    expect(() => validateMappingInput({ ...draft, ignorePatterns: new Array(MAX_IGNORE_PATTERNS + 1).fill("*.log") })).toThrow(
      "Use no more than 256 ignore patterns.",
    )
    expect(() =>
      validateMappingInput({ ...draft, ignorePatterns: ["a".repeat(MAX_IGNORE_PATTERN_LENGTH + 1)] }),
    ).toThrow("An ignore pattern is invalid or too long.")
    expect(() => validateMappingInput({ ...draft, mode: "one-way" as AddFolderInput["mode"] })).toThrow(
      "The sync direction is invalid.",
    )
  })
})

describe("peer scan-manifest envelope", () => {
  test("accepts the scans our own UI sends", () => {
    const parsed = parsePeerScanManifest({ path: "/home/tommy/Projects", ignorePatterns: ["node_modules/"] })
    expect(parsed).toEqual({ path: "/home/tommy/Projects", ignorePatterns: ["node_modules/"] })
  })

  test("rejects pattern counts, lengths, and paths our UI could never send", () => {
    expect(() => parsePeerScanManifest({ path: "/data", ignorePatterns: new Array(257).fill("*.log") })).toThrow(
      "The manifest request is invalid.",
    )
    expect(() => parsePeerScanManifest({ path: "/data", ignorePatterns: ["a".repeat(513)] })).toThrow(
      "The manifest request is invalid.",
    )
    expect(() => parsePeerScanManifest({ path: "/data", ignorePatterns: ["ok", 7] })).toThrow(
      "The manifest request is invalid.",
    )
    expect(() => parsePeerScanManifest({ path: "", ignorePatterns: [] })).toThrow("The manifest request is invalid.")
    expect(() => parsePeerScanManifest({ path: "a".repeat(4097), ignorePatterns: [] })).toThrow(
      "The manifest request is invalid.",
    )
    expect(() => parsePeerScanManifest({ path: "/data\0x", ignorePatterns: [] })).toThrow(
      "The manifest request is invalid.",
    )
  })
})

describe("conflict input parsing", () => {
  test("accepts a well-formed conflict reference", () => {
    expect(() => validateConflictInput({ mappingId: "mapping-1", path: "notes/todo.txt" })).not.toThrow()
  })

  test("rejects empty, unbounded, and NUL-carrying references", () => {
    expect(() => validateConflictInput({ mappingId: "", path: "a.txt" })).toThrow("Choose a valid file conflict.")
    expect(() => validateConflictInput({ mappingId: "m", path: "" })).toThrow("Choose a valid file conflict.")
    expect(() => validateConflictInput({ mappingId: "m".repeat(201), path: "a.txt" })).toThrow(
      "The selected file conflict is invalid.",
    )
    expect(() => validateConflictInput({ mappingId: "m", path: "a\0b.txt" })).toThrow(
      "The selected file conflict is invalid.",
    )
  })

  test("accepts a well-formed inspected copy", () => {
    expect(parseConflictCopyExpectation({ deviceId: "linux-box", digest: DIGEST, size: 12 })).toEqual({
      deviceId: "linux-box",
      digest: DIGEST,
      size: 12,
    })
  })

  test("rejects malformed inspected copies", () => {
    expect(() => parseConflictCopyExpectation({ deviceId: "linux-box", digest: "not-a-digest", size: 1 })).toThrow(
      "The inspected conflict copy is invalid.",
    )
    expect(() => parseConflictCopyExpectation({ deviceId: "linux-box", digest: DIGEST, size: -1 })).toThrow(
      "The inspected conflict copy is invalid.",
    )
    expect(() => parseConflictCopyExpectation(null)).toThrow("The inspected conflict copy is invalid.")
  })

  const inspectedCopies = [
    { deviceId: "linux-box", digest: DIGEST, size: 10 },
    { deviceId: "win-box", digest: OTHER_DIGEST, size: 11 },
  ] as [ResolveFileConflictInput["inspectedCopies"][number], ResolveFileConflictInput["inspectedCopies"][number]]

  test("accepts a resolution whose winner matches one inspected copy", () => {
    expect(
      parseResolveFileConflictInput({
        mappingId: "mapping-1",
        path: "notes/todo.txt",
        winnerDeviceId: "win-box",
        inspectedCopies,
      }),
    ).toEqual({ mappingId: "mapping-1", path: "notes/todo.txt", winnerDeviceId: "win-box", inspectedCopies })
  })

  test("rejects resolutions with an unknown winner or duplicate devices", () => {
    expect(() =>
      parseResolveFileConflictInput({
        mappingId: "mapping-1",
        path: "a.txt",
        winnerDeviceId: "unknown-box",
        inspectedCopies,
      }),
    ).toThrow("The inspected conflict copies do not match this folder's participants.")
    expect(() =>
      parseResolveFileConflictInput({
        mappingId: "mapping-1",
        path: "a.txt",
        winnerDeviceId: "linux-box",
        inspectedCopies: [inspectedCopies[0], inspectedCopies[0]],
      }),
    ).toThrow("The inspected conflict copies do not match this folder's participants.")
    expect(() =>
      parseResolveFileConflictInput({ mappingId: "mapping-1", path: "a.txt", winnerDeviceId: "linux-box", inspectedCopies: [inspectedCopies[0]] }),
    ).toThrow("Refresh both conflict copies before choosing a version.")
  })

  function inspection(localDigest: string, remoteDigest: string): ConflictInspection {
    return {
      conflict: {
        mappingId: "mapping-1",
        folderName: "Projects",
        path: "notes/todo.txt",
        kind: "simultaneous-modification",
        localDeviceId: "linux-box",
        localDeviceName: "Linux",
        remoteDeviceId: "win-box",
        remoteDeviceName: "Windows",
        resolutionQueued: false,
        detail: "changed on both computers",
      },
      local: { deviceId: "linux-box", deviceName: "Linux", location: "this-computer", present: true, digest: localDigest, size: 10 },
      remote: { deviceId: "win-box", deviceName: "Windows", location: "paired-computer", present: true, digest: remoteDigest, size: 11 },
    }
  }

  test("passes unchanged copies and rejects a copy that moved under review", () => {
    const input: ResolveFileConflictInput = { mappingId: "mapping-1", path: "notes/todo.txt", winnerDeviceId: "win-box", inspectedCopies }
    expect(() => requireUnchangedInspectedCopies(input, inspection(DIGEST, OTHER_DIGEST))).not.toThrow()
    expect(() => requireUnchangedInspectedCopies(input, inspection(OTHER_DIGEST, OTHER_DIGEST))).toThrow(
      "One of the conflict copies changed since you reviewed it.",
    )
  })
})

describe("peer conflict parsing", () => {
  test("accepts absent and present copies", () => {
    expect(parsePeerConflictCopy({ present: false })).toEqual({ present: false })
    expect(parsePeerConflictCopy({ present: true, size: 4, modifiedMs: 8, digest: DIGEST })).toEqual({
      present: true,
      size: 4,
      modifiedMs: 8,
      digest: DIGEST,
    })
  })

  test("rejects present copies with invalid metadata", () => {
    expect(() => parsePeerConflictCopy({ present: true, size: 4, modifiedMs: 8, digest: "xyz" })).toThrow(
      "The paired computer returned invalid conflict file metadata.",
    )
    expect(() => parsePeerConflictCopy({ present: "yes" })).toThrow(
      "The paired computer returned invalid conflict availability.",
    )
  })

  test("accepts a well-formed exact choice and rejects anything else", () => {
    expect(
      parseExactConflictChoice({
        type: "resolve",
        direction: "pull-remote",
        localDigest: DIGEST,
        localSize: 1,
        remoteDigest: OTHER_DIGEST,
        remoteSize: 2,
      }),
    ).toEqual({ direction: "pull-remote", localDigest: DIGEST, localSize: 1, remoteDigest: OTHER_DIGEST, remoteSize: 2 })
    expect(() =>
      parseExactConflictChoice({ type: "resolve", direction: "sideways", localDigest: DIGEST, localSize: 1, remoteDigest: OTHER_DIGEST, remoteSize: 2 }),
    ).toThrow("The paired computer sent an invalid exact conflict choice.")
    expect(() =>
      parseExactConflictChoice({ type: "resolve", direction: "pull-remote", localDigest: DIGEST, localSize: -1, remoteDigest: OTHER_DIGEST, remoteSize: 2 }),
    ).toThrow("The paired computer sent an invalid exact conflict choice.")
  })

  test("enforces one-way mapping direction on conflict choices", () => {
    expect(() => requireAllowedConflictDirection("receive-only", "push-local")).toThrow(
      "That version conflicts with this folder's one-way direction.",
    )
    expect(() => requireAllowedConflictDirection("send-only", "pull-remote")).toThrow(
      "That version conflicts with this folder's one-way direction.",
    )
    expect(() => requireAllowedConflictDirection("two-way", "push-local")).not.toThrow()
    expect(() => requireAllowedConflictDirection("receive-only", "pull-remote")).not.toThrow()
  })
})

describe("peer transfer parsing", () => {
  const entry = { path: "docs/plan.txt", size: 9, modifiedMs: 3, digest: DIGEST }

  test("accepts a descriptor that still matches the compared manifest", () => {
    expect(() => validateTransferDescriptor(entry, { size: 9, modifiedMs: 3, digest: DIGEST })).not.toThrow()
  })

  test("rejects malformed or stale descriptors", () => {
    expect(() => validateTransferDescriptor(entry, { size: 9, modifiedMs: 3, digest: "tampered" })).toThrow(
      "The peer returned invalid transfer metadata for docs/plan.txt.",
    )
    expect(() => validateTransferDescriptor(entry, { size: 10, modifiedMs: 3, digest: DIGEST })).toThrow(
      "docs/plan.txt changed after the folders were compared.",
    )
    expect(() => validateTransferDescriptor(entry, { size: 9, modifiedMs: 3, digest: OTHER_DIGEST })).toThrow(
      "docs/plan.txt changed after the folders were compared.",
    )
  })

  test("accepts a well-formed initial-merge result", () => {
    expect(
      validateInitialSyncPassResult({ copiedFiles: 2, copiedBytes: 20, fileCount: 3, skipped: [{ path: "a.txt", reason: "diverged" }] }),
    ).toEqual({ copiedFiles: 2, copiedBytes: 20, fileCount: 3, skipped: [{ path: "a.txt", reason: "diverged" }] })
  })

  test("rejects unbounded or malformed merge results", () => {
    expect(() => validateInitialSyncPassResult({ copiedFiles: -1, copiedBytes: 0, fileCount: 0, skipped: [] })).toThrow(
      "The peer returned an invalid initial-merge result.",
    )
    expect(() =>
      validateInitialSyncPassResult({ copiedFiles: 0, copiedBytes: 0, fileCount: 0, skipped: new Array(10_001).fill({ path: "a", reason: "r" }) }),
    ).toThrow("The peer returned an invalid initial-merge result.")
    expect(() =>
      validateInitialSyncPassResult({ copiedFiles: 0, copiedBytes: 0, fileCount: 0, skipped: [{ path: "a".repeat(4_097), reason: "r" }] }),
    ).toThrow("The peer returned an invalid initial-merge result.")
  })

  test("accepts a well-formed continuous-sync operation", () => {
    expect(
      validateContinuousOperationRequest({ type: "op", folderId: "m", path: "a.txt", digest: DIGEST, size: 5 }),
    ).toEqual({ folderId: "m", path: "a.txt", digest: DIGEST, size: 5, expectedDestinationDigest: undefined })
  })

  test("rejects staging paths, bad digests, and negative sizes", () => {
    const base = { type: "op", folderId: "m", path: "a.txt", digest: DIGEST, size: 5 }
    expect(() => validateContinuousOperationRequest({ ...base, digest: "nope" })).toThrow(
      "The continuous-sync file operation is invalid.",
    )
    expect(() => validateContinuousOperationRequest({ ...base, size: -2 })).toThrow(
      "The continuous-sync file operation is invalid.",
    )
    expect(() =>
      validateContinuousOperationRequest({ ...base, path: "x.tethera-tmp-0123456789abcdef0123456789abcdef" }),
    ).toThrow("The continuous-sync file operation is invalid.")
  })

  test("accepts well-formed peer operation lists", () => {
    expect(
      parsePeerFileOperations({
        operations: [{ id: 1, path: "a.txt", direction: "pull-remote", sourceDigest: DIGEST, sourceSize: 5 }],
      }),
    ).toEqual([{ id: 1, path: "a.txt", direction: "pull-remote", sourceDigest: DIGEST, sourceSize: 5, expectedDestinationDigest: undefined }])
  })

  test("rejects unbounded lists and malformed operations", () => {
    expect(() => parsePeerFileOperations({ operations: new Array(10_001).fill({}) })).toThrow(
      "The paired computer returned invalid durable operation state.",
    )
    expect(() =>
      parsePeerFileOperations({ operations: [{ id: 0, path: "a.txt", direction: "pull-remote", sourceDigest: DIGEST, sourceSize: 1 }] }),
    ).toThrow("The paired computer returned an invalid durable operation.")
    expect(() =>
      parsePeerFileOperations({ operations: [{ id: 1, path: "a.txt", direction: "sideways", sourceDigest: DIGEST, sourceSize: 1 }] }),
    ).toThrow("The paired computer returned an invalid durable operation.")
    expect(() =>
      parsePeerFileOperations({ operations: [{ id: 1, path: "a.txt", direction: "pull-remote", sourceDigest: "bad", sourceSize: 1 }] }),
    ).toThrow("The paired computer returned an invalid durable operation.")
  })

  test("accepts positive operation ids and rejects the rest", () => {
    expect(validatePeerOperationId({ type: "op", operationId: 7 })).toBe(7)
    expect(() => validatePeerOperationId({ type: "op", operationId: 0 })).toThrow(
      "The continuous-sync operation identity is invalid.",
    )
    expect(() => validatePeerOperationId({ type: "op" })).toThrow("The continuous-sync operation identity is invalid.")
  })
})
