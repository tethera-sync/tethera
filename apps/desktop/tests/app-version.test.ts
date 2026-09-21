import { describe, expect, test } from "bun:test"
import { compareAppVersions, isAppVersion } from "../src/shared/app-version"

describe("app versions", () => {
  test("accepts release and prerelease versions only", () => {
    expect(isAppVersion("0.1.22")).toBe(true)
    expect(isAppVersion("1.2.3-beta.1")).toBe(true)
    expect(isAppVersion("v0.1.22")).toBe(false)
    expect(isAppVersion("0.1")).toBe(false)
    expect(isAppVersion("0.1.22 ")).toBe(false)
    expect(isAppVersion("0.1.22-")).toBe(false)
    expect(isAppVersion("unknown")).toBe(false)
  })

  test("orders numerically rather than as text", () => {
    expect(compareAppVersions("0.1.9", "0.1.10")).toBe(-1)
    expect(compareAppVersions("0.2.0", "0.1.22")).toBe(1)
    expect(compareAppVersions("1.0.0", "0.99.99")).toBe(1)
    expect(compareAppVersions("0.1.22", "0.1.22")).toBe(0)
  })

  test("places a prerelease before its release and orders prerelease tags", () => {
    expect(compareAppVersions("1.0.0-beta.1", "1.0.0")).toBe(-1)
    expect(compareAppVersions("1.0.0", "1.0.0-beta.1")).toBe(1)
    expect(compareAppVersions("1.0.0-beta.2", "1.0.0-beta.10")).toBe(-1)
    expect(compareAppVersions("1.0.0-alpha", "1.0.0-beta")).toBe(-1)
  })

  test("cannot order a value that is not a release version", () => {
    expect(compareAppVersions("unknown", "0.1.22")).toBeUndefined()
    expect(compareAppVersions("0.1.22", "")).toBeUndefined()
  })
})
