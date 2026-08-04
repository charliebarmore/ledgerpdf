import { existsSync } from 'node:fs'
import { readFile, rm, stat, writeFile } from 'node:fs/promises'
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
import {
  atomicWriteJson,
  binderRecoveryPathFor,
  hideFromUser,
  readSessionWithRecovery,
  workingCopyPathFor
} from './persistence'
import { restrictedProcessEnv, runJsonCommand } from '../shared/json-process'
import { toSaved, type Session } from '../renderer/src/session'

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
/** binder path -> its de-marked working copy, for cleanup on close. */
const openWorkingCopies = new Map<string, string>()

/**
 * Drop the sibling files a binder needs only while it is open.
 *
 * The working copy is derived data and must not outlive the session that made
 * it — a stray de-marked copy of client workpapers left in an engagement folder
 * is exactly the kind of thing a firm should never find. The autosave sibling
 * goes too, because a clean save means there is nothing left to recover.
 */
async function releaseBinder(binder: string): Promise<void> {
  const working = openWorkingCopies.get(binder)
  openWorkingCopies.delete(binder)
  await Promise.all([
    working ? rm(working, { force: true }).catch(() => {}) : Promise.resolve(),
    rm(binderRecoveryPathFor(binder), { force: true }).catch(() => {})
  ])
}
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
/** Excel IS the workpaper format — see engine/sheets.py for what it becomes. */
const SHEET_EXTS = ['xlsx', 'xlsm', 'csv'] as const
/** Prose an agent writes — typeset, not dumped. See engine/documents.py. */
const DOC_EXTS = ['md', 'markdown', 'docx'] as const
const SOURCE_EXTS = ['pdf', ...SHEET_EXTS, ...DOC_EXTS, ...IMAGE_EXTS] as const

function isSourcePath(p: string): boolean {
  const ext = path.extname(p).slice(1).toLowerCase()
  return (SOURCE_EXTS as readonly string[]).includes(ext)
}

// --------------------------------------------------------------------- IPC


// ------------------------------------------------------- live agent access

/**
 * The renderer owns the binder — the undo stack, the autosave timer, and the
 * window someone is looking at. So live access asks it for the session and
 * hands changes back, rather than keeping a second copy that would fight the
 * first.
 *
 * Electron has no main->renderer invoke, so requests carry an id and the
 * renderer replies on one channel.
 */
let liveWindow: BrowserWindow | null = null
let liveSeq = 0
const livePending = new Map<number, (payload: unknown) => void>()

function askRenderer(kind: 'pull' | 'push', payload?: unknown): Promise<unknown> {
  const win = liveWindow
  if (!win || win.isDestroyed()) return Promise.reject(new Error('no open binder window'))
  const id = ++liveSeq
  return new Promise((resolve, reject) => {
    // A renderer that never answers must not wedge the agent forever.
    const timer = setTimeout(() => {
      livePending.delete(id)
      reject(new Error('the binder window did not respond'))
    }, 15_000)
    livePending.set(id, (value) => {
      clearTimeout(timer)
      resolve(value)
    })
    win.webContents.send('live:request', { id, kind, payload })
  })
}

/**
 * Authorize the source files a session names.
 *
 * The renderer has no generic read capability — it may only read paths a user
 * action authorized. A session arriving from a live agent names files this
 * process never opened a dialog for, so drawing them was refused and the page
 * showed "file not user-authorized this session" while the agent reported
 * success.
 *
 * Only paths that exist and are source types are authorized, and only from a
 * session that came through the authenticated live socket the user turned on
 * deliberately. Same rule the older session-open path already used: opening a
 * session authorizes the files it names, never a path string on its own.
 */
function authorizeSessionSources(session: unknown): number {
  if (typeof session !== 'object' || session === null) return 0
  const sources = (session as { sources?: unknown }).sources
  if (!Array.isArray(sources)) return 0
  let added = 0
  for (const source of sources) {
    const candidate = (source as { path?: unknown })?.path
    if (typeof candidate !== 'string' || !isSourcePath(candidate)) continue
    const abs = path.resolve(candidate)
    if (!existsSync(abs) || allowedInputs.has(abs)) continue
    allowedInputs.add(abs)
    added += 1
  }
  return added
}

/** Turn live agent access on or off. Off is the default and the safe state. */
async function setLiveAccess(on: boolean): Promise<{ on: boolean; socketPath?: string }> {
  const { startLive, stopLive, liveStatus } = await import('./live-host')
  // Main is the authority on this state and announces every change. The
  // indicator is security-relevant, so it must never be able to say "off"
  // while the socket is open — which it did when a path other than the button
  // enabled it.
  const announce = (state: { on: boolean; socketPath?: string }): typeof state => {
    if (liveWindow && !liveWindow.isDestroyed()) liveWindow.webContents.send('live:state', state)
    return state
  }
  if (!on) {
    await stopLive()
    return announce({ on: false })
  }
  const already = liveStatus()
  if (already) return announce({ on: true, socketPath: already.socketPath })
  const started = await startLive({
    pull: async () =>
      (await askRenderer('pull')) as {
        session: unknown
        path: string | null
        currentPage?: string | null
      },
    push: async (session) => {
      // Before the renderer is asked to draw it.
      authorizeSessionSources(session)
      await askRenderer('push', session)
    }
  })
  return announce({ on: true, socketPath: started.socketPath })
}

