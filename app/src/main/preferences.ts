/**
 * Preferences that belong to the person, not to any one binder.
 *
 * Right now that is the preparer's initials and the preferred placement size
 * for each mark tool.
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

import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { atomicWriteJson } from './persistence'

/** Initials are a short stamp on a page, not a name field. */
export const MAX_INITIALS = 4

interface Preferences {
  preparerInitials?: string
  markSizes?: Record<string, number>
}

const MARK_SIZE_MIN = 10
const MARK_SIZE_MAX = 72

let preferenceWrites: Promise<void> = Promise.resolve()

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

function normalizeMarkSizeKey(value: unknown): string {
  if (typeof value !== 'string') return ''
  if (['tick', 'cross', 'note', 'conn', 'date'].includes(value)) return value
  if (!value.startsWith('text:')) return ''
  const stamp = value.slice(5).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 8)
  return stamp ? `text:${stamp}` : ''
}

function normalizeMarkSize(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.min(MARK_SIZE_MAX, Math.max(MARK_SIZE_MIN, value))
}

export function normalizeMarkSizes(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: Record<string, number> = {}
  for (const [rawKey, rawSize] of Object.entries(value)) {
    const key = normalizeMarkSizeKey(rawKey)
    const size = normalizeMarkSize(rawSize)
    if (key && size !== null) result[key] = size
  }
  return result
}

async function readPreferences(userDataDir: string): Promise<Preferences> {
  try {
    const raw: unknown = JSON.parse(await readFile(file(userDataDir), 'utf8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Preferences) : {}
  } catch {
    return {}
  }
}

function updatePreferences<T>(
  userDataDir: string,
  mutate: (current: Preferences) => { next: Preferences; result: T }
): Promise<T> {
  const run = preferenceWrites.then(async () => {
    const { next, result } = mutate(await readPreferences(userDataDir))
    await mkdir(userDataDir, { recursive: true })
    await atomicWriteJson(file(userDataDir), next, { keepRecovery: false })
    return result
  })
  preferenceWrites = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

export async function readPreparerInitials(userDataDir: string): Promise<string> {
  return normalizeInitials((await readPreferences(userDataDir)).preparerInitials)
}

export async function readMarkSizes(userDataDir: string): Promise<Record<string, number>> {
  return normalizeMarkSizes((await readPreferences(userDataDir)).markSizes)
}

/**
 * Remember the initials for the next binder.
 *
 * Read-modify-write rather than overwrite, so adding a second preference later
 * does not mean this function silently drops it.
 */
export async function writePreparerInitials(userDataDir: string, value: unknown): Promise<string> {
  const initials = normalizeInitials(value)
  return updatePreferences(userDataDir, (current) => {
    const next: Preferences = { ...current }
    // An empty answer clears the stored default rather than saving "".
    if (initials) next.preparerInitials = initials
    else delete next.preparerInitials
    return { next, result: initials }
  })
}

export async function writeMarkSize(
  userDataDir: string,
  rawKey: unknown,
  rawSize: unknown
): Promise<{ key: string; size: number } | null> {
  const key = normalizeMarkSizeKey(rawKey)
  const size = normalizeMarkSize(rawSize)
  if (!key || size === null) return null
  return updatePreferences(userDataDir, (current) => ({
    next: {
      ...current,
      markSizes: { ...normalizeMarkSizes(current.markSizes), [key]: size }
    },
    result: { key, size }
  }))
}
