import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  BrowserWindow,
  app,
  dialog,
  ipcMain,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent
} from 'electron'
import { atomicWriteJson, readSessionWithRecovery } from './persistence'
import { restrictedProcessEnv, runJsonCommand } from '../shared/json-process'

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
const packageUiSmoke = !isDev && process.argv.includes('--wpt-package-ui-smoke')

/**
 * Identity. Without this Electron calls itself "Electron" in the menu bar,
 * ⌘-Tab and the Dock — confusing when what you are actually running is a
 * binder full of client workpapers. Set before `ready` so the name is in place
 * by the time the app menu is built.
 */
app.setName('Workpaper Binder')

/** Repo root. Dev: out/main -> out -> app -> repo. Packaged: resources/. */
function repoRoot(): string {
  return isDev ? path.resolve(__dirname, '../../..') : process.resourcesPath
}

function engineDir(): string {
  return path.join(repoRoot(), 'engine')
}

/**
 * Development uses the checked-out virtualenv. A packaged build carries a
 * platform-native, one-folder PyInstaller sidecar in Resources/engine so the
 * CPA workstation does not need Python or project dependencies installed.
 */
function engineCommand(): { executable: string; args: string[]; cwd: string } {
  if (isDev) {
    const cwd = engineDir()
    const venv = path.join(cwd, '.venv')
    const executable =
      process.platform === 'win32'
        ? path.join(venv, 'Scripts', 'python.exe')
        : path.join(venv, 'bin', 'python')
    return { executable, args: ['-m', 'workpaper_engine.cli'], cwd }
  }

  const cwd = path.join(process.resourcesPath, 'engine')
  const executable = path.join(cwd, process.platform === 'win32' ? 'workpaper-engine.exe' : 'workpaper-engine')
  return { executable, args: [], cwd }
}

/** The Dock icon. Optional — a missing file must never stop the app starting. */
function appIconPath(): string | null {
  const candidates = [
    path.join(repoRoot(), 'app', 'resources', 'icon.png'),
    path.join(process.resourcesPath ?? '', 'icon.png')
  ]
  return candidates.find((p) => p && existsSync(p)) ?? null
}

/** Files the user explicitly opened. Gate for every read/probe. */
const allowedInputs = new Set<string>()
/** Paths the user picked in a save dialog. Gate for every write. */
const allowedOutputs = new Set<string>()
/** Session paths chosen in a save/open dialog. Existing saves must stay here. */
const allowedSessions = new Set<string>()
let rendererDirty = false
const trustedWebContents = new Set<number>()

function assertTrustedIpc(event: IpcMainInvokeEvent | IpcMainEvent): void {
  if (
    !trustedWebContents.has(event.sender.id) ||
    (event.senderFrame && event.senderFrame !== event.sender.mainFrame)
  ) {
    throw new Error('refused IPC from an untrusted renderer')
  }
}

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

/** Spawn the Python engine for one bounded JSON command. */
function runEngine(command: unknown): Promise<EngineOk | EngineErr> {
  const engine = engineCommand()
  return runJsonCommand<EngineOk | EngineErr>({
    executable: engine.executable,
    args: engine.args,
    cwd: engine.cwd,
    env: restrictedProcessEnv(isDev ? { PYTHONPATH: engine.cwd } : {}),
    command
  })
}

/**
 * What may enter a binder. Images become one Letter page each at export — the
 * engine's images.py is the only place that knows how. Keep this list in step
 * with IMAGE_SUFFIXES there.
 */
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'jpe', 'gif', 'bmp', 'tif', 'tiff', 'webp'] as const
const SOURCE_EXTS = ['pdf', ...IMAGE_EXTS] as const

function isSourcePath(p: string): boolean {
  const ext = path.extname(p).slice(1).toLowerCase()
  return (SOURCE_EXTS as readonly string[]).includes(ext)
}

// --------------------------------------------------------------------- IPC

