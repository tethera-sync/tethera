import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  EngineSupervisor,
  parseMappingStoreHealth,
  type EngineState,
} from "../src/main/engine-supervisor"

async function waitForUnavailable(supervisor: EngineSupervisor): Promise<Extract<EngineState, { status: "unavailable" }>> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      supervisor.off("state", onState)
      reject(new Error("The engine did not become unavailable in time."))
    }, 3_000)
    const onState = (state: EngineState) => {
      if (state.status !== "unavailable") return
      clearTimeout(timeout)
      supervisor.off("state", onState)
      resolve(state)
    }
    supervisor.on("state", onState)
  })
}

async function waitForReady(supervisor: EngineSupervisor): Promise<Extract<EngineState, { status: "ready" }>> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      supervisor.off("state", onState)
      reject(new Error("The engine did not become ready in time."))
    }, 3_000)
    const onState = (state: EngineState) => {
      if (state.status !== "ready") return
      clearTimeout(timeout)
      supervisor.off("state", onState)
      resolve(state)
    }
    supervisor.on("state", onState)
  })
}

function resolveNodeExecutable(): string {
  const executableNames = process.platform === "win32" ? ["node.exe", "node"] : ["node"]
  const candidates = new Set<string>()
  const pathExecutable = Bun.which("node")
  if (pathExecutable) candidates.add(pathExecutable)
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    for (const executableName of executableNames) candidates.add(path.join(directory, executableName))
  }
  candidates.add(process.execPath)
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    const result = spawnSync(candidate, ["-e", "process.stdout.write(process.versions.node)"], { encoding: "utf8" })
    if (result.status === 0 && /^\d+\.\d+\.\d+/.test(result.stdout.trim())) return candidate
  }
  throw new Error("A Node.js executable is required for the child-process lifecycle test.")
}

/**
 * A fake Rust engine fixture that mirrors the real engine's serial FIFO
 * contract (crates/sync-engine/src/main.rs): it answers `health` immediately,
 * then answers every other request strictly one at a time, in the order it
 * received them. Requests named "slow" or "never" simulate a request that is
 * genuinely still being served; every other method responds almost at once.
 */
function serialFixtureScript(): string {
  return [
    "let buffer = ''",
    "const queue = []",
    "let processing = false",
    "function respond(request, result) {",
    "  process.stdout.write(JSON.stringify({ id: request.id, ok: true, result }) + '\\n')",
    "}",
    "function processNext() {",
    "  if (processing || queue.length === 0) return",
    "  processing = true",
    "  const request = queue.shift()",
    "  const delay = request.method === 'slow' || request.method === 'never' ? 400 : 10",
    "  setTimeout(() => {",
    "    respond(request, { method: request.method })",
    "    processing = false",
    "    processNext()",
    "  }, delay)",
    "}",
    "process.stdin.on('data', (chunk) => {",
    "  buffer += chunk.toString()",
    "  let newline",
    "  while ((newline = buffer.indexOf('\\n')) >= 0) {",
    "    const line = buffer.slice(0, newline)",
    "    buffer = buffer.slice(newline + 1)",
    "    if (!line) continue",
    "    const request = JSON.parse(line)",
    "    if (request.method === 'health') {",
    "      respond(request, { name: 'fixture', version: '1', protocol: '4', mappingStore: { status: 'ready', schemaVersion: 4, journalMode: 'wal', migrationState: 'completed', mutationsEnabled: true } })",
    "      continue",
    "    }",
    "    queue.push(request)",
    "    processNext()",
    "  }",
    "})",
    "setInterval(() => {}, 1000)",
  ].join(";")
}