async function openBinderAt(target: string): Promise<unknown> {

    // ---- the older two-file format: read it so the user can convert it once
    if (path.extname(target).toLowerCase() === '.json') {
      allowedSessions.add(target)
      const read = await readSessionWithRecovery(target)
      // Opening a session authorizes only the PDF/image paths it explicitly
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
      return { kind: 'legacy' as const, path: target, ...read }
    }

    // ---- a binder
    allowedInputs.add(target)
    // Saving writes back over this same file, so it is an authorized output too.
    allowedOutputs.add(target)

    const opened = await runEngine({ cmd: 'open_binder', path: target })
    if (!opened.ok) {
      return { kind: 'error' as const, path: target, error: (opened as EngineErr).error }
    }
    const info = (opened as EngineOk).binder as {
      found: boolean
      reason?: string
      payload_intact?: boolean
      geometry_matches?: boolean
      session?: unknown
    }

    // A PDF with no session is an ordinary file someone wants to work on, which
    // is the normal way a binder starts. Hand it back for import, not an error.
    if (!info.found) {
      return { kind: 'plain' as const, path: target, reason: info.reason }
    }

    const working = workingCopyPathFor(target)
    const cleaned = await runEngine({ cmd: 'clean_copy', path: target, output: working })
    if (!cleaned.ok) {
      return { kind: 'error' as const, path: target, error: (cleaned as EngineErr).error }
    }
    await hideFromUser(working)
    allowedInputs.add(working)
    openWorkingCopies.set(target, working)

    // An autosave sibling newer than the binder means the app closed without a
    // save. Hand both to the renderer and let the user choose; never silently
    // prefer one over the other.
    let pendingAutosave: unknown
    try {
      const recoveryPath = binderRecoveryPathFor(target)
      const [recoveryStat, binderStat] = await Promise.all([stat(recoveryPath), stat(target)])
      if (recoveryStat.mtimeMs > binderStat.mtimeMs) {
        pendingAutosave = JSON.parse(await readFile(recoveryPath, 'utf8'))
      }
    } catch {
      // No autosave sibling is the normal case.
    }

    return {
      kind: 'binder' as const,
      path: target,
      workingPath: working,
      session: info.session,
      payloadIntact: info.payload_intact === true,
      geometryMatches: info.geometry_matches === true,
      ...(pendingAutosave !== undefined ? { pendingAutosave } : {})
    }
}

