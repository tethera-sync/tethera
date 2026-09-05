const { app, BrowserWindow } = require("electron")

const harnessPath = process.argv[2]

function writeResult(payload) {
  process.stdout.write(`TETHERA_DIALOG_TEST_RESULT:${JSON.stringify(payload)}\n`)
}

app.commandLine.appendSwitch("disable-gpu")

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
    },
  })
  window.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    process.stderr.write(`renderer console [${level}] ${sourceId}:${line} ${message}\n`)
  })
  try {
    await window.loadFile(harnessPath)
    await window.webContents.executeJavaScript(
      "new Promise((resolve, reject) => { const started = Date.now(); const check = () => { if (typeof window.runDialogRegression === 'function') return resolve(); if (Date.now() - started > 10000) return reject(new Error('dialog harness did not initialise')); setTimeout(check, 10); }; check(); })",
      true,
    )
    const result = await window.webContents.executeJavaScript(
      "(async () => { try { return { ok: true, result: await window.runDialogRegression() }; } catch (error) { return { ok: false, error: String(error), stack: error instanceof Error ? error.stack : undefined }; } })()",
      true,
    )
    writeResult(result)
    if (!result.ok) process.exitCode = 1
  } catch (error) {
    writeResult({ ok: false, error: error instanceof Error ? error.message : String(error) })
    process.exitCode = 1
  } finally {
    if (!window.isDestroyed()) window.destroy()
    app.quit()
  }
})
