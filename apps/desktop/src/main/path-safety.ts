import path from "node:path"

const TETHERA_STAGING_SUFFIX = /\.tethera-tmp-[a-f0-9]{32}(?:$|[\\/])/
const TETHERA_RECOVERY_ROOT = /(?:^|[\\/])\.tethera-recovery(?:$|[\\/])/

/** Staging and recovery names are reserved internal namespaces and never synchronize. */
export function isTetheraStagingPath(relativePath: string): boolean {
  return TETHERA_STAGING_SUFFIX.test(relativePath) || TETHERA_RECOVERY_ROOT.test(relativePath)
}

/**
 * Resolves a peer- or UI-supplied relative path under a trusted root, rejecting
 * absolute paths, drive letters, empty/"."/".." segments and any path that
 * would escape the root after resolution.
 */
export function resolveWithinRoot(root: string, relativePath: string): string {
  if (typeof relativePath !== "string" || relativePath.length === 0) throw new Error("A file path is required.")
  const normalized = relativePath.replaceAll("\\", "/")
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.includes("\0")) {
    throw new Error("The file path is invalid.")
  }
  const segments = normalized.split("/")
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("The file path is invalid.")
  }

  const resolvedRoot = path.resolve(root)
  const resolvedTarget = path.resolve(resolvedRoot, ...segments)
  const relativeToRoot = path.relative(resolvedRoot, resolvedTarget)
  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    throw new Error("The file path escapes the folder root.")
  }
  return resolvedTarget
}
