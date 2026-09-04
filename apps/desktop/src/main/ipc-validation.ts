import { z } from "zod"
import type { AddFolderInput, AppSettings } from "../shared/contracts"

/**
 * Runtime validators for the renderer/IPC and peer/message boundaries.
 *
 * A compile-time TypeScript type on one side of IPC does not validate the
 * payload arriving from the other side, so every handler below parses its
 * input before acting on it. The ignore-pattern envelope mirrors
 * `validateMappingInput` in `index.ts` and the `manifest.scan` limits in the
 * Rust engine: anything our own UI can send passes, anything it could never
 * send fails closed.
 */
export const MAX_SCAN_PATH_LENGTH = 4096
export const MAX_IGNORE_PATTERNS = 256
export const MAX_IGNORE_PATTERN_LENGTH = 512

const pathString = z
  .string()
  .min(1)
  .max(MAX_SCAN_PATH_LENGTH)
  .refine((value) => !value.includes("\0"), "The path is invalid.")

const ignorePattern = z
  .string()
  .max(MAX_IGNORE_PATTERN_LENGTH)
  .refine((value) => !value.includes("\0"), "An ignore pattern is invalid or too long.")

export const ignorePatternsSchema = z.array(ignorePattern).max(MAX_IGNORE_PATTERNS)

/** Shape check for `shell:reveal-path`, which must never receive an unbounded string. */
export const revealPathSchema = pathString

export function parseRevealPath(value: unknown): string {
  const parsed = revealPathSchema.safeParse(value)
  if (!parsed.success) throw new Error("The selected path is invalid.")
  return parsed.data
}

const settingUpdateSchema = z.discriminatedUnion("key", [
  z.object({ key: z.literal("closeToTray"), value: z.boolean() }),
  z.object({ key: z.literal("launchAtLogin"), value: z.boolean() }),
  z.object({ key: z.literal("startMinimised"), value: z.boolean() }),
  z.object({ key: z.literal("pauseOnMetered"), value: z.boolean() }),
  z.object({ key: z.literal("theme"), value: z.enum(["system", "light", "dark"]) }),
])

export type SettingUpdate = z.infer<typeof settingUpdateSchema>

export function parseSettingUpdate(key: unknown, value: unknown): SettingUpdate {
  const parsed = settingUpdateSchema.safeParse({ key, value })
  if (!parsed.success) throw new Error("The requested setting change is invalid.")
  return parsed.data
}

/** Applies an already-validated update. The switch is exhaustive on purpose: adding a setting to the schema without handling it here is a compile error. */
export function applySettingUpdate(settings: AppSettings, update: SettingUpdate): AppSettings {
  switch (update.key) {
    case "closeToTray":
      return { ...settings, closeToTray: update.value }
    case "launchAtLogin":
      return { ...settings, launchAtLogin: update.value }
    case "startMinimised":
      return { ...settings, startMinimised: update.value }
    case "pauseOnMetered":
      return { ...settings, pauseOnMetered: update.value }
    case "theme":
      return { ...settings, theme: update.value }
    default: {
      const unexpected: never = update
      throw new Error(`Unsupported setting: ${JSON.stringify(unexpected)}`)
    }
  }
}

/** Validates a folder-mapping draft before any preview, scan, or peer request. Moved out of `index.ts` unchanged apart from sharing the envelope constants above. */
export function validateMappingInput(input: AddFolderInput): void {
  if (!input.localPath?.trim() || !input.remotePath?.trim()) throw new Error("Choose both folders before continuing.")
  if (!input.remoteDeviceId?.trim()) throw new Error("Choose a paired computer.")
  if (!(["two-way", "send-only", "receive-only"] as const).includes(input.mode)) throw new Error("The sync direction is invalid.")
  if (!Number.isInteger(input.historyDays) || input.historyDays < 1 || input.historyDays > 3_650) {
    throw new Error("Version history must be between 1 and 3,650 days.")
  }
  if (!Number.isSafeInteger(input.historyMaxBytes) || input.historyMaxBytes < 1024 ** 3 || input.historyMaxBytes > 4 * 1024 ** 4) {
    throw new Error("The history storage cap must be between 1 GB and 4 TB.")
  }
  if (!Array.isArray(input.ignorePatterns) || input.ignorePatterns.length > MAX_IGNORE_PATTERNS) {
    throw new Error("Use no more than 256 ignore patterns.")
  }
  if (
    input.ignorePatterns.some(
      (pattern) => typeof pattern !== "string" || pattern.length > MAX_IGNORE_PATTERN_LENGTH || pattern.includes("\0"),
    )
  ) {
    throw new Error("An ignore pattern is invalid or too long.")
  }
  if (input.name.length > 120) throw new Error("The folder name must be 120 characters or fewer.")
}

/** Envelope for a peer-requested `scan-manifest`: same limits our own UI enforces before sending one. */
const peerScanManifestSchema = z.object({
  path: pathString,
  ignorePatterns: ignorePatternsSchema,
})

export function parsePeerScanManifest(request: unknown): { path: string; ignorePatterns: string[] } {
  const parsed = peerScanManifestSchema.safeParse(request)
  if (!parsed.success) throw new Error("The manifest request is invalid.")
  return parsed.data
}
