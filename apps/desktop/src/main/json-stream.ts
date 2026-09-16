/**
 * Streaming JSON serialisation for large messages.
 *
 * A sync check can list hundreds of thousands of files. Building such a
 * message with one `JSON.stringify` call holds all of it in memory at once,
 * and again as UTF-8 bytes when it is written. These helpers produce the same
 * text in bounded pieces instead. They follow `JSON.stringify` for the plain
 * data Tethera sends: objects, arrays, strings, numbers, booleans and null,
 * including `toJSON`, omitted object members and `undefined` array items.
 */

const DEFAULT_PIECE_CHARS = 64 * 1024

/** `JSON.stringify(value)` in pieces of roughly `pieceChars` characters. */
export function* jsonPieces(value: unknown, pieceChars = DEFAULT_PIECE_CHARS): Generator<string, void, void> {
  const resolved = resolveJsonValue(value, "")
  if (isOmitted(resolved)) throw new TypeError("The value has no JSON representation.")
  let pending = ""
  for (const token of valueTokens(resolved)) {
    pending += token
    if (pending.length >= pieceChars) {
      yield pending
      pending = ""
    }
  }
  if (pending) yield pending
}

/** UTF-8 byte length of `JSON.stringify(value)`, without building the whole string. */
export function jsonByteLength(value: unknown): number {
  let bytes = 0
  for (const piece of jsonPieces(value)) bytes += Buffer.byteLength(piece, "utf8")
  return bytes
}

/** Tokens for a value whose `toJSON` has already been applied. */
function* valueTokens(value: unknown): Generator<string, void, void> {
  if (Array.isArray(value)) {
    yield "["
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) yield ","
      const item = resolveJsonValue(value[index], String(index))
      if (isOmitted(item)) yield "null"
      // Most items are small records such as one file entry; one call is much cheaper than a token each.
      else if (isFlatRecord(item)) yield JSON.stringify(item)
      else yield* valueTokens(item)
    }
    yield "]"
    return
  }
  if (typeof value === "object" && value !== null) {
    yield "{"
    let first = true
    for (const [name, member] of Object.entries(value)) {
      const resolved = resolveJsonValue(member, name)
      if (isOmitted(resolved)) continue
      yield `${first ? "" : ","}${JSON.stringify(name)}:`
      first = false
      yield* valueTokens(resolved)
    }
    yield "}"
    return
  }
  // Primitives: JSON.stringify handles escaping, and turns NaN and Infinity into null.
  yield JSON.stringify(value)
}

function resolveJsonValue(value: unknown, key: string): unknown {
  if (typeof value === "object" && value !== null && "toJSON" in value && typeof value.toJSON === "function") {
    return value.toJSON(key)
  }
  return value
}

function isOmitted(value: unknown): boolean {
  return value === undefined || typeof value === "function" || typeof value === "symbol"
}

function isFlatRecord(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  if ("toJSON" in value) return false
  for (const member of Object.values(value)) {
    if (typeof member === "object" && member !== null) return false
  }
  return true
}
