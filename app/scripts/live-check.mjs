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
import { statSync } from 'node:fs'
import { existsSync, rmSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const APP = path.resolve(here, '..')
const REPO = path.resolve(APP, '..')
const FIXTURES = path.join(REPO, 'spike', 'fixtures')
const SERVER = path.join(APP, 'out', 'mcp-server.cjs')
const OUT = path.join(REPO, 'spike', 'out', 'live_binder.pdf')

const checks = []
const check = (name, ok, detail = '') => checks.push([name, !!ok, detail])

const fixture = path.join(FIXTURES, 'fixture_a.pdf')
if (!existsSync(fixture) || !existsSync(SERVER)) {
  console.error('run: engine/.venv/bin/python spike/run_spike.py && npm run build:mcp')
  process.exit(1)
}
rmSync(OUT, { force: true })

const app = spawn('npm', ['run', 'dev'], {
  cwd: APP,
  shell: process.platform === 'win32',
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, WPT_DEV_OPEN: fixture, WPT_DEV_LIVE: '1' }
})
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

let failed = 0
let client = null
try {
  if (!endpoint) throw new Error('no endpoint')

  // The endpoint file is the only way in, and it is the app's own private file.
  const endpointFile = path.join(path.dirname(endpoint), 'live-endpoint.json')
  const stat = statSync(endpointFile)
  check(
    'the endpoint file is readable only by its owner',
    (stat.mode & 0o077) === 0,
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
  }
} catch (e) {
  const trace = (out + err)
    .split('\n')
    .filter((l) => l.includes('[dev]'))
    .slice(-6)
    .join(' | ')
  check('live session drove without throwing', false, `${String(e)}  ::  ${trace}`)
} finally {
  if (client) await client.close().catch(() => {})
  app.kill()
}

console.log('\n=== live agent access ===')
for (const [name, ok, detail] of checks) {
  if (!ok) failed++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? `  — ${detail}` : ''}`)
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`)
process.exit(failed ? 1 : 0)
