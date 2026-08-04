/**
 * Drives the MCP server the way an agent would — over stdio, as a real MCP
 * client — through a whole binder build, then verifies the PDF it produced.
 *
 * Import → order → bookmark → mark → tape → export → save → reopen, plus the
 * error paths an agent will actually hit (bad page id, empty export).
 *
 *   npm run verify:mcp
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const APP = path.resolve(here, '..')
const REPO = path.resolve(APP, '..')
const ENGINE = path.join(REPO, 'engine')
const PY = path.join(ENGINE, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
const FIXTURES = path.join(REPO, 'spike', 'fixtures')
const SERVER = path.join(APP, 'out', 'mcp-server.cjs')
const OUT_PDF = path.join(REPO, 'spike', 'out', 'mcp_binder.pdf')
const OUT_SESSION = path.join(REPO, 'spike', 'out', 'mcp_binder.wptsession.json')

const checks = []
const check = (name, ok, detail = '') => checks.push([name, !!ok, detail])

function engine(command) {
  return new Promise((resolve, reject) => {
    const c = spawn(PY, ['-m', 'workpaper_engine.cli'], {
      cwd: ENGINE,
      env: { ...process.env, PYTHONPATH: ENGINE }
    })
    let out = ''
    c.stdout.on('data', (d) => (out += d))
    c.on('error', reject)
    c.on('close', () => {
      try {
        resolve(JSON.parse(out.trim()))
      } catch {
        reject(new Error('engine gave no JSON'))
      }
    })
    c.stdin.end(JSON.stringify(command))
  })
}

const a = path.join(FIXTURES, 'fixture_a.pdf')
const b = path.join(FIXTURES, 'fixture_b.pdf')
if (!existsSync(a) || !existsSync(b)) {
  console.error('fixtures missing — run: engine/.venv/bin/python spike/run_spike.py')
  process.exit(1)
}
if (!existsSync(SERVER)) {
  console.error(`server bundle missing: ${SERVER} — run: npm run build:mcp`)
  process.exit(1)
}
rmSync(OUT_PDF, { force: true })
rmSync(OUT_SESSION, { force: true })

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [SERVER],
  env: { ...process.env, WPT_MCP_ROOTS: path.join(REPO, 'spike') }
})
const client = new Client({ name: 'wpt-mcp-check', version: '1.0.0' })
await client.connect(transport)

/** Call a tool and return its text, asserting it did not error. */
async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args })
  const body = (res.content ?? []).map((c) => c.text ?? '').join('\n')
  return { text: body, isError: !!res.isError }
}

const { tools } = await client.listTools()
const names = tools.map((t) => t.name).sort()
check('server advertises its tools', tools.length >= 15, `${tools.length}: ${names.join(', ')}`)
check(
  'the tools an agent needs to build a binder are all present',
  [
    'binder_add_pdfs',
    'binder_add_tape',
    'binder_export',
    'binder_place_mark',
    'binder_save',
    'binder_status'
  ].every((n) => names.includes(n)),
  names.join(', ')
)
check(
  'every tool documents itself for the agent',
  tools.every((t) => (t.description ?? '').length > 30),
  tools.filter((t) => (t.description ?? '').length <= 30).map((t) => t.name).join(',')
)

const probed = await call('probe_pdf', { path: b })
check(
  'probe_pdf reports pages and the outline without importing',
  probed.text.includes('3 page(s)') && probed.text.includes('Schedule X'),
  probed.text.slice(0, 160)
)

await call('binder_new')
const added = await call('binder_add_pdfs', { paths: [a, b] })
check(
  'binder_add_pdfs imports both files',
  added.text.includes('Added 2 file(s)') && added.text.includes('6 page(s)'),
  added.text.split('\n')[0]
)

