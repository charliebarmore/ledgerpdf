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
 * to spike/out/demo_frames/ with a durations.json; the separate ledgerpdf-site
 * repository's tools/make-demo-webp.py assembles them into website assets.
 *
 * macOS-only by design (screencapture -l), same as the icon pipeline.
 */

import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { isolatedAgentAccess } from './lib/isolated-agent-access.mjs'
import { stopApp as stopAppTree } from './lib/stop-app.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const APP = path.resolve(here, '..')
const REPO = path.resolve(APP, '..')
const PY = path.join(REPO, 'engine', '.venv', 'bin', 'python')

// The engagement the demo prepares: the Sample set — a synthetic MFJ 1040
// with two W-2s, three interest payers, childcare, a donation, a prior-year
// return and a multi-tab workpaper. Invented names, EINs and figures, built
// for exactly this. The documents stay OUT of the repo; only the recording
// ships. Point WPT_DEMO_DOCS at any folder with the same shape to re-record
// without them.
const DEMO_DOCS = process.env.WPT_DEMO_DOCS
  ? path.resolve(process.env.WPT_DEMO_DOCS)
  : path.join(
      process.env.HOME ?? '',
      'Desktop',
      'Demo Docs',
      'Sample Demo Client (Synthetic)'
    )
const WORKPAPER = path.join(
  DEMO_DOCS,
  'Taxes',
  '2025',
  'Sample-Demo-Client-Synthetic-2025-Tax-Workpaper.xlsx'
)
const FRAMES = path.join(REPO, 'spike', 'out', 'demo_frames')
const SERVER = path.join(APP, 'out', 'mcp-server.cjs')
const DEMO_ACCESS = isolatedAgentAccess(
  path.join(REPO, 'spike', 'out', 'agent-profile-demo'),
  [path.join(REPO, 'spike'), DEMO_DOCS]
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (!existsSync(DEMO_DOCS) || !existsSync(WORKPAPER)) {
  console.error(`demo documents not found at ${DEMO_DOCS}`)
  console.error('set WPT_DEMO_DOCS to a folder of synthetic engagement documents')
  process.exit(1)
}

// ---------------------------------------------------------------- the app
rmSync(FRAMES, { recursive: true, force: true })
mkdirSync(FRAMES, { recursive: true })

// Rebuild the server bundle FIRST. The recorder drives out/mcp-server.cjs,
// and a take against a stale bundle records behavior the source no longer
// has — which happened: two takes ran without a fix that was sitting
// typechecked in server.ts, and the missing beat read as a product bug.
console.log('bundling the MCP server…')
await new Promise((resolve, reject) => {
  const b = spawn('npm', ['run', 'build:mcp'], { cwd: APP, stdio: 'inherit' })
  b.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`build:mcp exited ${code}`))))
})

console.log('launching the app (empty binder, live access on)…')
// detached + group kill: killing npm alone orphans Electron, and the orphan
// holds the single-instance lock against every later run. See live-check.mjs.
const app = spawn('npm', ['run', 'dev'], {
  cwd: APP,
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
  env: { ...process.env, ...DEMO_ACCESS.env, WPT_DEV_LIVE: '1' }
})
// Bounded, cross-platform teardown — see scripts/lib/stop-app.mjs. This file
// used to carry its own copy, and that copy still ended in an unbounded
// `await closed` after live-check's had been fixed: the escalation path it
// waited on was `process.kill(-pid)`, which cannot work on Windows, so on the
// one platform the fallback existed for it waited forever. macOS-only or not,
// a private copy of shared teardown is how one gets fixed and the other does
// not.
const stopApp = () => stopAppTree(app)
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
    env: {
      ...process.env,
      ...DEMO_ACCESS.env
    }
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

await call('binder_set_reviewer', { initials: 'ABC' })

// The stack a 1040 preparer actually receives, in one gesture: thirteen source
// documents — W-2s, consolidated 1099s, 1098, childcare, a donation receipt,
// the prior-year return — then the firm's own multi-tab workpaper. recurse:
// false because the folder also holds filed copies underneath; the demo takes
// the inbox, not the archive.
await call('binder_add_folder', { path: DEMO_DOCS, recurse: false })
await sleep(4200)

