import { createHash } from "node:crypto"

/**
 * Order-independent fingerprint of a folder observation: the same files,
 * each identified by path, size and digest, give the same value in any order.
 * Two sweeps with equal fingerprints saw the same files with the same content,
 * which is what lets an idle continuous cycle skip reconciliation.
 */
export class ObservationFingerprint {
  readonly #combined = Buffer.alloc(32)
  #count = 0

  add(path: string, size: number, digest: string): void {
    // Paths are unique within one observation, so XOR-combining per-file
    // hashes never cancels a real entry.
    const entryHash = createHash("sha256").update(JSON.stringify(["tethera-observation-v1", path, size, digest])).digest()
    for (let offset = 0; offset < entryHash.length; offset += 8) {
      this.#combined.writeBigUInt64LE(this.#combined.readBigUInt64LE(offset) ^ entryHash.readBigUInt64LE(offset), offset)
    }
    this.#count += 1
  }

  value(): string {
    return `${this.#count}:${this.#combined.toString("hex")}`
  }
}

const OBSERVATION_FINGERPRINT_PATTERN = /^[0-9]{1,10}:[0-9a-f]{64}$/

export function isObservationFingerprint(value: unknown): value is string {
  return typeof value === "string" && OBSERVATION_FINGERPRINT_PATTERN.test(value)
}

export function fingerprintObservation(files: Iterable<{ path: string; size: number; digest: string }>): string {
  const fingerprint = new ObservationFingerprint()
  for (const file of files) fingerprint.add(file.path, file.size, file.digest)
  return fingerprint.value()
}
