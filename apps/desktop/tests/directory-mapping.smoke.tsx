// Run as an Electron main script after bundling with electron external.
import { app, BrowserWindow, shell } from "electron"
import { strict as assert } from "node:assert"
import { mkdir, readFile, readdir, writeFile, utimes } from "node:fs/promises"
import path from "node:path"
import { renderToStaticMarkup } from "react-dom/server"
import { EngineSupervisor } from "../src/main/engine-supervisor"
import { cleanupOlderDirectories } from "../src/main/directory-cleanup"
import { DirectoryPathMapping, projectDirectoryManifest } from "../src/main/directory-mapping"
import { compareManifests, scanFolder } from "../src/main/folder-manifest"
import { describeTransferFile, readTransferFileChunk } from "../src/main/file-transfer"
import { computeSyncPlan, mergeInitialSyncFile, writeFileChunksAtomic } from "../src/main/initial-sync"
import { DirectoryMappingNotice } from "../src/renderer/components/directory-mapping-notice"
import type { MappingRecord } from "../src/main/mapping-index"

const directory = process.env.TETHERA_DIRECTORY_SMOKE_ROOT
if (!directory || process.env.XDG_DATA_HOME !== path.join(directory, "xdg")) throw new Error("An isolated smoke-test root is required.")
const root = directory
app.setPath("userData", path.join(root, "electron"))
const engine = new EngineSupervisor()

async function scan(root: string, routing: DirectoryPathMapping) {
  return projectDirectoryManifest(await scanFolder(root, [], { hashAllFiles: true }), routing)
}