const beforeWp = await call('binder_status')
const preIds = new Set([...beforeWp.matchAll(/\bpg_\d+\b/g)].map((m) => m[0]))
await call('binder_add_pdfs', { paths: [WORKPAPER] })
await sleep(3000)
const afterWp = await call('binder_status')
// The workpaper's own pages, so a find can be told "the workpaper copy, not
// the source document" when the same figure rightly appears on both.
const wpPages = new Set(
  [...afterWp.matchAll(/\bpg_\d+\b/g)].map((m) => m[0]).filter((id) => !preIds.has(id))
)

// Every hit a find returned, each with the spot a preparer would tick —
// "beside" the figure, not on top of it.
const hits = (text) =>
  [...text.matchAll(/\[page (pg_\d+)\s+nx ([\d.]+)\s+ny ([\d.]+)(?:\s+beside nx ([\d.]+))?\]/g)].map(
    (m) => ({ page: m[1], nx: Number(m[4] ?? m[2]), ny: Number(m[3]) })
  )
const findOn = async (query, wanted) => {
  const found = hits(await call('binder_find', { query, limit: 50 })).filter((h) =>
    wanted ? wpPages.has(h.page) === wanted.workpaper : true
  )
  if (!found.length) throw new Error(`"${query}" not found where expected`)
  return found[0]
}

// Tie Daniel's W-2 box 1 to the workpaper's W-2 line. The agent decides these
// SHOULD agree; binder_tie proves whether they do, in integer cents, and
// records the result on both pages. The window follows the work.
const w2 = await findOn('128,450.00', { workpaper: false })
const lead = await findOn('128,450', { workpaper: true })
await call('binder_tie', {
  label: 'Wages — W-2 box 1 to workpaper',
  a: { pageId: w2.page, amount: '128,450.00', nx: w2.nx, ny: w2.ny, what: 'W-2 box 1 (Ironwood)' },
  b: { pageId: lead.page, amount: '128,450', nx: lead.nx, ny: lead.ny, what: 'workpaper W-2 wages' }
})
await sleep(2600)

// Foot Schedule B interest from its three payers, on the workpaper page where
// the figures live. Whole cents, never floats; the card shows its addends.
const int3 = await findOn('486.12', { workpaper: true })
await call('binder_add_tape', {
  pageId: int3.page,
  nx: 0.64,
  ny: Math.min(int3.ny + 0.16, 0.9),
  title: 'Interest — Sch B',
  entries: [
    { value: 187.42, op: '+', note: 'Atlantic Natl' },
    { value: 214.87, op: '+', note: 'Meridian' },
    { value: 486.12, op: '+', note: 'Whitfield Barnes' }
  ]
})
await sleep(2600)

// A real open item, flagged where the document is: the childcare statement
// has no provider EIN, and Form 2441 needs one.
const care = await findOn('9,840.00', { workpaper: false })
await call('binder_add_note', {
  pageId: care.page,
  nx: Math.min(care.nx + 0.06, 0.92),
  ny: care.ny,
  note: 'Provider EIN not on statement — request Form W-10 before filing 2441.',
  flag: true
})
await sleep(2600)

// The binder explains itself: a cover memo, typeset as page 1.
await call('binder_add_cover', {
  path: path.join(REPO, 'spike', 'out', 'demo_cover.md'),
  narrative:
    'Assembled the 2025 Sample engagement from the client folder. Wages tied to the workpaper; Schedule B interest footed across three payers. One open item: the childcare provider EIN.'
})
await sleep(2600)

await call('binder_save', { path: path.join(REPO, 'spike', 'out', 'demo_binder.pdf') })
await sleep(2400)

// ------------------------------------------------------------------ wrap
rolling = false
await camera
writeFileSync(path.join(FRAMES, 'durations.json'), JSON.stringify(stamps))
console.log(`${frame} frames -> ${FRAMES}`)
console.log(
  `next: from ledgerpdf-site, run .venv/bin/python tools/make-demo-webp.py ${JSON.stringify(FRAMES)}`
)
} finally {
  rolling = false
  await client?.close().catch(() => {})
  await stopApp()
}
