import { describe, expect, test } from "bun:test"
import type { AppSnapshot } from "../src/shared/contracts"
import { createSnapshotSubscription, preferredPairedDevice } from "../src/renderer/lib/snapshot"
import { appSnapshot } from "./helpers"

const snapshot = (engineMessage: string) => appSnapshot({ engineMessage })

const device = (id: string, name: string, status: "this-device" | "online" | "offline") => ({
  id,
  name,
  platform: "linux" as const,
  status,
  route: status === "online" ? "lan-direct" as const : "offline" as const,
})

describe("preferredPairedDevice", () => {
  test("prefers an online peer listed after an offline peer", () => {
    const offline = device("offline", "Offline computer", "offline")
    const online = device("online", "Online computer", "online")

    expect(preferredPairedDevice(appSnapshot({ devices: [offline, online] }))).toEqual(online)
  })

  test("returns a single offline peer", () => {
    const offline = device("offline", "Offline computer", "offline")

    expect(preferredPairedDevice(appSnapshot({ devices: [offline] }))).toEqual(offline)
  })

  test("returns undefined when there are no paired peers", () => {
    expect(preferredPairedDevice(appSnapshot())).toBeUndefined()
  })

  test("never returns the local device", () => {
    const local = device("local", "This computer", "this-device")

    expect(preferredPairedDevice(appSnapshot({ devices: [local] }))).toBeUndefined()
  })
})

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

  test("rejects an initial read failure when no snapshot was pushed", async () => {
    const api = {
      subscribe: () => () => undefined,
      getSnapshot: () => Promise.reject(new Error("read failed")),
    }
    const store = createSnapshotSubscription(api, snapshot("fallback"))
    store.subscribe(() => undefined)

    await expect(store.loadInitial()).rejects.toThrow("read failed")
    expect(store.getSnapshot()).toEqual(snapshot("fallback"))
  })

  test("a retried read publishes and applies a matching action result", async () => {
    let attempt = 0
    const api = {
      subscribe: () => () => undefined,
      getSnapshot: async () => {
        attempt += 1
        if (attempt === 1) throw new Error("read failed")
        return snapshot("retried")
      },
    }
    const store = createSnapshotSubscription(api, snapshot("fallback"))
    const received: AppSnapshot[] = []
    store.subscribe((value) => received.push(value))

    await expect(store.loadInitial()).rejects.toThrow("read failed")
    await store.loadInitial()

    expect(store.getSnapshot()).toEqual(snapshot("retried"))
    const revision = store.beginAction()
    expect(store.applyActionResult(snapshot("action"), revision)).toBe(true)
    expect(received).toEqual([snapshot("retried"), snapshot("action")])
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
