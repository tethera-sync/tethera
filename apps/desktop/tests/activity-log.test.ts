import { describe, expect, test } from "bun:test"
import type { ActivityEvent } from "../src/shared/contracts"
import { appendActivity, MAX_ACTIVITY_EVENTS, type NewActivityEvent } from "../src/main/activity-log"

const watchFailed: NewActivityEvent = {
  title: "Folder watch failed",
  detail: "coding: The synchronized folder exceeds the watch limit.",
  level: "error",
  folderId: "coding",
  occurredAt: "2026-09-15T05:08:00.000Z",
}

describe("appendActivity", () => {
  test("adds a new event to the top", () => {
    const earlier = appendActivity([], { ...watchFailed, title: "Folder paused", level: "warning" })
    const activity = appendActivity(earlier, watchFailed)
    expect(activity.map((event) => event.title)).toEqual(["Folder watch failed", "Folder paused"])
    expect(activity[0]?.repeatCount).toBeUndefined()
  })

  test("counts a repeat of the folder's newest event instead of adding a row", () => {
    let activity: ActivityEvent[] = appendActivity([], watchFailed)
    const id = activity[0]?.id
    activity = appendActivity(activity, { ...watchFailed, occurredAt: "2026-09-15T05:08:04.000Z" })
    activity = appendActivity(activity, { ...watchFailed, occurredAt: "2026-09-15T05:08:08.000Z" })
    expect(activity).toHaveLength(1)
    expect(activity[0]).toMatchObject({ id, repeatCount: 3, occurredAt: "2026-09-15T05:08:08.000Z" })
  })

  test("moves a repeat above newer events from other folders", () => {
    let activity = appendActivity([], watchFailed)
    activity = appendActivity(activity, { ...watchFailed, title: "Paired computer connected", level: "info", folderId: undefined })
    activity = appendActivity(activity, watchFailed)
    expect(activity.map((event) => [event.title, event.repeatCount])).toEqual([
      ["Folder watch failed", 2],
      ["Paired computer connected", undefined],
    ])
  })

  test("keeps separate rows when the folder had a different event in between", () => {
    let activity = appendActivity([], watchFailed)
    activity = appendActivity(activity, { ...watchFailed, title: "Folder paused", level: "warning" })
    activity = appendActivity(activity, watchFailed)
    expect(activity.map((event) => event.title)).toEqual(["Folder watch failed", "Folder paused", "Folder watch failed"])
  })

  test("keeps the log bounded", () => {
    let activity: ActivityEvent[] = []
    for (let index = 0; index < MAX_ACTIVITY_EVENTS + 5; index += 1) {
      activity = appendActivity(activity, { ...watchFailed, detail: `event ${index}` })
    }
    expect(activity).toHaveLength(MAX_ACTIVITY_EVENTS)
    expect(activity[0]?.detail).toBe(`event ${MAX_ACTIVITY_EVENTS + 4}`)
  })
})
