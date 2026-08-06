/**
 * Record the landing-page demo: the REAL app, driven by the REAL MCP server
 * over live access, captured frame by frame. No mockup, no screen-recorder
 * chrome — what ships on ledgerpdf.com is the product doing the work.
 *
 *   node scripts/record-demo.mjs        (from app/, on macOS, screen visible)
 *
 * Launches the dev app empty, attaches an agent, and runs the story a CPA
 * should see: files land in an empty binder, the agent finds a figure by name
 * and ticks it, keys a tape that foots, flags an open item, saves. Frames go
 * to spike/out/demo_frames/ with a durations.json; tools/make-demo-webp.py
 * assembles them.
 *
 * macOS-only by design (screencapture -l), same as the icon pipeline.
 */

import { execFile, spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const APP = path.resolve(here, '..')
const REPO = path.resolve(APP, '..')
const FIXTURES = path.join(REPO, 'spike', 'fixtures')
const PY = path.join(REPO, 'engine', '.venv', 'bin', 'python')
const FRAMES = path.join(REPO, 'spike', 'out', 'demo_frames')
const SERVER = path.join(APP, 'out', 'mcp-server.cjs')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- the app
rmSync(FRAMES, { recursive: true, force: true })
mkdirSync(FRAMES, { recursive: true })

console.log('launching the app (empty binder, live access on)…')
// detached + group kill: killing npm alone orphans Electron, and the orphan
// holds the single-instance lock against every later run. See live-check.mjs.
const app = spawn('npm', ['run', 'dev'], {
  cwd: APP,
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
  env: { ...process.env, WPT_DEV_LIVE: '1' }
})
// Stop the app and WAIT for it to be gone. SIGTERM starts a graceful Electron
// quit; returning while that is in flight leaves the single-instance lock held
// against whatever runs next — which is exactly how one run's teardown became
// the next run's mystery failure.
const stopApp = async () => {
  const closed = new Promise((resolve) => {
    if (app.exitCode !== null) return resolve()
    app.once('close', resolve)
  })
  try {
    if (process.platform === 'win32') app.kill()
    else process.kill(-app.pid, 'SIGTERM')
  } catch {}
  const timeout = new Promise((resolve) => setTimeout(resolve, 8000))
  if ((await Promise.race([closed.then(() => 'closed'), timeout.then(() => 'timeout')])) === 'timeout') {
    try {
      process.kill(-app.pid, 'SIGKILL')
    } catch {}
    await closed
  }
}
let out = ''
app.stdout.on('data', (d) => (out += d))
app.stderr.on('data', () => {})

const deadline = Date.now() + 90_000
while (Date.now() < deadline && !out.includes('live agent access at')) await sleep(300)
if (!out.includes('live agent access at')) {
  await stopApp()
  throw new Error('app never offered live access — is another instance holding the single-instance lock?')
}
await sleep(2500) // let the window paint its empty state

// The window id, via the same Quartz query the icon checks use.
const windowId = await new Promise((resolve, reject) => {
  execFile(
    PY,
    ['-c', `
import Quartz
wl = Quartz.CGWindowListCopyWindowInfo(Quartz.kCGWindowListOptionOnScreenOnly | Quartz.kCGWindowListExcludeDesktopElements, Quartz.kCGNullWindowID)
for w in wl:
    if w.get('kCGWindowName') == 'LedgerPDF' and 'lectron' in (w.get('kCGWindowOwnerName') or ''):
        print(w.get('kCGWindowNumber')); break
`],
    (e, stdout) => (e || !stdout.trim() ? reject(e ?? new Error('window not found')) : resolve(stdout.trim()))
  )
})
console.log(`window ${windowId}; recording…`)

// ------------------------------------------------------------- the camera
// A steady capture loop rather than one shot per action: the durations file
// keeps real time, so the assembler can replay pacing honestly.
const stamps = []
let frame = 0
let rolling = true
const camera = (async () => {
  while (rolling) {
    const n = String(frame++).padStart(4, '0')
    await new Promise((r) =>
      execFile('screencapture', ['-o', '-x', `-l${windowId}`, path.join(FRAMES, `f${n}.png`)], () => r())
    )
    stamps.push(Date.now())
    await sleep(140)
  }
})()

// -------------------------------------------------------------- the agent
// Everything from here runs under try/finally: a failed take that leaves the
// app alive holds the single-instance lock against the NEXT take, which is
// exactly how the first failure here compounded into a second.
let client
try {
client = new Client({ name: 'demo-recorder', version: '1.0.0' })
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { ...process.env, WPT_MCP_ROOTS: path.join(REPO, 'spike') }
  })
)
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args })
  const text = (r.content ?? []).map((c) => c.text ?? '').join('\n')
  // A failed step must stop the take, not record a demo of nothing happening.
  // The first cut of this script ignored results and produced footage in which
  // the agent "worked" for twenty seconds and not one mark appeared.
  if (r.isError) throw new Error(`${name} failed: ${text.split('\n')[0]}`)
  console.log(`  ${name}: ${text.split('\n')[0].slice(0, 90)}`)
  return text
}

