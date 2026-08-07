/**
 * Preferences that belong to the person, not to any one binder.
 *
 * Right now that is one thing: the preparer's initials.
 *
 * They used to live only on `session.reviewer`, which made them a property of
 * the DOCUMENT. That is the wrong home. Initials identify who did the work, and
 * the person does not change between binders — so a preparer was asked again on
 * every new binder, and the initials-stamp button in the palette went back to
 * being a dead dash each time. Storing them here means the question is asked
 * once on a machine, and every session is seeded from the answer.
 *
 * The session still carries its own copy, and that is deliberate: attribution
 * has to travel inside the binder, so a reviewer opening the file elsewhere sees
 * who marked it. This file is only the default the next session starts from.
 *
 * PRIVACY. Unlike `recents.ts`, this is not client data — a preparer's own
 * initials name nobody's client. It lives in userData beside recents anyway,
 * with the same owner-only mode, because the rule "the app's private state
 * never leaves userData and never syncs" is easier to state and audit with no
 * exceptions in it.
 */

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** Initials are a short stamp on a page, not a name field. */
export const MAX_INITIALS = 4

interface Preferences {
  preparerInitials?: string
}

function file(userDataDir: string): string {
  return path.join(userDataDir, 'preferences.json')
}

/**
 * Trim, upper-case and clamp. Applied on the way in AND on the way out, so a
 * hand-edited or older file cannot put a value on a page that the input would
 * have refused.
 */
export function normalizeInitials(value: unknown): string {
  return typeof value === 'string' ? value.trim().toUpperCase().slice(0, MAX_INITIALS) : ''
}

export async function readPreparerInitials(userDataDir: string): Promise<string> {
  try {
    const raw: unknown = JSON.parse(await readFile(file(userDataDir), 'utf8'))
    if (!raw || typeof raw !== 'object') return ''
    return normalizeInitials((raw as Preferences).preparerInitials)
  } catch {
    // No file yet, or an unreadable one. Either way there is no stored answer,
    // and the app asks — which is the same path a first run takes.
    return ''
  }
}

/**
 * Remember the initials for the next binder.
 *
 * Read-modify-write rather than overwrite, so adding a second preference later
 * does not mean this function silently drops it.
 */
export async function writePreparerInitials(userDataDir: string, value: unknown): Promise<string> {
  const initials = normalizeInitials(value)
  let current: Preferences = {}
  try {
    const raw: unknown = JSON.parse(await readFile(file(userDataDir), 'utf8'))
    if (raw && typeof raw === 'object') current = raw as Preferences
  } catch {
    // Nothing stored yet.
  }

  const next: Preferences = { ...current }
  // An empty answer clears the stored default rather than saving "".
  if (initials) next.preparerInitials = initials
  else delete next.preparerInitials

  await mkdir(userDataDir, { recursive: true })
  const out = file(userDataDir)
  await writeFile(out, JSON.stringify(next, null, 2), { mode: 0o600 })
  await chmod(out, 0o600).catch(() => {})
  return initials
}
