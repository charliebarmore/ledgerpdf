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

const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER] })
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
    !!t && t.wpt_data?.total === 1490 && t.wpt_data?.entries?.join(',') === '1200,340,-50',
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
  (await call('binder_add_pdfs', { paths: [path.join(REPO, 'ROADMAP.md')] })).text.includes(
    'not a PDF or supported image'
  )
)

await call('binder_new')
check('exporting an empty binder is refused', (await call('binder_export', { output: OUT_PDF })).isError)

await client.close()

console.log('\n=== MCP server check ===')
let fails = 0
for (const [name, ok, detail] of checks) {
  if (!ok) fails++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? `  — ${detail}` : ''}`)
}
console.log(`\n${checks.length - fails}/${checks.length} checks passed`)
process.exit(fails ? 1 : 0)
