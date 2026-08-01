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

  saveSession: (
    session: unknown,
    existingPath: string | null,
    suggested?: string
  ): Promise<string | null> =>
    ipcRenderer.invoke('session:save', session, existingPath, suggested),

  openSession: (): Promise<{
    path: string
    session?: unknown
    recoverySession?: unknown
    recoveredFrom?: string
    error?: string
  } | null> =>
    ipcRenderer.invoke('session:open'),

  confirmDiscard: (): Promise<boolean> => ipcRenderer.invoke('session:confirmDiscard'),

  relinkSource: (sourceName: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:relinkSource', sourceName),

  setDirty: (dirty: boolean): void => ipcRenderer.send('session:setDirty', dirty),

  reveal: (filePath: string): Promise<void> => ipcRenderer.invoke('shell:reveal', filePath),

  /** Dev seam (WPT_DEV_OPEN) — preload a binder without clicking dialogs. */
  onDevOpen: (
    cb: (arg: { paths: string[]; exportTo?: string; seedMarks?: boolean }) => void
  ): void => {
    ipcRenderer.on('dev:open', (_e, arg) => cb(arg))
  },

  /**
   * Dev seam — tell main the binder finished loading (triggers WPT_DEV_SHOT).
   * Carries what actually loaded so the packaged smoke can tell a working
   * binder from an empty window; a failed import still reaches this line.
   */
  devRendered: (loaded: { pages: number; sources: number }): void =>
    ipcRenderer.send('dev:rendered', loaded)
}

contextBridge.exposeInMainWorld('wpt', api)

export type WptApi = typeof api
