/** Preserve expected comparison errors across Electron invoke without its diagnostic prefix. */
export type FolderComparisonResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string }

export async function folderComparisonResult<T>(operation: () => Promise<T>): Promise<FolderComparisonResult<T>> {
  try {
    return { ok: true, value: await operation() }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unable to compare the folders. Please retry." }
  }
}

export function unwrapFolderComparisonResult<T>(result: FolderComparisonResult<T>): T {
  if (!result || typeof result !== "object" || typeof result.ok !== "boolean") {
    throw new Error("Tethera returned an invalid comparison response.")
  }
  if (result.ok) return result.value
  if (typeof result.error !== "string") throw new Error("Tethera returned an invalid comparison error.")
  throw new Error(result.error)
}
