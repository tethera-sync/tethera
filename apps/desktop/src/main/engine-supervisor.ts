import { EventEmitter } from "node:events"
import { randomBytes, randomUUID } from "node:crypto"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import readline from "node:readline"

export type EngineState =
  | { status: "starting"; message: string }
  | { status: "ready"; message: string }
  | { status: "unavailable"; message: string }
  | { status: "error"; message: string }

type RpcResponse = {
  id: string
  ok: boolean
  result?: unknown
  error?: string
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

export class EngineSupervisor extends EventEmitter {
  #child: ChildProcessWithoutNullStreams | null = null
  #sessionToken: string | null = null
  #pending = new Map<string, PendingRequest>()
  #state: EngineState = {
    status: "unavailable",
    message: "The Rust engine has not been started.",
  }

  get state(): EngineState {
    return this.#state
  }

  start(options: EngineLaunchOptions): void {
    if (this.#child) return

    this.#setState({ status: "starting", message: "Starting the Rust sync engine…" })
    this.#sessionToken = randomBytes(32).toString("base64url")

    try {
      this.#child = spawn(options.command, [...(options.args ?? []), "--rpc-stdio"], {
        cwd: options.cwd,
        env: {
          ...process.env,
          ...options.env,
          FOLDERSYNC_RPC_SESSION_TOKEN: this.#sessionToken,
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      })
    } catch (error) {
      this.#child = null
      this.#sessionToken = null
      this.#setState({
        status: "unavailable",
        message: error instanceof Error ? error.message : "Unable to launch the Rust engine.",
      })
      return
    }

    const lines = readline.createInterface({ input: this.#child.stdout })
    lines.on("line", (line: string) => this.#handleLine(line))

    this.#child.stderr.on("data", (chunk: Buffer) => {
      const message = chunk.toString("utf8").trim()
      if (message) console.error(`[sync-engine] ${message}`)
    })

    this.#child.once("error", (error: Error) => {
      this.#setState({ status: "unavailable", message: error.message })
    })

    this.#child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      const message = `Rust engine stopped${code === null ? "" : ` with code ${code}`}${
        signal ? ` (${signal})` : ""
      }.`
      this.#rejectPending(new Error(message))
      this.#child = null
      this.#sessionToken = null
      this.#setState({ status: "unavailable", message })
    })

    void this.request<{ name: string; version: string; protocol: string }>("health")
      .then((health) => {
        this.#setState({
          status: "ready",
          message: `${health.name} ${health.version} · protocol ${health.protocol}`,
        })
      })
      .catch((error: Error) => {
        this.#setState({ status: "error", message: error.message })
      })
  }

  markUnavailable(message: string): void {
    if (this.#child) return
    this.#setState({ status: "unavailable", message })
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    if (!this.#child || !this.#sessionToken) {
      throw new Error("Rust sync engine is not running.")
    }

    const id = randomUUID()
    const body = JSON.stringify({ id, method, params, sessionToken: this.#sessionToken })

    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`Rust engine request timed out: ${method}`))
      }, 5_000)

      this.#pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      })

      this.#child?.stdin.write(`${body}\n`)
    })
  }

  async stop(): Promise<void> {
    if (!this.#child) return

    try {
      await this.request("shutdown")
    } catch {
      this.#child.kill()
    }

    this.#rejectPending(new Error("Rust engine stopped."))
    this.#child = null
    this.#sessionToken = null
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
    else pending.reject(new Error(response.error ?? "Unknown Rust engine error."))
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
