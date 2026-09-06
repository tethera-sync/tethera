import { describe, expect, test } from "bun:test"
import type { AppSnapshot } from "../src/shared/contracts"
import { createSnapshotSubscription } from "../src/renderer/lib/snapshot"
import { appSnapshot } from "./helpers"

const snapshot = (engineMessage: string) => appSnapshot({ engineMessage })

describe("createSnapshotSubscription", () => {
  test("subscribes before reading and lets a pushed snapshot win", async () => {
    let releaseRead!: (value: AppSnapshot) => void
    let listener: ((value: AppSnapshot) => void) | undefined
    const api = {
      subscribe: (next: (value: AppSnapshot) => void) => {
        listener = next
        return () => {
          listener = undefined
        }
      },
      getSnapshot: () => new Promise<AppSnapshot>((resolve) => { releaseRead = resolve }),
    }
    const store = createSnapshotSubscription(api, snapshot("fallback"))
    const received: AppSnapshot[] = []
    store.subscribe((value) => received.push(value))
    const initial = store.loadInitial()
    listener?.(snapshot("pushed"))
    releaseRead(snapshot("stale"))
    await initial

    expect(store.getSnapshot()).toEqual(snapshot("pushed"))
    expect(received).toEqual([snapshot("pushed")])
  })

  test("suppresses an initial read failure after a pushed snapshot", async () => {
    let rejectRead!: (error: Error) => void
    let listener: ((value: AppSnapshot) => void) | undefined
    const api = {
      subscribe: (next: (value: AppSnapshot) => void) => {
        listener = next
        return () => { listener = undefined }
      },
      getSnapshot: () => new Promise<AppSnapshot>((_resolve, reject) => { rejectRead = reject }),
    }
    const store = createSnapshotSubscription(api, snapshot("fallback"))
    store.subscribe(() => undefined)
    const initial = store.loadInitial()
    listener?.(snapshot("pushed"))
    rejectRead(new Error("stale failure"))

    await expect(initial).resolves.toBeUndefined()
    expect(store.getSnapshot()).toEqual(snapshot("pushed"))
  })

  test("cleans up the real subscription and rejects stale action results", () => {
    let unsubscribeCalls = 0
    let listener: ((value: AppSnapshot) => void) | undefined
    const api = {
      subscribe: (next: (value: AppSnapshot) => void) => {
        listener = next
        return () => { unsubscribeCalls += 1 }
      },
      getSnapshot: async () => snapshot("initial"),
    }
    const store = createSnapshotSubscription(api, snapshot("fallback"))
    const unsubscribe = store.subscribe(() => undefined)
    const actionRevision = store.beginAction()
    listener?.(snapshot("newer"))

    expect(store.applyActionResult(snapshot("older-action-result"), actionRevision)).toBe(false)
    unsubscribe()
    expect(unsubscribeCalls).toBe(1)
  })
})
