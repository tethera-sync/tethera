const APP_VERSION = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z-]{1,40}(?:\.[0-9A-Za-z-]{1,40}){0,7}))?$/

/** Whether `value` is a Tethera release version: `1.2.3`, optionally with a prerelease tag such as `1.2.3-beta.1`. */
export function isAppVersion(value: string): boolean {
  return APP_VERSION.test(value)
}

/**
 * Orders two release versions by semantic-version precedence: negative when
 * `left` is older, positive when it is newer, zero when they are the same
 * release. Undefined when either is not a release version.
 */
export function compareAppVersions(left: string, right: string): number | undefined {
  const a = APP_VERSION.exec(left)
  const b = APP_VERSION.exec(right)
  if (!a || !b) return undefined
  for (const index of [1, 2, 3]) {
    const difference = Number(a[index]) - Number(b[index])
    if (difference !== 0) return Math.sign(difference)
  }
  const [leftTag, rightTag] = [a[4], b[4]]
  if (leftTag === rightTag) return 0
  // A release outranks its own prereleases.
  if (leftTag === undefined) return 1
  if (rightTag === undefined) return -1
  return Math.sign(leftTag.localeCompare(rightTag, "en", { numeric: true }))
}
