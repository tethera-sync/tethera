import { describe, expect, test } from "bun:test"

/**
 * Structural guard for the IPC boundary: a renderer can only reach these
 * handlers from the trusted main window, and that check is easy to forget when
 * a channel is added. Scanning the source keeps the invariant testable without
 * booting Electron.
 */
describe("IPC sender validation", () => {
  test("every registered handler checks the trusted main renderer", async () => {
    const source = await Bun.file(new URL("../src/main/index.ts", import.meta.url)).text()
    const start = source.indexOf("function registerIpc")
    const end = source.indexOf("function requireTrustedMainRenderer")
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const block = source.slice(start, end)

    const channels = [...block.matchAll(/ipcMain\.handle\("([^"]+)"/g)].map((match) => match[1])
    expect(channels.length).toBeGreaterThan(30)

    const missing: string[] = []
    for (const [index, channel] of channels.entries()) {
      const handlerStart = block.indexOf(`ipcMain.handle("${channel}"`)
      const nextChannel = channels[index + 1]
      const handlerEnd = nextChannel ? block.indexOf(`ipcMain.handle("${nextChannel}"`, handlerStart + 1) : block.length
      const handler = block.slice(handlerStart, handlerEnd)
      if (!handler.includes("requireTrustedMainRenderer(event)")) missing.push(channel)
    }

    expect(missing).toEqual([])
  })
})
