import { createHash } from "node:crypto"
import type { FileManifest } from "../src/main/folder-manifest"

/** Builds a minimal in-memory manifest for comparison and sync-plan tests. */
export function manifest(files: FileManifest["files"]): FileManifest {
  return { rootPath: "/tmp/test", files, ignored: 0, unreadable: 0, truncated: false }
}

/** Lowercase SHA-256 hex digest used to build deterministic fixtures. */
export function sha256Hex(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex")
}
