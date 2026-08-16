import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  BrowserWindow,
  app,
  dialog,
  ipcMain,
  net,
  protocol,
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
import { clearRecents, readRecents, rememberBinder } from './recents'
import {
  readMarkSizes,
  readPreparerInitials,
  writeMarkSize,
  writePreparerInitials
} from './preferences'
import {
  isPathInsideRoot,
  readAgentRoots,
  readAgentRootsSync,
  writeAgentRoots
} from '../shared/agent-roots'
import { toSaved, type Session } from '../renderer/src/session'
import { agentConnectCommand, unstableInstallReason } from '../shared/agent-connect'
import { argvOpenTarget } from '../shared/argv-open'
import { acquireBinderLock, type BinderLease } from '../shared/binder-lock'
import {
  RENDERER_ENTRY_URL,
  RENDERER_SCHEME,
  rendererAssetPath
} from './renderer-protocol'

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

/**
 * A closed pipe must never take the app down.
 *
 * Launched from a terminal, stdout and stderr are pipes owned by the parent.
 * When that parent goes away — the shell closes, `npm run dev` is interrupted —
 * the next write fails with EPIPE. Node emits that on the stream, and an
 * unhandled stream error in the main process is an uncaught exception, which
 * Electron reports as "A JavaScript error occurred in the main process" over a
 * running app with unsaved work in it.
 *
 * Diagnostics are not worth a crash. Only EPIPE is swallowed; anything else
 * still surfaces, so this cannot hide a real fault.
 */
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error?.code === 'EPIPE') return
    throw error
  })
}

const isDev = !app.isPackaged
const packageUiSmoke = !isDev && process.argv.includes('--wpt-package-ui-smoke')
/** Either headless verification run. Not a person launching the app. */
const packageSmoke = packageUiSmoke || (!isDev && process.argv.includes('--wpt-package-smoke'))

/**
 * Identity. Without this Electron calls itself "Electron" in the menu bar,
 * ⌘-Tab and the Dock — confusing when what you are actually running is a
 * binder full of client workpapers. Set before `ready` so the name is in place
 * by the time the app menu is built.
 */
app.setName('LedgerPDF')

/**
 * Treat the packaged renderer as an ordinary secure web origin rather than a
 * privileged file:// page. This declaration must happen before app.ready;
 * the narrowly contained handler itself is installed after ready below.
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: RENDERER_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
])

/**
 * Dev seam: give a headless run its own userData directory.
 *
 * Preferences now persist across binders — the preparer's initials among them —
 * which makes any test that depends on "no initials stored yet" both fragile
 * and destructive. Fragile because it passes once and then never again, having
 * stored the answer on its first run; destructive because the state it stores
 * is the developer's own. The scripted placement smoke hit exactly that: green
 * on its first run, then failing identically for the wrong reason.
 *
 * Set before `whenReady`, because Electron resolves userData lazily on first
 * use and moving it afterwards would leave earlier reads pointing elsewhere.
 */
const isolatedUserData = isDev
  ? process.env.WPT_DEV_USERDATA
  : packageSmoke
    ? process.env.WPT_PACKAGE_SMOKE_USERDATA
    : undefined
if (isolatedUserData) {
  app.setPath('userData', path.resolve(isolatedUserData))
}

/**
 * A binder opened from Finder or Explorer.
 *
 * macOS delivers it through `open-file`, which can fire BEFORE the window
 * exists, so the path is held until there is somewhere to send it. Windows and
 * Linux pass it in argv instead. Registered here rather than inside `ready` for
 * the same reason: the event arrives early.
 */
let pendingOpen: string | null = null

/**
 * Paths the OPERATING SYSTEM asked us to open — Finder's double-click and Open
 * With, and a file handed to a second launch.
 *
 * The renderer echoes the path back through `binder:open`, and main accepts it
 * only if it is one main itself delivered. That is what keeps this from becoming
 * a "read any file you name" capability: the renderer cannot invent an entry
 * here, and each is consumed on use.
 */
const osRequestedOpens = new Set<string>()

function requestOpen(target: string): void {
  osRequestedOpens.add(target)
  const win = BrowserWindow.getAllWindows()[0]
  if (!win || win.isDestroyed() || win.webContents.isLoading()) {
    pendingOpen = target
    return
  }
  win.webContents.send('binder:openPath', target)
  win.focus()
}

app.on('open-file', (event, filePath) => {
  event.preventDefault()
  requestOpen(path.resolve(filePath))
})

/**
 * Windows and Linux hand a double-clicked file to a COLD launch in argv —
 * there is no open-file event. `second-instance` below covers the warm
 * launch; this covers the cold one. The pair is what kept "double-click
 * never worked in a packaged build" invisible: anyone testing casually has
 * the app already running and takes the warm path, which worked.
 * (Same class as the two bugs commented further down at the recents fix.)
 */
if (process.platform !== 'darwin' && !packageSmoke) {
  const coldOpen = argvOpenTarget(process.argv)
  if (coldOpen) requestOpen(path.resolve(coldOpen))
}

