import { lstat, realpath } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import type { DirectoryPathMapping } from "./directory-mapping"
import { resolveWithinRoot } from "./path-safety"

const decimal = z.string().regex(/^-?\d{1,20}$/)
const identitySchema = z.object({ device: decimal, inode: decimal, modifiedNs: decimal, changedNs: decimal }).strict()
const cleanupSchema = z.object({ identity: identitySchema, completed: z.boolean() }).strict().nullable()
type Identity = z.infer<typeof identitySchema>

interface CleanupRpc {
  request<T>(method: string, params: unknown): Promise<T>
}

async function directoryIdentity(root: string, relative: string): Promise<Identity | undefined> {
  const absolute = resolveWithinRoot(root, relative)
  // Never send a symlink/junction or a path through one to the desktop trash API.
  const canonicalRoot = await realpath(root)
  if (canonicalRoot !== path.resolve(root)) throw new Error("Folder cleanup requires a folder root without symbolic links.")
  let cursor = canonicalRoot
  try {
    for (const component of relative.split("/")) {
      cursor = path.join(cursor, component)
      const entry = await lstat(cursor)
      if (entry.isSymbolicLink() || !entry.isDirectory() || await realpath(cursor) !== cursor) {
        throw new Error("Folder cleanup cannot follow a symbolic link or a changed directory.")
      }
    }
    const entry = await lstat(absolute, { bigint: true })
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.dev === 0n || entry.ino === 0n) {
      throw new Error("The older folder's identity could not be verified.")
    }
    return { device: String(entry.dev), inode: String(entry.ino), modifiedNs: String(entry.mtimeNs), changedNs: String(entry.ctimeNs) }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
    throw error
  }
}

function sameIdentity(left: Identity, right: Identity): boolean {
  return left.device === right.device && left.inode === right.inode && left.modifiedNs === right.modifiedNs && left.changedNs === right.changedNs
}

/** Called only within an approved initial-merge lease. There is no permanent-delete fallback. */
export async function cleanupOlderDirectories(options: {
  rpc: CleanupRpc
  mappingId: string
  deviceId: string
  root: string
  routing: DirectoryPathMapping
  otherRoots: string[]
  trashItem(path: string): Promise<void>
}): Promise<number> {
  let removed = 0
  for (const mapping of options.routing.mappings) {
    const local = options.routing.side === "local"
    const selected = local ? mapping.localPath : mapping.remotePath
    for (const older of local ? mapping.olderLocalPaths : mapping.olderRemotePaths) {
      const request = { mappingId: options.mappingId, deviceId: options.deviceId, path: older }
      let stored = cleanupSchema.parse(await options.rpc.request("directoryMapping.cleanup", request))
      if (stored?.completed) continue
      const absolute = resolveWithinRoot(options.root, older)
      for (const root of options.otherRoots) {
        const relative = path.relative(absolute, await realpath(root))
        if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
          throw new Error("The older folder contains another configured sync folder. Remove that mapping before continuing.")
        }
      }
      const current = await directoryIdentity(options.root, older)
      if (!current) {
        if (stored) await options.rpc.request("directoryMapping.cleanup", { ...request, identity: stored.identity, complete: true })
        continue
      }
      const winner = await directoryIdentity(options.root, selected)
      if (!winner || (winner.device === current.device && winner.inode === current.inode) || BigInt(current.modifiedNs) > BigInt(winner.modifiedNs)) {
        throw new Error("The selected folders changed after comparison. Compare them again before removing an older folder.")
      }
      if (!stored) stored = cleanupSchema.parse(await options.rpc.request("directoryMapping.cleanup", { ...request, identity: current }))
      if (!stored || !sameIdentity(stored.identity, current)) throw new Error("The older folder changed; it has been preserved.")
      const rechecked = await directoryIdentity(options.root, older)
      if (!rechecked || !sameIdentity(current, rechecked)) throw new Error("The older folder changed before cleanup; it has been preserved.")
      await options.trashItem(absolute)
      await options.rpc.request("directoryMapping.cleanup", { ...request, identity: stored.identity, complete: true })
      removed += 1
    }
  }
  return removed
}