const status = await call('binder_status')
const pageIds = [...status.text.matchAll(/\bpg_\d+\b/g)].map((m) => m[0])
check(
  'binder_status exposes a permanent id for every page',
  pageIds.length === 6 && new Set(pageIds).size === 6,
  pageIds.join(',')
)
check(
  'binder_status names the source file and page behind each binder page',
  status.text.includes('fixture_a.pdf') && status.text.includes('fixture_b.pdf'),
  status.text.split('\n')[2] ?? ''
)

// Move fixture_b's three pages to the front — the agent's core reordering move.
const moved = await call('binder_move_pages', { pageIds: pageIds.slice(3), beforeIndex: 0 })
const movedIds = [...moved.text.matchAll(/\bpg_\d+\b/g)].map((m) => m[0])
check(
  'binder_move_pages reorders and reports the new order',
  movedIds.slice(0, 3).join(',') === pageIds.slice(3).join(','),
  movedIds.join(',')
)

check(
  'a bad page id is refused, not silently ignored',
  (await call('binder_move_pages', { pageIds: ['pg_nope'], beforeIndex: 0 })).isError
)
check(
  'placing a mark on a bad page id is refused',
  (await call('binder_place_mark', { pageId: 'pg_nope', kind: 'tick', nx: 0.5, ny: 0.5 })).isError
)
check(
  'a lettered mark with no letters is refused',
  (await call('binder_place_mark', { pageId: pageIds[0], kind: 'text', nx: 0.5, ny: 0.5 })).isError
)

const bm = await call('binder_add_bookmark', { pageId: pageIds[0], title: 'Adjusting entries' })
check('binder_add_bookmark returns the key needed to rename it', /key u:bm_\d+/.test(bm.text), bm.text)
const tree = await call('binder_bookmarks', { pageCounts: true })
check(
  'binder_bookmarks shows the tree as it will export, with keys',
  tree.text.includes('Adjusting entries') && tree.text.includes('Schedule X'),
  tree.text.split('\n').join(' | ').slice(0, 200)
)

await call('binder_set_reviewer', { initials: 'CJB' })
await call('binder_place_mark', { pageId: pageIds[0], kind: 'tick', nx: 0.72, ny: 0.3 })
const stamped = await call('binder_place_mark', {
  pageId: pageIds[0],
  kind: 'text',
  nx: 0.4,
  ny: 0.45,
  text: 'TB',
  note: 'Tied to trial balance'
})
check('binder_place_mark places a lettered stamp', stamped.text.includes('"TB"'), stamped.text)

const tape = await call('binder_add_tape', {
  pageId: pageIds[0],
  nx: 0.68,
  ny: 0.62,
  entries: [1200, 340, -50],
  title: 'Repairs'
})
check(
  'binder_add_tape foots the entries in cents and reports the total',
  tape.text.includes('1,490.00'),
  tape.text
)

const listed = await call('binder_annotations')
const markIds = [...listed.text.matchAll(/\bmk_\d+\b/g)].map((m) => m[0])
const tapeIds = [...listed.text.matchAll(/\btp_\d+\b/g)].map((m) => m[0])
check(
  'binder_annotations exposes the ids, positions and totals of what was placed',
  markIds.length === 2 && tapeIds.length === 1 && listed.text.includes('1,490.00'),
  listed.text.split('\n').join(' | ')
)
check(
  'removing an annotation by an id that does not exist is refused',
  (await call('binder_remove_marks', { markIds: ['mk_nope'] })).isError
)
// Place one to throw away, so the remove path is exercised without disturbing
// the marks the export assertions below depend on.
await call('binder_place_mark', { pageId: pageIds[1], kind: 'cross', nx: 0.2, ny: 0.2 })
const spare = [...(await call('binder_annotations', { pageId: pageIds[1] })).text.matchAll(/\bmk_\d+\b/g)]
const removed = await call('binder_remove_marks', { markIds: [spare[0][0]] })
check(
  'binder_remove_marks deletes exactly the named annotation',
  removed.text.includes('Removed 1') && removed.text.includes('2 mark(s)'),
  removed.text
)

