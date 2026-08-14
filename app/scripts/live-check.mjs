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
import { isolatedAgentAccess } from './lib/isolated-agent-access.mjs'
import { stopApp as stopAppTree } from './lib/stop-app.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const APP = path.resolve(here, '..')
const REPO = path.resolve(APP, '..')
const FIXTURES = path.join(REPO, 'spike', 'fixtures')
const SERVER = path.join(APP, 'out', 'mcp-server.cjs')
const OUT = path.join(REPO, 'spike', 'out', 'live_binder.pdf')
const HIDDEN_SAVE_AS = path.join(REPO, 'spike', 'out', 'live_hidden_save_as.pdf')
const OUTSIDE_ROOT = path.join(APP, 'build', 'live-outside-root.pdf')
const USERDATA = path.join(REPO, 'spike', 'out', 'userdata-live')
const LIVE_ACCESS = isolatedAgentAccess(
  path.join(REPO, 'spike', 'out', 'agent-profile-live'),
  [path.join(REPO, 'spike')]
)

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
rmSync(HIDDEN_SAVE_AS, { force: true })
rmSync(OUTSIDE_ROOT, { force: true })
copyFileSync(fixture, OUTSIDE_ROOT)
rmSync(USERDATA, { force: true, recursive: true })

// Seed a real saved binder, then close the standalone owner. The desktop app
// below opens THIS file and must become the cross-process lock holder.
const seedTransport = new StdioClientTransport({
  command: process.execPath,
  args: [SERVER],
  env: {
    ...process.env,
    ...LIVE_ACCESS.env,
    WPT_NO_LIVE: '1'
  }
})
const seedClient = new Client({ name: 'live-check-seed', version: '1.0.0' })
await seedClient.connect(seedTransport)
await seedClient.callTool({ name: 'binder_add_pdfs', arguments: { paths: [fixture] } })
const seeded = await seedClient.callTool({ name: 'binder_save', arguments: { path: OUT } })
await seedClient.callTool({ name: 'binder_new', arguments: {} })
await seedClient.close()
if (seeded.isError || !existsSync(OUT)) {
  console.error('could not seed the saved binder used by the live lock check')
  process.exit(1)
}

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
    ...LIVE_ACCESS.env,
    // Its own userData, wiped first, because Electron's single-instance lock is
    // a file in there. Sharing the real one means this check cannot run while
    // the developer has the app open — the launch hands off to the running
    // window, exits without ever printing an endpoint, and this fails with "no
    // endpoint", which looks like a live-access defect rather than a busy
    // machine. Safe here because the live endpoint is deliberately NOT under
    // userData (see shared/live-endpoint.ts) and is pinned above anyway.
    WPT_DEV_USERDATA: USERDATA,
    // Import once to hold live startup until the renderer is ready, then use
    // the real single-file reopen seam so the app (not the harness) claims OUT.
    WPT_DEV_OPEN: fixture,
    WPT_DEV_REOPEN: OUT,
    WPT_DEV_LIVE: '1',
    // Forward renderer console messages into stderr. The follow assertion below
    // can then distinguish a deliberately suppressed jump from one that was
    // accepted and later overwritten by the scroll tracker.
    ELECTRON_ENABLE_LOGGING: '1',
    // The app independently reads the same approval file as the MCP server.
    // Giving only the server a root would leave a token-holding local client
    // able to bypass the user's folder approval through a forged live push.
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

  /** Authenticated raw pull of the state the app itself holds. */
  const pullAppState = async () => {
    const endpointInfo = JSON.parse(readFileSync(ENDPOINT_FILE, 'utf8'))
    return new Promise((resolve) => {
      const sock = connect(endpointInfo.socketPath)
      sock.setEncoding('utf8')
      let buffer = ''
      let stage = 'hello'
      const timer = setTimeout(() => {
        sock.destroy()
        resolve(null)
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
          } else {
            finish({ session: reply.session ?? null, documentId: reply.documentId })
          }
        }
      })
      sock.on('error', () => finish(null))
    })
  }

  /** Two clients read one revision; only the first may replace it. */
  const stalePushIsRefused = async () => {
    const endpointInfo = JSON.parse(readFileSync(ENDPOINT_FILE, 'utf8'))
    return new Promise((resolve) => {
      const sock = connect(endpointInfo.socketPath)
      sock.setEncoding('utf8')
      let buffer = ''
      let stage = 'hello'
      let firstPull = null
      const timer = setTimeout(() => {
        sock.destroy()
        resolve({ ok: false, error: 'revision check timed out' })
      }, 8000)
      const finish = (value) => {
        clearTimeout(timer)
        sock.destroy()
        resolve(value)
      }
      sock.on('connect', () => {
        sock.write(`${JSON.stringify({ id: 11, verb: 'hello', token: endpointInfo.token })}\n`)
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
            stage = 'pull-one'
            sock.write(`${JSON.stringify({ id: 12, verb: 'pull' })}\n`)
          } else if (stage === 'pull-one') {
            firstPull = reply
            stage = 'pull-two'
            sock.write(`${JSON.stringify({ id: 13, verb: 'pull' })}\n`)
          } else if (stage === 'pull-two') {
            stage = 'push-one'
            sock.write(
              `${JSON.stringify({
                id: 14,
                verb: 'push',
                expectedRevision: firstPull.revision,
                session: { ...firstPull.session, reviewer: 'REVISION-A' }
              })}\n`
            )
          } else if (stage === 'push-one') {
            if (!reply.ok) return finish({ ok: false, error: `first push failed: ${reply.error}` })
            stage = 'push-stale'
            sock.write(
              `${JSON.stringify({
                id: 15,
                verb: 'push',
                expectedRevision: firstPull.revision,
                session: { ...firstPull.session, reviewer: 'REVISION-B' }
              })}\n`
            )
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
      env: {
        ...process.env,
        ...LIVE_ACCESS.env
      }
    })
  )
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args })
    return { text: (r.content ?? []).map((c) => c.text ?? '').join('\n'), isError: !!r.isError }
  }

  const status = await call('binder_status')
  check(
    'the agent sees the binder the app already has open',
    status.text.includes('3 page(s)') && status.text.includes('live_binder.pdf'),
    status.text.split('\n')[0]
  )
  check(
    'the agent is told it is editing the live binder, not a copy',
    status.text.includes('LIVE'),
    status.text.split('\n')[1] ?? ''
  )

  // Force a second server to stay standalone even though live access is on.
  // It must meet the lease held by the desktop app and refuse the open.
  const standaloneTransport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: {
      ...process.env,
      ...LIVE_ACCESS.env,
      WPT_NO_LIVE: '1'
    }
  })
  const standaloneClient = new Client({ name: 'live-lock-check', version: '1.0.0' })
  await standaloneClient.connect(standaloneTransport)
  const busyOpen = await standaloneClient.callTool({
    name: 'binder_open',
    arguments: { path: OUT }
  })
  const busyText = (busyOpen.content ?? []).map((part) => part.text ?? '').join('\n')
  check(
    'a standalone agent cannot open the binder held by the desktop app',
    busyOpen.isError && /already open/i.test(busyText),
    busyText.split('\n')[0]
  )
  await standaloneClient.close()

  const stale = await stalePushIsRefused()
  check(
    'a stale live push cannot replace a newer user or agent change',
    stale.ok === false && /changed after the agent read it|stale change/i.test(stale.error ?? ''),
    JSON.stringify(stale).slice(0, 180)
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

  // REGRESSION — the run-attribution leak. The agent's run id must never
  // survive the push into the app: if `activeRun` crosses the socket, stamp()
  // marks every tick the PERSON places afterwards as agent work, and "undo the
  // AI's run" deletes their marks along with the agent's. Pull the app's own
  // session and look at what it actually holds.
  const appState = await pullAppState()
  const appSession = appState?.session ?? null
  check(
    'the live binder carries a document identity distinct from its save path',
    typeof appState?.documentId === 'string' && appState.documentId.length > 0,
    `documentId=${JSON.stringify(appState?.documentId)}`
  )
  check(
    "the app's session carries no activeRun after an agent edit",
    appSession !== null && appSession.activeRun === undefined,
    appSession ? `activeRun=${JSON.stringify(appSession.activeRun)}` : 'pull failed'
  )
  check(
    "while the agent's own mark keeps its attribution",
    !!appSession?.marks?.some((m) => m.by === 'agent' && m.run),
    JSON.stringify(appSession?.marks?.map((m) => [m.by, m.run]) ?? 'no marks')
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

  // Follow-the-agent: marking a page the person is NOT looking at moves the
  // window there. The harness never generates input events, so the idle guard
  // is open and the follow must fire.
  const enumerated = await call('binder_status')
  const ids = [...enumerated.text.matchAll(/\bpg_\d+\b/g)].map((m) => m[0])
  const last = [...new Set(ids)].pop()
  const before = await call('binder_current_page')
  if (last && !before.text.includes(last)) {
    await call('binder_place_mark', { pageId: last, kind: 'tick', nx: 0.5, ny: 0.5 })
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
    check(
      'the window follows the agent to the page it marked',
      false,
      `could not find an off-screen page to mark (view: ${before.text.split('\n')[0]})`
    )
  }

  // The live agent may change the open session, but it may not silently choose
  // a new durable path the app does not adopt or lock. The person saves through
  // the visible app; standalone mode owns its own Save paths.
  const saved = await call('binder_save', { path: HIDDEN_SAVE_AS })
  check(
    'a live agent cannot choose a hidden Save As destination behind the app',
    saved.isError && /Save As in the app/i.test(saved.text) && !existsSync(HIDDEN_SAVE_AS),
    saved.text.split('\n')[0]
  )

  // binder_new during live access would blank the binder the person is
  // reviewing — and leave sessionPath aimed at their real file, one path-less
  // save away from overwriting it. It must refuse, and the binder must
  // still be there afterwards.
  const blanked = await call('binder_new', {})
  const stillThere = await call('binder_status')
  check(
    'a live agent cannot discard the binder a person has open',
    blanked.isError &&
      /unavailable during live access/i.test(blanked.text) &&
      /\b[1-9]\d* page\(s\)/.test(stillThere.text),
    `${blanked.text.split('\n')[0]} | ${stillThere.text.split('\n')[0]}`
  )
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
  rmSync(HIDDEN_SAVE_AS, { force: true })
}

clearTimeout(watchdog)
process.exit(report() ? 1 : 0)