async function main() {
  await app.whenReady()
  await mkdir(path.join(root, "engine"), { recursive: true })
  const left = path.join(root, "left")
  const right = path.join(root, "right")
  for (const folder of ["left/Lib", "left/lib", "right/lib"]) await mkdir(path.join(root, folder), { recursive: true })
  await writeFile(path.join(left, "lib/old.txt"), "recover this unique file")
  await writeFile(path.join(left, "Lib/left.txt"), "from left")
  await writeFile(path.join(right, "lib/right.txt"), "from right")
  await writeFile(path.join(left, "Lib/conflict.txt"), "left conflict")
  await writeFile(path.join(right, "lib/conflict.txt"), "right conflict")
  await utimes(path.join(left, "lib"), 10, 10)
  await utimes(path.join(right, "lib"), 20, 20)
  await utimes(path.join(left, "Lib"), 30, 30)
  const local = await scanFolder(left, [], { includeDirectories: true, hashAllFiles: true })
  const remote = await scanFolder(right, [], { includeDirectories: true, hashAllFiles: true })
  const preview = compareManifests(local, remote, { mode: "two-way", localPlatform: "linux", remotePlatform: "windows" })
  assert.equal(preview.caseCollisions.length, 0)
  const mappings = preview.directoryMappings
  assert(mappings && mappings.length === 1)
  const localRouting = new DirectoryPathMapping(mappings, "local")
  const remoteRouting = new DirectoryPathMapping(mappings, "remote")
  engine.start({ command: path.join(process.cwd(), "target/debug/sync-engine"), env: { TETHERA_DATA_DIR: path.join(root, "engine") } })
  await engine.request("health")
  await engine.request("mapping.importLegacy", { sourceFingerprint: "a".repeat(64), importingDeviceId: "left", importedAt: "2026-09-13T12:00:00Z", records: [] })
  const mapping = {
    id: "smoke", name: "Case folders", initiatorDeviceId: "left", initiatorDeviceName: "Left", responderDeviceId: "right", responderDeviceName: "Right",
    initiatorPath: left, responderPath: right, mode: "two-way", ignorePatterns: [], historyDays: 30, historyMaxBytes: 1_000_000,
    setupStatus: "ready-for-initial-sync", paused: false, preview, createdAt: "2026-09-13T12:00:00Z", updatedAt: "2026-09-13T12:00:00Z",
  }
  await engine.request("mapping.upsert", { mapping, authorDeviceId: "left", deliveryTargetDeviceId: null, expectedRevision: null, occurredAt: "2026-09-13T12:00:00Z" })
  const cleanup = { rpc: engine, root: left, mappingId: "smoke", deviceId: "left", routing: localRouting, otherRoots: [], trashItem: (path: string) => shell.trashItem(path) }
  assert.equal(await cleanupOlderDirectories(cleanup), 1)
  const trashFiles = path.join(root, "xdg/Trash/files")
  const trashed = await readdir(trashFiles)
  assert.equal(trashed.length, 1)
  assert.equal(await readFile(path.join(trashFiles, trashed[0]!, "old.txt"), "utf8"), "recover this unique file")
  assert.deepEqual(await readdir(left), ["Lib"])

  for (const [destination, source, destinationRouting, sourceRouting] of [[left, right, localRouting, remoteRouting], [right, left, remoteRouting, localRouting]] as const) {
    const plan = computeSyncPlan(await scan(destination, destinationRouting), await scan(source, sourceRouting), "two-way")
    for (const entry of plan.toPull) {
      const sourcePath = sourceRouting.physicalPath(entry.path)
      const destinationPath = destinationRouting.physicalPath(entry.path)
      const descriptor = await describeTransferFile(source, sourcePath)
      async function* chunks() { yield await readTransferFileChunk(source, sourcePath, descriptor, 0, descriptor.size) }
      await mergeInitialSyncFile(destination, { ...entry, path: destinationPath }, async () => {
        await writeFileChunksAtomic(destination, destinationPath, descriptor.size, descriptor.digest, chunks())
        return { bytes: descriptor.size }
      })
    }
  }
  assert.equal(await readFile(path.join(left, "Lib/right.txt"), "utf8"), "from right")
  assert.equal(await readFile(path.join(right, "lib/left.txt"), "utf8"), "from left")
  assert.equal(await readFile(path.join(left, "Lib/conflict.txt"), "utf8"), "left conflict")
  assert.equal(await readFile(path.join(right, "lib/conflict.txt"), "utf8"), "right conflict")
  await engine.restart()
  await engine.request("health")
  const persisted = await engine.request<MappingRecord>("mapping.get", { id: "smoke" })
  assert.deepEqual(persisted.mapping.preview?.directoryMappings, mappings)
  await mkdir(path.join(left, "lib"))
  assert.equal(await cleanupOlderDirectories(cleanup), 0)
  assert((await readdir(left)).includes("lib"))

  const assets = path.join(process.cwd(), "apps/desktop/out/renderer/assets")
  const cssFile = (await readdir(assets)).find((file) => file.endsWith(".css"))
  assert(cssFile)
  const css = await readFile(path.join(assets, cssFile), "utf8")
  const markup = renderToStaticMarkup(<main className="mx-auto max-w-2xl p-6"><DirectoryMappingNotice mappings={mappings} localName="This computer" remoteName="Other computer" /></main>)
  const window = new BrowserWindow({ width: 960, height: 650, show: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<html class="dark"><head><style>${css}</style></head><body>${markup}</body></html>`)}`)
  window.focus()
  await window.webContents.executeJavaScript('document.querySelector("summary").focus()')
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" })
  window.webContents.sendInputEvent({ type: "char", keyCode: "\r" })
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" })
  assert.equal(await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => resolve(document.querySelector("details").open)))'), true)
  assert.equal(await window.webContents.executeJavaScript('document.documentElement.scrollWidth <= innerWidth'), true)
  await writeFile(path.join(root, "notice.png"), (await window.webContents.capturePage()).toPNG())
  window.destroy()
  console.log("DIRECTORY_MAPPING_ELECTRON_PASS", root)
  await engine.stop()
  app.quit()
}

main().catch(async (error: unknown) => { console.error(error); await engine.stop(); app.exit(1) })
