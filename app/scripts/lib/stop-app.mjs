/**
 * Stop a spawned `npm run dev` tree and WAIT for it to be gone — bounded, on
 * both platforms.
 *
 * Two failures produced this, and both cost a whole CI job:
 *
 * 1. Returning while a graceful Electron quit is still in flight leaves the
 *    single-instance lock held against whatever runs next. One run's teardown
 *    then becomes the next run's mystery failure, in code that has nothing to
 *    do with it. So this waits rather than fires and forgets.
 *
 * 2. Waiting for that forever. Windows has no process group, so the POSIX
 *    `process.kill(-pid)` throws there and — inside the usual empty catch —
 *    silently does nothing. `child.kill()` is no better: with `shell: true` it
 *    reaps the cmd.exe in front of npm and leaves Electron alive beneath it,
 *    still holding the stdio pipes this process inherited to it. 'close' needs
 *    both exit AND closed pipes, so it never fires, and an unbounded `await`
 *    on it waits until the job's timeout kills the runner. That is exactly how
 *    live-check sat silent for 45 minutes and reported nothing.
 *
 * So: `taskkill /T` for the tree on Windows, a group signal on POSIX, and every
 * wait bounded. If the tree still will not die, leaking it is strictly better
 * than hanging — a hang costs the whole job and prints nothing, while a leak
 * costs the next run at worst and says so on the way out.
 *
 * POSIX callers must spawn with `detached: true` for the group signal to have a
 * group to signal. Without it the kill is a no-op that the bound then covers.
 */

import { spawnSync } from 'node:child_process'

export async function stopApp(child, { graceMs = 8000, warn = console.error } = {}) {
  if (!child || child.pid == null) return true

  // Attach before killing. A listener attached after a wait misses a 'close'
  // that fired during it, and the await never settles — the same shape of bug
  // as the one above, one level down.
  const closed = new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    child.once('close', resolve)
  })

  const killTree = (force) => {
    try {
      if (process.platform === 'win32') {
        // Without /F this is the graceful WM_CLOSE, which is what SIGTERM is
        // on the other side. /T takes the children npm put underneath it.
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', ...(force ? ['/F'] : [])])
      } else {
        process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM')
      }
    } catch {
      // Already dead, or never had a group. Both are covered by the wait below.
    }
  }

  // The timer is cleared when the process wins the race, so a clean stop does
  // not leave an 8-second timer holding the event loop open behind it.
  const exitedWithin = (ms) =>
    new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), ms)
      closed.then(() => {
        clearTimeout(t)
        resolve(true)
      })
    })

  killTree(false)
  if (await exitedWithin(graceMs)) return true
  killTree(true)
  if (await exitedWithin(graceMs)) return true

  warn(`warning: pid ${child.pid} would not die; leaking it rather than hanging the run`)
  return false
}
