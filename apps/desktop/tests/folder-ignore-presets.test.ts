import { expect, test } from "bun:test"
import { appendIgnorePreset, defaultIgnorePatterns, folderIgnorePresets } from "../src/renderer/components/folder-ignore-presets"
import { isManifestPathIgnored } from "../src/main/folder-manifest"

test("defaults exclude nested installed environments but keep source and lockfiles", () => {
  for (const relativePath of ["apps/api/.venv/Lib/site-packages/library.pyd", "apps/api/.venv/lib/library.so", "web/node_modules/react/index.js"]) {
    expect(isManifestPathIgnored(relativePath, defaultIgnorePatterns)).toBe(true)
  }
  for (const relativePath of ["src/main.ts", "pyproject.toml", "uv.lock", "bun.lock", "package.json", ".env", ".git/config"]) {
    expect(isManifestPathIgnored(relativePath, defaultIgnorePatterns)).toBe(false)
  }
})

test("adding presets preserves custom rules and can be repeated without duplicates", () => {
  const custom = "# My rules\nprivate/\n  node_modules/  \n"
  for (const preset of folderIgnorePresets) {
    const added = appendIgnorePreset(custom, preset.patterns)
    expect(added.startsWith(custom.trimEnd())).toBe(true)
    expect(appendIgnorePreset(added, preset.patterns)).toBe(added)
    expect(added.split("\n").filter((line) => line.trim() === "node_modules/")).toHaveLength(1)
  }
})