function registerIpc(): void {
  ipcMain.handle('engine:ping', (event) => {
    assertTrustedIpc(event)
    return runEngine({ cmd: 'ping' })
  })

  ipcMain.handle('dialog:openPdfs', async (event) => {
    assertTrustedIpc(event)
    const res = await dialog.showOpenDialog({
      title: 'Add files to binder',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'PDFs and images', extensions: [...SOURCE_EXTS] },
        { name: 'PDF', extensions: ['pdf'] },
        { name: 'Images', extensions: [...IMAGE_EXTS] }
      ]
    })
    if (res.canceled) return []
    for (const p of res.filePaths) allowedInputs.add(path.resolve(p))
    return res.filePaths
  })

  /** Authorize paths extracted by the preload from genuine dropped Files. */
  ipcMain.handle('files:registerDropped', (event, paths: unknown) => {
    assertTrustedIpc(event)
    if (!Array.isArray(paths)) return []
    const ok: string[] = []
    for (const p of paths) {
      if (typeof p === 'string' && isSourcePath(p) && existsSync(path.resolve(p))) {
        const abs = path.resolve(p)
        allowedInputs.add(abs)
        ok.push(abs)
      }
    }
    return ok
  })

  /** Source bytes for rendering: a PDF for PDF.js, or an image for the canvas. */
  ipcMain.handle('fs:readSource', async (_e, p: unknown) => {
    assertTrustedIpc(_e)
    const abs = assertAllowed(allowedInputs, p, 'file')
    const buf = await readFile(abs)
    return new Uint8Array(buf)
  })

  ipcMain.handle('engine:probe', async (_e, p: unknown) => {
    assertTrustedIpc(_e)
    const abs = assertAllowed(allowedInputs, p, 'file')
    return runEngine({ cmd: 'probe', path: abs })
  })

  ipcMain.handle('dialog:saveBinderAs', async (_e, suggested: unknown) => {
    assertTrustedIpc(_e)
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
    assertTrustedIpc(_e)
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
    assertTrustedIpc(_e)
    let target = typeof existing === 'string' ? assertAllowed(allowedSessions, existing, 'session path') : null
    if (!target) {
      const res = await dialog.showSaveDialog({
        title: 'Save binder session',
        defaultPath: 'binder.wptsession.json',
        filters: [{ name: 'Workpaper session', extensions: ['json'] }]
      })
      if (res.canceled || !res.filePath) return null
      target = path.resolve(res.filePath)
      allowedSessions.add(target)
    }
    await atomicWriteJson(target, session)
    return target
  })

  ipcMain.handle('session:open', async (event) => {
    assertTrustedIpc(event)
    const res = await dialog.showOpenDialog({
      title: 'Open binder session',
      properties: ['openFile'],
      filters: [{ name: 'Workpaper session', extensions: ['json'] }]
    })
    if (res.canceled || !res.filePaths[0]) return null
    const target = path.resolve(res.filePaths[0])
    allowedSessions.add(target)
    const read = await readSessionWithRecovery(target)
    // Selecting a session authorizes only the PDF/image paths it explicitly
    // references. The renderer never gets a generic string-to-file capability.
    for (const raw of [read.session, read.recoverySession]) {
      if (typeof raw !== 'object' || raw === null) continue
      const sources = (raw as { sources?: unknown }).sources
      if (!Array.isArray(sources)) continue
      for (const source of sources) {
        const candidate = (source as { path?: unknown })?.path
        if (typeof candidate === 'string' && isSourcePath(candidate)) {
          allowedInputs.add(path.resolve(candidate))
        }
      }
    }
    return { path: target, ...read }
  })

  ipcMain.handle('dialog:relinkSource', async (_e, sourceName: unknown) => {
    assertTrustedIpc(_e)
    const res = await dialog.showOpenDialog({
      title: `Locate ${typeof sourceName === 'string' ? sourceName : 'missing source'}`,
      properties: ['openFile'],
      filters: [
        { name: 'PDFs and images', extensions: [...SOURCE_EXTS] },
        { name: 'PDF', extensions: ['pdf'] },
        { name: 'Images', extensions: [...IMAGE_EXTS] }
      ]
    })
    if (res.canceled || !res.filePaths[0]) return null
    const target = path.resolve(res.filePaths[0])
    if (!isSourcePath(target)) return null
    allowedInputs.add(target)
    return target
  })

  ipcMain.handle('session:confirmDiscard', async (event) => {
    assertTrustedIpc(event)
    if (!rendererDirty) return true
    const result = await dialog.showMessageBox({
      type: 'warning',
      title: 'Unsaved workpaper changes',
      message: 'This binder has changes that have not been saved.',
      detail: 'Continue only if you want to discard those changes.',
      buttons: ['Keep editing', 'Discard changes'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    })
    return result.response === 1
  })

  ipcMain.on('session:setDirty', (_e, dirty: unknown) => {
    assertTrustedIpc(_e)
    rendererDirty = dirty === true
  })

  ipcMain.handle('shell:reveal', (_e, p: unknown) => {
    assertTrustedIpc(_e)
    const target = assertAllowed(allowedOutputs, p, 'revealed output')
    shell.showItemInFolder(target)
  })

  /**
   * Dev smoke-test hook. The renderer reports when it has finished loading a
   * binder; with WPT_DEV_SHOT set we snapshot the window to a PNG (and quit if
   * WPT_DEV_EXIT is set). Lets the GUI be verified without a human clicking, and
   * without OS screen-recording permission. Dev builds only.
   */
  ipcMain.on('dev:rendered', async (e) => {
    assertTrustedIpc(e)
    const shot = isDev
      ? process.env.WPT_DEV_SHOT
      : packageUiSmoke
        ? process.env.WPT_PACKAGE_SMOKE_SHOT
        : undefined
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
    if ((isDev && process.env.WPT_DEV_EXIT) || packageUiSmoke) app.quit()
  })
}

