import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  type MenuItemConstructorOptions,
  shell,
  Tray,
} from "electron"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import type {
  AddFolderInput,
  AppSettingKey,
  AppSettings,
  AppSnapshot,
  DeviceSummary,
  FolderSummary,
} from "../shared/contracts"
import { EngineSupervisor, type EngineState } from "./engine-supervisor"

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
let snapshot: AppSnapshot

const engine = new EngineSupervisor()

const defaultSettings: AppSettings = {
  closeToTray: true,
  launchAtLogin: false,
  startMinimised: false,
  pauseOnMetered: true,
  theme: "system",
}

function getLocalDevice(): DeviceSummary {
  return {
    id: "local-device",
    name: os.hostname(),
    platform: process.platform === "win32" ? "windows" : process.platform === "linux" ? "linux" : "unknown",
    status: "this-device",
    route: "offline",
  }
}

function getInitialSnapshot(): AppSnapshot {
  return {
    status: "offline",
    route: "offline",
    engineStatus: "starting",
    engineMessage: "Checking the Rust sync engine…",
    paused: false,
    folders: [],
    devices: [getLocalDevice()],
    activity: [
      {
        id: randomUUID(),
        level: "info",
        title: "FolderSync is ready to configure",
        detail: "Add a folder now. Pairing and live transfers are the next implementation milestone.",
        occurredAt: new Date().toISOString(),
      },
    ],
    settings: defaultSettings,
  }
}

function stateFilePath(): string {
  return path.join(app.getPath("userData"), "state.json")
}

async function loadState(): Promise<void> {
  snapshot = getInitialSnapshot()

  try {
    const parsed = JSON.parse(await readFile(stateFilePath(), "utf8")) as Partial<AppSnapshot>
    snapshot = {
      ...snapshot,
      ...parsed,
      folders: (parsed.folders ?? []).map((folder) => ({
        ...folder,
        paused: folder.paused ?? false,
        status: folder.paused ? "paused" : folder.status === "needs-attention" ? "needs-attention" : "offline",
        ignorePatterns: folder.ignorePatterns ?? [],
      })),
      engineStatus: "starting",
      engineMessage: "Checking the Rust sync engine…",
      devices: [getLocalDevice(), ...(parsed.devices ?? []).filter((device) => device.id !== "local-device")],
      settings: { ...defaultSettings, ...(parsed.settings ?? {}) },
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("Unable to load persisted app state", error)
    }
  }

  recomputeOverallStatus()
}

async function persistState(): Promise<void> {
  const persisted = {
    ...snapshot,
    engineStatus: "unavailable",
    engineMessage: undefined,
    devices: snapshot.devices.filter((device) => device.id !== "local-device"),
  }
  await mkdir(path.dirname(stateFilePath()), { recursive: true })
  await writeFile(stateFilePath(), `${JSON.stringify(persisted, null, 2)}\n`, "utf8")
}

function idleFolderStatus(): FolderSummary["status"] {
  return snapshot.engineStatus === "ready" && snapshot.route !== "offline" ? "up-to-date" : "offline"
}

function recomputeOverallStatus(): void {
  if (snapshot.paused) {
    snapshot.status = "paused"
    return
  }
  if (snapshot.folders.some((folder) => folder.status === "needs-attention")) {
    snapshot.status = "needs-attention"
    return
  }
  if (snapshot.folders.some((folder) => folder.status === "syncing")) {
    snapshot.status = "syncing"
    return
  }
  if (snapshot.folders.length === 0 || snapshot.engineStatus !== "ready" || snapshot.route === "offline") {
    snapshot.status = "offline"
    return
  }
  snapshot.status = "up-to-date"
}

function pushActivity(
  title: string,
  detail: string,
  level: "info" | "success" | "warning" | "error" = "info",
  folderId?: string,
): void {
  snapshot.activity = [
    {
      id: randomUUID(),
      title,
      detail,
      level,
      folderId,
      occurredAt: new Date().toISOString(),
    },
    ...snapshot.activity,
  ].slice(0, 100)
}

function broadcastSnapshot(): AppSnapshot {
  recomputeOverallStatus()
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("app:snapshot", snapshot)
  }
  rebuildTrayMenu()
  return snapshot
}

async function mutate(mutator: () => void): Promise<AppSnapshot> {
  mutator()
  recomputeOverallStatus()
  await persistState()
  return broadcastSnapshot()
}

async function setAllPaused(paused: boolean): Promise<AppSnapshot> {
  return mutate(() => {
    snapshot.paused = paused
    snapshot.folders = snapshot.folders.map((folder) => ({
      ...folder,
      status: paused || folder.paused ? "paused" : idleFolderStatus(),
    }))
    pushActivity(
      paused ? "Syncing paused" : "Syncing resumed",
      paused
        ? "All configured folders were paused."
        : "Configured folders can sync when the paired device is online.",
      paused ? "warning" : "success",
    )
  })
}