const exported = await call('binder_export', { output: OUT_PDF, pageCounts: true })
check(
  'binder_export writes a validated PDF',
  !exported.isError && exported.text.includes('validation: clean') && existsSync(OUT_PDF),
  exported.text
)

const probe = await engine({ cmd: 'probe', path: OUT_PDF })
check('the exported binder parses', probe.ok === true)
if (probe.ok) {
  check('exported binder has all 6 pages', probe.probe.n_pages === 6, `n=${probe.probe.n_pages}`)
  const annots = probe.probe.pages.flatMap((p) => (p.annotations ?? []).filter((x) => x.wpt_kind))
  check(
    'the marks the agent placed are in the PDF, authored by the reviewer',
    annots.filter((x) => x.wpt_kind !== 'tape').length === 2 &&
      annots.some((x) => x.wpt_data?.text === 'TB' && x.wpt_data?.author === 'CJB'),
    JSON.stringify(annots.map((x) => [x.wpt_kind, x.wpt_data?.text, x.wpt_data?.author]))
  )
  const t = annots.find((x) => x.wpt_kind === 'tape')
  check(
    'the tape is in the PDF with its addends and total',
    !!t &&
      t.wpt_data?.total === 1490 &&
      t.wpt_data?.entries?.map((e) => `${e.op}${e.value}`).join(',') === '+1200,+340,-50',
    JSON.stringify(t?.wpt_data)
  )
  const titles = JSON.stringify(probe.probe.outline)
  check('the agent-added bookmark exported', titles.includes('Adjusting entries'), titles.slice(0, 200))
}

const saved = await call('binder_save', { path: OUT_SESSION })
check('binder_save writes the session for handoff to the app', existsSync(OUT_SESSION), saved.text)
check(
  'binder_save tells the agent the app is where a human reviews it',
  /open it in workpaper binder/i.test(saved.text),
  saved.text.split('\n').pop()
)

await call('binder_new')
const reopened = await call('binder_open', { path: OUT_SESSION })
check(
  'a saved session reopens with its pages, marks and tapes intact',
  reopened.text.includes('6 page(s)') &&
    reopened.text.includes('2 mark(s)') &&
    reopened.text.includes('1 tape(s)'),
  reopened.text.split('\n')[0]
)

// An agent should be able to drop a receipt photo into a binder too.
await call('binder_new')
const imgProbe = await call('probe_pdf', { path: path.join(FIXTURES, 'receipt.jpg') })
check(
  'probe_pdf handles an image as a one-page source',
  imgProbe.text.includes('1 page(s)') && !imgProbe.isError,
  imgProbe.text.split('\n')[0]
)
const imgAdd = await call('binder_add_pdfs', {
  paths: [path.join(FIXTURES, 'receipt.jpg'), path.join(FIXTURES, 'screenshot.png')]
})
check(
  'an agent can add images, one page each',
  imgAdd.text.includes('Added 2 file(s)') && imgAdd.text.includes('2 page(s)'),
  imgAdd.text.split('\n')[0]
)
const imgOut = path.join(REPO, 'spike', 'out', 'mcp_images.pdf')
const imgExport = await call('binder_export', { output: imgOut })
check(
  'a binder of images exports and validates',
  !imgExport.isError && imgExport.text.includes('validation: clean'),
  imgExport.text
)
check(
  'a non-PDF, non-image file is refused with a useful message',
  (await call('binder_add_pdfs', { paths: [path.join(REPO, 'spike', 'README.md')] })).text.includes(
    'not a PDF or supported image'
  )
)
check(
  'MCP refuses file access outside its configured engagement root',
  (await call('probe_pdf', { path: path.join(REPO, 'PROJECT.md') })).text.includes(
    'outside WPT_MCP_ROOTS'
  )
)

