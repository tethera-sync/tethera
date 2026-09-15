import * as nodeFs from "node:fs"

/**
 * Filesystem access for synchronized folders, their staging files and the
 * version archive.
 *
 * Electron's asar support patches `fs` so any `*.asar` file is reported as a
 * directory. A synchronized folder can hold ordinary `.asar` files (every
 * packaged Electron app has one), which could then be neither scanned nor
 * copied. Electron's unpatched `original-fs` sees the real file. It is not a
 * Node built-in, so it is looked up at runtime rather than bundled; outside
 * Electron (tests) plain `node:fs` already behaves this way.
 */
function loadSyncedFilesystem(): typeof nodeFs {
  if (!process.versions.electron) return nodeFs
  const original = process.getBuiltinModule("original-fs")
  if (!original) throw new Error("Electron's original-fs module is unavailable.")
  // `original-fs` is Electron's copy of `node:fs` without the asar patch.
  return original as typeof nodeFs
}

const syncedFilesystem = loadSyncedFilesystem()

export const { constants, watch } = syncedFilesystem
export const { chmod, link, lstat, mkdir, open, opendir, readdir, realpath, rename, stat, statfs, unlink } = syncedFilesystem.promises
