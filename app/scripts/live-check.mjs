/**
 * Proves an agent and the running app share ONE binder.
 *
 * Launches the real Electron app with a binder already open and live access on,
 * then drives the real stdio MCP server as a real MCP client. The agent is
 * never told what the app has open — if the two kept separate copies, which is
 * what happened before live access existed, every assertion below fails.
 *
 *   npm run verify:live
 */

import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { copyFileSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { stopApp as stopAppTree } from './lib/stop-app.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const APP = path.resolve(here, '..')
const REPO = path.resolve(APP, '..')
const FIXTURES = path.join(REPO, 'spike', 'fixtures')
const SERVER = path.join(APP, 'out', 'mcp-server.cjs')
const OUT = path.join(REPO, 'spike', 'out', 'live_binder.pdf')
const OUTSIDE_ROOT = path.join(APP, 'build', 'live-outside-root.pdf')
const USERDATA = path.join(REPO, 'spike', 'out', 'userdata-live')

// Pin the endpoint file for this run. Two reasons, and the first is a real bug
// this replaced: deriving it from the socket's directory only works on POSIX,
// where the socket happens to live beside it. A Windows named pipe is
// `\\.\pipe\name`, which is not a directory and cannot hold a file. The app and
// the MCP server both honour WPT_LIVE_ENDPOINT, so pinning it is the supported
// seam. Second, it keeps this check off the real endpoint file, so running it
// can never disturb an app the user has open.
const ENDPOINT_FILE = path.join(REPO, 'spike', 'out', 'live-endpoint.json')
process.env.WPT_LIVE_ENDPOINT = ENDPOINT_FILE

const checks = []
const check = (name, ok, detail = '') => checks.push([name, !!ok, detail])

const report = () => {
  console.log('\n=== live agent access ===')
  let failed = 0
  for (const [name, ok, detail] of checks) {
    if (!ok) failed++
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? `  — ${detail}` : ''}`)
  }
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`)
  return failed
}

// Every wait inside this check is individually bounded — the endpoint at 90s,
// each MCP call at 60s, the socket probe at 3s — so a healthy run finishes in
// well under two minutes. The watchdog exists for the waits that are NOT
// bounded, in the MCP client and in teardown: on 2026-08-06 one of those hung
// on Windows and the job died at its 45-minute timeout having printed nothing
// at all, which is the worst way to fail. Overrunning now costs five minutes
// and still prints which check it got to.
const WATCHDOG_MS = 5 * 60_000
const watchdog = setTimeout(() => {
  check('live-check finished inside its time budget', false, `hung past ${WATCHDOG_MS / 1000}s`)
  report()
  process.exit(1)
}, WATCHDOG_MS)

const fixture = path.join(FIXTURES, 'fixture_a.pdf')
if (!existsSync(fixture) || !existsSync(SERVER)) {
  // Two things differ on Windows: the venv is `Scripts\` rather than `bin/`,
  // and Windows PowerShell 5.1 has no `&&`, so chaining the two commands on
  // one line is a parse error there. Print them as separate lines instead.
  if (process.platform === 'win32') {
    console.error('run: engine\\.venv\\Scripts\\python spike\\run_spike.py')
    console.error('     npm run build:mcp')
  } else {
    console.error('run: engine/.venv/bin/python spike/run_spike.py && npm run build:mcp')
  }
  process.exit(1)
}
rmSync(OUT, { force: true })
rmSync(OUTSIDE_ROOT, { force: true })
copyFileSync(fixture, OUTSIDE_ROOT)
rmSync(USERDATA, { force: true, recursive: true })

// detached: the child leads its own process group, so cleanup can signal the
// GROUP. `app.kill()` alone kills npm and orphans Electron underneath it — and
// an orphaned Electron holds the single-instance lock, which made every
// FOLLOWING run fail in ways that looked like the code under test.
const app = spawn('npm', ['run', 'dev'], {
  cwd: APP,
  shell: process.platform === 'win32',
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: process.platform !== 'win32',
  env: {
    ...process.env,
    // Its own userData, wiped first, because Electron's single-instance lock is
    // a file in there. Sharing the real one means this check cannot run while
    // the developer has the app open — the launch hands off to the running
    // window, exits without ever printing an endpoint, and this fails with "no
    // endpoint", which looks like a live-access defect rather than a busy
    // machine. Safe here because the live endpoint is deliberately NOT under
    // userData (see shared/live-endpoint.ts) and is pinned above anyway.
    WPT_DEV_USERDATA: USERDATA,
    WPT_DEV_OPEN: fixture,
    WPT_DEV_LIVE: '1',
    // Forward renderer console messages into stderr. The follow assertion below
    // can then distinguish a deliberately suppressed jump from one that was
    // accepted and later overwritten by the scroll tracker.
    ELECTRON_ENABLE_LOGGING: '1',
    // The app independently enforces the same roots as the MCP server. Giving
    // only the server a root would leave a token-holding local client able to
    // bypass the user's folder approval through a forged live push.
    WPT_MCP_ROOTS: path.join(REPO, 'spike')
  }
})
// Bounded, cross-platform teardown — scripts/lib/stop-app.mjs carries the two
// failures that shaped it, and record-demo.mjs and smoke.mjs share it. It used
// to live here as a private copy, which is how record-demo went on running the
// version with the unbounded wait after this one was fixed.
const stopApp = () => stopAppTree(app)
let out = ''
let err = ''
app.stdout.on('data', (d) => (out += d))
app.stderr.on('data', (d) => (err += d))

