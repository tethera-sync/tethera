import { createReadStream } from "node:fs"
import { createHash } from "node:crypto"
import { opendir, stat } from "node:fs/promises"
import path from "node:path"
import type { FolderMappingPreview, MappingPreviewItem, SyncMode } from "../shared/contracts"

const MAX_MANIFEST_FILES = 10_000
const MAX_HASH_FILE_BYTES = 16 * 1024 * 1024
const MAX_SAMPLE_ITEMS = 14

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

export async function scanFolder(rootPath: string, ignorePatterns: string[]): Promise<FileManifest> {
  const root = path.resolve(rootPath)
  const rootStat = await stat(root)
  if (!rootStat.isDirectory()) throw new Error("The selected path is not a folder.")

  const matcher = createIgnoreMatcher(ignorePatterns)
  const files: FileManifestEntry[] = []
  let ignored = 0
  let unreadable = 0
  let truncated = false

  async function visit(directoryPath: string, relativeDirectory: string): Promise<void> {
    if (truncated) return
    let directory
    try {
      directory = await opendir(directoryPath)
    } catch {
      unreadable += 1
      return
    }

    for await (const entry of directory) {
      if (truncated) break
      const relativePath = normalizeRelative(path.join(relativeDirectory, entry.name))
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
      if (files.length >= MAX_MANIFEST_FILES) {
        truncated = true
        break
      }
      try {
        const metadata = await stat(absolutePath)
        files.push({
          path: relativePath,
          size: metadata.size,
          modifiedMs: metadata.mtimeMs,
          digest: metadata.size <= MAX_HASH_FILE_BYTES ? await hashFile(absolutePath) : undefined,
        })
      } catch {
        unreadable += 1
      }
    }
  }

  await visit(root, "")
  return { rootPath: root, files, ignored, unreadable, truncated }
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

    const digestMatch = Boolean(localEntry.digest && remoteEntry.digest && localEntry.digest === remoteEntry.digest)
    const metadataMatch =
      !localEntry.digest &&
      !remoteEntry.digest &&
      localEntry.size === remoteEntry.size &&
      Math.abs(localEntry.modifiedMs - remoteEntry.modifiedMs) <= 2_000
    if (digestMatch || metadataMatch) {
      identicalFiles += 1
      continue
    }

    differentFiles += 1
    if (options.mode === "send-only") bytesToRemote += localEntry.size
    else if (options.mode === "receive-only") bytesToLocal += remoteEntry.size
    else if (localEntry.modifiedMs >= remoteEntry.modifiedMs) bytesToRemote += localEntry.size
    else bytesToLocal += remoteEntry.size
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
  if (samples.length < MAX_SAMPLE_ITEMS) samples.push(sample)
}

function normalizeRelative(relativePath: string): string {
  return relativePath.replaceAll("\\", "/").replace(/^\.\//, "")
}

function createIgnoreMatcher(patterns: string[]): (relativePath: string, directory: boolean) => boolean {
  const rules = patterns
    .map((pattern) => pattern.trim().replaceAll("\\", "/").replace(/^\.\//, ""))
    .filter((pattern) => pattern && !pattern.startsWith("#"))
    .map((pattern) => {
      const directoryOnly = pattern.endsWith("/")
      const normalizedPattern = directoryOnly ? pattern.slice(0, -1) : pattern
      return {
        directoryOnly,
        regex: globToRegExp(normalizedPattern),
        basenameOnly: !normalizedPattern.includes("/"),
      }
    })

  return (relativePath, directory) => {
    const normalized = normalizeRelative(relativePath)
    const basename = normalized.split("/").at(-1) ?? normalized
    return rules.some((rule) => {
      if (rule.directoryOnly && !directory) return false
      return rule.regex.test(rule.basenameOnly ? basename : normalized)
    })
  }
}

function globToRegExp(pattern: string): RegExp {
  let source = ""
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]
    const next = pattern[index + 1]
    if (character === "*" && next === "*") {
      source += ".*"
      index += 1
    } else if (character === "*") source += "[^/]*"
    else if (character === "?") source += "[^/]"
    else source += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
  }
  return new RegExp(`^${source}$`, "i")
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256")
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath)
    stream.on("data", (chunk) => hash.update(chunk))
    stream.once("error", reject)
    stream.once("end", resolve)
  })
  return hash.digest("hex")
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
