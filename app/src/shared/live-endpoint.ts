/**
 * Where the app advertises live agent access.
 *
 * ONE definition, imported by the app that writes it and the MCP server that
 * reads it. Deliberately NOT Electron's userData: that directory is named after
 * the app's display name, so a rename would silently stop the agent finding the
 * app — it would just quietly work on its own copy, which is the exact failure
 * this feature exists to prevent.
 *
 * The product was renamed to LedgerPDF on 2026-08-05 and this constant did NOT
 * move, which is the whole point: it survived the rename it was written to
 * survive. It is not stale and it is not a leftover. Leave it alone.
 */

import path from 'node:path'
import os from 'node:os'

/** Stable, product-name-independent. Do not "tidy" this to match a brand. */
const DIR = 'workpaper-binder'

/** The per-user config root, matching platform convention. */
export function liveDir(): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', DIR)
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? os.homedir(), DIR)
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), DIR)
}

/** The file carrying the socket path and token. Always 0600. */
export function liveEndpointFile(): string {
  return process.env.WPT_LIVE_ENDPOINT ?? path.join(liveDir(), 'live-endpoint.json')
}
