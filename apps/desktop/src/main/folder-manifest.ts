import { createHash } from "node:crypto"
import { lstat, open, opendir, realpath, stat } from "node:fs/promises"
import path from "node:path"
import type { FolderMappingPreview, FolderScanActivity, MappingPreviewItem, SyncMode } from "../shared/contracts"
import { isTetheraStagingPath, resolveWithinRoot } from "./path-safety"

export const DEFAULT_MAX_MANIFEST_FILES = 10_000
const MAX_HASH_FILE_BYTES = 16 * 1024 * 1024
const MAX_SAMPLE_ITEMS = 14
const SCAN_ACTIVITY_INTERVAL_MS = 250

export interface FileManifestEntry {
  path: string
  size: number
  modifiedMs: number
  digest?: string
}

export interface FileManifest {
  rootPath: string
  files: FileManifestEntry[]
  ignored: number
  unreadable: number
  truncated: boolean
}

export interface CompareManifestOptions {
  mode: SyncMode
  localPlatform: "linux" | "windows" | "unknown"
  remotePlatform: "linux" | "windows" | "unknown"
}

export interface ScanFolderOptions {
  /** Hash every file for a transfer decision; preview scans retain the bounded fast path. */
  hashAllFiles?: boolean
  /**
   * Ceiling on collected files before the manifest reports `truncated`.
   * `undefined` (the default) resolves to `DEFAULT_MAX_MANIFEST_FILES`;
   * `null` removes the ceiling for an explicitly opted-in unbounded scan.
   * A number must be a positive safe integer; anything else fails closed.
   */
  maxFiles?: number | null
  /** Time-throttled local activity, including long hashes and scans of small folders. */
  onActivity?: (activity: FolderScanActivity) => void
}

export async function scanFolder(
  rootPath: string,
  ignorePatterns: string[],
  options: ScanFolderOptions = {},
): Promise<FileManifest> {
  const root = path.resolve(rootPath)
  const rootStat = await stat(root)
  if (!rootStat.isDirectory()) throw new Error("The selected path is not a folder.")
  const canonicalRoot = await realpath(root)

  const matcher = createIgnoreMatcher(ignorePatterns)
  const files: FileManifestEntry[] = []
  let ignored = 0
  let unreadable = 0
  let truncated = false
  const maxFiles = resolveScanLimit(options.maxFiles)
  let hashedBytes = 0
  let lastActivityAt = -Infinity
  function reportActivity(stage: FolderScanActivity["stage"], currentPath: string, force = false): void {
    if (!options.onActivity) return
    const now = performance.now()
    if (!force && now - lastActivityAt < SCAN_ACTIVITY_INTERVAL_MS) return
    lastActivityAt = now
    try {
      options.onActivity({ stage, currentPath, scannedFiles: files.length, ignoredEntries: ignored, unreadableEntries: unreadable, hashedBytes })
    } catch {
      // Advisory UI delivery must never change the scan result.
    }
  }

  async function visit(directoryPath: string, relativeDirectory: string): Promise<void> {
    if (truncated) return
    reportActivity("listing", relativeDirectory)
    let directory: Awaited<ReturnType<typeof opendir>> | undefined
    try {
      directory = await opendir(directoryPath)
      const canonicalDirectory = await realpath(directoryPath)
      if (!isCanonicalPathInside(canonicalRoot, canonicalDirectory)) {
        await directory.close()
        unreadable += 1
        return
      }
    } catch {
      await directory?.close().catch(() => undefined)
      unreadable += 1
      return
    }

    for await (const entry of directory) {
      if (truncated) break
      reportActivity("listing", relativeDirectory)
      const relativePath = normalizeRelative(path.join(relativeDirectory, entry.name))
      if (isTetheraStagingPath(relativePath)) {
        ignored += 1
        continue
      }
      if (matcher(relativePath, entry.isDirectory())) {
        ignored += 1
        continue
      }
      const absolutePath = path.join(directoryPath, entry.name)
      if (entry.isSymbolicLink()) {
        ignored += 1
        continue
      }
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath)
        continue
      }
      if (!entry.isFile()) continue
      if (files.length >= maxFiles) {
        truncated = true
        break
      }
      try {
        reportActivity("inspecting", relativePath)
        files.push(await inspectManifestFile(root, canonicalRoot, relativePath, options.hashAllFiles === true, (bytesRead) => {
          hashedBytes += bytesRead
          reportActivity("hashing", relativePath)
        }))
      } catch {
        unreadable += 1
        continue
      }
    }
  }

  await visit(root, "")
  reportActivity("complete", "", true)
  return { rootPath: root, files, ignored, unreadable, truncated }
}

