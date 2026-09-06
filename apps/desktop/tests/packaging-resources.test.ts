import { describe, expect, test } from "bun:test"

// The main process loads its tray/window icons through resolveResourcePath,
// which looks under process.resourcesPath in packaged builds. Icons missing
// from extraResources silently degrade to an empty NativeImage, so the tray
// icon never appears. Guard the packaging contract here.
describe("packaging resources", () => {
  test("ships the tray and window icons as extra resources", async () => {
    const configPath = new URL("../electron-builder.yml", import.meta.url)
    const config = await Bun.file(configPath).text()
    const extraResources = config.slice(config.indexOf("extraResources:"))
    // Assert exact source-to-destination pairs: the runtime resolver reads
    // process.resourcesPath/tray.png and process.resourcesPath/icon.png, so a
    // name appearing anywhere else (or copied to another destination) must fail.
    const pairs = [...extraResources.matchAll(/-\s*from:\s*(\S+)\s*\n\s*to:\s*(\S+)/g)].map(
      (match) => `${match[1]} -> ${match[2]}`,
    )
    expect(pairs).toContain("resources/tray.png -> tray.png")
    expect(pairs).toContain("resources/icon.png -> icon.png")
  })
})