function registerIpc(): void {
  ipcMain.handle("app:get-snapshot", () => snapshot)
  ipcMain.handle("app:pause-all", () => setAllPaused(true))
  ipcMain.handle("app:resume-all", () => setAllPaused(false))

  ipcMain.handle("dialog:choose-directory", async () => {
    const options: Electron.OpenDialogOptions = {
      properties: ["openDirectory", "createDirectory"],
    }
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle("folders:add", async (_event: Electron.IpcMainInvokeEvent, input: AddFolderInput) => {
    if (!input.localPath.trim() || !input.remotePath.trim()) {
      throw new Error("Both local and remote folder paths are required.")
    }

    return mutate(() => {
      const folder: FolderSummary = {
        id: randomUUID(),
        name: input.name.trim() || path.basename(input.localPath),
        localPath: input.localPath,
        remotePath: input.remotePath,
        status: snapshot.paused ? "paused" : idleFolderStatus(),
        mode: input.mode,
        paused: false,
        ignorePatterns: input.ignorePatterns,
        fileCount: 0,
      }
      snapshot.folders = [...snapshot.folders, folder]
      pushActivity(
        "Folder added",
        `${folder.name} is configured. No files are transferred until a peer is paired and the Rust engine is ready.`,
        "success",
        folder.id,
      )
    })
  })

  ipcMain.handle("folders:set-paused", async (_event: Electron.IpcMainInvokeEvent, folderId: string, paused: boolean) =>
    mutate(() => {
      snapshot.folders = snapshot.folders.map((folder) =>
        folder.id === folderId
          ? {
              ...folder,
              status: paused || snapshot.paused ? "paused" : idleFolderStatus(),
              paused,
            }
          : folder,
      )
      const folder = snapshot.folders.find((item) => item.id === folderId)
      if (folder) {
        pushActivity(
          paused ? "Folder paused" : "Folder resumed",
          `${folder.name} was ${paused ? "paused" : "resumed"}.`,
          paused ? "warning" : "success",
          folderId,
        )
      }
    }),
  )

  ipcMain.handle("folders:remove", async (_event: Electron.IpcMainInvokeEvent, folderId: string) =>
    mutate(() => {
      const folder = snapshot.folders.find((item) => item.id === folderId)
      snapshot.folders = snapshot.folders.filter((item) => item.id !== folderId)
      if (folder) {
        pushActivity(
          "Folder removed",
          `${folder.name} is no longer managed. Existing files were left untouched.`,
          "warning",
        )
      }
    }),
  )

  ipcMain.handle("shell:reveal-path", async (_event: Electron.IpcMainInvokeEvent, targetPath: string) => {
    if (!targetPath) return
    await shell.openPath(targetPath)
  })

  ipcMain.handle("settings:update", async (_event: Electron.IpcMainInvokeEvent, key: AppSettingKey, value: AppSettings[AppSettingKey]) =>
    mutate(() => {
      snapshot.settings = { ...snapshot.settings, [key]: value }
      if (key === "launchAtLogin") {
        app.setLoginItemSettings({ openAtLogin: Boolean(value), openAsHidden: snapshot.settings.startMinimised })
      }
      if (key === "startMinimised" && snapshot.settings.launchAtLogin) {
        app.setLoginItemSettings({ openAtLogin: true, openAsHidden: Boolean(value) })
      }
    }),
  )

  ipcMain.handle("window:show", () => showMainWindow())
}

function resolveEngineExecutable(): string | null {
  const override = process.env.FOLDERSYNC_ENGINE_PATH
  if (override && existsSync(override)) return override

  const binaryName = process.platform === "win32" ? "sync-engine.exe" : "sync-engine"
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, "engine", binaryName)]
    : [
        path.resolve(__dirname, "../../../../target/debug", binaryName),
        path.resolve(__dirname, "../../../../target/release", binaryName),
      ]

  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

function startEngine(): void {
  engine.on("state", (state: EngineState) => {
    snapshot.engineStatus = state.status
    snapshot.engineMessage = state.message
    broadcastSnapshot()
  })

  const executable = resolveEngineExecutable()
  if (!executable) {
    engine.markUnavailable("Build the engine with `cargo build -p sync-engine`, then restart FolderSync.")
    return
  }

  engine.start({ command: executable })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 960,
    minHeight: 650,
    show: false,
    title: "FolderSync",
    backgroundColor: "#0b0d12",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  mainWindow.webContents.on("will-navigate", (event: Electron.Event, url: string) => {
    const isDevServer = process.env.ELECTRON_RENDERER_URL && url.startsWith(process.env.ELECTRON_RENDERER_URL)
    if (!isDevServer && !url.startsWith("file:")) event.preventDefault()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"))
  }

  mainWindow.once("ready-to-show", () => {
    if (!snapshot.settings.startMinimised) mainWindow?.show()
  })

  mainWindow.on("close", (event: Electron.Event) => {
    if (!isQuitting && snapshot.settings.closeToTray) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.on("closed", () => {
    mainWindow = null
  })
}

function showMainWindow(): void {
  if (!mainWindow) createWindow()
  mainWindow?.show()
  mainWindow?.focus()
}

function createTray(): void {
  const iconPath = path.resolve(__dirname, "../../resources/tray.png")
  const image = existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty()
  tray = new Tray(image.resize({ width: 18, height: 18 }))
  tray.setToolTip("FolderSync")
  tray.on("click", showMainWindow)
  rebuildTrayMenu()
}

function rebuildTrayMenu(): void {
  if (!tray || !snapshot) return
  const template: MenuItemConstructorOptions[] = [
    { label: "Open FolderSync", click: showMainWindow },
    { type: "separator" },
    snapshot.paused
      ? { label: "Resume all", click: () => void setAllPaused(false) }
      : { label: "Pause all", click: () => void setAllPaused(true) },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        isQuitting = true
        app.quit()
      },
    },
  ]
  tray.setContextMenu(Menu.buildFromTemplate(template))
}

app.whenReady().then(async () => {
  await loadState()
  registerIpc()
  createWindow()
  createTray()
  startEngine()

  app.on("activate", showMainWindow)
})

app.on("before-quit", () => {
  isQuitting = true
})

app.on("window-all-closed", () => {
  // Keep the background process alive while close-to-tray is enabled.
  if (process.platform === "darwin" || snapshot?.settings.closeToTray) return
  app.quit()
})

app.on("will-quit", () => {
  void engine.stop()
})
