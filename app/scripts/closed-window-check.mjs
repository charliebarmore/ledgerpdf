/**
 * Live access during an unsaved-changes dialog and after its binder window
 * closes (macOS only).
 *
 *   npm run verify:closed-window
 *
 * The close dialog used to be synchronous, blocking main and making every
 * agent call wait 15 seconds before a generic timeout. It is now asynchronous,
 * so the call fails immediately and names the dialog. If the reviewer discards
 * the binder and closes the window, live access ends with that exact document;
 * a request can never be routed into a newly mounted empty session.
 */
import { spawn } from 'node:child_process'
import path from 'node:path'

import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { isolatedAgentAccess } from './lib/isolated-agent-access.mjs'
import { stopApp } from './lib/stop-app.mjs'

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO = path.resolve(APP, '..')
const SERVER = path.join(APP, 'out', 'mcp-server.cjs')
const ENDPOINT = path.join(REPO, 'spike', 'out', 'closed-window-endpoint.json')
const FIXTURE = path.join(REPO, 'spike', 'fixtures', 'fixture_a.pdf')
const CLOSED_ACCESS = isolatedAgentAccess(
  path.join(REPO, 'spike', 'out', 'agent-profile-closed-window'),
  [path.join(REPO, 'spike')]
)

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

// Launch with live on, a dirty binder, and a test-held close dialog. The dev
// hook follows the real close state machine but supplies the response without
// asking a headless run to click a native modal.
const app = spawn('npm', ['run', 'dev'], {
  cwd: APP,
  // On Windows npm is a .cmd shim. Node's command-spawn hardening refuses to
  // launch it directly, so use the platform shell just for this npm command.
  shell: process.platform === 'win32',
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: process.platform !== 'win32',
  env: {
    ...process.env,
    ...CLOSED_ACCESS.env,
    WPT_LIVE_ENDPOINT: ENDPOINT,
    WPT_DEV_LIVE: '1',
    WPT_DEV_USERDATA: path.join(REPO, 'spike', 'out', 'userdata-closedwin'),
    WPT_DEV_CLOSE_WINDOW_MS: '10000',
    // Deterministically hold main's readiness acknowledgement so the first
    // live request exercises the mount queue rather than merely hoping to win
    // a naturally tiny race.
    WPT_DEV_LIVE_READY_DELAY_MS: '1500',
    WPT_DEV_CLOSE_DIALOG_HOLD_MS: '5000',
    WPT_DEV_CLOSE_DIALOG_RESPONSE: 'discard',
    ELECTRON_ENABLE_LOGGING: '1'
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
    env: {
      ...process.env,
      ...CLOSED_ACCESS.env,
      WPT_LIVE_ENDPOINT: ENDPOINT,
    }
  })
)
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args })
  return { text: (r.content ?? []).map((c) => c.text ?? '').join('\n'), isError: !!r.isError }
}

// 1. The endpoint is not useful until the renderer listener has signalled
// ready, so this first request succeeds without a retry loop.
const firstStarted = Date.now()
const before = await call('binder_status')
const firstWait = Date.now() - firstStarted
const imported = await call('binder_add_pdfs', { paths: [FIXTURE] })
check(
  'a request during renderer mount queues, then reaches the live binder once',
  !before.isError &&
    /LIVE/.test(before.text) &&
    firstWait >= 1000 &&
    !imported.isError &&
    /3 page\(s\)/.test(imported.text),
  `${firstWait}ms; ${imported.text.split('\n')[0].slice(0, 80)}`
)

// 2. Find the held dialog window. Calls before the close event remain valid;
// once it opens the error must be immediate and specific.
let duringDialog = { isError: false, text: '' }
const dialogDeadline = Date.now() + 20_000
while (Date.now() < dialogDeadline) {
  duringDialog = await call('binder_status')
  if (duringDialog.isError && /unsaved-changes dialog/i.test(duringDialog.text)) break
  await new Promise((r) => setTimeout(r, 200))
}
check(
  'a live call during the close dialog fails immediately with the named reason',
  duringDialog.isError && /unsaved-changes dialog/i.test(duringDialog.text),
  duringDialog.text.split('\n')[0].slice(0, 110)
)

// 3. The dev response discards and closes. Live access belongs to that exact
// binder window, so the socket closes and later calls fail rather than opening
// a blank replacement document.
await new Promise((r) => setTimeout(r, 6500))
const afterClose = await call('binder_status')
check(
  'closing the binder window ends the attached agent session',
  afterClose.isError && /binder window closed/i.test(afterClose.text),
  afterClose.text.split('\n')[0]
)

const indicatorSyncs = (log.match(/\[live-indicator\] on/g) ?? []).length
check(
  'no replacement renderer silently inherited live access',
  indicatorSyncs === 1,
  `${indicatorSyncs} renderer(s) reported on`
)

await client.close()
await stopApp(app)
const failed = checks.filter((ok) => !ok).length
console.log(`\n${checks.length - failed}/${checks.length} checks passed`)
process.exit(failed ? 1 : 0)
