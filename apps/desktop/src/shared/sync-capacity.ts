/**
 * Legacy full-manifest peer frame capacity contract: the single owner of the
 * encoded-byte budget and its estimator. Consumed today by Electron main
 * (`folder-manifest.ts`, `ipc-validation.ts`).
 *
 * It lives on the shared boundary and stays renderer-safe -- pure TypeScript,
 * no `node:` or Electron imports -- so the budget can never be restated as a
 * second, drifting copy on the renderer side. `Buffer` is unavailable in the
 * sandboxed renderer bundle, so byte lengths use `TextEncoder`, which is
 * byte-for-byte equivalent to `Buffer.byteLength(value, "utf8")`.
 */

/** Conservative ceiling for one legacy full-manifest peer frame, reserving room for JSON escaping, UTF-8, encryption/base64 and envelope overhead below the 16 MiB wire cap. */
export const MAX_LEGACY_MANIFEST_ENCODED_BYTES = 12 * 1024 * 1024

// Reused across every entry: the estimator runs once per file over manifests
// that can reach tens of thousands of paths.
const utf8 = new TextEncoder()

/** UTF-8 byte length of a string, equivalent to `Buffer.byteLength(value, "utf8")` without requiring `Buffer`. */
function utf8ByteLength(value: string): number {
  return utf8.encode(value).length
}

/**
 * Estimates the encrypted wire size of a legacy full-manifest response without
 * serializing it: per-entry UTF-8 path bytes plus JSON/envelope overhead,
 * expanded for base64 ciphertext. Used to fail closed before serialization.
 */
export function estimateManifestEncodedBytes(files: readonly { path: string; digest?: string }[]): number {
  let bytes = 256
  for (const entry of files) {
    bytes += utf8ByteLength(entry.path) * 2 + 128
    if (entry.digest) bytes += 64
  }
  // AES-GCM ciphertext base64 expansion plus the secure-frame envelope.
  return Math.ceil(bytes * 1.37) + 512
}
