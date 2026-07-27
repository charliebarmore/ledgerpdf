import { contextBridge, ipcRenderer, webUtils } from 'electron'

/**
 * The entire surface the renderer gets. Everything is an explicit,
 * named operation — no generic "read any file" or "run any command".
 */
const api = {
  platform: process.platform,

  ping: () => ipcRenderer.invoke('engine:ping'),

  /** Open dialog; returns chosen paths (also authorizes them). */
  openPdfs: (): Promise<string[]> => ipcRenderer.invoke('dialog:openPdfs'),

  /** Authorize drag-dropped / session-restored paths. Returns the accepted ones. */
  registerFiles: (paths: string[]): Promise<string[]> =>
    ipcRenderer.invoke('files:register', paths),

  readPdf: (filePath: string): Promise<Uint8Array> => ipcRenderer.invoke('fs:readPdf', filePath),

  probe: (filePath: string): Promise<{ ok: boolean; probe?: unknown; error?: string }> =>
    ipcRenderer.invoke('engine:probe', filePath),

  chooseBinderOutput: (suggested: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:saveBinderAs', suggested),

  exportBinder: (spec: unknown): Promise<{ ok: boolean; result?: unknown; error?: string }> =>
    ipcRenderer.invoke('engine:export', spec),

  saveSession: (session: unknown, existingPath: string | null): Promise<string | null> =>
    ipcRenderer.invoke('session:save', session, existingPath),

  openSession: (): Promise<{ path: string; session: unknown } | null> =>
    ipcRenderer.invoke('session:open'),

  reveal: (filePath: string): Promise<void> => ipcRenderer.invoke('shell:reveal', filePath),

  /** File.path was removed from Electron; this is the sanctioned replacement. */
  pathForFile: (file: File): string => webUtils.getPathForFile(file),

  /** Dev seam (WPT_DEV_OPEN) — preload a binder without clicking dialogs. */
  onDevOpen: (cb: (arg: { paths: string[]; exportTo?: string }) => void): void => {
    ipcRenderer.on('dev:open', (_e, arg) => cb(arg))
  },

  /** Dev seam — tell main the binder finished loading (triggers WPT_DEV_SHOT). */
  devRendered: (): void => ipcRenderer.send('dev:rendered')
}

contextBridge.exposeInMainWorld('wpt', api)

export type WptApi = typeof api
