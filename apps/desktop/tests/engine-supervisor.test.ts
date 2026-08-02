import { describe, expect, test } from "bun:test"
import { parseMappingStoreHealth } from "../src/main/engine-supervisor"

describe("engine mapping-store health contract", () => {
  test("accepts the bounded authoritative health shape", () => {
    expect(
      parseMappingStoreHealth({
        status: "ready",
        schemaVersion: 2,
        journalMode: "wal",
        migrationState: "completed",
        mutationsEnabled: true,
      }),
    ).toEqual({
      status: "ready",
      schemaVersion: 2,
      journalMode: "wal",
      migrationState: "completed",
      mutationsEnabled: true,
    })
  })

  test("an old engine without mapping-store health is incompatible, never an empty database", () => {
    expect(() => parseMappingStoreHealth(undefined)).toThrow("incompatible")
  })

  test("rejects unknown states and invalid schema versions", () => {
    expect(() => parseMappingStoreHealth({ status: "empty", mutationsEnabled: true })).toThrow("malformed")
    expect(() =>
      parseMappingStoreHealth({ status: "ready", schemaVersion: -0.5, mutationsEnabled: true }),
    ).toThrow("schema version")
  })
})