// ------------------------------------------------------------ attribution
// Everything this server does is agent work. A reviewer must be able to see
// which changes were automated and take them back out.
await call('binder_new')
await call('binder_add_pdfs', { paths: [a] })
await call('binder_set_reviewer', { initials: 'CJB' })
const attIds = [...(await call('binder_status')).text.matchAll(/\bpg_\d+\b/g)].map((m) => m[0])
await call('binder_place_mark', { pageId: attIds[0], kind: 'tick', nx: 0.3, ny: 0.3 })
await call('binder_add_tape', { pageId: attIds[0], nx: 0.5, ny: 0.6, entries: [10, 20] })
await call('binder_rotate_pages', { pageIds: [attIds[1]], degrees: 90 })

const history = await call('binder_history')
const runId = history.text.match(/\brun_\d+\b/)?.[0]
check('binder_history records what the agent did, in order', !!runId && history.text.includes('Placed tick'), history.text.split('\n').slice(0, 4).join(' | '))
check(
  'binder_history flags what a revert will not be able to undo',
  history.text.includes('[structural — revert cannot undo this]'),
  history.text.split('\n').find((l) => l.includes('Rotated')) ?? ''
)

// Attribution has to survive into the exported PDF, or it is only a claim the
// app makes about itself.
const attPdf = path.join(REPO, 'spike', 'out', 'mcp_attribution.pdf')
rmSync(attPdf, { force: true })
await call('binder_export', { output: attPdf })
const attProbe = await engine({ cmd: 'probe', path: attPdf })
const attAnnots = attProbe.ok
  ? attProbe.probe.pages.flatMap((p) => (p.annotations ?? []).filter((x) => x.wpt_kind))
  : []
check(
  'an agent mark is attributed to the AI in the exported PDF, not to the reviewer',
  attAnnots.length > 0 && attAnnots.every((x) => (x.author ?? '').includes('(AI)')),
  JSON.stringify(attAnnots.map((x) => [x.wpt_kind, x.author]))
)
check(
  "the reviewer's own initials are still recorded underneath",
  // Tapes carry their structured entries in wpt_data rather than an author —
  // the same split the GUI smoke asserts.
  attAnnots.filter((x) => x.wpt_kind !== 'tape').every((x) => x.wpt_data?.author === 'CJB'),
  JSON.stringify(attAnnots.map((x) => [x.wpt_kind, x.wpt_data?.author]))
)

const reverted = await call('binder_revert_run', { run: runId })
check(
  'binder_revert_run removes the agent annotations',
  reverted.text.includes('removed 2 agent annotation(s)'),
  reverted.text.split('\n')[0]
)
check(
  'binder_revert_run says plainly what it could not undo',
  reverted.text.includes('could NOT be undone') && reverted.text.includes('Rotated'),
  reverted.text.split('\n').slice(-3).join(' | ')
)
check(
  'the binder really has no agent annotations left',
  (await call('binder_history')).text.includes('0 mark(s), 0 tape(s)'),
  (await call('binder_history')).text.split('\n')[1]
)
check('reverting an unknown run is refused', (await call('binder_revert_run', { run: 'run_nope' })).isError)

// ---------------------------------------------------------------- reading
// The point of text extraction: an agent can address a figure by name instead
// of being handed coordinates. Fresh binder so page ids are deterministic.
await call('binder_new')
await call('binder_add_pdfs', { paths: [a] })
const textIds = [...(await call('binder_status')).text.matchAll(/\bpg_\d+\b/g)].map((m) => m[0])

const read = await call('binder_read_page', { pageId: textIds[0] })
check(
  'binder_read_page returns the page as readable lines, not run-together text',
  read.text.includes('1 Wages, salaries, tips 84,200.00') &&
    read.text.includes('11 Adjusted gross income 88,750.00'),
  read.text.split('\n').slice(0, 3).join(' | ')
)

