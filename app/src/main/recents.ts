/**
 * Binders this person worked on lately, so opening the app offers them back.
 *
 * PRIVACY. A list of recent binders is a list of engagement file paths, and
 * those carry client names — `.../Sample 2025/Sample-Q4-binder.pdf` says
 * who the client is before the file is even opened. So it lives in the app's
 * own userData directory with owner-only permissions, never in an engagement
 * folder and never anywhere that syncs, and there is a way to clear it.
 *
 * Entries are kept even when the file has gone missing, and reported as
 * missing rather than silently dropped: a binder that vanished from a shared
 * drive is something a preparer needs to notice, not something a tool should
 * quietly forget.
 */

import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

export interface RecentBinder {
  path: string
  name: string
  /** ISO timestamp of the last open or save. */
  at: string
  pages?: number
  /** False when the file is no longer where it was. */
  present?: boolean
}

const MAX = 12

function file(userDataDir: string): string {
  return path.join(userDataDir, 'recent-binders.json')
}

export async function readRecents(userDataDir: string): Promise<RecentBinder[]> {
  try {
    const raw = JSON.parse(await readFile(file(userDataDir), 'utf8'))
    if (!Array.isArray(raw)) return []
    return raw
      .filter(
        (r): r is RecentBinder =>
          !!r && typeof r.path === 'string' && typeof r.name === 'string' && typeof r.at === 'string'
      )
      .slice(0, MAX)
      .map((r) => ({ ...r, present: existsSync(r.path) }))
  } catch {
    return []
  }
}

/** Record a binder as recently used. Most recent first, de-duplicated by path. */
export async function rememberBinder(
  userDataDir: string,
  binder: string,
  pages?: number
): Promise<void> {
  const target = path.resolve(binder)
  const existing = await readRecents(userDataDir)
  const next: RecentBinder[] = [
    {
      path: target,
      name: path.basename(target),
      at: new Date().toISOString(),
      ...(pages !== undefined ? { pages } : {})
    },
    ...existing.filter((r) => path.resolve(r.path) !== target)
  ].slice(0, MAX)

  await mkdir(userDataDir, { recursive: true })
  const out = file(userDataDir)
  // 0600: this is a list of client engagement paths.
  await writeFile(out, JSON.stringify(next.map(({ present: _p, ...r }) => r), null, 2), {
    mode: 0o600
  })
  await chmod(out, 0o600).catch(() => {})
}

export async function clearRecents(userDataDir: string): Promise<void> {
  await rm(file(userDataDir), { force: true }).catch(() => {})
}