// The story. Pauses are the choreography — a beat after every visible change.
const status = await call('binder_status')
if (!status.includes('LIVE')) throw new Error(`agent is not live against the window: ${status.split('\n')[0]}`)

await call('binder_add_pdfs', {
  paths: [
    path.join(FIXTURES, 'fixture_a.pdf'),
    path.join(FIXTURES, 'fixture_b.pdf'),
    path.join(FIXTURES, 'trial_balance.xlsx'),
    path.join(FIXTURES, 'receipt.jpg')
  ]
})
await sleep(2600)

// Find the wages figure BY NAME and tick it where it sits — the product's
// whole argument in one gesture. Coordinates come from the find, not a human.
const locate = (hit) => ({
  page: hit.match(/\bpg_\d+\b/)?.[0],
  // find hands back "beside nx" — the spot just right of the figure, where a
  // preparer would actually put the tick. Use it rather than guessing offsets.
  nx: Number(hit.match(/beside nx (\d+\.\d+)/)?.[1] ?? hit.match(/nx (\d+\.\d+)/)?.[1]),
  ny: Number(hit.match(/ny (\d+\.\d+)/)?.[1])
})
const wages = locate(await call('binder_find', { query: '84,200.00' }))
const page = wages.page
await call('binder_place_mark', { pageId: page, kind: 'tick', nx: wages.nx, ny: wages.ny })
await sleep(1800)

const interest = locate(await call('binder_find', { query: '1,150.00' }))
await call('binder_place_mark', { pageId: page, kind: 'tick', nx: interest.nx, ny: interest.ny })
await sleep(1800)

// A tape that shows the interest figure footing from its parts.
await call('binder_add_tape', {
  pageId: page,
  nx: 0.62,
  ny: 0.42,
  title: 'Interest ties',
  entries: [
    { value: 612.0, op: '+', note: 'First Natl' },
    { value: 538.0, op: '+', note: 'Credit Union' }
  ]
})
await sleep(2200)

await call('binder_add_note', {
  pageId: page,
  nx: 0.33,
  ny: 0.55,
  note: 'Wages agreed to W-2 summary. Interest foots to 1099-INTs.',
  flag: true
})
await sleep(2200)

await call('binder_save', { path: path.join(REPO, 'spike', 'out', 'demo_binder.pdf') })
await sleep(2400)

// ------------------------------------------------------------------ wrap
rolling = false
await camera
writeFileSync(path.join(FRAMES, 'durations.json'), JSON.stringify(stamps))
console.log(`${frame} frames -> ${FRAMES}`)
console.log(`next: engine/.venv/bin/python tools/make-demo-webp.py`)
} finally {
  rolling = false
  await client?.close().catch(() => {})
  await stopApp()
}