/**
 * Printed to stderr when a scripted run cannot get the single-instance lock, so
 * the verifier can name the cause instead of guessing from missing files.
 * Matched literally in `app/scripts/smoke.mjs` — the two are bundled separately,
 * so this is a shared literal by agreement rather than a shared import.
 */
const SINGLE_INSTANCE_LOCK_HELD = 'WPT_SINGLE_INSTANCE_LOCK_HELD'

/**
 * A second launch hands its file to the running instance rather than starting
 * again.
 *
 * Skipped for a packaged smoke run. That is headless verification, not somebody
 * opening a binder, and the lock is claimed here at module load — before
 * `whenReady`, so before the smoke ever runs. If anything else holds it, this
 * process calls `app.quit()` and exits 0 having produced no output at all,
 * which a verifier cannot distinguish from a healthy app that said nothing.
 */
if (!packageSmoke) {
  if (!app.requestSingleInstanceLock()) {
    // A human double-clicking a second PDF wants the running app to open it,
    // and nothing needs saying. A VERIFIER is the other case, and silence has
    // cost real coverage: this path quit with code 0 and no output, so the dev
    // smoke's "app ran and exited cleanly" PASSED while the screenshot and the
    // export never happened — two missing-file failures pointing at the export
    // code, when the actual cause was an app already running. Three runs over
    // two days reported themselves that way, and two commits shipped saying
    // their GUI coverage "could not run".
    //
    // So when the environment says a scripted run is watching, say why and
    // exit non-zero. The marker is matched literally in app/scripts/smoke.mjs.
    if (process.env.WPT_DEV_EXIT || process.env.WPT_DEV_SHOT) {
      process.stderr.write(`${SINGLE_INSTANCE_LOCK_HELD}\n`)
      app.exit(1)
    } else {
      app.quit()
    }
  } else {
    app.on('second-instance', (_e, argv) => {
      const target = argvOpenTarget(argv)
      if (target) requestOpen(path.resolve(target))
    })
  }
}

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
/** binder path -> the cross-process lease held for as long as it is open. */
const binderLocks = new Map<string, BinderLease>()

async function claimBinder(binder: string): Promise<{ lease: BinderLease; acquired: boolean }> {
  const absolute = path.resolve(binder)
  const existing = binderLocks.get(absolute)
  if (existing) return { lease: existing, acquired: false }
  const lease = await acquireBinderLock(absolute)
  binderLocks.set(absolute, lease)
  return { lease, acquired: true }
}

async function releaseBinderLease(binder: string): Promise<void> {
  const absolute = path.resolve(binder)
  const lease = binderLocks.get(absolute)
  if (!lease) return
  binderLocks.delete(absolute)
  await lease.release().catch(() => {})
}

/**
 * Drop the sibling files a binder needs only while it is open.
 *
 * The working copy is derived data and must not outlive the session that made
 * it — a stray de-marked copy of client workpapers left in an engagement folder
 * is exactly the kind of thing a firm should never find. The autosave sibling
 * goes too, because a clean save means there is nothing left to recover.
 */
