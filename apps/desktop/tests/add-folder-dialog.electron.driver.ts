import { mkdtemp, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { resolve } from "node:path"
import { build } from "vite"
import react from "@vitejs/plugin-react"

const desktopRoot = resolve(import.meta.dir, "..")
const harnessInput = resolve(import.meta.dir, "electron/add-folder-dialog-harness.html")
const driverInput = resolve(import.meta.dir, "electron/add-folder-dialog-driver.cjs")
const electronRequire = createRequire(import.meta.url)
const electronModule: unknown = electronRequire("electron")

if (typeof electronModule !== "string") {
  throw new Error("The Electron package did not resolve to an executable path.")
}

if (!existsSync(electronModule)) {
  throw new Error("Electron binary is not installed; run `bun run desktop:setup` before the explicit harness command.")
}

const outputDirectory = await mkdtemp(resolve(desktopRoot, ".dialog-harness-"))

try {
  await build({
    root: desktopRoot,
    configFile: false,
    resolve: {
      alias: {
        "@": resolve(desktopRoot, "src/renderer"),
        "@shared": resolve(desktopRoot, "src/shared"),
      },
    },
    plugins: [react()],
    base: "./",
    build: {
      outDir: outputDirectory,
      emptyOutDir: true,
      rollupOptions: { input: harnessInput },
    },
  })

  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...environment } = Bun.env
  const process = Bun.spawn([electronModule, driverInput, resolve(outputDirectory, "tests/electron/add-folder-dialog-harness.html")], {
    cwd: desktopRoot,
    env: { ...environment, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const timeout = setTimeout(() => process.kill(), 30_000)
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ])
  clearTimeout(timeout)

  const marker = "TETHERA_DIALOG_TEST_RESULT:"
  const line = stdout.split("\n").find((candidate) => candidate.startsWith(marker))
  if (!line) {
    throw new Error(
      `Electron harness did not return a result (exit ${exitCode}). ` +
        "The explicit harness requires a working Electron display/session on Linux.\n" +
        stderr,
    )
  }

  const payload: unknown = JSON.parse(line.slice(marker.length))
  if (!isHarnessPayload(payload)) {
    throw new Error(`Electron harness returned an invalid result payload.\n${stderr}`)
  }
  if (!payload.ok) throw new Error(`${payload.error}\n${payload.stack ?? ""}\n${stderr}`)
  if (exitCode !== 0) throw new Error(`Electron harness exited with ${exitCode}.\n${stderr}`)
  console.log(JSON.stringify(payload.result))
} finally {
  await rm(outputDirectory, { recursive: true, force: true })
}

interface HarnessPayload {
  ok: boolean
  error: string
  stack?: string
  result?: {
    previewPendingDismissalsBlocked: boolean
    rulesStayedDisabled: boolean
    rejectedCompareCanDismiss: boolean
    approvalPendingDismissalsBlocked: boolean
    resolvedApprovalClosed: boolean
    addedCalls: number
  }
}

function isHarnessPayload(value: unknown): value is HarnessPayload {
  if (typeof value !== "object" || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.ok === "boolean" && (record.ok || typeof record.error === "string")
}
