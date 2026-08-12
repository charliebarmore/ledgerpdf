import { contextBridge, ipcRenderer, webUtils } from 'electron'

/**
 * The entire surface the renderer gets. Everything is an explicit,
 * named operation — no generic "read any file" or "run any command".
 */
const api = {
  platform: process.platform,

  ping: () => ipcRenderer.invoke('engine:ping'),

  /** Open dialog; returns chosen paths (also authorizes them). PDFs or images. */
  openPdfs: (): Promise<string[]> => ipcRenderer.invoke('dialog:openPdfs'),

  /** Authorize genuine OS drag-dropped Files without exposing arbitrary paths. */
  registerDroppedFiles: (files: File[]): Promise<string[]> =>
    ipcRenderer.invoke(
      'files:registerDropped',
      files.map((file) => webUtils.getPathForFile(file)).filter(Boolean)
    ),

  /** Raw bytes of a source file — a PDF for PDF.js, or an image for the canvas. */
  readSource: (filePath: string): Promise<Uint8Array> =>
    ipcRenderer.invoke('fs:readSource', filePath),

  probe: (filePath: string): Promise<{ ok: boolean; probe?: unknown; error?: string }> =>
    ipcRenderer.invoke('engine:probe', filePath),

  chooseBinderOutput: (suggested: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:saveBinderAs', suggested),

  exportBinder: (spec: unknown): Promise<{ ok: boolean; result?: unknown; error?: string }> =>
    ipcRenderer.invoke('engine:export', spec),

  /**
   * Open a saved binder, or an older `.wptsession.json` so it can be converted.
   * `kind` says which arrived:
   *   binder — a saved binder, with its recovered session and working copy
   *   plain  — an ordinary PDF with no session inside; import it instead
   *   legacy — the older two-file format
   *   error  — the engine could not read it
   */
  openBinder: (devPath?: string): Promise<
    | {
        kind: 'binder'
        path: string
        workingPath: string
        session: unknown
        payloadIntact: boolean
        geometryMatches: boolean
        pendingAutosave?: { savedAt?: string; session?: unknown }
      }
    | { kind: 'plain'; path: string; reason?: string; flattened?: boolean }
    | {
        kind: 'legacy'
        path: string
        session?: unknown
        recoverySession?: unknown
        recoveredFrom?: string
        error?: string
      }
    | { kind: 'error'; path: string; error: string }
    | null
  > => ipcRenderer.invoke('binder:open', devPath),

  /** Autosave to the invisible sibling. Never rewrites the binder itself. */
  autosaveBinder: (binderPath: string, session: unknown): Promise<string> =>
    ipcRenderer.invoke('binder:autosave', binderPath, session),

  /** Drop the working copy and autosave sibling for a binder being closed. */
  releaseBinder: (binderPath: string): Promise<void> =>
    ipcRenderer.invoke('binder:release', binderPath),

  /**
   * Write the tickmark legend to a markdown file and hand back its path, so it
   * can be imported as a normal typeset page.
   *
   * The renderer supplies TEXT ONLY and main chooses where it lands. That is
   * the same rule the rest of this boundary follows: a renderer that could name
   * the destination could write anywhere, and the privilege-boundary work
   * removed exactly that ability.
   */
  writeLegendDoc: (markdown: string): Promise<string> =>
    ipcRenderer.invoke('binder:writeLegendDoc', markdown),

  confirmDiscard: (): Promise<boolean> => ipcRenderer.invoke('session:confirmDiscard'),

  relinkSource: (sourceName: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:relinkSource', sourceName),

  setDirty: (dirty: boolean): void => ipcRenderer.send('session:setDirty', dirty),

  reveal: (filePath: string): Promise<void> => ipcRenderer.invoke('shell:reveal', filePath),

  /**
   * Live agent access. The renderer answers pull/push so an agent works on the
   * SAME binder a person is looking at.
   */
  setLive: (on: boolean): Promise<{ on: boolean; socketPath?: string }> =>
    ipcRenderer.invoke('live:set', on),
  /** Pull the authoritative state on every renderer mount; broadcasts can race. */
  getLive: (): Promise<{ on: boolean; socketPath?: string }> => ipcRenderer.invoke('live:get'),
  onLiveRequest: (
    cb: (req: {
      id: number
      kind: 'pull' | 'push'
      payload?: unknown
      focus?: string | null
      expectedRevision?: number
    }) => void
  ): void => {
    ipcRenderer.on('live:request', (_e, req) => cb(req))
  },
  liveReply: (id: number, payload: unknown): void => ipcRenderer.send('live:reply', id, payload),
  /** Main announces changes after the initial authoritative pull. */
  onLiveState: (cb: (state: { on: boolean; socketPath?: string }) => void): void => {
    ipcRenderer.on('live:state', (_e, state) => cb(state))
  },

  /** Binders worked on lately, offered on the empty screen. */
  recentBinders: (): Promise<
    Array<{ path: string; name: string; at: string; pages?: number; present?: boolean }>
  > => ipcRenderer.invoke('recents:list'),
  clearRecentBinders: (): Promise<void> => ipcRenderer.invoke('recents:clear'),
  /**
   * The preparer's own initials, remembered across binders rather than asked
   * for again on each one. Setting returns the value as stored (trimmed,
   * upper-cased, clamped), so the UI shows what was actually kept.
   */
  preparerInitials: (): Promise<string> => ipcRenderer.invoke('prefs:initials:get'),
  setPreparerInitials: (value: string): Promise<string> =>
    ipcRenderer.invoke('prefs:initials:set', value),
  /**
   * Folders a standalone agent may read and write. `addAgentRoot` takes no
   * argument on purpose — the folder is chosen in a dialog owned by main, so a
   * renderer cannot widen agent access by passing a path.
   */
  agentRoots: (): Promise<string[]> => ipcRenderer.invoke('agent:roots:get'),
  addAgentRoot: (): Promise<string[]> => ipcRenderer.invoke('agent:roots:add'),
  removeAgentRoot: (root: string): Promise<string[]> =>
    ipcRenderer.invoke('agent:roots:remove', root),
  agentConnectCommand: (): Promise<{
    command: string
    runner: string
    bundle: string
    needsElectronRunAsNode: boolean
  }> => ipcRenderer.invoke('agent:connect-command'),
  /** A binder opened from Finder/Explorer while the app is ALREADY running. */
  onOpenPath: (cb: (target: string) => void): void => {
    ipcRenderer.on('binder:openPath', (_e, target) => cb(target))
  },
  /** A cold-start open, pulled once the renderer is ready — no push race. */
  consumePendingOpen: (): Promise<string | null> =>
    ipcRenderer.invoke('binder:consumePendingOpen'),

  /** Dev seam (WPT_DEV_OPEN) — preload a binder without clicking dialogs. */
  onDevOpen: (
    cb: (arg: {
      paths: string[]
      exportTo?: string
      seedMarks?: boolean
      reopen?: string
      place?: string
      openRecent?: boolean
    }) => void
  ): void => {
    ipcRenderer.on('dev:open', (_e, arg) => cb(arg))
  },

  /**
   * Dev seam — tell main the binder finished loading (triggers WPT_DEV_SHOT).
   * Carries what actually loaded so the packaged smoke can tell a working
   * binder from an empty window; a failed import still reaches this line.
   */
  devRendered: (loaded: { pages: number; sources: number; exported?: string }): void =>
    ipcRenderer.send('dev:rendered', loaded)
}

contextBridge.exposeInMainWorld('wpt', api)

export type WptApi = typeof api
