/**
 * An agent asking for a binder whose WINDOW was closed (macOS only).
 *
 *   npm run verify:closed-window
 *
 * macOS leaves the app running on ⌘W, so live access stays on and the socket
 * keeps listening with nothing behind it. This surfaced in the first real
 * end-to-end test: every call failed with "no open binder window", which names
 * no cause and no remedy while the Dock icon looks perfectly healthy.
 *
 * The fix reopens the window and refuses THIS request with an instruction to
 * retry — deliberately not a silent fall back to standalone, which would have
 * the agent quietly working on its own copy, the exact failure live mode exists
 * to prevent.
 *
 * ---------------------------------------------------------------------------
 * IF THIS FAILS WITH "the binder window did not respond", SUSPECT THE MACHINE
 * BEFORE THE CODE.
 *
 * `app.on('activate')` recreates a window whenever macOS activates the app, and
 * quitting or killing ANOTHER Electron process hands focus around. So a second
 * Electron app starting or dying during the 64-second wait can reopen the
 * window behind this check's back: the request then finds a live window that
 * has not mounted its `live:request` listener yet, and times out at 15s instead
 * of taking the reopen branch.
 *
 * Seen on 2026-08-08 and very nearly recorded as a regression in the commit
 * that happened to be checked out. Both suspect commits passed 2/2 once the
 * machine was quiet. Before bisecting: close other Electron apps, `pkill -f
 * electron`, wait a few seconds, and run it again.
 *
 * Not papered over with a retry, and that is deliberate. Check 2 asserts the
 * message you get with the window closed — and the first call REOPENS the
 * window, so a retry would find it open and fail honestly. The flake has to be
 * removed from the environment, not from the assertion.
 */
import { spawn } from 'node:child_process'
import path from 'node:path'

import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { stopApp } from './lib/stop-app.mjs'

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO = path.resolve(APP, '..')
const SERVER = path.join(APP, 'out', 'mcp-server.cjs')
const ENDPOINT = path.join(REPO, 'spike', 'out', 'closed-window-endpoint.json')

// Closing the last window quits LedgerPDF on Windows and Linux. Only macOS
// keeps an app running with no windows and later recreates one on activation,
// so applying the assertions below elsewhere tests a state the product does
// not support and leaves the client waiting on a process that is exiting.
if (process.platform !== 'darwin') {
  console.log('[SKIP] closed-window recovery is macOS-only; this platform quits when its last window closes')
  process.exit(0)
}

const checks = []
const check = (name, ok, detail = '') => {
  checks.push(ok)
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? `  — ${detail}` : ''}`)
}

// Launch with live on, a binder open, and the window set to close after 6s.
const app = spawn('npm', ['run', 'dev'], {
  cwd: APP,
  // On Windows npm is a .cmd shim. Node's command-spawn hardening refuses to
  // launch it directly, so use the platform shell just for this npm command.
  shell: process.platform === 'win32',
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: process.platform !== 'win32',
  env: {
    ...process.env,
    WPT_LIVE_ENDPOINT: ENDPOINT,
    WPT_DEV_LIVE: '1',
    // NO binder opened, on purpose. An open binder is DIRTY, and win.close()
    // then hits the unsaved-changes guard: a synchronous modal that nothing in a
    // headless run can dismiss. The window stays open, the renderer sits blocked
    // behind the dialog, and the agent times out after 15s with "the binder
    // window did not respond" — which is what the first version of this check
    // produced, and it tested the guard rather than the fix.
    WPT_DEV_USERDATA: path.join(REPO, 'spike', 'out', 'userdata-closedwin'),
    WPT_DEV_CLOSE_WINDOW_MS: '60000'
  }
})
let log = ''
app.stdout.on('data', (d) => (log += d))
app.stderr.on('data', (d) => (log += d))

const deadline = Date.now() + 90_000
while (Date.now() < deadline && !/live agent access at/.test(log)) {
  await new Promise((r) => setTimeout(r, 400))
}
if (!/live agent access at/.test(log)) {
  console.log('[FAIL] the app never offered live access')
  console.log(log.slice(-500))
  await stopApp(app)
  process.exit(1)
}

const client = new Client({ name: 'closed-window-check', version: '1.0.0' })
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { ...process.env, WPT_LIVE_ENDPOINT: ENDPOINT, WPT_MCP_ROOTS: path.join(REPO, 'spike') }
  })
)
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args })
  return { text: (r.content ?? []).map((c) => c.text ?? '').join('\n'), isError: !!r.isError }
}

// 1. While the window is open, live mode works — the control.
//
// Retried, because the endpoint appearing does NOT mean the renderer is ready:
// main advertises live access from `whenReady`, while the listener that answers
// `live:request` is registered when React mounts. A request landing in that gap
// waits out the full 15s timeout and reports "the binder window did not
// respond". This check saw both outcomes on consecutive runs, which makes it
// flaky — and a flaky check is worse than none, because it fails often enough on
// correct code that people learn to re-run it.
//
// Worth naming as a product fact too, not just a test annoyance: for a moment
// after the window appears, an agent's request times out instead of being
// queued. Rare in practice, since a person connects an agent to an app they are
// already looking at.
let before = { isError: true, text: '' }
for (let attempt = 0; attempt < 3; attempt++) {
  before = await call('binder_status')
  if (!before.isError && /LIVE/.test(before.text)) break
}
check(
  'with a window open, the agent reaches the live binder',
  !before.isError && /LIVE/.test(before.text),
  before.text.split('\n').slice(0, 2).join(' | ').slice(0, 110)
)

// 2. Wait for the seam to close it, then ask again.
await new Promise((r) => setTimeout(r, 64_000))
const afterClose = await call('binder_status')
check(
  'a request with the window closed explains itself and says what to do',
  afterClose.isError && /window was closed/i.test(afterClose.text) && /again/i.test(afterClose.text),
  afterClose.text.split('\n')[0].slice(0, 110)
)

// 3. And the retry works, because the window was reopened rather than left shut.
await new Promise((r) => setTimeout(r, 4000))
const retry = await call('binder_status')
check(
  'the window is reopened, so the very next request succeeds',
  !retry.isError && /page\(s\)/.test(retry.text),
  retry.text.split('\n')[0]
)

await client.close()
await stopApp(app)
const failed = checks.filter((ok) => !ok).length
console.log(`\n${checks.length - failed}/${checks.length} checks passed`)
process.exit(failed ? 1 : 0)
