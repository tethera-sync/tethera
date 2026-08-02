import { EventEmitter } from "node:events"
import { randomBytes, randomUUID } from "node:crypto"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import readline from "node:readline"

export type EngineState =
  | { status: "starting"; message: string }
  | { status: "ready"; message: string; mappingStore: MappingStoreHealth }
  | { status: "unavailable"; message: string }
  | { status: "error"; message: string }

export interface MappingStoreHealth {
  status: "ready" | "not-configured" | "unavailable" | "unsupported-schema" | "migration-failed"
  detail?: string
  schemaVersion?: number
  journalMode?: string
  migrationState?: "pending" | "completed" | "failed"
  mutationsEnabled: boolean
}

type RpcResponse = {
  id: string
  ok: boolean
  result?: unknown
  error?: string
  errorCode?: string
}

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timeout: NodeJS.Timeout
}

export interface EngineLaunchOptions {
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
}

export class EngineRpcError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = "EngineRpcError"
  }
}

export class EngineSupervisor extends EventEmitter {
  #child: ChildProcessWithoutNullStreams | null = null
  #sessionToken: string | null = null
  #launchOptions: EngineLaunchOptions | null = null
  #generation = 0
  #restartPromise: Promise<void> | null = null
  #intentionalStops = new WeakSet<ChildProcessWithoutNullStreams>()
  #pending = new Map<string, PendingRequest>()
  #state: EngineState = {
    status: "unavailable",
    message: "The Rust engine has not been started.",
  }

  get state(): EngineState {
    return this.#state
  }

  get generation(): number {
    return this.#generation
  }

  start(options: EngineLaunchOptions): void {
    if (this.#child) return

    this.#generation += 1

    this.#launchOptions = {
      ...options,
      args: options.args ? [...options.args] : undefined,
      env: options.env ? { ...options.env } : undefined,
    }

    this.#setState({ status: "starting", message: "Starting the Rust sync engine…" })
    this.#sessionToken = randomBytes(32).toString("base64url")

    try {
      const child = spawn(options.command, [...(options.args ?? []), "--rpc-stdio"], {
        cwd: options.cwd,
        env: {
          ...process.env,
          ...options.env,
          FOLDERSYNC_RPC_SESSION_TOKEN: this.#sessionToken,
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      })
      this.#child = child
    } catch (error) {
      this.#child = null
      this.#sessionToken = null
      this.#setState({
        status: "unavailable",
        message: error instanceof Error ? error.message : "Unable to launch the Rust engine.",
      })
      return
    }

    const child = this.#child
    const lines = readline.createInterface({ input: child.stdout })
    lines.on("line", (line: string) => this.#handleLine(line))

    child.stderr.on("data", (chunk: Buffer) => {
      const message = chunk.toString("utf8").trim()
      if (message) console.error(`[sync-engine] ${message}`)
    })

    child.once("error", (error: Error) => {
      if (this.#child !== child) return
      this.#setState({ status: "unavailable", message: error.message })
    })

    child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.#child !== child) return
      const message = `Rust engine stopped${code === null ? "" : ` with code ${code}`}${
        signal ? ` (${signal})` : ""
      }.`
      this.#rejectPending(new Error(message))
      this.#child = null
      this.#sessionToken = null
      if (!this.#intentionalStops.has(child)) this.#setState({ status: "unavailable", message })
    })

    void this.request<{ name: string; version: string; protocol: string; mappingStore?: unknown }>("health")
      .then((health) => {
        if (this.#child !== child) return
        const mappingStore = parseMappingStoreHealth(health.mappingStore)
        this.#setState({
          status: "ready",
          message: `${health.name} ${health.version} · protocol ${health.protocol}`,
          mappingStore,
        })
      })
      .catch((error: Error) => {
        if (this.#child !== child) return
        this.#setState({ status: "error", message: error.message })
      })
  }

  markUnavailable(message: string): void {
    if (this.#child) return
    this.#setState({ status: "unavailable", message })
  }

  async request<T>(method: string, params?: unknown, timeoutMs = 10_000): Promise<T> {
    if (!this.#child || !this.#sessionToken) {
      throw new Error("Rust sync engine is not running.")
    }

    const id = randomUUID()
    const body = JSON.stringify({ id, method, params, sessionToken: this.#sessionToken })

    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`Rust engine request timed out: ${method}`))
      }, timeoutMs)

      this.#pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      })

      this.#child?.stdin.write(`${body}\n`)
    })
  }

  async stop(): Promise<void> {
    const child = this.#child
    if (!child) return
    this.#intentionalStops.add(child)

    try {
      await this.request("shutdown")
    } catch {
      child.kill()
    }
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          child.kill()
          resolve()
        }, 2_000)
        child.once("exit", () => {
          clearTimeout(timeout)
          resolve()
        })
      })
    }
    if (this.#child === child) {
      this.#rejectPending(new Error("Rust engine stopped."))
      this.#child = null
      this.#sessionToken = null
    }
  }

  restart(): Promise<void> {
    if (this.#restartPromise) return this.#restartPromise
    const options = this.#launchOptions
    if (!options) return Promise.reject(new Error("The Rust engine has no launch configuration to retry."))
    const restart = (async () => {
      await this.stop()
      this.start(options)
    })()
    this.#restartPromise = restart
    void restart.then(
      () => {
        if (this.#restartPromise === restart) this.#restartPromise = null
      },
      () => {
        if (this.#restartPromise === restart) this.#restartPromise = null
      },
    )
    return restart
  }

  #handleLine(line: string): void {
    let response: RpcResponse
    try {
      response = JSON.parse(line) as RpcResponse
    } catch {
      console.error(`[sync-engine] Invalid response: ${line}`)
      return
    }

    const pending = this.#pending.get(response.id)
    if (!pending) return

    clearTimeout(pending.timeout)
    this.#pending.delete(response.id)

    if (response.ok) pending.resolve(response.result)
    else pending.reject(new EngineRpcError(response.error ?? "Unknown Rust engine error.", response.errorCode ?? "RPC_ERROR"))
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.#pending.clear()
  }

  #setState(state: EngineState): void {
    this.#state = state
    this.emit("state", state)
  }
}

