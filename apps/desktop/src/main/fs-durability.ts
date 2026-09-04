import { open } from "node:fs/promises"

/**
 * Fsyncs a directory so atomic file commits survive a crash.
 *
 * Owns the single directory-durability primitive shared by state writes,
 * legacy-mapping backups, and version-archive operations. No-op on Windows,
 * where opening a directory handle is unsupported.
 */
export async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return
  const handle = await open(directory, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}