async function releaseBinder(binder: string): Promise<void> {
  const absolute = path.resolve(binder)
  // Only a binder opened or saved by this main process has siblings or a lease
  // to release. A trusted-but-compromised renderer must not turn this into a
  // generic "delete the recovery-shaped sibling of any path" capability.
  if (!openWorkingCopies.has(absolute) && !binderLocks.has(absolute)) return
  const working = openWorkingCopies.get(absolute)
  openWorkingCopies.delete(absolute)
  await Promise.all([
    working ? rm(working, { force: true }).catch(() => {}) : Promise.resolve(),
    rm(binderRecoveryPathFor(absolute), { force: true }).catch(() => {}),
    releaseBinderLease(absolute)
  ])
}
let rendererDirty = false
/** Live access started once by whichever dev seam fires first. */
let liveAnnounced = false
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
async function runEngine(command: unknown): Promise<EngineOk | EngineErr> {
  const engine = engineCommand()
  const result = await runJsonCommand<(EngineOk | EngineErr) & { warnings?: string }>({
    executable: engine.executable,
    args: engine.args,
    cwd: engine.cwd,
    env: restrictedProcessEnv(isDev ? { PYTHONPATH: engine.cwd } : {}),
    command
  })
  // Engine stderr on a successful call is a warning, not noise — a discarded
  // PageCopyWarning is how dropped form fields stayed invisible.
  if (result.warnings) console.warn(`[engine warning] ${result.warnings}`)
  return result
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
let liveWindowReady = false
let liveWindowBlock: string | null = null
let liveSeq = 0
interface PendingLiveRequest {
  windowId: number
  request: Record<string, unknown>
  sent: boolean
  resolve: (payload: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}
const livePending = new Map<number, PendingLiveRequest>()

function sendLiveRequest(id: number): void {
  const pending = livePending.get(id)
  const win = liveWindow
  if (!pending || pending.sent || !liveWindowReady || !win || win.isDestroyed()) return
  if (pending.windowId !== win.webContents.id) return
  pending.sent = true
  win.webContents.send('live:request', pending.request)
}

function rejectLiveRequests(windowId: number, message: string): void {
  for (const [id, pending] of livePending) {
    if (pending.windowId !== windowId) continue
    livePending.delete(id)
    clearTimeout(pending.timer)
    pending.reject(new Error(message))
  }
}

function askRenderer(
  kind: 'pull' | 'push',
  payload?: unknown,
  focus?: string | null,
  expectedRevision?: number
): Promise<unknown> {
  const win = liveWindow
  if (!win || win.isDestroyed()) {
    return Promise.reject(
      new Error(
        'live agent access ended because the binder window closed; reopen the binder and turn live access on again'
      )
    )
  }
  if (liveWindowBlock) return Promise.reject(new Error(liveWindowBlock))
  const id = ++liveSeq
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const pending = livePending.get(id)
      livePending.delete(id)
      reject(
        new Error(
          pending?.sent
            ? 'the binder window did not respond'
            : 'the binder window did not become ready'
        )
      )
    }, 15_000)
    livePending.set(id, {
      windowId: win.webContents.id,
      request: {
        id,
        kind,
        payload,
        ...(focus ? { focus } : {}),
        ...(typeof expectedRevision === 'number' ? { expectedRevision } : {})
      },
      sent: false,
      resolve,
      reject,
      timer
    })
    sendLiveRequest(id)
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
  const roots = readAgentRootsSync()
  let added = 0
  const refused: string[] = []
  for (const source of sources) {
    const candidate = (source as { path?: unknown })?.path
    if (typeof candidate !== 'string' || !isSourcePath(candidate)) continue
    const abs = path.resolve(candidate)
    if (!existsSync(abs) || allowedInputs.has(abs)) continue
    const canonical = realpathSync(abs)
    if (!roots.some((root) => isPathInsideRoot(root, canonical))) {
      refused.push(canonical)
      continue
    }
    allowedInputs.add(canonical)
    added += 1
  }
  if (refused.length) {
    throw new Error(
      `live agent requested source(s) outside the approved folders: ${refused.join(', ')}`
    )
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
        documentId?: string
        currentPage?: string | null
      },
    push: async (session, focus, expectedRevision) => {
      // Before the renderer is asked to draw it.
      authorizeSessionSources(session)
      const reply = (await askRenderer('push', session, focus, expectedRevision)) as {
        ok?: boolean
        error?: string
      }
      if (reply?.ok !== true) throw new Error(reply?.error ?? 'the binder rejected the change')
    }
  })
  return announce({ on: true, socketPath: started.socketPath })
}

/**
 * The renderer must be able to PULL this security-relevant state.
 *
 * A broadcast is not durable: one sent before React subscribes is lost, and a
 * window recreated after ⌘W starts with fresh renderer state. Never expose the
 * live handle itself here because it also carries the authentication token.
 */