/**
 * Decides whether two same-path manifest entries describe identical content.
 * A matching full-content digest wins; without digests, size plus a 2-second
 * mtime tolerance applies. Mixed digest presence never matches.
 */
export function manifestEntriesMatch(a: FileManifestEntry, b: FileManifestEntry): boolean {
  if (a.digest || b.digest) {
    return Boolean(a.digest && b.digest && a.digest === b.digest)
  }
  return a.size === b.size && Math.abs(a.modifiedMs - b.modifiedMs) <= 2_000
}

export function compareManifests(
  local: FileManifest,
  remote: FileManifest,
  options: CompareManifestOptions,
): FolderMappingPreview {
  const localByPath = new Map(local.files.map((entry) => [entry.path, entry]))
  const remoteByPath = new Map(remote.files.map((entry) => [entry.path, entry]))
  const paths = [...new Set([...localByPath.keys(), ...remoteByPath.keys()])].sort((a, b) => a.localeCompare(b))

  let identicalFiles = 0
  let differentFiles = 0
  let localOnlyFiles = 0
  let remoteOnlyFiles = 0
  let bytesToRemote = 0
  let bytesToLocal = 0
  const samples: MappingPreviewItem[] = []

  for (const relativePath of paths) {
    const localEntry = localByPath.get(relativePath)
    const remoteEntry = remoteByPath.get(relativePath)
    if (localEntry && !remoteEntry) {
      localOnlyFiles += 1
      if (options.mode !== "receive-only") bytesToRemote += localEntry.size
      addSample(samples, { path: relativePath, category: "local-only", size: localEntry.size })
      continue
    }
    if (remoteEntry && !localEntry) {
      remoteOnlyFiles += 1
      if (options.mode !== "send-only") bytesToLocal += remoteEntry.size
      addSample(samples, { path: relativePath, category: "remote-only", size: remoteEntry.size })
      continue
    }
    if (!localEntry || !remoteEntry) continue

    if (manifestEntriesMatch(localEntry, remoteEntry)) {
      identicalFiles += 1
      continue
    }

    differentFiles += 1
    // The initial merge is additive-only. Same-path differences are surfaced and left untouched
    // until durable revisions and history exist, so they must not inflate transfer estimates.
    addSample(samples, { path: relativePath, category: "different", size: Math.max(localEntry.size, remoteEntry.size) })
  }

  const invalidWindowsNames = new Set<string>()
  const caseCollisions = new Set<string>()
  if (options.remotePlatform === "windows" && options.mode !== "receive-only") {
    for (const entry of local.files) if (hasWindowsInvalidPath(entry.path)) invalidWindowsNames.add(entry.path)
    for (const collision of findCaseCollisions(local.files)) caseCollisions.add(collision)
  }
  if (options.localPlatform === "windows" && options.mode !== "send-only") {
    for (const entry of remote.files) if (hasWindowsInvalidPath(entry.path)) invalidWindowsNames.add(entry.path)
    for (const collision of findCaseCollisions(remote.files)) caseCollisions.add(collision)
  }

  for (const invalid of [...invalidWindowsNames].slice(0, 4)) addSample(samples, { path: invalid, category: "invalid-name" })
  for (const collision of [...caseCollisions].slice(0, 4)) addSample(samples, { path: collision, category: "case-collision" })

  return {
    localFiles: local.files.length,
    remoteFiles: remote.files.length,
    identicalFiles,
    differentFiles,
    localOnlyFiles,
    remoteOnlyFiles,
    ignoredLocal: local.ignored + local.unreadable,
    ignoredRemote: remote.ignored + remote.unreadable,
    bytesToRemote,
    bytesToLocal,
    invalidWindowsNames: [...invalidWindowsNames].slice(0, 100),
    caseCollisions: [...caseCollisions].slice(0, 100),
    truncated: local.truncated || remote.truncated,
    samples,
  }
}

