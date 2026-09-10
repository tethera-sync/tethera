import { ScanCancelledError } from "./folder-manifest"

/**
 * Process-wide admission control for read-only folder scans.
 *
 * Preview, initial-merge, continuous and inbound peer scans all funnel their
 * local filesystem walk through here so one peer cannot stack unbounded
 * concurrent walks. The coordinator owns only the local walk: callers must
 * release the slot before waiting on peer work, otherwise two devices can
 * hold a local slot while waiting for each other (reciprocal deadlock).
 */
export const MAX_ACTIVE_SCANS = 4
export const MAX_QUEUED_SCANS = 16

interface QueuedScan {
  key: string
  start: () => void
  cancel: (error: Error) => void
  signal?: AbortSignal | null
}

export class ScanCoordinator {
  #active = 0
  #queue: QueuedScan[] = []

  get activeScans(): number {
    return this.#active
  }

  get queuedScans(): number {
    return this.#queue.length
  }

  async run<T>(key: string, task: (signal: AbortSignal | null) => Promise<T>, signal?: AbortSignal | null): Promise<T> {
    if (signal?.aborted) throw new ScanCancelledError()
    if (this.#active >= MAX_ACTIVE_SCANS) {
      if (this.#queue.length >= MAX_QUEUED_SCANS) {
        throw new Error("Tethera is already running its maximum number of folder scans. Retry shortly.")
      }
      await new Promise<void>((resolve, reject) => {
        const entry: QueuedScan = {
          key,
          start: () => resolve(),
          cancel: (error: Error) => reject(error),
          signal,
        }
        this.#queue.push(entry)
        signal?.addEventListener("abort", () => {
          const index = this.#queue.indexOf(entry)
          if (index >= 0) this.#queue.splice(index, 1)
          reject(new ScanCancelledError())
        }, { once: true })
      })
    }
    this.#active += 1
    try {
      return await task(signal ?? null)
    } finally {
      this.#active = Math.max(0, this.#active - 1)
      const next = this.#queue.shift()
      next?.start()
    }
  }

  /** Cancels queued (not yet started) scans; active scans observe their own signal. */
  cancelQueued(reason = "The folder scan queue was cleared."): void {
    const queued = this.#queue.splice(0)
    const error = new ScanCancelledError(reason)
    for (const entry of queued) entry.cancel(error)
  }
}

export const globalScanCoordinator = new ScanCoordinator()