function registerIpc(): void {
  ipcMain.on('live:reply', (e, id: unknown, payload: unknown) => {
    assertTrustedIpc(e)
    const resolve = typeof id === 'number' ? livePending.get(id) : undefined
    if (resolve) {
      livePending.delete(id as number)
      resolve(payload)
    }
  })

  ipcMain.handle('live:set', async (e, on: unknown) => {
    assertTrustedIpc(e)
    return setLiveAccess(on === true)
  })

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
        { name: 'Workpaper sources', extensions: [...SOURCE_EXTS] },
        { name: 'PDF', extensions: ['pdf'] },
        { name: 'Spreadsheets', extensions: [...SHEET_EXTS] },
        { name: 'Documents', extensions: [...DOC_EXTS] },
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
    // The renderer draws with PDF.js, so a spreadsheet's own bytes (a ZIP) get
    // it "Invalid PDF structure" — import, text and export all worked and only
    // the thing a person looks at did not. Hand back the pages the sheet
    // BECOMES, which are the same pages the export writes.
    if ([...SHEET_EXTS, ...DOC_EXTS].some((ext) => abs.toLowerCase().endsWith(`.${ext}`))) {
      const res = await runEngine({ cmd: 'materialize', path: abs })
      if (!res.ok || typeof res.pdf_base64 !== 'string') {
        throw new Error(`could not read ${path.basename(abs)}: ${String(res.error ?? 'no pages')}`)
      }
      return new Uint8Array(Buffer.from(res.pdf_base64, 'base64'))
    }
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

  /**
   * Autosave for an open binder.
   *
   * Writes the small JSON sibling, never the binder itself — re-writing a
   * several-hundred-page PDF after every edit is not something to do on a timer.
   * The binder is written when the user saves.
   */
  ipcMain.handle('binder:autosave', async (_e, binder: unknown, session: unknown) => {
    assertTrustedIpc(_e)
    const target = assertAllowed(allowedOutputs, binder, 'binder path')
    const recovery = binderRecoveryPathFor(target)
    await atomicWriteJson(recovery, { binder: target, savedAt: new Date().toISOString(), session }, {
      keepRecovery: false
    })
    // A dot prefix hides this on macOS and does nothing on Windows.
    await hideFromUser(recovery)
    return recovery
  })

  /** Discard the working copy and autosave sibling once a binder is closed. */
  ipcMain.handle('binder:release', async (_e, binder: unknown) => {
    assertTrustedIpc(_e)
    if (typeof binder !== 'string') return
    await releaseBinder(path.resolve(binder))
  })

  /**
   * Open a saved binder — or an older `.wptsession.json`, once, so nothing
   * made before the single-file model is stranded.
   *
   * For a binder this does three things the renderer cannot: recovers the
   * embedded session, writes the de-marked working copy the app renders from,
   * and reports whether the pages moved since the session was written.
   */
  ipcMain.handle('binder:open', async (event, devPath: unknown) => {
    assertTrustedIpc(event)
    // Dev seam: open a binder without the dialog, so the single-file reopen
    // path — the primary flow now — can be driven headlessly. Dev builds only.
    if (isDev && typeof devPath === 'string' && devPath) {
      return openBinderAt(path.resolve(devPath))
    }
    const res = await dialog.showOpenDialog({
      title: 'Open binder',
      properties: ['openFile'],
      filters: [
        { name: 'Workpaper binder', extensions: ['pdf'] },
        { name: 'Older session file', extensions: ['json'] }
      ]
    })
    if (res.canceled || !res.filePaths[0]) return null
    return openBinderAt(path.resolve(res.filePaths[0]))
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
  ipcMain.on('dev:rendered', async (e, loaded: unknown) => {
    assertTrustedIpc(e)
    // Dev seam: bring live access up once a binder is loaded, so the live check
    // can drive the running app for real. Main does this rather than the
    // renderer because a sandboxed preload has no process.env, and because
    // main's stdout is what a test can actually read.
    if (isDev && process.env.WPT_DEV_LIVE === '1') {
      try {
        const live = await setLiveAccess(true)
        console.log(`[dev] live agent access at ${live.socketPath}`)
      } catch (error) {
        console.error(`[dev] live agent access failed: ${String(error)}`)
      }
    }
    // A screenshot only proves the window painted. Report the binder the
    // renderer actually holds, so the packaged check can fail on an empty one.
    if (packageUiSmoke) {
      const shape = (loaded ?? {}) as { pages?: unknown; sources?: unknown; exported?: unknown }
      const pages = typeof shape.pages === 'number' ? shape.pages : 0
      const sources = typeof shape.sources === 'number' ? shape.sources : 0
      console.log(`[package-smoke] loaded ${pages} pages from ${sources} sources`)
      if (typeof shape.exported === 'string') {
        console.log(`[package-smoke] export ${shape.exported}`)
      }
    }
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
  liveWindow = win
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
      // Optional: lets the smoke test drive a real export through IPC + the
      // engine without a save dialog. The packaged variant matters more than
      // the dev one — until it existed, no export had ever run through the
      // *frozen* sidecar on Windows, which is precisely where the read-only
      // fsync bug that broke every Windows export was hiding. Same gate as
      // the preopen above: an explicit argv flag no shipped app is launched
      // with, plus an env var, and the path still goes through allowedOutputs.
      const exportEnv = isDev
        ? process.env.WPT_DEV_EXPORT
        : packageUiSmoke
          ? process.env.WPT_PACKAGE_SMOKE_EXPORT
          : undefined
      const exportTo = exportEnv ? path.resolve(exportEnv) : undefined
      if (exportTo) allowedOutputs.add(exportTo)
      win.webContents.send('dev:open', {
        paths,
        exportTo,
        seedMarks: isDev && !!process.env.WPT_DEV_MARKS,
        reopen: isDev ? process.env.WPT_DEV_REOPEN : undefined
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

// Never leave a live socket or its token behind for the next process to find.
// `before-quit` misses a signalled shutdown, which is exactly how a socket
// survived a killed dev run — so the signals are handled too. SIGKILL cannot
// be caught; a client that dials a dead socket falls back to standalone.
const stopLiveQuietly = (): void => {
  void import('./live-host')
    .then(({ stopLive }) => stopLive())
    .catch(() => {})
}
app.on('before-quit', stopLiveQuietly)
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopLiveQuietly()
    app.quit()
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

/**
 * Never leave a de-marked copy of client workpapers behind. Best effort and
 * synchronous-ish: a crash can still strand one, which is why opening a binder
 * overwrites any working copy already sitting beside it.
 */
app.on('before-quit', async () => {
  await Promise.all([...openWorkingCopies.keys()].map((binder) => releaseBinder(binder)))
})