function addSample(samples: MappingPreviewItem[], sample: MappingPreviewItem): void {
  samples.push(sample)
  samples.sort((a, b) => (b.size ?? 0) - (a.size ?? 0) || a.path.localeCompare(b.path) || a.category.localeCompare(b.category))
  if (samples.length > MAX_SAMPLE_ITEMS) samples.pop()
}

function normalizeRelative(relativePath: string): string {
  return relativePath.replaceAll("\\", "/").replace(/^\.\//, "")
}

function resolveScanLimit(maxFiles: number | null | undefined): number {
  if (maxFiles === undefined) return DEFAULT_MAX_MANIFEST_FILES
  if (maxFiles === null) return Number.POSITIVE_INFINITY
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1) throw new Error("The scan limit is invalid.")
  return maxFiles
}

/**
 * Compiles one ignore-file line into its regex rule(s), mirroring
 * `sync-core::manifest::build_rule` so both scanners prune the same trees.
 *
 * A pattern normally becomes exactly one rule. A pattern ending in `/**`
 * additionally emits a derived directory-only rule for the prefix itself:
 * without it the main regex only matches paths *inside* the directory, so
 * the walk would still open an excluded directory and count every entry
 * underneath one at a time instead of pruning the subtree.
 */
function buildIgnoreRule(pattern: string): Array<{ directoryOnly: boolean; basenameOnly: boolean; regex: RegExp }> | undefined {
  const normalized = pattern.trim().replaceAll("\\", "/").replace(/^\.\//, "")
  if (!normalized || normalized.startsWith("#")) return undefined
  const directoryOnly = normalized.endsWith("/")
  const source = directoryOnly ? normalized.slice(0, -1) : normalized
  // The size envelope is UTF-8 bytes, mirroring Rust's `str::len`, not UTF-16 code units.
  if (!source || Buffer.byteLength(source, "utf8") > 512) return undefined
  // Anchoring is decided from the full pattern, before `**` is parsed away:
  // any pattern containing a slash is anchored to the scan root.
  const basenameOnly = !source.includes("/")
  const regex = globToRegExp(source)
  if (!regex) return undefined
  const rules = [{ directoryOnly, basenameOnly, regex }]
  if (source.endsWith("/**")) {
    const prefix = source.slice(0, -3)
    if (prefix) {
      const prefixRegex = globToRegExp(prefix)
      if (!prefixRegex) return undefined
      rules.push({ directoryOnly: true, basenameOnly, regex: prefixRegex })
    }
  }
  return rules
}

function createIgnoreMatcher(patterns: string[]): (relativePath: string, directory: boolean) => boolean {
  const rules = patterns.flatMap((pattern) => buildIgnoreRule(pattern) ?? [])

  return (relativePath, directory) => {
    const normalized = normalizeRelative(relativePath)
    const basename = normalized.split("/").at(-1) ?? normalized
    return rules.some((rule) => {
      if (rule.directoryOnly && !directory) return false
      return rule.regex.test(rule.basenameOnly ? basename : normalized)
    })
  }
}

/** Applies manifest ignore rules to a direct file request, including ignored parent folders. */
export function isManifestPathIgnored(relativePath: string, patterns: string[]): boolean {
  const normalized = normalizeRelative(relativePath)
  const matcher = createIgnoreMatcher(patterns)
  if (matcher(normalized, false)) return true
  const segments = normalized.split("/")
  for (let index = 1; index < segments.length; index += 1) {
    if (matcher(segments.slice(0, index).join("/"), true)) return true
  }
  return false
}

/**
 * Compiles a gitignore-flavoured glob body to an anchored case-insensitive
 * regex, mirroring `sync-core::manifest::glob_to_regex`.
 *
 * A double star is positional, not a bare wildcard: a leading double star
 * plus slash matches zero or more leading segments, a slash plus double
 * star plus slash in the middle matches zero or more segments between two
 * literals, a trailing slash plus double star matches a slash followed by
 * anything, and any other double star falls back to `.*`. A single `*` or
 * `?` stays within one segment.
 *
 * The unicode flag keeps `?` and negated classes on full code points, as
 * Rust matches on `char`s. Returns `undefined` when the pattern cannot
 * compile, so the caller skips the rule instead of throwing into the scan.
 */
function globToRegExp(pattern: string): RegExp | undefined {
  // A lone surrogate compiles under the unicode flag and would match
  // itself, but it can never equal a Rust `str` or a real filename, so it
  // must not become a rule.
  if (hasUnpairedSurrogate(pattern)) return undefined
  let source = ""
  let index = 0
  while (index < pattern.length) {
    if (index === 0 && pattern.startsWith("**/", index)) {
      source += "(?:.*/)?"
      index += 3
    } else if (pattern.startsWith("/**/", index)) {
      source += "/(?:.*/)?"
      index += 4
    } else if (index + 3 === pattern.length && pattern.startsWith("/**", index)) {
      source += "/.*"
      index += 3
    } else if (pattern.startsWith("**", index)) {
      source += ".*"
      index += 2
    } else if (pattern[index] === "*") {
      source += "[^/]*"
      index += 1
    } else if (pattern[index] === "?") {
      source += "[^/]"
      index += 1
    } else {
      source += pattern[index]?.replace(/[|\\{}()[\]^$+?.]/g, "\\$&") ?? ""
      index += 1
    }
  }
  try {
    return new RegExp(`^${source}$`, "iu")
  } catch {
    return undefined
  }
}

/** Whether the value holds a UTF-16 surrogate without its partner. */
function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1
        continue
      }
      return true
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true
  }
  return false
}