async function currentLiveAccess(): Promise<{ on: boolean; socketPath?: string }> {
  const { liveStatus } = await import('./live-host')
  const status = liveStatus()
  return status ? { on: true, socketPath: status.socketPath } : { on: false }
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

    let claimed: { lease: BinderLease; acquired: boolean }
    try {
      claimed = await claimBinder(target)
    } catch (error) {
      return { kind: 'error' as const, path: target, error: String((error as Error).message) }
    }
    const releaseFailedOpen = async (): Promise<void> => {
      if (claimed.acquired) await releaseBinderLease(target)
    }

    const opened = await runEngine({ cmd: 'open_binder', path: target })
    if (!opened.ok) {
      await releaseFailedOpen()
      return { kind: 'error' as const, path: target, error: (opened as EngineErr).error }
    }
    const info = (opened as EngineOk).binder as {
      found: boolean
      reason?: string
      flattened?: boolean
      payload_intact?: boolean
      geometry_matches?: boolean
      session?: unknown
    }

    // A PDF with no session is an ordinary file someone wants to work on, which
    // is the normal way a binder starts. Hand it back for import, not an error.
    if (!info.found) {
      await releaseFailedOpen()
      if (info.flattened) {
        const result = await dialog.showMessageBox({
          type: 'warning',
          title: 'This is a flattened copy',
          message: `${path.basename(target)} is a copy for sending, not the editable binder.`,
          detail:
            'Its LedgerPDF marks and note icons are printed permanently into the pages. They cannot be clicked, edited, or recovered from this copy. Open the editable binder if you need the comments.\n\nYou can still open this PDF as a new binder and add new marks of your own.',
          buttons: ['Cancel', 'Open as a new binder'],
          defaultId: 0,
          cancelId: 0,
          noLink: true
        })
        if (result.response !== 1) return null
      }
      return {
        kind: 'plain' as const,
        path: target,
        reason: info.reason,
        ...(info.flattened ? { flattened: true } : {})
      }
    }

    const working = workingCopyPathFor(target)
    const cleaned = await runEngine({ cmd: 'clean_copy', path: target, output: working })
    if (!cleaned.ok) {
      await releaseFailedOpen()
      return { kind: 'error' as const, path: target, error: (cleaned as EngineErr).error }
    }
    await hideFromUser(working)
    allowedInputs.add(working)
    openWorkingCopies.set(target, working)
    void rememberBinder(app.getPath('userData'), target).catch(() => {})

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
  ipcMain.on('live:ready', (e) => {
    assertTrustedIpc(e)
    const senderId = e.sender.id
    const accept = (): void => {
      if (
        !liveWindow ||
        liveWindow.isDestroyed() ||
        senderId !== liveWindow.webContents.id
      ) {
        return
      }
      liveWindowReady = true
      for (const id of livePending.keys()) sendLiveRequest(id)
    }
    const devDelay = isDev ? Number(process.env.WPT_DEV_LIVE_READY_DELAY_MS) : NaN
    if (Number.isFinite(devDelay) && devDelay > 0) setTimeout(accept, devDelay)
    else accept()
  })

  ipcMain.on('live:reply', (e, id: unknown, payload: unknown) => {
    assertTrustedIpc(e)
    const pending = typeof id === 'number' ? livePending.get(id) : undefined
    if (pending && pending.windowId === e.sender.id) {
      livePending.delete(id as number)
      clearTimeout(pending.timer)
      pending.resolve(payload)
    }
  })

  ipcMain.handle('live:set', async (e, on: unknown) => {
    assertTrustedIpc(e)
    return setLiveAccess(on === true)
  })

  ipcMain.handle('live:get', async (e) => {
    assertTrustedIpc(e)
    return currentLiveAccess()
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

  /**
   * Where "Save binder as" should point on a machine we know nothing about.
   *
   * This used to pass a bare filename and let the OS choose the folder. On
   * Windows the OS chooses the shell Documents folder, and OneDrive's Known
   * Folder Move redirects exactly that — so the default landed a client
   * workpaper in a folder syncing to a CONSUMER Microsoft account, with no
   * business data-protection agreement behind it. A pilot user accepting the
   * default would have moved client data off the machine without being told,
   * from an app whose headline claim is that nothing does.
   *
   * So the directory is chosen here rather than delegated, in the order a
   * preparer would expect:
   *   1. wherever they last kept a binder,
   *   2. else the engagement folder they opened these documents from,
   *   3. else home — deliberately NOT `getPath('documents')`, which is the
   *      redirected one.
   * A `suggested` value that already names a directory is left alone.
   */
  const defaultSaveDir = async (): Promise<string | undefined> => {
    try {
      const recents = await readRecents(app.getPath('userData'))
      const lastPresent = recents.find((r) => r.present !== false && existsSync(path.dirname(r.path)))
      if (lastPresent) return path.dirname(lastPresent.path)
    } catch {}
    // The sources the user authorized this session are, by definition, folders
    // they chose on purpose — which is what an engagement folder is.
    for (const input of [...allowedInputs].reverse()) {
      const dir = path.dirname(input)
      if (existsSync(dir)) return dir
    }
    return app.getPath('home')
  }

  ipcMain.handle('dialog:saveBinderAs', async (_e, suggested: unknown) => {
    assertTrustedIpc(_e)
    const name = typeof suggested === 'string' ? suggested : 'binder.pdf'
    const already = path.dirname(name)
    const defaultPath =
      already && already !== '.' ? name : path.join((await defaultSaveDir()) ?? '', path.basename(name))
    const res = await dialog.showSaveDialog({
      // "Save", not "Export". The binder PDF IS the document — "Export" is the
      // vocabulary of the two-file model this deliberately moved away from.
      title: 'Save binder as',
      defaultPath,
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
    let claimed: { lease: BinderLease; acquired: boolean }
    try {
      claimed = await claimBinder(output)
    } catch (error) {
      return { ok: false, error: String((error as Error).message) }
    }
    const retain = s.session !== undefined && s.flatten !== true
    let result: Awaited<ReturnType<typeof runEngine>>
    let succeeded = false
    try {
      result = await runEngine({ cmd: 'export', binder: { ...s, output } })
      succeeded = result.ok
    } finally {
      // A working binder keeps its lease until it is closed. Flattened copies
      // and failed Save As attempts need only a write-duration lock.
      if (claimed.acquired && (!retain || !succeeded)) await releaseBinderLease(output)
    }
    // A binder you just saved is one you will want back. A flattened copy is
    // not — it cannot be reopened for editing, so offering it later would be
    // offering a dead end.
    if (result.ok && s.session !== undefined && s.flatten !== true) {
      void rememberBinder(app.getPath('userData'), output).catch(() => {})
    }
    return result
  })

  /**
   * Autosave for an open binder.
   *
   * Writes the small JSON sibling, never the binder itself — re-writing a
   * several-hundred-page PDF after every edit is not something to do on a timer.
   * The binder is written when the user saves.
   */
  ipcMain.handle('recents:list', async (e) => {
    assertTrustedIpc(e)
    return readRecents(app.getPath('userData'))
  })

  ipcMain.handle('recents:clear', async (e) => {
    assertTrustedIpc(e)
    await clearRecents(app.getPath('userData'))
  })

  /**
   * The preparer's initials, remembered across binders.
   *
   * Asked once on a machine rather than once per binder — see preferences.ts
   * for why they do not belong to the document.
   */
  ipcMain.handle('prefs:initials:get', async (e) => {
    assertTrustedIpc(e)
    return readPreparerInitials(app.getPath('userData'))
  })

  /** Returns the value as stored, so the renderer shows what was actually kept. */
  ipcMain.handle('prefs:initials:set', async (e, value: unknown) => {
    assertTrustedIpc(e)
    return writePreparerInitials(app.getPath('userData'), value)
  })

  ipcMain.handle('prefs:mark-sizes:get', async (e) => {
    assertTrustedIpc(e)
    return readMarkSizes(app.getPath('userData'))
  })

  ipcMain.handle('prefs:mark-size:set', async (e, key: unknown, size: unknown) => {
    assertTrustedIpc(e)
    return writeMarkSize(app.getPath('userData'), key, size)
  })

  /**
   * The folders a standalone agent may read and write.
   *
   * NOT stored in Electron's userData with the other preferences, and that is
   * deliberate: the MCP server is a separate process that must not import
   * Electron, so it cannot ask for `app.getPath('userData')`. Both sides import
   * shared/agent-roots.ts instead, which derives one product-name-independent
   * location — the same reasoning, and the same directory, as the live endpoint.
   */
  ipcMain.handle('agent:roots:get', async (e) => {
    assertTrustedIpc(e)
    return readAgentRoots()
  })

  /**
   * Approve a folder. A DIALOG, never a path from the renderer: this is the
   * §7216 decision, and it should be the same gesture as choosing where to save
   * a binder — deliberate, visible, and impossible for a page to make on the
   * user's behalf. Accepting a string here would let any renderer bug widen what
   * an agent can read.
   */
  ipcMain.handle('agent:roots:add', async (e) => {
    assertTrustedIpc(e)
    const res = await dialog.showOpenDialog({
      title: 'Approve a folder for agent access',
      message:
        'A standalone agent will be able to read documents and create or update LedgerPDF files in this folder.',
      buttonLabel: 'Approve folder',
      properties: ['openDirectory', 'createDirectory']
    })
    if (res.canceled || res.filePaths.length === 0) return readAgentRoots()
    const current = await readAgentRoots()
    return writeAgentRoots([...current, ...res.filePaths])
  })

  /** Withdraw one. Takes effect on the agent's next request, not on restart. */
  ipcMain.handle('agent:roots:remove', async (e, value: unknown) => {
    assertTrustedIpc(e)
    const target = typeof value === 'string' ? path.resolve(value) : ''
    const current = await readAgentRoots()
    return writeAgentRoots(current.filter((root) => root !== target))
  })

  /**
   * The command that registers this app as an MCP server, ready to copy.
   *
   * Built HERE rather than in the renderer because only main knows where the app
   * actually is, and the answer differs between a dev run and an installed one.
   * `ELECTRON_RUN_AS_NODE` makes the app binary behave as node, which is what
   * lets an installed build serve MCP at all: the bundle lives inside app.asar,
   * where a system `node` cannot reach it — and requiring a Node install would
   * exclude most of the people this is for.
   */
  ipcMain.handle('agent:connect-command', async (e) => {
    assertTrustedIpc(e)
    const bundle = isDev
      ? path.join(repoRoot(), 'app', 'out', 'mcp-server.cjs')
      : path.join(process.resourcesPath, 'app.asar', 'out', 'mcp-server.cjs')
    const runner = isDev ? 'node' : process.execPath
    const command = agentConnectCommand({ isDev, runner, bundle })
    // From a mounted DMG or a translocated run, the baked path dies with the
    // session — offer the move-to-Applications instruction, not the command.
    const unstable = isDev ? null : unstableInstallReason(process.resourcesPath, process.platform)
    return unstable ? { ...command, unstableReason: unstable } : command
  })

  ipcMain.handle('binder:autosave', async (_e, binder: unknown, session: unknown) => {
    assertTrustedIpc(_e)
    const target = assertAllowed(allowedOutputs, binder, 'binder path')
    const recovery = binderRecoveryPathFor(target)
    await atomicWriteJson(
      recovery,
      { binder: target, savedAt: new Date().toISOString(), session: toSaved(session as Session) },
      { keepRecovery: false }
    )
    // A dot prefix hides this on macOS and does nothing on Windows.
    await hideFromUser(recovery)
    return recovery
  })

  /**
   * Write the tickmark legend to a markdown file and return its path.
   *
   * Main picks the location; the renderer only supplies text. The file name is
   * the content's own hash so regenerating an unchanged legend reuses the same
   * file: an imported source is FINGERPRINTED, and rewriting one in place under
   * a session that already points at it is how a binder starts reporting that
   * its own source was tampered with.
   *
   * A legend contains tickmark letters and their meanings — no client data —
   * which is why userData is the right home for it rather than the engagement
   * folder the working copies live in.
   */
  ipcMain.handle('binder:writeLegendDoc', async (event, markdown: unknown) => {
    assertTrustedIpc(event)
    if (typeof markdown !== 'string' || !markdown.trim()) throw new Error('empty legend')
    const dir = path.join(app.getPath('userData'), 'legend')
    await mkdir(dir, { recursive: true })
    const hash = createHash('sha256').update(markdown).digest('hex').slice(0, 12)
    const target = path.join(dir, `Tickmark Legend ${hash}.md`)
    if (!existsSync(target)) await writeFile(target, markdown, 'utf8')
    // Authorize the file we just wrote, or the renderer's very next call —
    // probe it, so it can become a page — is refused by the input gate. That
    // gate exists to stop a renderer naming arbitrary paths; this path was
    // chosen HERE, from content the renderer already had, so authorizing it
    // grants nothing the renderer did not already hold.
    //
    // Found by running the feature, not by reading the code: every model check
    // was green because none of them cross this boundary.
    allowedInputs.add(target)
    return target
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
  /**
   * The renderer drains a cold-start open once it is ready to handle it.
   *
   * Returns the path a double-click or Open With handed us before the window
   * existed, or null. It stays in `osRequestedOpens`, so the follow-up
   * `binder:open` call is honoured exactly as a warm one is.
   */
  ipcMain.handle('binder:consumePendingOpen', async (event) => {
    assertTrustedIpc(event)
    const target = pendingOpen
    pendingOpen = null
    return target
  })

  ipcMain.handle('binder:open', async (event, devPath: unknown) => {
    assertTrustedIpc(event)
    const asked = typeof devPath === 'string' && devPath ? path.resolve(devPath) : ''

    /**
     * A binder the OS asked us to open.
     *
     * THIS IS WHY DOUBLE-CLICK NEVER WORKED IN A PACKAGED BUILD. The path
     * argument was conceived purely as a dev seam and gated behind `isDev`, so
     * in a shipped app Finder's path was thrown away and a file picker opened
     * instead — asking the person to choose the file they had just chosen. On a
     * running instance the picker even opened behind the frontmost app, so it
     * looked like nothing happened at all. "Save it, double-click to reopen" is
     * the whole point of the single-file binder, and it worked only from source.
     *
     * Accepting only paths main itself delivered keeps the renderer from naming
     * arbitrary files, which is what the isDev gate was really protecting.
     */
    if (asked && osRequestedOpens.has(asked)) {
      osRequestedOpens.delete(asked)
      return openBinderAt(asked)
    }
    /**
     * A binder from "Pick up where you left off".
     *
     * Same bug as the Finder one above, one door along, and it survived that
     * fix: a recents click hands main a path, which in a packaged build matched
     * neither branch and fell through to the file picker — so clicking a binder
     * by name opened a dialog asking the person to find the binder they had
     * just clicked. It worked from source the whole time, because `isDev`
     * accepted any path.
     *
     * The list is read from MAIN's own file, not from anything the renderer
     * sent. That is what makes this safe and is the same rule as the OS branch:
     * the renderer cannot name a file main did not already record, so it gains
     * no ability to open arbitrary paths. Every entry got there by the user
     * opening or saving that binder in the first place.
     */
    if (asked) {
      const known = await readRecents(app.getPath('userData'))
      if (known.some((r) => path.resolve(r.path) === asked)) return openBinderAt(asked)
    }
    // Dev seam: open a binder without the dialog, so the single-file reopen
    // path can be driven headlessly. Dev builds only.
    if (isDev && asked) {
      return openBinderAt(asked)
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
        { name: 'Workpaper sources', extensions: [...SOURCE_EXTS] },
        { name: 'PDF', extensions: ['pdf'] },
        { name: 'Spreadsheets', extensions: [...SHEET_EXTS] },
        { name: 'Documents', extensions: [...DOC_EXTS] },
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
    // Dev seam, preloading case: a binder named in WPT_DEV_OPEN is loading, so
    // live access waits for THIS report. Advertising the socket at ready let a
    // harness attach before the fixture finished importing and pull an empty
    // binder — a race that passed or failed by which side won. When nothing is
    // preloading, ready already started live below; setLiveAccess is
    // idempotent enough that the guard here is what prevents a double start.
    if (isDev && process.env.WPT_DEV_LIVE === '1' && process.env.WPT_DEV_OPEN && !liveAnnounced) {
      liveAnnounced = true
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
      console.log(`[package-smoke] renderer ${e.sender.getURL()}`)
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
    title: 'LedgerPDF',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  const windowContentsId = win.webContents.id
  trustedWebContents.add(windowContentsId)
  liveWindow = win
  liveWindowReady = false
  liveWindowBlock = null
  win.webContents.on('did-start-loading', () => {
    if (liveWindow === win) liveWindowReady = false
  })
  win.webContents.once('destroyed', () => {
    trustedWebContents.delete(windowContentsId)
    rejectLiveRequests(windowContentsId, 'the binder window closed')
  })

  // This application never needs browser permissions, webviews, or navigation.
  // Deny them centrally so a future renderer bug cannot silently widen scope.
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  win.webContents.session.setPermissionCheckHandler(() => false)
  win.webContents.on('will-attach-webview', (event) => event.preventDefault())
  win.webContents.on('will-navigate', (event) => event.preventDefault())

  win.once('ready-to-show', () => {
    win.show()
    /**
     * Dev seam: close the window after N ms, leaving the process running.
     *
     * That is the state macOS leaves behind on ⌘W — app alive, live socket still
     * listening, nothing to push to — and it is not reachable from a script any
     * other way, which is why the bug it produces reached a real user before it
     * reached a test. Dev builds only.
     */
    if (isDev && process.env.WPT_DEV_CLOSE_WINDOW_MS) {
      const after = Number(process.env.WPT_DEV_CLOSE_WINDOW_MS)
      if (Number.isFinite(after)) setTimeout(() => win.close(), Math.max(0, after))
    }
    // pendingOpen is NOT pushed here any more, and that was a real cold-start
    // bug. `ready-to-show` fires when the page can paint, which is NOT a promise
    // that the renderer's `binder:openPath` listener has been attached — that
    // happens in a React mount effect, a beat later. A push landing in the gap
    // was silently dropped, so a cold double-click showed the file picker while
    // a warm one (listener long since attached) worked. The renderer now PULLS
    // via `binder:consumePendingOpen` once it is ready, which cannot race.
    // Dev seam: WPT_DEV_OPEN="/a.pdf:/b.pdf" preloads a binder so the import →
    // organize → export flow can be exercised without clicking through dialogs.
    // Dev builds only; packaged builds ignore it.
    const preopen = isDev
      ? process.env.WPT_DEV_OPEN
      : packageUiSmoke
        ? process.env.WPT_PACKAGE_SMOKE_OPEN
        : undefined
    // With a shot requested but nothing to open, still hand the renderer an
    // empty payload so it snapshots and exits. The empty screen carries the
    // recent-binders list now, and had no headless coverage at all.
    /**
     * Packaged seam: open the FIRST ENTRY of "Pick up where you left off", by
     * the same call the row's click makes.
     *
     * Packaged on purpose, and it cannot be covered in dev. The dev branch of
     * `binder:open` accepts any path, so a dev-mode check passes against a
     * shipped app that opens a file picker instead — which is exactly how
     * clicking a recent binder reached real use broken.
     */
    if (packageUiSmoke && process.env.WPT_PACKAGE_SMOKE_RECENT) {
      win.webContents.send('dev:open', { paths: [], seedMarks: false, openRecent: true })
    }
    if (!preopen && isDev && (process.env.WPT_DEV_SHOT || process.env.WPT_DEV_REOPEN)) {
      // Empty payload, but carry reopen: the single-file reopen path is driven
      // WITHOUT importing anything first, which is how a person opens a saved
      // binder. Without this, WPT_DEV_REOPEN only fired when WPT_DEV_OPEN was
      // also set, so the reopen seam could not reproduce a cold "just open a
      // binder" — the exact path a user reported broken.
      win.webContents.send('dev:open', {
        paths: [],
        seedMarks: false,
        reopen: process.env.WPT_DEV_REOPEN
      })
    }
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
        preflight: isDev && !!process.env.WPT_DEV_PREFLIGHT,
        reopen: isDev ? process.env.WPT_DEV_REOPEN : undefined,
        // A scripted run through the REAL placeTool, rather than around it.
        // WPT_DEV_MARKS above calls addMark directly, which is why placeTool
        // had no coverage at all and collected three defects in two days — a
        // blank author, a mark that moved when a stray click landed behind the
        // initials prompt, and a keyboard race. Only a person clicking found
        // any of them. Format: "tick@0.7,0.3;tick@0.1,0.9;answer:RV".
        place: isDev ? process.env.WPT_DEV_PLACE : undefined
      })
    }
  })

  // Never let the app navigate away or spawn windows — it is a local tool.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  let closePromptOpen = false
  const startClosing = (): void => {
    liveWindowReady = false
    liveWindowBlock = 'the binder window is closing; retry after reopening the binder and enabling live access'
    rejectLiveRequests(windowContentsId, liveWindowBlock)
  }

  win.on('close', (event) => {
    if (
      allowWindowClose ||
      !rendererDirty ||
      (isDev && process.env.WPT_DEV_EXIT) ||
      packageUiSmoke
    ) {
      startClosing()
      return
    }
    event.preventDefault()
    if (closePromptOpen) return
    closePromptOpen = true
    liveWindowBlock =
      'the reviewer has an unsaved-changes dialog open; dismiss it, then retry'
    rejectLiveRequests(windowContentsId, liveWindowBlock)
    void (async () => {
      let choice: number
      const devHold = isDev ? Number(process.env.WPT_DEV_CLOSE_DIALOG_HOLD_MS) : NaN
      if (Number.isFinite(devHold) && devHold >= 0) {
        await new Promise((resolve) => setTimeout(resolve, devHold))
        choice = process.env.WPT_DEV_CLOSE_DIALOG_RESPONSE === 'discard' ? 1 : 0
      } else {
        const result = await dialog.showMessageBox(win, {
          type: 'warning',
          title: 'Unsaved workpaper changes',
          message: 'This binder has changes that have not been saved.',
          detail: 'Keep editing and save the session before closing.',
          buttons: ['Keep editing', 'Discard changes'],
          defaultId: 0,
          cancelId: 0,
          noLink: true
        })
        choice = result.response
      }
      closePromptOpen = false
      if (choice === 0) {
        liveWindowBlock = null
        return
      }
      allowWindowClose = true
      startClosing()
      win.close()
    })().catch(() => {
      closePromptOpen = false
      liveWindowBlock = null
    })
  })

  win.on('closed', () => {
    if (liveWindow !== win) return
    liveWindow = null
    liveWindowReady = false
    liveWindowBlock = null
    rendererDirty = false
    // Live access belongs to the exact binder window that enabled it. A fresh
    // window starts with newSession(); keeping the socket alive would let an
    // agent believe it was still editing the closed binder.
    void setLiveAccess(false).catch(() => {})
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (isDev && devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadURL(RENDERER_ENTRY_URL)
  }
}

function registerRendererProtocol(): void {
  const rendererRoot = path.resolve(__dirname, '../renderer')
  protocol.handle(RENDERER_SCHEME, (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } })
    }
    const target = rendererAssetPath(rendererRoot, request.url)
    if (!target) return new Response(null, { status: 404 })
    return net.fetch(pathToFileURL(target).toString(), { method: request.method })
  })
}

app.whenReady().then(async () => {
  // Release-pipeline health check: exercises the packaged main-process path and
  // bundled native engine without opening client files or exposing dev IPC.
  if (!isDev && process.argv.includes('--wpt-package-smoke')) {
    // A packaged Windows app is a GUI-subsystem binary, so main-process stdout
    // never reaches the parent's pipe: the verifier saw exit 0 with both streams
    // empty and could not tell a healthy engine from silence. Report through a
    // file when one is named — the same way the UI smoke already hands back its
    // screenshot and its export.
    const reportTo = process.env.WPT_PACKAGE_SMOKE_REPORT
    const report = async (line: string): Promise<void> => {
      console.log(line)
      if (!reportTo) return
      // Create the parent: the caller's directory may be gitignored and absent
      // on a clean checkout, and a swallowed ENOENT here reads downstream as a
      // dead app rather than a missing folder.
      await mkdir(path.dirname(reportTo), { recursive: true }).catch(() => {})
      await writeFile(reportTo, line, 'utf8').catch(() => {})
    }
    const result = await runEngine({ cmd: 'ping' })
    if (!result.ok) {
      console.error(`[package-smoke] ${result.error}`)
      await report(`[package-smoke] FAILED ${String(result.error)}`)
      app.exit(1)
      return
    }
    await report(`[package-smoke] engine ${String(result.version)} ready`)
    app.exit(0)
    return
  }

  // Dock icon, macOS only. In dev this is the difference between a generic
  // Electron diamond and something recognisable in ⌘-Tab.
  if (process.platform === 'darwin' && app.dock) {
    const icon = appIconPath()
    if (icon) app.dock.setIcon(icon)
  }
  if (!isDev) registerRendererProtocol()
  registerIpc()
  createWindow()
  // Dev seam, empty-start case: WPT_DEV_LIVE with nothing preloading brings
  // live access up at launch — an app started empty never fires dev:rendered,
  // which is where the preloading case starts it (see registerIpc; ordering
  // matters there, and the race is documented on that block).
  if (isDev && process.env.WPT_DEV_LIVE === '1' && !process.env.WPT_DEV_OPEN) {
    liveAnnounced = true
    try {
      const live = await setLiveAccess(true)
      console.log(`[dev] live agent access at ${live.socketPath}`)
    } catch (error) {
      console.error(`[dev] live agent access failed: ${String(error)}`)
    }
  }
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
app.on('before-quit', () => {
  // Not an async handler: a rejection from one has nothing to catch it, which
  // surfaces as an unhandled-rejection warning and, with a dead stderr, as a
  // crash dialog. Failing to tidy up is not worth interrupting a quit.
  const openBinders = new Set([...openWorkingCopies.keys(), ...binderLocks.keys()])
  void Promise.all([...openBinders].map((binder) => releaseBinder(binder))).catch(() => {})
})
