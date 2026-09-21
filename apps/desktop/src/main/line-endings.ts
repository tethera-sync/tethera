import { createHash } from "node:crypto"
import type { FileSyncDirection } from "./continuous-sync"

const CARRIAGE_RETURN = 0x0d
const LINE_FEED = 0x0a
const CARRIAGE_RETURN_BYTE = Buffer.from([CARRIAGE_RETURN])

export interface TextDigestHasher {
  update(chunk: Buffer): void
  /** Undefined when the content held a NUL byte, which is how git also tells binary from text. */
  digest(): string | undefined
}

/**
 * Hashes content as text with every CRLF read as LF, so two copies that differ
 * only in Windows and Unix line endings share one digest. A lone CR is kept, and
 * a CRLF split across two chunks is still recognised.
 */
export function createTextDigestHasher(): TextDigestHasher {
  const hash = createHash("sha256")
  let binary = false
  let pendingCarriageReturn = false
  return {
    update(chunk) {
      if (binary || chunk.length === 0) return
      if (chunk.includes(0)) {
        binary = true
        return
      }
      if (pendingCarriageReturn && chunk[0] !== LINE_FEED) hash.update(CARRIAGE_RETURN_BYTE)
      pendingCarriageReturn = false
      let start = 0
      for (let index = chunk.indexOf(CARRIAGE_RETURN); index !== -1; index = chunk.indexOf(CARRIAGE_RETURN, index + 1)) {
        if (index === chunk.length - 1) {
          hash.update(chunk.subarray(start, index))
          pendingCarriageReturn = true
          return
        }
        if (chunk[index + 1] === LINE_FEED) {
          hash.update(chunk.subarray(start, index))
          start = index + 1
        }
      }
      hash.update(chunk.subarray(start))
    },
    digest() {
      if (binary) return undefined
      if (pendingCarriageReturn) hash.update(CARRIAGE_RETURN_BYTE)
      return hash.digest("hex")
    },
  }
}

export interface TextCopy {
  digest: string
  textDigest?: string
}

/**
 * The direction that settles two copies holding the same text in different line
 * endings, or undefined when they are not exactly that. The copy already using
 * LF throughout is kept: it is the form git stores, so neither working tree is
 * left showing every line as modified. Copies that both mix in some CRLF have
 * no such answer and stay a conflict.
 */
export function lineEndingOnlyDirection(local: TextCopy, remote: TextCopy): FileSyncDirection | undefined {
  if (local.textDigest === undefined || local.textDigest !== remote.textDigest || local.digest === remote.digest) {
    return undefined
  }
  const localUsesLf = local.digest === local.textDigest
  const remoteUsesLf = remote.digest === remote.textDigest
  if (localUsesLf === remoteUsesLf) return undefined
  return localUsesLf ? "push-local" : "pull-remote"
}