async function inspectManifestFile(
  rootPath: string,
  canonicalRoot: string,
  relativePath: string,
  hashAllFiles: boolean,
  onHashBytes?: (bytesRead: number) => void,
): Promise<FileManifestEntry> {
  const absolutePath = resolveWithinRoot(rootPath, relativePath)
  const entry = await lstat(absolutePath)
  if (entry.isSymbolicLink() || !entry.isFile()) throw new Error("The manifest path is not a regular file.")
  const canonicalFile = await realpath(absolutePath)
  if (!isCanonicalPathInside(canonicalRoot, canonicalFile)) throw new Error("The manifest file escapes the folder root.")

  const handle = await open(absolutePath, "r")
  try {
    const initial = await handle.stat()
    if (!initial.isFile() || initial.dev !== entry.dev || initial.ino !== entry.ino) {
      throw new Error("The manifest file changed while it was opened.")
    }
    let digest: string | undefined
    if (hashAllFiles || initial.size <= MAX_HASH_FILE_BYTES) {
      const hash = createHash("sha256")
      const buffer = Buffer.allocUnsafe(512 * 1024)
      let offset = 0
      while (offset < initial.size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, initial.size - offset), offset)
        if (bytesRead === 0) throw new Error("The manifest file changed while it was read.")
        hash.update(buffer.subarray(0, bytesRead))
        offset += bytesRead
        onHashBytes?.(bytesRead)
      }
      digest = hash.digest("hex")
    }
    const after = await handle.stat()
    if (initial.size !== after.size || initial.mtimeMs !== after.mtimeMs) {
      throw new Error("The manifest file changed while it was read.")
    }
    return { path: relativePath, size: initial.size, modifiedMs: initial.mtimeMs, digest }
  } finally {
    await handle.close()
  }
}

function isCanonicalPathInside(canonicalRoot: string, canonicalCandidate: string): boolean {
  const relative = path.relative(canonicalRoot, canonicalCandidate)
  return !relative.startsWith("..") && !path.isAbsolute(relative)
}

function hasWindowsInvalidPath(relativePath: string): boolean {
  const reserved = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i
  return relativePath.split("/").some((segment) => {
    if (!segment || segment.endsWith(".") || segment.endsWith(" ")) return true
    if (reserved.test(segment)) return true
    return /[<>:"|?*\u0000-\u001F]/.test(segment)
  })
}

function findCaseCollisions(files: FileManifestEntry[]): string[] {
  const seen = new Map<string, string>()
  const collisions = new Set<string>()
  for (const entry of files) {
    const folded = entry.path.toLocaleLowerCase("en-US")
    const previous = seen.get(folded)
    if (previous && previous !== entry.path) collisions.add(`${previous} ↔ ${entry.path}`)
    else seen.set(folded, entry.path)
  }
  return [...collisions]
}

export const folderManifestTestHelpers = {
  compareManifests,
  createIgnoreMatcher,
  findCaseCollisions,
  hasWindowsInvalidPath,
}
