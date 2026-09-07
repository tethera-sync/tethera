import { describe, expect, test } from "bun:test"
import { buildBreadcrumbs } from "../src/renderer/components/folder-picker-dialog"

describe("folder picker breadcrumbs", () => {
  test("preserves Linux roots", () => {
    expect(buildBreadcrumbs("/home/tethera/projects", "/")).toEqual([
      { label: "Computer", path: "/" },
      { label: "home", path: "/home" },
      { label: "tethera", path: "/home/tethera" },
      { label: "projects", path: "/home/tethera/projects" },
    ])
  })

  test("preserves Windows drive roots", () => {
    expect(buildBreadcrumbs("C:\\Users\\tethera", "\\")).toEqual([
      { label: "C:", path: "C:\\" },
      { label: "Users", path: "C:\\Users\\" },
      { label: "tethera", path: "C:\\Users\\tethera\\" },
    ])
  })

  test("uses the share as the root for UNC locations", () => {
    expect(buildBreadcrumbs("\\\\server\\share\\folder", "\\")).toEqual([
      { label: "\\\\server\\share", path: "\\\\server\\share\\" },
      { label: "folder", path: "\\\\server\\share\\folder\\" },
    ])
  })
})
