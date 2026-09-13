import type { DirectoryMapping } from "../shared/directory-mapping"
import { directoryMappingsSchema } from "../shared/directory-mapping"
import type { FileManifest } from "./folder-manifest"

export interface DirectoryObservation {
  path: string
  modifiedMs: number
}

type Side = "local" | "remote"

const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0
const parentPath = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/")))
const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1)

/** A fixed approved projection; timestamps are never consulted during transfer or recovery. */
export class DirectoryPathMapping {
  readonly #byFoldedPath: ReadonlyMap<string, DirectoryMapping>

  constructor(readonly mappings: readonly DirectoryMapping[], readonly side: Side) {
    this.#byFoldedPath = new Map(mappings.map((mapping) => [mapping.path.toLowerCase(), mapping]))
  }

  /** Older sibling trees stay outside the logical manifest. */
  logicalPath(physicalPath: string, directory = false): string | undefined {
    const parts = physicalPath.split("/")
    let selected: DirectoryMapping | undefined
    let prefixLength = 0
    for (let count = 1; count <= parts.length - (directory ? 0 : 1); count += 1) {
      const prefix = parts.slice(0, count).join("/")
      const mapping = this.#byFoldedPath.get(prefix.toLowerCase())
      if (!mapping) continue
      if (prefix !== mapping[this.side === "local" ? "localPath" : "remotePath"]) return undefined
      selected = mapping
      prefixLength = count
    }
    return selected ? [selected.path, ...parts.slice(prefixLength)].join("/") : physicalPath
  }

  physicalPath(logicalPath: string, directory = false): string {
    const parts = logicalPath.split("/")
    for (let count = parts.length - (directory ? 0 : 1); count > 0; count -= 1) {
      const prefix = parts.slice(0, count).join("/")
      const mapping = this.#byFoldedPath.get(prefix.toLowerCase())
      if (!mapping) continue
      if (prefix !== mapping.path) throw new Error("The requested path does not match the approved folder spelling.")
      return [mapping[this.side === "local" ? "localPath" : "remotePath"], ...parts.slice(count)].join("/")
    }
    return logicalPath
  }
}

/** Selects by directory mtime, with a locale-independent spelling tie-breaker. */
export function planDirectoryMappings(local: DirectoryObservation[], remote: DirectoryObservation[]): DirectoryMapping[] {
  const groups = new Map<string, { local: DirectoryObservation[]; remote: DirectoryObservation[] }>()
  for (const [side, directories] of [["local", local], ["remote", remote]] as const) {
    for (const directory of directories) {
      const key = directory.path.toLowerCase()
      const group = groups.get(key) ?? { local: [], remote: [] }
      group[side].push(directory)
      groups.set(key, group)
    }
  }
  const mappings: DirectoryMapping[] = []
  const order = [...groups.keys()].sort((a, b) => a.split("/").length - b.split("/").length || compareText(a, b))
  const newest = (a: DirectoryObservation, b: DirectoryObservation): number => b.modifiedMs - a.modifiedMs || compareText(a.path, b.path)
  for (const key of order) {
    const group = groups.get(key)
    if (!group) continue
    const localPaths = new DirectoryPathMapping(mappings, "local")
    const remotePaths = new DirectoryPathMapping(mappings, "remote")
    const locals = group.local.filter((entry) => !parentPath(entry.path) || localPaths.logicalPath(parentPath(entry.path), true) !== undefined).sort(newest)
    const remotes = group.remote.filter((entry) => !parentPath(entry.path) || remotePaths.logicalPath(parentPath(entry.path), true) !== undefined).sort(newest)
    const leading = [...locals, ...remotes].sort(newest)[0]
    if (!leading) continue
    if (new Set([...locals, ...remotes].map((entry) => basename(entry.path))).size <= 1) continue
    const leadingPaths = locals.includes(leading) ? localPaths : remotePaths
    const parent = parentPath(leading.path)
    const logicalParent = parent ? leadingPaths.logicalPath(parent, true) : ""
    if (logicalParent === undefined) continue
    const path = [logicalParent, basename(leading.path)].filter(Boolean).join("/")
    mappings.push({
      path,
      localPath: locals[0]?.path ?? localPaths.physicalPath(path, true),
      remotePath: remotes[0]?.path ?? remotePaths.physicalPath(path, true),
      olderLocalPaths: locals.slice(1).map((entry) => entry.path).sort(compareText),
      olderRemotePaths: remotes.slice(1).map((entry) => entry.path).sort(compareText),
    })
  }
  return directoryMappingsSchema.parse(mappings)
}

export function projectDirectoryManifest(manifest: FileManifest, mapping: DirectoryPathMapping): FileManifest {
  let excluded = 0
  const files = manifest.files.flatMap((entry) => {
    const path = mapping.logicalPath(entry.path)
    if (path === undefined) { excluded += 1; return [] }
    return [{ ...entry, path }]
  })
  let excludedIssues = 0
  const unreadableEntries = manifest.unreadableEntries.flatMap((issue) => {
    const path = issue.path ? mapping.logicalPath(issue.path, issue.kind === "directory") : ""
    if (path === undefined) { excludedIssues += 1; return [] }
    return [{ ...issue, path }]
  })
  return { ...manifest, files, unreadableEntries, unreadable: manifest.unreadable - excludedIssues, ignored: manifest.ignored + excluded + excludedIssues }
}