const deadline = Date.now() + 90_000
let endpoint = null
while (Date.now() < deadline && !endpoint) {
  const m = out.match(/live agent access at (.+)/)
  if (m) endpoint = m[1].trim()
  else await new Promise((r) => setTimeout(r, 400))
}
check('the running app offers live agent access', !!endpoint, endpoint ?? `${out.slice(-300)}${err.slice(-300)}`)

let client = null
try {
  if (!endpoint) throw new Error('no endpoint')

  // The endpoint file is the only way in, and it is the app's own private file.
  const endpointFile = ENDPOINT_FILE
  const stat = statSync(endpointFile)
  // POSIX modes are the mechanism on macOS/Linux. Windows does not have them —
  // Node reports 0o666 there regardless — and the protection is the per-user
  // profile ACL on %APPDATA% instead. Asserting 0600 on Windows would only
  // prove Node's shim, so assert the file exists and is a file, and keep the
  // real permission assertion where it means something.
  check(
    process.platform === 'win32'
      ? 'the endpoint file is created (Windows: protected by the per-user ACL)'
      : 'the endpoint file is readable only by its owner',
    process.platform === 'win32' ? stat.isFile() : (stat.mode & 0o077) === 0,
    `mode ${(stat.mode & 0o777).toString(8)}`
  )

  // A client that does not present the token gets nothing.
  const anon = await new Promise((resolve) => {
    const sock = connect(endpoint, () => {
      sock.write(`${JSON.stringify({ id: 1, verb: 'pull' })}\n`)
    })
    let buf = ''
    sock.setEncoding('utf8')
    sock.on('data', (d) => {
      buf += d
      if (buf.includes('\n')) {
        sock.destroy()
        resolve(buf.trim())
      }
    })
    sock.on('error', (e) => resolve(`error ${e.message}`))
    setTimeout(() => {
      sock.destroy()
      resolve(buf.trim() || 'no reply')
    }, 3000)
  })
  check(
    'an unauthenticated local client is refused',
    anon.includes('unauthorized'),
    String(anon).slice(0, 120)
  )

  // Possessing the endpoint token grants access to the open binder, but it must
  // not bypass the independently approved filesystem roots. Forge a live push
  // that swaps the current source for a valid PDF outside the approved tree;
  // main must reject it before the renderer is asked to read that path.
  const forgeOutsideRoot = async () => {
    const endpointInfo = JSON.parse(readFileSync(endpointFile, 'utf8'))
    return new Promise((resolve) => {
      const sock = connect(endpointInfo.socketPath)
      sock.setEncoding('utf8')
      let buffer = ''
      let stage = 'hello'
      const timer = setTimeout(() => {
        sock.destroy()
        resolve({ ok: false, error: 'forged push timed out' })
      }, 5000)
      const finish = (value) => {
        clearTimeout(timer)
        sock.destroy()
        resolve(value)
      }
      sock.on('connect', () => {
        sock.write(`${JSON.stringify({ id: 1, verb: 'hello', token: endpointInfo.token })}\n`)
      })
      sock.on('data', (chunk) => {
        buffer += chunk
        let cut = buffer.indexOf('\n')
        while (cut >= 0) {
          const line = buffer.slice(0, cut)
          buffer = buffer.slice(cut + 1)
          cut = buffer.indexOf('\n')
          if (!line.trim()) continue
          const reply = JSON.parse(line)
          if (stage === 'hello') {
            stage = 'pull'
            sock.write(`${JSON.stringify({ id: 2, verb: 'pull' })}\n`)
          } else if (stage === 'pull') {
            const session = structuredClone(reply.session)
            session.sources[0].path = OUTSIDE_ROOT
            stage = 'push'
            sock.write(`${JSON.stringify({ id: 3, verb: 'push', session })}\n`)
          } else {
            finish(reply)
          }
        }
      })
      sock.on('error', (error) => finish({ ok: false, error: error.message }))
    })
  }

  // The real MCP server, spawned exactly as an MCP client would spawn it.
  client = new Client({ name: 'live-check', version: '1.0.0' })
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      env: { ...process.env, WPT_MCP_ROOTS: path.join(REPO, 'spike') }
    })
  )
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args })
    return { text: (r.content ?? []).map((c) => c.text ?? '').join('\n'), isError: !!r.isError }
  }

  const status = await call('binder_status')
  check(
    'the agent sees the binder the app already has open',
    status.text.includes('3 page(s)') && status.text.includes('fixture_a.pdf'),
    status.text.split('\n')[0]
  )
  check(
    'the agent is told it is editing the live binder, not a copy',
    status.text.includes('LIVE'),
    status.text.split('\n')[1] ?? ''
  )

  const pageId = status.text.match(/\bpg_\d+\b/)?.[0]
  const placed = await call('binder_place_mark', { pageId, kind: 'tick', nx: 0.33, ny: 0.44 })
  check('the agent can mark that binder', !placed.isError, placed.text)

  // The question this whole feature exists to answer: did it land in the APP's
  // session, or in an agent-side copy?
  const after = await call('binder_status')
  check(
    "the mark is in the app's own binder, not an agent-side copy",
    after.text.includes('1 mark(s)'),
    after.text.split('\n')[0]
  )

  // The agent adding a file it can reach is not the same as the WINDOW being
  // able to draw it. The renderer may only read paths a user action authorized,
  // and a session arriving from an agent names files this app never opened a
  // dialog for — which showed up as "file not user-authorized this session" on
  // the page while the agent reported success.
  const second = path.join(FIXTURES, 'fixture_b.pdf')
  const grew = await call('binder_add_pdfs', { paths: [second] })
  check('the agent can add a file the app never opened itself', !grew.isError, grew.text.split('\n')[0])
  const drew = await call('binder_current_page')
  check(
    'and the window can actually draw it',
    !drew.isError && !/not user-authorized/i.test(drew.text + grew.text),
    drew.text.split('\n')[0]
  )

  const saved = await call('binder_save', { path: OUT })
  check('the shared binder saves as one file', !saved.isError && existsSync(OUT), saved.text.split('\n')[0])
  if (existsSync(OUT)) {
    // Reopening it is the real assertion: the page the APP had open and the
    // mark the AGENT made both come back out of the binder itself.
    await call('binder_new')
    const back = await call('binder_open', { path: OUT })
    check(
      'the saved binder holds the page the APP opened and the mark the AGENT made',
      // Six now: the three the APP opened plus the three the AGENT added.
      back.text.includes('6 page(s)') && back.text.includes('1 mark(s)'),
      back.text.split('\n')[0]
    )

    // Follow-the-agent: marking a page the person is NOT looking at moves the
    // window there. Without this, an agent working deep in a real binder is
    // invisible — the push applies but the view sits on page 1 and "watch it
    // work" is only true of binders small enough to have no elsewhere. The
    // harness never generates input events, so the idle guard is open and the
    // follow must fire.
    // binder_open's reply summarizes; binder_status is what enumerates pages.
    // The first draft read ids out of the open reply, found none, and failed
    // for a reason that had nothing to do with following.
    const enumerated = await call('binder_status')
    const ids = [...enumerated.text.matchAll(/\bpg_\d+\b/g)].map((m) => m[0])
    const last = [...new Set(ids)].pop()
    const before = await call('binder_current_page')
    if (last && !before.text.includes(last)) {
      await call('binder_place_mark', { pageId: last, kind: 'tick', nx: 0.5, ny: 0.5 })
      // Wait for the OBSERVED view, not for the push to return. The push
      // resolves when the renderer acknowledges it, but setCurrentId is a React
      // state update and binder_current_page pulls what the last RENDER put in
      // the ref — so reading it immediately races the re-render. It passed on
      // timing luck until a rebase shifted the timing, which is exactly how a
      // flaky check earns its keep: never on the run where it matters.
      let after = ''
      for (let i = 0; i < 40; i++) {
        after = (await call('binder_current_page')).text
        if (after.includes(last)) break
        await new Promise((r) => setTimeout(r, 100))
      }
      check(
        'the window follows the agent to the page it marked',
        after.includes(last),
        `marked ${last}; view: ${after.split('\n')[0]}; ${err
          .split('\n')
          .filter((line) => line.includes('[live-follow]'))
          .slice(-3)
          .join(' | ')}`
      )
    } else {
      check('the window follows the agent to the page it marked', false,
        `could not find an off-screen page to mark (view: ${before.text.split('\n')[0]})`)
    }
  }
  const forged = await forgeOutsideRoot()
  check(
    'an authenticated live client cannot widen the approved folders',
    forged.ok === false && /outside the approved folders/i.test(forged.error ?? ''),
    JSON.stringify(forged).slice(0, 180)
  )
} catch (e) {
  const trace = (out + err)
    .split('\n')
    .filter((l) => l.includes('[dev]'))
    .slice(-6)
    .join(' | ')
  check('live session drove without throwing', false, `${String(e)}  ::  ${trace}`)
} finally {
  if (client) await client.close().catch(() => {})
  await stopApp()
  rmSync(OUTSIDE_ROOT, { force: true })
}

clearTimeout(watchdog)
process.exit(report() ? 1 : 0)
