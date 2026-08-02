import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { MappingStoreBanner } from "../src/renderer/components/mapping-store-banner"

describe("MappingStoreBanner", () => {
  test("renders an explicit unavailable warning and retry action", () => {
    const html = renderToStaticMarkup(
      <MappingStoreBanner
        state={{
          status: "unavailable",
          detail: "The authoritative database is locked.",
          mutationsEnabled: false,
          pendingDeliveryCount: 0,
        }}
      />,
    )
    expect(html).toContain('role="alert"')
    expect(html).toContain("Mapping database unavailable")
    expect(html).toContain("The authoritative database is locked.")
    expect(html).toContain("Retry")
  })

  test("distinguishes a newer schema from migration failure", () => {
    const unsupported = renderToStaticMarkup(
      <MappingStoreBanner
        state={{ status: "unsupported-schema", mutationsEnabled: false, pendingDeliveryCount: 0 }}
      />,
    )
    const failed = renderToStaticMarkup(
      <MappingStoreBanner
        state={{ status: "migration-failed", mutationsEnabled: false, pendingDeliveryCount: 0 }}
      />,
    )
    expect(unsupported).toContain("needs a newer Tethera build")
    expect(failed).toContain("migration needs attention")
  })

  test("renders loading without presenting an empty mapping state", () => {
    const html = renderToStaticMarkup(
      <MappingStoreBanner state={{ status: "loading", mutationsEnabled: false, pendingDeliveryCount: 0 }} />,
    )
    expect(html).toContain('role="status"')
    expect(html).toContain("Loading folder configuration")
  })

  test("healthy state stays quiet while pending delivery remains visible", () => {
    expect(
      renderToStaticMarkup(
        <MappingStoreBanner state={{ status: "ready", mutationsEnabled: true, pendingDeliveryCount: 0 }} />,
      ),
    ).toBe("")
    const pending = renderToStaticMarkup(
      <MappingStoreBanner state={{ status: "ready", mutationsEnabled: true, pendingDeliveryCount: 1 }} />,
    )
    expect(pending).toContain("Configuration delivery pending")
    expect(pending).toContain("authenticated peer acknowledgement")
  })
})
