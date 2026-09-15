import { randomUUID } from "node:crypto"
import type { ActivityEvent } from "../shared/contracts"

export const MAX_ACTIVITY_EVENTS = 100

export type NewActivityEvent = Omit<ActivityEvent, "id" | "repeatCount">

/**
 * Adds an event to the newest-first, bounded activity log. When the same
 * event is already the newest entry for its folder, that entry is moved to
 * the top and its repeat count raised instead, so one recurring failure
 * cannot push the rest of the history out of the log.
 */
export function appendActivity(activity: readonly ActivityEvent[], event: NewActivityEvent): ActivityEvent[] {
  const previousIndex = activity.findIndex((entry) => entry.folderId === event.folderId)
  const previous = activity[previousIndex]
  if (previous && isSameEvent(previous, event)) {
    const repeated: ActivityEvent = { ...previous, occurredAt: event.occurredAt, repeatCount: (previous.repeatCount ?? 1) + 1 }
    return [repeated, ...activity.slice(0, previousIndex), ...activity.slice(previousIndex + 1)]
  }
  return [{ id: randomUUID(), ...event }, ...activity].slice(0, MAX_ACTIVITY_EVENTS)
}

function isSameEvent(entry: ActivityEvent, event: NewActivityEvent): boolean {
  return entry.level === event.level && entry.title === event.title && entry.detail === event.detail
}
