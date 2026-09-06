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
    expect(extraResources).toContain("resources/tray.png")
    expect(extraResources).toContain("resources/icon.png")
  })
})
