import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron'

/**
 * Main process. Owns ALL filesystem and subprocess access; the renderer gets a
 * deliberately narrow IPC surface (see ../preload/index.ts).
 *
 * Security posture (this app will hold client tax documents):
 *  - contextIsolation on, nodeIntegration off, sandboxed renderer
 *  - the renderer may only read/probe paths the USER explicitly chose this
 *    session (`allowedInputs`), and may only write to a path the user picked in
 *    a save dialog (`allowedOutputs`)
 *  - no telemetry, no network calls, nothing leaves the machine
 */

const isDev = !app.isPackaged

/** Repo root. Dev: out/main -> out -> app -> repo. Packaged: resources/. */
function repoRoot(): string {
  return isDev ? path.resolve(__dirname, '../../..') : process.resourcesPath
}

function engineDir(): string {
  return path.join(repoRoot(), 'engine')
}

function pythonExe(): string {
  const venv = path.join(engineDir(), '.venv')
  return process.platform === 'win32'
    ? path.join(venv, 'Scripts', 'python.exe')
    : path.join(venv, 'bin', 'python')
}

/** Files the user explicitly opened. Gate for every read/probe. */
const allowedInputs = new Set<string>()
/** Paths the user picked in a save dialog. Gate for every write. */
const allowedOutputs = new Set<string>()

function assertAllowed(set: Set<string>, p: unknown, what: string): string {
  if (typeof p !== 'string' || !set.has(path.resolve(p))) {
    throw new Error(`refused: ${what} not user-authorized this session`)
  }
  return path.resolve(p)
}

// ----------------------------------------------------------------- sidecar

interface EngineOk {
  ok: true
  [k: string]: unknown
}
interface EngineErr {
  ok: false
  error: string
  trace?: string
}

