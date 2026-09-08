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
  method: string
  timeoutMs: number
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  // Only the head-of-queue request (see #armHeadTimer) has a live timer; a
  // request still waiting behind it is untimed until it becomes the head.
  timer: NodeJS.Timeout | null
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

    child.stdin.once("error", (error: Error) => {
      this.#handleChildTermination(child, `Rust engine input failed: ${error.message}`, error, true)
    })

    child.once("error", (error: Error) => {
      this.#handleChildTermination(child, error.message, error, true)
    })

    child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      const message = `Rust engine stopped${code === null ? "" : ` with code ${code}`}${
        signal ? ` (${signal})` : ""
      }.`
      this.#handleChildTermination(child, message)
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
      this.#pending.set(id, {
        method,
        timeoutMs,
        resolve: (value) => resolve(value as T),
        reject,
        timer: null,
      })
      this.#armHeadTimer()

      const child = this.#child
      if (!child) {
        const pending = this.#pending.get(id)
        if (pending?.timer) clearTimeout(pending.timer)
        this.#pending.delete(id)
        this.#armHeadTimer()
        reject(new Error("Rust sync engine stopped while sending the request."))
        return
      }
      child.stdin.write(`${body}\n`, "utf8", (error?: Error | null) => {
        if (!error) return
        this.#handleChildTermination(child, `Unable to send Rust engine request: ${method}`, error, true)
      })
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
    if (!pending) {
      // The engine already answered a request we stopped waiting for (it timed
      // out while queued behind a slow head, or was dropped on termination).
      console.warn(`[sync-engine] Received a response for an unknown or already-settled request: ${response.id}`)
      return
    }

    if (pending.timer) clearTimeout(pending.timer)
    this.#pending.delete(response.id)

    if (response.ok) pending.resolve(response.result)
    else pending.reject(new EngineRpcError(response.error ?? "Unknown Rust engine error.", response.errorCode ?? "RPC_ERROR"))

    // The response we just settled may have been the head of the queue;
    // promote and time the next request if so.
    this.#armHeadTimer()
  }

  /**
   * The Rust engine is a single-threaded, strictly serial FIFO loop (see
   * crates/sync-engine/src/main.rs): it fully handles one request — including
   * SQLite writes — before reading the next line. A request still waiting in
   * line has not started being served, so giving it its own enqueue-time
   * timer would fail it for sitting behind a slow-but-healthy request. Only
   * the head of the queue (the oldest pending entry — a Map preserves
   * insertion order) gets a live timeout budget; when it settles, the next
   * entry becomes the head and is armed with its own budget in turn.
   */
  #armHeadTimer(): void {
    const head = this.#pending.entries().next()
    if (head.done) return
    const [headId, headRequest] = head.value
    if (headRequest.timer) return

    headRequest.timer = setTimeout(() => {
      this.#pending.delete(headId)
      headRequest.reject(new Error(`Rust engine request timed out: ${headRequest.method}`))
      this.#armHeadTimer()
    }, headRequest.timeoutMs)
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
  }

  #handleChildTermination(
    child: ChildProcessWithoutNullStreams,
    message: string,
    cause?: unknown,
    terminate = false,
  ): void {
    if (this.#child !== child) return
    this.#rejectPending(new Error(message, cause === undefined ? undefined : { cause }))
    this.#child = null
    this.#sessionToken = null
    if (terminate && child.exitCode === null && child.signalCode === null) child.kill()
    if (!this.#intentionalStops.has(child)) this.#setState({ status: "unavailable", message })
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
