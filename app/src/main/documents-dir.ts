/**
 * An optional folder that every file dialog opens in: `WPT_DOCUMENTS_DIR`.
 *
 * Without it, Save points at the last binder's folder (see `defaultSaveDir`)
 * and Open / Add files / Relink name no folder at all, so the OS dialog opens
 * wherever it last was. That is fine for one person with one set of files. It
 * is not fine for someone who keeps two separate trees on one machine — a
 * synthetic demo set and real engagements, say, each launched with its own
 * `XDG_CONFIG_HOME` — because the dialog's memory is shared between them and
 * can open one tree's files while the other is on screen.
 *
 * Setting the variable pins every dialog to that folder, ahead of the
 * recent-binder and session-document guesses. Unset, empty, relative, or not an
 * existing directory: ignored, and behaviour is exactly as before. It only
 * chooses where a dialog STARTS — it grants no access; the user still picks.
 */

import { statSync } from 'node:fs'
import path from 'node:path'

export const DOCUMENTS_DIR_ENV = 'WPT_DOCUMENTS_DIR'

/** The configured folder, resolved, or undefined when unset or unusable. */
export function configuredDocumentsDir(
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const raw = env[DOCUMENTS_DIR_ENV]?.trim()
  if (!raw || !path.isAbsolute(raw)) return undefined
  try {
    return statSync(raw).isDirectory() ? path.resolve(raw) : undefined
  } catch {
    return undefined
  }
}