/** Spawn the Python engine for one JSON command. One process per command. */
function runEngine(command: unknown): Promise<EngineOk | EngineErr> {
  return new Promise((resolve) => {
    const child = spawn(pythonExe(), ['-m', 'workpaper_engine.cli'], {
      cwd: engineDir(),
      env: { ...process.env, PYTHONPATH: engineDir() }
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', (e) =>
      resolve({ ok: false, error: `engine not runnable (${pythonExe()}): ${e.message}` })
    )
    child.on('close', () => {
      try {
        resolve(JSON.parse(out.trim()))
      } catch {
        resolve({ ok: false, error: `engine returned no JSON. stderr: ${err.slice(0, 500)}` })
      }
    })
    child.stdin.write(JSON.stringify(command))
    child.stdin.end()
  })
}

// --------------------------------------------------------------------- IPC

function registerIpc(): void {
  ipcMain.handle('engine:ping', () => runEngine({ cmd: 'ping' }))

  ipcMain.handle('dialog:openPdfs', async () => {
    const res = await dialog.showOpenDialog({
      title: 'Add PDFs to binder',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    })
    if (res.canceled) return []
    for (const p of res.filePaths) allowedInputs.add(path.resolve(p))
    return res.filePaths
  })

  /** Authorize paths that arrived by drag-drop or from a reopened session. */
  ipcMain.handle('files:register', (_e, paths: unknown) => {
    if (!Array.isArray(paths)) return []
    const ok: string[] = []
    for (const p of paths) {
      if (typeof p === 'string' && p.toLowerCase().endsWith('.pdf')) {
        const abs = path.resolve(p)
        allowedInputs.add(abs)
        ok.push(abs)
      }
    }
    return ok
  })

  /** PDF bytes for rendering in the renderer (PDF.js). */
  ipcMain.handle('fs:readPdf', async (_e, p: unknown) => {
    const abs = assertAllowed(allowedInputs, p, 'file')
    const buf = await readFile(abs)
    return new Uint8Array(buf)
  })

  ipcMain.handle('engine:probe', async (_e, p: unknown) => {
    const abs = assertAllowed(allowedInputs, p, 'file')
    return runEngine({ cmd: 'probe', path: abs })
  })

  ipcMain.handle('dialog:saveBinderAs', async (_e, suggested: unknown) => {
    const res = await dialog.showSaveDialog({
      title: 'Export binder',
      defaultPath: typeof suggested === 'string' ? suggested : 'binder.pdf',
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    })
    if (res.canceled || !res.filePath) return null
    const abs = path.resolve(res.filePath)
    allowedOutputs.add(abs)
    return abs
  })

  ipcMain.handle('engine:export', async (_e, spec: unknown) => {
    if (typeof spec !== 'object' || spec === null) {
      return { ok: false, error: 'bad spec' }
    }
    const s = spec as Record<string, unknown>
    const output = assertAllowed(allowedOutputs, s.output, 'output path')
    // Sources must all be user-authorized inputs.
    const sources = (s.sources ?? {}) as Record<string, unknown>
    for (const v of Object.values(sources)) assertAllowed(allowedInputs, v, 'source file')
    return runEngine({ cmd: 'export', binder: { ...s, output } })
  })

  ipcMain.handle('session:save', async (_e, session: unknown, existing: unknown) => {
    let target = typeof existing === 'string' ? path.resolve(existing) : null
    if (!target) {
      const res = await dialog.showSaveDialog({
        title: 'Save binder session',
        defaultPath: 'binder.wptsession.json',
        filters: [{ name: 'Workpaper session', extensions: ['json'] }]
      })
      if (res.canceled || !res.filePath) return null
      target = path.resolve(res.filePath)
    }
    await writeFile(target, JSON.stringify(session, null, 2), 'utf8')
    return target
  })

  ipcMain.handle('session:open', async () => {
    const res = await dialog.showOpenDialog({
      title: 'Open binder session',
      properties: ['openFile'],
      filters: [{ name: 'Workpaper session', extensions: ['json'] }]
    })
    if (res.canceled || !res.filePaths[0]) return null
    const target = path.resolve(res.filePaths[0])
    const text = await readFile(target, 'utf8')
    return { path: target, session: JSON.parse(text) }
  })

  ipcMain.handle('shell:reveal', (_e, p: unknown) => {
    if (typeof p === 'string') shell.showItemInFolder(path.resolve(p))
  })

  /**
   * Dev smoke-test hook. The renderer reports when it has finished loading a
   * binder; with WPT_DEV_SHOT set we snapshot the window to a PNG (and quit if
   * WPT_DEV_EXIT is set). Lets the GUI be verified without a human clicking, and
   * without OS screen-recording permission. Dev builds only.
   */
  ipcMain.on('dev:rendered', async (e) => {
    const shot = isDev ? process.env.WPT_DEV_SHOT : undefined
    if (!shot) return
    const wc = e.sender
    // Give thumbnails/canvas a beat to paint before snapshotting.
    await new Promise((r) => setTimeout(r, 1800))
    try {
      const image = await wc.capturePage()
      await writeFile(path.resolve(shot), image.toPNG())
      console.log(`[dev] captured window -> ${shot}`)
    } catch (err) {
      console.error('[dev] capture failed', err)
    }
    if (process.env.WPT_DEV_EXIT) app.quit()
  })
}

// ------------------------------------------------------------------ window

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#F7F6F2',
    title: 'Workpaper Binder',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  win.once('ready-to-show', () => {
    win.show()
    // Dev seam: WPT_DEV_OPEN="/a.pdf:/b.pdf" preloads a binder so the import →
    // organize → export flow can be exercised without clicking through dialogs.
    // Dev builds only; packaged builds ignore it.
    const preopen = isDev ? process.env.WPT_DEV_OPEN : undefined
    if (preopen) {
      const paths = preopen
        .split(path.delimiter)
        .map((p) => path.resolve(p.trim()))
        .filter((p) => p.toLowerCase().endsWith('.pdf'))
      for (const p of paths) allowedInputs.add(p)
      // Optional: WPT_DEV_EXPORT lets the smoke test drive a real export
      // through IPC + the engine without a save dialog.
      const exportTo = process.env.WPT_DEV_EXPORT
        ? path.resolve(process.env.WPT_DEV_EXPORT)
        : undefined
      if (exportTo) allowedOutputs.add(exportTo)
      win.webContents.send('dev:open', {
        paths,
        exportTo,
        seedMarks: !!process.env.WPT_DEV_MARKS
      })
    }
  })

  // Never let the app navigate away or spawn windows — it is a local tool.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (isDev && devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