const found = await call('binder_find', { query: '84,200.00' })
const hit = found.text.match(/\[page (pg_\d+)\s+nx ([\d.]+)\s+ny ([\d.]+)/)
check('binder_find locates a figure and reports where it is', !!hit, found.text.split('\n')[1] ?? found.text)
check(
  'binder_find reports the page that actually holds the figure',
  hit?.[1] === textIds[0],
  `${hit?.[1]} vs ${textIds[0]}`
)

// The whole ergonomic claim — a hit's coordinates go straight into a mark.
if (hit) {
  const placed = await call('binder_place_mark', {
    pageId: hit[1],
    kind: 'tick',
    nx: Number(hit[2]),
    ny: Number(hit[3])
  })
  check(
    "a find hit's coordinates are directly usable as a mark position",
    !placed.isError && placed.text.includes('Placed tick'),
    placed.text
  )
}

// A page the user straightened after import displays differently from its
// source. If the rotation delta were not applied, this is where a tick would
// silently land on the wrong edge — so assert the exact transform.
const before = hit ? { nx: Number(hit[2]), ny: Number(hit[3]) } : null
const rotated = await call('binder_rotate_pages', { pageIds: [textIds[0]], degrees: 90 })
// Assert the precondition. Without this a failed rotate call reads as a
// coordinate bug, which is exactly how this check first went red.
check('the page actually rotated before coordinates were re-checked', !rotated.isError, rotated.text)
const afterFound = await call('binder_find', { query: '84,200.00', pageId: textIds[0] })
const afterHit = afterFound.text.match(/nx ([\d.]+)\s+ny ([\d.]+)/)
check(
  'text coordinates follow a page rotated inside the binder',
  !!before &&
    !!afterHit &&
    Math.abs(Number(afterHit[1]) - (1 - before.ny)) < 0.002 &&
    Math.abs(Number(afterHit[2]) - before.nx) < 0.002,
  before && afterHit
    ? `(${before.nx},${before.ny}) rotated 90° -> (${afterHit[1]},${afterHit[2]}), expected (${(1 - before.ny).toFixed(5)},${before.nx})`
    : 'no hit'
)

// A photo has no text layer. Saying so plainly is what tells an agent OCR is
// the missing piece rather than that the page is blank.
await call('binder_new')
await call('binder_add_pdfs', { paths: [path.join(FIXTURES, 'receipt.jpg')] })
const scanIds = [...(await call('binder_status')).text.matchAll(/\bpg_\d+\b/g)].map((m) => m[0])
const scan = await call('binder_read_page', { pageId: scanIds[0] })
check(
  'a scan is reported as having no text layer, not as empty or failed',
  scan.text.includes('no text layer') && scan.text.toLowerCase().includes('ocr'),
  scan.text
)

await call('binder_new')
check('exporting an empty binder is refused', (await call('binder_export', { output: OUT_PDF })).isError)

await client.close()

// No root means no filesystem capability at all. This is the default when a
// user merely registers the server without deliberately scoping engagements.
const lockedTransport = new StdioClientTransport({
  command: process.execPath,
  args: [SERVER],
  env: Object.fromEntries(
    Object.entries(process.env).filter(([key, value]) => key !== 'WPT_MCP_ROOTS' && value !== undefined)
  )
})
const lockedClient = new Client({ name: 'wpt-mcp-locked-check', version: '1.0.0' })
await lockedClient.connect(lockedTransport)
const locked = await lockedClient.callTool({ name: 'probe_pdf', arguments: { path: a } })
const lockedText = (locked.content ?? []).map((part) => part.text ?? '').join('\n')
check(
  'MCP filesystem access is disabled by default',
  !!locked.isError && lockedText.includes('WPT_MCP_ROOTS'),
  lockedText
)
await lockedClient.close()

console.log('\n=== MCP server check ===')
let fails = 0
for (const [name, ok, detail] of checks) {
  if (!ok) fails++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? `  — ${detail}` : ''}`)
}
console.log(`\n${checks.length - fails}/${checks.length} checks passed`)
process.exit(fails ? 1 : 0)