export function parseMappingStoreHealth(value: unknown): MappingStoreHealth {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("The Rust engine is incompatible: health did not include mapping-store status.")
  }
  const health = value as Record<string, unknown>
  const statuses = ["ready", "not-configured", "unavailable", "unsupported-schema", "migration-failed"]
  const migrationStates = ["pending", "completed", "failed"]
  if (!statuses.includes(String(health.status)) || typeof health.mutationsEnabled !== "boolean") {
    throw new Error("The Rust engine returned malformed mapping-store health.")
  }
  if (health.detail !== undefined && typeof health.detail !== "string") {
    throw new Error("The Rust engine returned malformed mapping-store health detail.")
  }
  if (
    health.schemaVersion !== undefined &&
    (!Number.isSafeInteger(health.schemaVersion) || (health.schemaVersion as number) < 0)
  ) {
    throw new Error("The Rust engine returned an invalid mapping schema version.")
  }
  if (health.journalMode !== undefined && typeof health.journalMode !== "string") {
    throw new Error("The Rust engine returned an invalid mapping journal mode.")
  }
  if (health.migrationState !== undefined && !migrationStates.includes(String(health.migrationState))) {
    throw new Error("The Rust engine returned an invalid legacy migration state.")
  }
  if (
    health.status === "ready" &&
    (health.schemaVersion === undefined || health.migrationState === undefined || health.journalMode === undefined)
  ) {
    throw new Error("The Rust engine is incompatible: ready health omitted authoritative mapping metadata.")
  }
  return health as unknown as MappingStoreHealth
}