// ------------------------------------------------------------------ window

function createWindow(): void {
  let allowWindowClose = false
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
  trustedWebContents.add(win.webContents.id)
  win.webContents.once('destroyed', () => trustedWebContents.delete(win.webContents.id))

  // This application never needs browser permissions, webviews, or navigation.
  // Deny them centrally so a future renderer bug cannot silently widen scope.
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  win.webContents.session.setPermissionCheckHandler(() => false)
  win.webContents.on('will-attach-webview', (event) => event.preventDefault())
  win.webContents.on('will-navigate', (event) => event.preventDefault())

  win.once('ready-to-show', () => {
    win.show()
    // Dev seam: WPT_DEV_OPEN="/a.pdf:/b.pdf" preloads a binder so the import →
    // organize → export flow can be exercised without clicking through dialogs.
    // Dev builds only; packaged builds ignore it.
    const preopen = isDev
      ? process.env.WPT_DEV_OPEN
      : packageUiSmoke
        ? process.env.WPT_PACKAGE_SMOKE_OPEN
        : undefined
    if (preopen) {
      const paths = preopen
        .split(path.delimiter)
        .map((p) => path.resolve(p.trim()))
        .filter(isSourcePath)
      for (const p of paths) allowedInputs.add(p)
      // Optional: WPT_DEV_EXPORT lets the smoke test drive a real export
      // through IPC + the engine without a save dialog.
      const exportTo = isDev && process.env.WPT_DEV_EXPORT
        ? path.resolve(process.env.WPT_DEV_EXPORT)
        : undefined
      if (exportTo) allowedOutputs.add(exportTo)
      win.webContents.send('dev:open', {
        paths,
        exportTo,
        seedMarks: isDev && !!process.env.WPT_DEV_MARKS
      })
    }
  })

  // Never let the app navigate away or spawn windows — it is a local tool.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  win.on('close', (event) => {
    if (
      allowWindowClose ||
      !rendererDirty ||
      (isDev && process.env.WPT_DEV_EXIT) ||
      packageUiSmoke
    ) {
      return
    }
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      title: 'Unsaved workpaper changes',
      message: 'This binder has changes that have not been saved.',
      detail: 'Keep editing and save the session before closing.',
      buttons: ['Keep editing', 'Discard changes'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    })
    if (choice === 0) event.preventDefault()
    else allowWindowClose = true
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (isDev && devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  // Release-pipeline health check: exercises the packaged main-process path and
  // bundled native engine without opening client files or exposing dev IPC.
  if (!isDev && process.argv.includes('--wpt-package-smoke')) {
    const result = await runEngine({ cmd: 'ping' })
    if (!result.ok) {
      console.error(`[package-smoke] ${result.error}`)
      app.exit(1)
      return
    }
    console.log(`[package-smoke] engine ${String(result.version)} ready`)
    app.exit(0)
    return
  }

  // Dock icon, macOS only. In dev this is the difference between a generic
  // Electron diamond and something recognisable in ⌘-Tab.
  if (process.platform === 'darwin' && app.dock) {
    const icon = appIconPath()
    if (icon) app.dock.setIcon(icon)
  }
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
