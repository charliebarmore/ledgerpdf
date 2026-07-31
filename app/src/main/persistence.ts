/**
 * Durable session persistence.
 *
 * A workpaper session is the editable engagement record, so it must never be
 * overwritten in place. Writes land in a same-directory temporary file, are
 * flushed, and are then renamed over the destination. The previous complete
 * file is kept beside it as a one-generation recovery copy.
 */

import { randomUUID } from 'node:crypto'
import { open, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'

export function recoveryPathFor(target: string): string {
  return /\.wptsession\.json$/i.test(target)
    ? target.replace(/\.wptsession\.json$/i, '.recovery.wptsession.json')
    : `${target}.recovery.json`
}

async function syncDirectory(dir: string): Promise<void> {
  // Directory fsync makes the rename durable on POSIX. Windows does not allow
  // directories to be opened this way, so the file fsync + atomic rename is
  // the strongest portable behavior available through Node.
  try {
    const handle = await open(dir, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // Best effort on platforms/filesystems that do not support directory fsync.
  }
}

async function atomicWrite(target: string, contents: string): Promise<void> {
  const absolute = path.resolve(target)
  const dir = path.dirname(absolute)
  const temp = path.join(dir, `.${path.basename(absolute)}.${process.pid}.${randomUUID()}.tmp`)
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    // 0600 keeps session metadata (client names, paths, notes, tape entries)
    // private on POSIX. Windows applies its own ACLs.
    handle = await open(temp, 'wx', 0o600)
    await handle.writeFile(contents, 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
    await rename(temp, absolute)
    await syncDirectory(dir)
  } finally {
    await handle?.close().catch(() => {})
    await rm(temp, { force: true }).catch(() => {})
  }
}

export async function atomicWriteJson(
  target: string,
  value: unknown,
  options: { keepRecovery?: boolean } = {}
): Promise<void> {
  const absolute = path.resolve(target)
  const keepRecovery = options.keepRecovery ?? true
  if (keepRecovery) {
    try {
      const previous = await readFile(absolute, 'utf8')
      await atomicWrite(recoveryPathFor(absolute), previous)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') throw error
    }
  }
  await atomicWrite(absolute, JSON.stringify(value, null, 2))
}

export interface SessionReadResult {
  session?: unknown
  recoverySession?: unknown
  recoveredFrom?: string
  error?: string
}

/** Read the primary session and its previous complete generation, if present. */
export async function readSessionWithRecovery(target: string): Promise<SessionReadResult> {
  const absolute = path.resolve(target)
  const recovery = recoveryPathFor(absolute)
  let primaryError: string | null = null
  let session: unknown
  let recoverySession: unknown

  try {
    session = JSON.parse(await readFile(absolute, 'utf8'))
  } catch (error) {
    primaryError = String((error as Error).message)
  }

  try {
    recoverySession = JSON.parse(await readFile(recovery, 'utf8'))
  } catch {
    // A recovery file is optional. If the primary is healthy, this is normal.
  }

  if (session !== undefined) return { session, ...(recoverySession !== undefined ? { recoverySession } : {}) }
  if (recoverySession !== undefined) {
    return {
      session: recoverySession,
      recoveredFrom: recovery,
      error: primaryError ? `primary session was unreadable: ${primaryError}` : undefined
    }
  }
  return { error: primaryError ?? 'session file was empty or unreadable' }
}
