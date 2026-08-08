import { lstat, open, realpath, stat } from "node:fs/promises"
import { createHash } from "node:crypto"
import path from "node:path"
import { resolveWithinRoot } from "./path-safety"

/** Keeps base64 responses comfortably below the peer session's 16 MiB line limit. */
export const TRANSFER_CHUNK_BYTES = 512 * 1024

export interface TransferFileDescriptor {
  size: number
  modifiedMs: number
  digest: string
}

export interface TransferFileIdentity {
  size: number
  modifiedMs: number
}

/**
 * Opens an approved mapping-relative file without accepting a symlink escape, hashes it through
 * a bounded buffer, and confirms it stayed stable for the whole read.
 */
export async function describeTransferFile(rootPath: string, relativePath: string): Promise<TransferFileDescriptor> {
  const { absolutePath, handle, initial } = await openContainedRegularFile(rootPath, relativePath)
  try {
    const hash = createHash("sha256")
    const buffer = Buffer.allocUnsafe(TRANSFER_CHUNK_BYTES)
    let offset = 0
    while (offset < initial.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, initial.size - offset), offset)
      if (bytesRead === 0) throw new Error("The shared file changed while its transfer digest was being prepared.")
      hash.update(buffer.subarray(0, bytesRead))
      offset += bytesRead
    }
    const after = await handle.stat()
    assertStableIdentity(initial, after, absolutePath)
    return { size: initial.size, modifiedMs: initial.mtimeMs, digest: hash.digest("hex") }
  } finally {
    await handle.close()
  }
}

/** Reads one bounded range only if the file still matches the descriptor previously returned. */
export async function readTransferFileChunk(
  rootPath: string,
  relativePath: string,
  expected: TransferFileIdentity,
  offset: number,
  length: number,
): Promise<Buffer> {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("The requested file offset is invalid.")
  if (!Number.isSafeInteger(length) || length < 1 || length > TRANSFER_CHUNK_BYTES) {
    throw new Error(`File chunks must be between 1 and ${TRANSFER_CHUNK_BYTES} bytes.`)
  }
  if (!Number.isSafeInteger(expected.size) || expected.size < 0 || !Number.isFinite(expected.modifiedMs)) {
    throw new Error("The expected file identity is invalid.")
  }
  if (offset >= expected.size || offset + length > expected.size) throw new Error("The requested file range is invalid.")

  const { absolutePath, handle, initial } = await openContainedRegularFile(rootPath, relativePath)
  try {
    assertExpectedIdentity(initial, expected, absolutePath)
    const buffer = Buffer.allocUnsafe(length)
    let bytesRead = 0
    while (bytesRead < length) {
      const result = await handle.read(buffer, bytesRead, length - bytesRead, offset + bytesRead)
      if (result.bytesRead === 0) throw new Error("The shared file changed during transfer.")
      bytesRead += result.bytesRead
    }
    const after = await handle.stat()
    assertStableIdentity(initial, after, absolutePath)
    return buffer
  } finally {
    await handle.close()
  }
}

async function openContainedRegularFile(rootPath: string, relativePath: string) {
  const absolutePath = resolveWithinRoot(rootPath, relativePath)
  const entry = await lstat(absolutePath)
  if (entry.isSymbolicLink() || !entry.isFile()) throw new Error("The requested path is not a regular file.")

  const [canonicalRoot, canonicalFile] = await Promise.all([realpath(rootPath), realpath(absolutePath)])
  const relative = path.relative(canonicalRoot, canonicalFile)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("The requested file resolves outside the approved folder.")
  }

  const handle = await open(absolutePath, "r")
  const initial = await handle.stat()
  if (!initial.isFile()) {
    await handle.close()
    throw new Error("The requested path is not a regular file.")
  }
  if (entry.dev !== initial.dev || entry.ino !== initial.ino) {
    await handle.close()
    throw new Error("The requested file changed while it was being opened.")
  }
  return { absolutePath, handle, initial }
}

function assertExpectedIdentity(
  actual: { size: number; mtimeMs: number },
  expected: TransferFileIdentity,
  filePath: string,
): void {
  if (actual.size !== expected.size || actual.mtimeMs !== expected.modifiedMs) {
    throw new Error(`The shared file changed before its next chunk could be read: ${path.basename(filePath)}`)
  }
}

function assertStableIdentity(
  before: { size: number; mtimeMs: number },
  after: { size: number; mtimeMs: number },
  filePath: string,
): void {
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error(`The shared file changed while it was being read: ${path.basename(filePath)}`)
  }
}
