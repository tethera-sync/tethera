import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  describeTransferFile,
  readTransferFileChunk,
  TRANSFER_CHUNK_BYTES,
} from "../src/main/file-transfer"
import { writeFileChunksAtomic } from "../src/main/initial-sync"

describe("bounded transfer file reads", () => {
  test("describes and reads stable ranges with a full-file digest", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tethera-transfer-test-"))
    const content = Buffer.alloc(TRANSFER_CHUNK_BYTES + 17, 0x5a)
    try {
      await writeFile(path.join(root, "large.bin"), content)
      const descriptor = await describeTransferFile(root, "large.bin")
      const first = await readTransferFileChunk(root, "large.bin", descriptor, 0, TRANSFER_CHUNK_BYTES)
      const second = await readTransferFileChunk(
        root,
        "large.bin",
        descriptor,
        TRANSFER_CHUNK_BYTES,
        content.length - TRANSFER_CHUNK_BYTES,
      )
      expect(Buffer.concat([first, second])).toEqual(content)
      expect(descriptor.digest).toMatch(/^[a-f0-9]{64}$/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("rejects a file whose identity changed after it was described", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tethera-transfer-test-"))
    try {
      await writeFile(path.join(root, "changing.txt"), "before")
      const descriptor = await describeTransferFile(root, "changing.txt")
      await writeFile(path.join(root, "changing.txt"), "after and larger")
      await expect(readTransferFileChunk(root, "changing.txt", descriptor, 0, descriptor.size)).rejects.toThrow("changed")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("rejects a symlink that points outside the approved folder", async () => {
    if (process.platform === "win32") return
    const root = await mkdtemp(path.join(tmpdir(), "tethera-transfer-test-"))
    const outside = await mkdtemp(path.join(tmpdir(), "tethera-transfer-outside-"))
    try {
      await writeFile(path.join(outside, "secret.txt"), "secret")
      await symlink(path.join(outside, "secret.txt"), path.join(root, "escape.txt"))
      await expect(describeTransferFile(root, "escape.txt")).rejects.toThrow("regular file")
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  test("moves a file larger than the old whole-message limit through verified chunks", async () => {
    const source = await mkdtemp(path.join(tmpdir(), "tethera-transfer-source-"))
    const destination = await mkdtemp(path.join(tmpdir(), "tethera-transfer-destination-"))
    const content = Buffer.alloc(9 * 1024 * 1024 + 13, 0x6b)
    try {
      await writeFile(path.join(source, "large.bin"), content)
      const descriptor = await describeTransferFile(source, "large.bin")
      async function* chunks() {
        for (let offset = 0; offset < descriptor.size; offset += TRANSFER_CHUNK_BYTES) {
          const length = Math.min(TRANSFER_CHUNK_BYTES, descriptor.size - offset)
          yield await readTransferFileChunk(source, "large.bin", descriptor, offset, length)
        }
      }
      await writeFileChunksAtomic(destination, "large.bin", descriptor.size, descriptor.digest, chunks())
      expect(await readFile(path.join(destination, "large.bin"))).toEqual(content)
    } finally {
      await rm(source, { recursive: true, force: true })
      await rm(destination, { recursive: true, force: true })
    }
  })
})
