/**
 * One saved binder may have exactly one writer across LedgerPDF and every MCP
 * process on the machine.
 *
 * The lock is a sibling directory created atomically. `proper-lockfile` keeps
 * its mtime fresh, which makes this work on network filesystems and lets a new
 * process recover a lock left by a crash. An in-memory mutex would protect one
 * process and do nothing about the 20 other agent sessions that exposed this
 * bug in practice.
 */
import { chmod } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { lock } from 'proper-lockfile'

export interface BinderLease {
  binder: string
  lockPath: string
  release: () => Promise<void>
}

/** Hidden beside the binder, with no client content inside it. */
export function binderLockPathFor(binder: string): string {
  const absolute = path.resolve(binder)
  return path.join(
    path.dirname(absolute),
    `.${path.basename(absolute, path.extname(absolute))}.wpt-lock`
  )
}

async function hideLockOnWindows(target: string): Promise<void> {
  if (process.platform !== 'win32') return
  await new Promise<void>((resolve) => {
    const child = spawn('attrib', ['+h', target], { windowsHide: true, stdio: 'ignore' })
    child.once('error', () => resolve())
    child.once('close', () => resolve())
  })
}

export async function acquireBinderLock(binder: string): Promise<BinderLease> {
  const absolute = path.resolve(binder)
  const lockPath = binderLockPathFor(absolute)
  let rawRelease: () => Promise<void>
  try {
    rawRelease = await lock(absolute, {
      // The binder may be a new Save As destination, so resolving the target
      // itself through realpath is not possible. The caller has already
      // canonicalized/authorized its parent directory.
      realpath: false,
      lockfilePath: lockPath,
      stale: 30_000,
      update: 10_000,
      retries: 0
    })
  } catch (error) {
    const code = (error as { code?: unknown }).code
    if (code === 'ELOCKED') {
      throw new Error(
        `This binder is already open in LedgerPDF or another agent session: ${path.basename(absolute)}. ` +
          'Close it there before opening or saving it here.'
      )
    }
    throw error
  }

  await chmod(lockPath, 0o700).catch(() => {})
  await hideLockOnWindows(lockPath)
  let held = true
  return {
    binder: absolute,
    lockPath,
    release: async () => {
      if (!held) return
      held = false
      await rawRelease()
    }
  }
}

/** A short write/export that should not retain ownership afterwards. */
export async function withBinderLock<T>(binder: string, work: () => Promise<T>): Promise<T> {
  const lease = await acquireBinderLock(binder)
  try {
    return await work()
  } finally {
    await lease.release().catch(() => {})
  }
}