describe("engine mapping-store health contract", () => {
  test("accepts the bounded authoritative health shape", () => {
    expect(
      parseMappingStoreHealth({
        status: "ready",
        schemaVersion: 2,
        journalMode: "wal",
        migrationState: "completed",
        mutationsEnabled: true,
      }),
    ).toEqual({
      status: "ready",
      schemaVersion: 2,
      journalMode: "wal",
      migrationState: "completed",
      mutationsEnabled: true,
    })
  })

  test("an old engine without mapping-store health is incompatible, never an empty database", () => {
    expect(() => parseMappingStoreHealth(undefined)).toThrow("incompatible")
  })

  test("rejects unknown states and invalid schema versions", () => {
    expect(() => parseMappingStoreHealth({ status: "empty", mutationsEnabled: true })).toThrow("malformed")
    expect(() =>
      parseMappingStoreHealth({ status: "ready", schemaVersion: -0.5, mutationsEnabled: true }),
    ).toThrow("schema version")
  })

  test("cleans up an engine that cannot be spawned and allows an immediate restart", async () => {
    const supervisor = new EngineSupervisor()
    const testRoot = await mkdtemp(path.join(tmpdir(), "tethera-engine-supervisor-"))
    try {
      const firstUnavailable = waitForUnavailable(supervisor)
      supervisor.start({ command: path.join(testRoot, "missing-engine") })
      expect((await firstUnavailable).message).toContain("spawn")

      const secondUnavailable = waitForUnavailable(supervisor)
      const restartStartedAt = Date.now()
      await supervisor.restart()
      expect(Date.now() - restartStartedAt).toBeLessThan(2_000)
      await secondUnavailable
      expect(supervisor.generation).toBe(2)
    } finally {
      await supervisor.stop()
      await rm(testRoot, { recursive: true, force: true })
    }
  })

  // Bun's child_process emulation never surfaces a stdin EPIPE (the write
  // callback reports success even after the child closes its read end), so an
  // EPIPE-driven test cannot fail deterministically here. Drive the same
  // termination guarantee through the exit path instead: the pending request
  // is rejected and the supervisor becomes unavailable. The stdin
  // write-callback/EPIPE branch itself relies on Node stream semantics in the
  // Electron production runtime.
  test("rejects a pending request when the engine exits mid-request", async () => {
    const supervisor = new EngineSupervisor()
    try {
      const ready = waitForReady(supervisor)
      const script = [
        "let buffer = ''",
        "let seen = 0",
        "process.stdin.on('data', (chunk) => {",
        "  buffer += chunk.toString()",
        "  let newline",
        "  while ((newline = buffer.indexOf('\\n')) >= 0) {",
        "    const line = buffer.slice(0, newline)",
        "    buffer = buffer.slice(newline + 1)",
        "    if (!line) continue",
        "    seen += 1",
        "    const request = JSON.parse(line)",
        "    if (seen === 1) {",
        "      process.stdout.write(JSON.stringify({ id: request.id, ok: true, result: { name: 'fixture', version: '1', protocol: '4', mappingStore: { status: 'ready', schemaVersion: 4, journalMode: 'wal', migrationState: 'completed', mutationsEnabled: true } } }) + '\\n')",
        "    } else {",
        "      process.exit(1)",
        "    }",
        "  }",
        "})",
        "setInterval(() => {}, 1000)",
      ].join(";")
      supervisor.start({
        command: resolveNodeExecutable(),
        args: ["-e", script, "fixture"],
      })
      await ready
      const unavailable = waitForUnavailable(supervisor)
      await expect(supervisor.request("after-engine-exit", undefined, 2_000)).rejects.toThrow(
        "Rust engine stopped with code 1.",
      )
      await unavailable
    } finally {
      await supervisor.stop()
    }
  })

  test("a queued request does not time out while an earlier, slower request is still being served", async () => {
    const supervisor = new EngineSupervisor()
    try {
      const ready = waitForReady(supervisor)
      supervisor.start({ command: resolveNodeExecutable(), args: ["-e", serialFixtureScript(), "fixture"] })
      await ready

      // "slow" takes ~400ms to be served. "fast" is enqueued right behind it
      // with a budget (150ms) far shorter than that wait. Against the old
      // enqueue-time timer, "fast" would time out while still queued, even
      // though the engine is healthy and simply busy with the request ahead
      // of it in the FIFO.
      const slow = supervisor.request<{ method: string }>("slow", undefined, 5_000)
      const fast = supervisor.request<{ method: string }>("fast", undefined, 150)

      const [slowResult, fastResult] = await Promise.all([slow, fast])
      expect(slowResult).toEqual({ method: "slow" })
      expect(fastResult).toEqual({ method: "fast" })
    } finally {
      await supervisor.stop()
    }
  })

  test("a head request that never answers times out on its own budget, and the next queued request is then served normally", async () => {
    const supervisor = new EngineSupervisor()
    const warnings: unknown[][] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnings.push(args)
    }
    try {
      const ready = waitForReady(supervisor)
      supervisor.start({ command: resolveNodeExecutable(), args: ["-e", serialFixtureScript(), "fixture"] })
      await ready

      const never = supervisor.request<{ method: string }>("never", undefined, 150)
      const afterNever = supervisor.request<{ method: string }>("after-never", undefined, 5_000)

      await expect(never).rejects.toThrow("Rust engine request timed out: never")
      // The fixture still answers "never" ~400ms in, well after the client gave
      // up on it; that late response must be discarded, not silently ignored,
      // and must not disturb "after-never" becoming the new head and resolving.
      const afterNeverResult = await afterNever
      expect(afterNeverResult).toEqual({ method: "after-never" })

      expect(warnings.some((call) => String(call[0]).includes("unknown or already-settled"))).toBe(true)
    } finally {
      console.warn = originalWarn
      await supervisor.stop()
    }
  })
})
