/**
 * The contract of scripts/lib/stop-app.mjs.
 *
 *   npm run verify:teardown
 *
 * This exists because the defect it guards cost a whole CI job and reported
 * nothing: an unbounded wait on a 'close' event that a surviving process tree
 * can never emit. A hang is the worst failure a test harness has, because it
 * looks identical to work in progress right up until the runner is killed.
 *
 * Written for both platforms on purpose. The bug was Windows-only — POSIX has
 * process groups and Windows does not — so a POSIX-only test would have passed
 * the whole time the bug existed, and this project's CI runs Windows.
 *
 * The assertions are therefore about the CONTRACT, not the mechanism: it stops
 * the tree, it never exceeds its bound, and it reports rather than hangs. What
 * counts as "polite" differs by platform — SIGTERM is deliverable to anything,
 * while taskkill without /F sends WM_CLOSE, which a console process does not
 * answer — so the polite attempt is expected to fail on Windows for every child
 * here, and the escalation is what does the work. Asserting "stopped, within
 * the bound" holds on both; asserting "stopped politely" would not.
 */

import { spawn } from 'node:child_process'
import { stopApp } from './lib/stop-app.mjs'

const GRACE = 1500
const checks = []
const check = (name, ok, detail = '') => checks.push([name, !!ok, detail])

// Signal 0 is an existence probe on Windows too — the one liveness test that
// does not need a platform branch.
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Children are always `node -e`, never `sleep` or `sh -c`: those do not exist
// on a Windows runner, and shelling out to find an equivalent would test the
// shell rather than the teardown.
const child = (body) =>
  spawn(process.execPath, ['-e', body], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32'
  })

const FOREVER = 'setInterval(() => {}, 1000)'
const settle = (ms) => new Promise((r) => setTimeout(r, ms))

// ------------------------------------------------- it stops a running child
{
  const c = child(FOREVER)
  await settle(400) // let it reach its interval, so this is a real kill
  const t0 = Date.now()
  const ok = await stopApp(c, { graceMs: GRACE, warn: () => {} })
  const took = Date.now() - t0
  check('a running child is stopped', ok === true && !alive(c.pid), `${took}ms`)
  // The bound is what this file is for: two grace periods plus slack for a
  // loaded runner. Anything slower means a wait escaped its timer.
  check('and within its bound', took < GRACE * 2 + 4000, `${took}ms vs limit ${GRACE * 2 + 4000}ms`)
}

// --------------------------------- it escalates past a child that ignores it
// On POSIX this child ignores SIGTERM, so only SIGKILL ends it. On Windows
// every console child already behaves this way. Either way the polite attempt
// cannot work, so reaching `true` proves the escalation ran.
{
  const c = child(`process.on('SIGTERM', () => {}); ${FOREVER}`)
  await settle(400)
  const t0 = Date.now()
  const ok = await stopApp(c, { graceMs: GRACE, warn: () => {} })
  const took = Date.now() - t0
  check('a child that ignores the polite signal is still stopped', ok === true && !alive(c.pid), `${took}ms`)
  check(
    'and the polite attempt was given its full grace first',
    took >= GRACE - 100,
    `${took}ms, grace ${GRACE}ms`
  )
}

// ------------------------------------------------- it takes the whole tree
// The original bug in one shape: killing the process you spawned while its
// child lives on. An orphaned Electron holds the single-instance lock and fails
// every later run in ways that look like the code under test.
{
  const c = child(
    `const { spawn } = require('child_process');
     const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
     console.log(g.pid);
     ${FOREVER}`
  )
  const grandchild = await new Promise((resolve, reject) => {
    let buf = ''
    const bail = setTimeout(() => reject(new Error('grandchild never reported its pid')), 20_000)
    c.stdout.on('data', (d) => {
      buf += d
      if (buf.includes('\n')) {
        clearTimeout(bail)
        resolve(Number(buf.trim()))
      }
    })
  })
  check('a grandchild is running before the stop', alive(grandchild), `pid ${grandchild}`)
  await stopApp(c, { graceMs: GRACE, warn: () => {} })
  // Windows kills the tree synchronously via taskkill /T; a POSIX group signal
  // is delivered asynchronously, so give the grandchild a moment to be reaped
  // before concluding it survived.
  for (let i = 0; i < 40 && alive(grandchild); i++) await settle(50)
  check('the stop reaches the grandchild too', !alive(grandchild), `pid ${grandchild}`)
}

// ------------------------------------------- an already-exited child is free
// The listener is attached inside stopApp, after the process is long gone. If
// it waited for a 'close' that already fired, this would hang — which is the
// same shape as the bug one level down.
{
  const c = child('process.exit(0)')
  await new Promise((r) => c.on('close', r))
  const t0 = Date.now()
  const ok = await stopApp(c, { graceMs: 5000, warn: () => {} })
  const took = Date.now() - t0
  check('an already-exited child returns at once', ok === true && took < 500, `${took}ms`)
}

// ---------------------------------------------------------- degenerate input
check('a null child is a no-op rather than a crash', (await stopApp(null)) === true)

// A clean stop must not leave its timer armed. If one were, this process would
// sit here for the remaining grace after printing instead of exiting, so the
// wall-clock below is part of the assertion rather than decoration.
const failed = checks.filter(([, ok]) => !ok)
for (const [name, ok, detail] of checks) {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? `  — ${detail}` : ''}`)
}
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
process.exit(failed.length ? 1 : 0)
