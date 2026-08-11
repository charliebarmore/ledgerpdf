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
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isolatedAgentAccess } from './lib/isolated-agent-access.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const APP = path.resolve(here, '..')
const REPO = path.resolve(APP, '..')
const ENGINE = path.join(REPO, 'engine')
const PY = path.join(ENGINE, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
// The command we tell the reader to run has to be the one their shell accepts.
// A venv is `bin/` on POSIX and `Scripts\` on Windows, so a hardcoded POSIX
// hint sends a Windows reader to a path that does not exist.
const RUN_SPIKE =
  process.platform === 'win32'
    ? 'engine\\.venv\\Scripts\\python spike\\run_spike.py'
    : 'engine/.venv/bin/python spike/run_spike.py'
const FIXTURES = path.join(REPO, 'spike', 'fixtures')
const SERVER = path.join(APP, 'out', 'mcp-server.cjs')
const OUT_PDF = path.join(REPO, 'spike', 'out', 'mcp_binder.pdf')
const OUT_BINDER = path.join(REPO, 'spike', 'out', 'mcp_binder_saved.pdf')
const EXISTING_BINDER = path.join(REPO, 'spike', 'out', 'mcp_existing.pdf')
const IMAGE_OUT = path.join(REPO, 'spike', 'out', 'mcp_images.pdf')
const MAIN_ACCESS = isolatedAgentAccess(
  path.join(REPO, 'spike', 'out', 'agent-profile-mcp'),
  [path.join(REPO, 'spike')]
)

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
  console.error(`fixtures missing — run: ${RUN_SPIKE}`)
  process.exit(1)
}
if (!existsSync(SERVER)) {
  console.error(`server bundle missing: ${SERVER} — run: npm run build:mcp`)
  process.exit(1)
}
rmSync(OUT_PDF, { force: true })
rmSync(OUT_BINDER, { force: true })
rmSync(EXISTING_BINDER, { force: true })
rmSync(IMAGE_OUT, { force: true })

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [SERVER],
  // WPT_NO_LIVE keeps this harness on its own binder. Without it, running the
  // suite while the app is open with live access redirects every check at the
  // app's binder and they fail in ways that look like model bugs.
  env: {
    ...process.env,
    ...MAIN_ACCESS.env,
    WPT_NO_LIVE: '1'
  }
})
const client = new Client({ name: 'wpt-mcp-check', version: '1.0.0' })
await client.connect(transport)

const instructions = client.getInstructions() ?? ''
check(
  'server instructions disclose page-text access and the hosted-model boundary',
  /page text/i.test(instructions) &&
    /user-approved folders/i.test(instructions) &&
    /leaves the machine/i.test(instructions),
  instructions
)

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

// --- binder_draw: the toolbar's drawing tools, reachable by an agent.
{
  const drew = await call('binder_draw', {
    pageId: pageIds[0], kind: 'rect', nx: 0.2, ny: 0.2, nx2: 0.5, ny2: 0.35, color: 'blue'
  })
  check('binder_draw draws a rectangle', !drew.isError && /1 shape\(s\) total/.test(drew.text), drew.text)
  const box = await call('binder_draw', {
    pageId: pageIds[0], kind: 'textbox', nx: 0.6, ny: 0.6, nx2: 0.9, ny2: 0.72,
    text: 'Tied to the payroll register.'
  })
  check('binder_draw draws a text box', !box.isError, box.text)
  check(
    'a text box with no text is refused',
    (await call('binder_draw', {
      pageId: pageIds[0], kind: 'textbox', nx: 0.1, ny: 0.8, nx2: 0.4, ny2: 0.9
    })).isError
  )
  // A zero-area box has no renderable appearance — the viewer's BBox->Rect fit
  // divides by its height. Refused, not silently nudged to a minimum.
  check(
    'a shape with no area is refused rather than nudged',
    (await call('binder_draw', {
      pageId: pageIds[0], kind: 'rect', nx: 0.3, ny: 0.3, nx2: 0.3, ny2: 0.6
    })).isError
  )
  check(
    'a line may share an axis, because two endpoints are not a box',
    !(await call('binder_draw', {
      pageId: pageIds[0], kind: 'line', nx: 0.3, ny: 0.9, nx2: 0.7, ny2: 0.9
    })).isError
  )
  check(
    'drawing on a bad page id is refused',
    (await call('binder_draw', {
      pageId: 'pg_nope', kind: 'ellipse', nx: 0.1, ny: 0.1, nx2: 0.2, ny2: 0.2
    })).isError
  )
}

const bm = await call('binder_add_bookmark', { pageId: pageIds[0], title: 'Adjusting entries' })
check('binder_add_bookmark returns the key needed to rename it', /key u:bm_\d+/.test(bm.text), bm.text)
const tree = await call('binder_bookmarks', { pageCounts: true })
check(
  'binder_bookmarks shows the tree as it will export, with keys',
  tree.text.includes('Adjusting entries') && tree.text.includes('Schedule X'),
  tree.text.split('\n').join(' | ').slice(0, 200)
)

await call('binder_set_reviewer', { initials: 'ABC' })
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
const refusedExportOverwrite = await call('binder_export', {
  output: OUT_PDF,
  pageCounts: true
})
check(
  'binder_export refuses to overwrite an existing PDF',
  refusedExportOverwrite.isError && /Refusing to overwrite/.test(refusedExportOverwrite.text),
  refusedExportOverwrite.text.split('\n')[0]
)

const probe = await engine({ cmd: 'probe', path: OUT_PDF })
check('the exported binder parses', probe.ok === true)
if (probe.ok) {
  check('exported binder has all 6 pages', probe.probe.n_pages === 6, `n=${probe.probe.n_pages}`)
  const annots = probe.probe.pages.flatMap((p) => (p.annotations ?? []).filter((x) => x.wpt_kind))
  check(
    'the marks the agent placed are in the PDF, authored by the reviewer',
    // Names the kinds it means. This used to count "everything that is not a
    // tape" and expect 2, which is a subtraction that breaks every time a new
    // annotation kind lands — binder_draw's shapes broke it exactly that way.
    annots.filter((x) => ['tick', 'cross', 'text', 'note'].includes(x.wpt_kind)).length === 2 &&
      annots.some((x) => x.wpt_data?.text === 'TB' && x.wpt_data?.author === 'ABC'),
    JSON.stringify(annots.map((x) => [x.wpt_kind, x.wpt_data?.text, x.wpt_data?.author]))
  )
  const drawn = annots.filter((x) => ['rect', 'textbox', 'line'].includes(x.wpt_kind))
  check(
    'the shapes the agent drew reach the exported PDF',
    drawn.length === 3 &&
      drawn.some((x) => x.wpt_kind === 'textbox' && /payroll register/.test(x.wpt_data?.text ?? '')),
    JSON.stringify(drawn.map((x) => [x.wpt_kind, x.wpt_data?.color]))
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

// One Save, one file. An agent and a person now produce the same artifact: a
// binder PDF with the editable session inside it, not a .wptsession.json a
// preparer would have no idea what to do with.
const saved = await call('binder_save', { path: OUT_BINDER })
check('binder_save writes a binder PDF, not a session file', existsSync(OUT_BINDER), saved.text)
check(
  'the saved binder says it can be reopened by double-clicking',
  /double-click to reopen/i.test(saved.text),
  saved.text.split('\n').pop()
)
check(
  'saving a binder to anything but a .pdf is refused',
  (await call('binder_save', { path: path.join(REPO, 'spike', 'out', 'nope.wptsession.json') })).isError
)

writeFileSync(EXISTING_BINDER, 'keep this file')
const refusedOverwrite = await call('binder_save', { path: EXISTING_BINDER })
check(
  'binder_save refuses to overwrite an unrelated existing file',
  refusedOverwrite.isError && readFileSync(EXISTING_BINDER, 'utf8') === 'keep this file',
  refusedOverwrite.text.split('\n')[0]
)

// A second standalone agent cannot open the binder while this process owns it.
const secondTransport = new StdioClientTransport({
  command: process.execPath,
  args: [SERVER],
  env: {
    ...process.env,
    ...MAIN_ACCESS.env,
    WPT_NO_LIVE: '1'
  }
})
const secondClient = new Client({ name: 'wpt-mcp-lock-check', version: '1.0.0' })
await secondClient.connect(secondTransport)
const secondCall = async (name, args = {}) => {
  const res = await secondClient.callTool({ name, arguments: args })
  return {
    text: (res.content ?? []).map((c) => c.text ?? '').join('\n'),
    isError: !!res.isError
  }
}
const lockedOpen = await secondCall('binder_open', { path: OUT_BINDER })
check(
  'a second standalone agent cannot open a binder already in use',
  lockedOpen.isError && /already open/i.test(lockedOpen.text),
  lockedOpen.text.split('\n')[0]
)

await call('binder_new')
const afterRelease = await secondCall('binder_open', { path: OUT_BINDER })
check(
  'closing the first session releases the binder for another agent',
  !afterRelease.isError && /Opened/.test(afterRelease.text),
  afterRelease.text.split('\n')[0]
)
await secondCall('binder_new')
await secondClient.close()
const reopened = await call('binder_open', { path: OUT_BINDER })
check(
  'a saved binder reopens with its pages, marks and tapes intact',
  reopened.text.includes('6 page(s)') &&
    reopened.text.includes('2 mark(s)') &&
    reopened.text.includes('1 tape(s)'),
  reopened.text.split('\n')[0]
)
// The point of the single-file model: the binder carries its own pages, so the
// sources it was built from are provenance rather than a dependency.
check(
  'the reopened binder points at itself, not at the original sources',
  // Two sources went in; one comes back — the binder's own pages. That is what
  // makes a saved binder portable: the originals are provenance, not a
  // dependency, so it still opens after they move.
  reopened.text.includes('1 source(s)') && reopened.text.includes('6 page(s)'),
  reopened.text.split('\n')[0]
)
check(
  'an ordinary PDF with no session is refused as a binder, with what to do instead',
  (await call('binder_open', { path: a })).text.includes('binder_add_pdfs'),
  (await call('binder_open', { path: a })).text.slice(0, 120)
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
const imgExport = await call('binder_export', { output: IMAGE_OUT })
check(
  'a binder of images exports and validates',
  !imgExport.isError && imgExport.text.includes('validation: clean'),
  imgExport.text
)
check(
  'a file type the binder cannot hold is refused with a useful message',
  // A .py, not a .md: markdown is a supported source now, and this check
  // caught that the moment it changed.
  (
    await call('binder_add_pdfs', { paths: [path.join(REPO, 'spike', 'make_fixtures.py')] })
  ).text.includes('not a supported source')
)
check(
  'MCP refuses file access outside its configured engagement root',
  // README exists in both the private engineering tree and the sanitized
  // public tree; keep this fixture anchored to a file every release includes.
  (await call('probe_pdf', { path: path.join(REPO, 'README.md') })).text.includes(
    'outside the approved folders'
  )
)

// ----------------------------------------------------------------- tie-out
// The agent decides WHAT should tie; the tool does the arithmetic and leaves
// the evidence. A model doing money maths is exactly where it should not be
// trusted, and a verdict in a chat log is not support for anything.
{
  await call('binder_new')
  await call('binder_add_pdfs', { paths: [a, b] })
  await call('binder_set_reviewer', { initials: 'ABC' })
  const ids = [...(await call('binder_status')).text.matchAll(/\bpg_\d+\b/g)].map((m) => m[0])

  const tied = await call('binder_tie', {
    label: 'Wages — 1040 to W-2',
    a: { pageId: ids[0], amount: '84,200.00', nx: 0.75, ny: 0.13, what: '1040 line 1' },
    b: { pageId: ids[3], amount: '84,200.00', nx: 0.5, ny: 0.3, what: 'W-2 box 1' }
  })
  check('an agreeing figure ties', tied.text.startsWith('TIES'), tied.text.split('\n')[0])
  const afterTie = await call('binder_annotations')
  check(
    'both sides are ticked and cross-referenced to each other',
    (afterTie.text.match(/tick/g) ?? []).length === 2 && afterTie.text.includes('ties'),
    afterTie.text.split('\n').filter((l) => l.includes('tick')).join(' | ').slice(0, 140)
  )
  // The reference must NOT carry a baked page number. It used to read
  // "ties to p.4", resolved when the tie was made and wrong after any reorder —
  // pointing a reviewer confidently at the wrong page, on evidence.
  check(
    'a tie reference carries no frozen page number',
    !/ties to p\.\d/.test(afterTie.text),
    afterTie.text.split('\n').find((l) => l.includes('ties')) ?? ''
  )
  check(
    'the tie is linked both ways, not just noted',
    tied.text.includes('linked both ways'),
    tied.text.split('\n').pop() ?? ''
  )

  const off = await call('binder_tie', {
    label: 'Interest',
    // (1,230.00) is the accounting convention for a negative. Reading it as
    // positive would make this "agree" by 2,380.00.
    a: { pageId: ids[0], amount: '1,150.00', nx: 0.75, ny: 0.19 },
    b: { pageId: ids[3], amount: '(1,230.00)', nx: 0.5, ny: 0.4 }
  })
  check(
    'a difference is caught, with the accounting negative read correctly',
    off.text.startsWith('DOES NOT TIE') && off.text.includes('2,380.00'),
    off.text.split('\n').slice(0, 4).join(' | ')
  )
  check(
    'the tool says how it read a figure a person might read differently',
    off.text.includes('read as a negative'),
    off.text.split('\n').slice(-1)[0]
  )
  const queueT = await call('binder_review_queue')
  check(
    'both sides of a broken tie are flagged and noted',
    (queueT.text.match(/DOES NOT TIE/g) ?? []).length === 2,
    queueT.text.split('\n').slice(0, 3).join(' | ')
  )

  const foots = await call('binder_foot', {
    pageId: ids[0],
    label: 'Total income',
    amounts: ['84,200.00', '1,150.00', '3,400.00'],
    expectedTotal: '88,750.00',
    nx: 0.4,
    ny: 0.55
  })
  check('a column that adds up foots', foots.text.startsWith('FOOTS'), foots.text.split('\n')[0])
  const withTape = await call('binder_annotations')
  check(
    'the tape left behind shows the addends, so the sum is checkable',
    withTape.text.includes('88,750.00') && (withTape.text.match(/tp_\d+/g) ?? []).length === 1,
    withTape.text.split('\n').find((l) => l.includes('tp_')) ?? ''
  )

  const bad = await call('binder_foot', {
    pageId: ids[1],
    label: 'Deductions',
    amounts: ['14,600.00', '1,000.00'],
    expectedTotal: '15,000.00',
    nx: 0.4,
    ny: 0.55
  })
  check(
    'a column that does not add up is caught, with the difference',
    bad.text.startsWith('DOES NOT FOOT') && bad.text.includes('600.00'),
    bad.text.split('\n').slice(0, 4).join(' | ')
  )

  check(
    'a figure the tool cannot read is refused, never guessed',
    (
      await call('binder_tie', {
        label: 'x',
        a: { pageId: ids[0], amount: 'about 84k', nx: 0.5, ny: 0.5 },
        b: { pageId: ids[1], amount: '84,200.00', nx: 0.5, ny: 0.5 }
      })
    ).isError
  )
  const within = await call('binder_tie', {
    label: 'Rounding',
    a: { pageId: ids[0], amount: '1,000.00', nx: 0.3, ny: 0.3 },
    b: { pageId: ids[1], amount: '999.99', nx: 0.3, ny: 0.3 },
    toleranceCents: 1
  })
  check('a tolerance the reviewer sets is respected', within.text.startsWith('TIES'), within.text.split('\n')[0])
}

// ------------------------------------------------------------ folder intake
// "Point me at the engagement folder" is step one of the real workflow, and a
// folder full of client documents is full of traps.
{
  const ENG = path.join(REPO, 'spike', 'out', 'engagement')
  rmSync(ENG, { recursive: true, force: true })
  mkdirSync(path.join(ENG, '1 - Income'), { recursive: true })
  mkdirSync(path.join(ENG, '2 - Deductions'), { recursive: true })
  mkdirSync(path.join(ENG, '10 - Notes'), { recursive: true })
  copyFileSync(a, path.join(ENG, '1 - Income', 'W-2.pdf'))
  copyFileSync(path.join(FIXTURES, 'trial_balance.xlsx'), path.join(ENG, '1 - Income', '9 - interest.xlsx'))
  copyFileSync(path.join(FIXTURES, 'trial_balance.xlsx'), path.join(ENG, '1 - Income', '10 - dividends.xlsx'))
  copyFileSync(path.join(FIXTURES, 'receipt.jpg'), path.join(ENG, '2 - Deductions', 'receipt.jpg'))
  copyFileSync(path.join(FIXTURES, 'review_memo.md'), path.join(ENG, '10 - Notes', 'memo.md'))
  // The traps a real client folder has.
  copyFileSync(path.join(FIXTURES, 'trial_balance.xlsx'), path.join(ENG, '1 - Income', '~$open-workbook.xlsx'))
  writeFileSync(path.join(ENG, '2 - Deductions', '.DS_Store'), 'x')
  writeFileSync(path.join(ENG, 'empty.pdf'), '')
  writeFileSync(path.join(ENG, 'notes.py'), 'print(1)')
  const folderAccess = isolatedAgentAccess(
    path.join(REPO, 'spike', 'out', 'agent-profile-folder'),
    [ENG]
  )

  const folderClient = new Client({ name: 'wpt-folder-check', version: '1.0.0' })
  await folderClient.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      env: { ...process.env, ...folderAccess.env, WPT_NO_LIVE: '1' }
    })
  )
  const fcall = async (name, args = {}) => {
    const r = await folderClient.callTool({ name, arguments: args })
    return { text: (r.content ?? []).map((c) => c.text ?? '').join('\n'), isError: !!r.isError }
  }
  await fcall('binder_new')

  const dry = await fcall('binder_add_folder', { path: ENG, dryRun: true })
  // Entries inside a subfolder are the ones that carry a separator — and on
  // Windows `path.relative` gives backslashes, so matching only '/' selected
  // nothing there and both ordering checks below failed against an empty list.
  // The tool is right to print native separators; the check has to read them.
  const order = dry.text
    .split('\n')
    .filter((l) => l.startsWith('  ') && /[\\/]/.test(l))
    .map((l) => l.trim().replace(/\\/g, '/'))
  check(
    'a dry run lists what it would take, without touching the binder',
    dry.text.includes('would be imported') &&
      (await fcall('binder_status')).text.includes('Empty binder'),
    dry.text.split('\n')[0]
  )
  check(
    'files are ordered the way a person files them, not lexically',
    order[0]?.includes('9 - interest') && order[1]?.includes('10 - dividends'),
    order.join(' | ')
  )
  check(
    'subfolders run 1, 2, 10 — not 1, 10, 2',
    order.findIndex((l) => l.startsWith('2 - ')) < order.findIndex((l) => l.startsWith('10 - ')),
    order.join(' | ')
  )
  check(
    'an Excel lock file is called out, because that workbook is open right now',
    dry.text.includes('open in Excel and may have unsaved changes'),
    dry.text.split('Skipped:')[1]?.trim().split('\n')[0]
  )
  check(
    'every skip carries a reason',
    dry.text.includes('empty.pdf — empty file') &&
      dry.text.includes('notes.py — not a PDF'),
    dry.text.split('Skipped:')[1]?.trim()
  )
  check('OS noise is not reported as a skip', !dry.text.includes('.DS_Store'), dry.text)

  const done = await fcall('binder_add_folder', { path: ENG })
  check(
    'the folder imports and reports its subfolders for bookmarking',
    done.text.includes('Imported 5 of 5') && done.text.includes('1 - Income/'),
    done.text.split('\n')[0]
  )
  const invF = await fcall('binder_inventory')
  check(
    'the inventory accounts for every file that came in',
    ['W-2.pdf', '9 - interest.xlsx', '10 - dividends.xlsx', 'receipt.jpg', 'memo.md'].every((n) =>
      invF.text.includes(n)
    ),
    invF.text.split('\n')[0]
  )
  await folderClient.close()
}

// ------------------------------------------------- the binder's own account
// A reviewer who did not do the work should not have to take the worker's word
// for what the work was, so every figure in the summary is read from the binder.
{
  const ENG = path.join(REPO, 'spike', 'out', 'cover')
  rmSync(ENG, { recursive: true, force: true })
  mkdirSync(ENG, { recursive: true })

  await call('binder_new')
  await call('binder_add_pdfs', { paths: [a, path.join(FIXTURES, 'trial_balance.xlsx')] })
  await call('binder_set_reviewer', { initials: 'ABC' })
  const ids = [...(await call('binder_status')).text.matchAll(/\bpg_\d+\b/g)].map((m) => m[0])
  await call('binder_place_mark', { pageId: ids[0], kind: 'tick', nx: 0.75, ny: 0.13 })
  await call('binder_add_tape', { pageId: ids[0], nx: 0.5, ny: 0.6, entries: [10, 20], title: 'Income' })
  await call('binder_add_note', { pageId: ids[3], nx: 0.5, ny: 0.3, flag: true, note: 'Confirm the renewal.' })

  const brief = await call('binder_summary', { narrative: 'Assembled from the engagement folder.' })
  check(
    'the summary carries the narrative AND facts read from the binder',
    brief.text.includes('Assembled from the engagement folder.') &&
      brief.text.includes('trial_balance.xlsx') &&
      brief.text.includes('1 review note(s)'),
    brief.text.split('\n').slice(0, 3).join(' | ')
  )
  check(
    'the summary says how much of the work was the agent\'s',
    /\d+ of these were placed by an agent/.test(brief.text),
    brief.text.split('\n').find((l) => l.includes('placed by an agent')) ?? ''
  )
  check(
    'the summary lists what is still outstanding, with the note',
    brief.text.includes('Still needs you') && brief.text.includes('Confirm the renewal.'),
    brief.text.split('Still needs you')[1]?.split('##')[0]?.trim().slice(0, 80)
  )
  check(
    'the summary replays what the agent did, in order',
    brief.text.includes('What the agent did') && brief.text.includes('Placed tick'),
    brief.text.split('What the agent did')[1]?.trim().split('\n')[0]
  )

  const coverPath = path.join(ENG, 'summary.md')
  const cover = await call('binder_add_cover', { path: coverPath, narrative: 'Assembled.' })
  check('the cover lands as page 1', !cover.isError && cover.text.includes('page 1'), cover.text.split('\n')[0])
  check('the cover is a real file the binder points at', existsSync(coverPath))

  const after = await call('binder_status')
  const order = [...after.text.matchAll(/\bpg_\d+\b/g)].map((m) => m[0])
  check(
    'the cover sits ahead of the evidence',
    after.text.split('\n').find((l) => l.includes(order[0]))?.includes('summary.md') === true,
    after.text.split('\n').slice(2, 4).join(' | ')
  )

  // Page numbers inside the cover must count the cover itself, or every
  // reference a reviewer follows is off by its length.
  const written = readFileSync(coverPath, 'utf8')
  check(
    'page references count the cover, so they match the delivered binder',
    written.includes('plus this') && /- \*\*p\.(6|7)\*\*/.test(written),
    written.split('\n').filter((l) => l.startsWith('- **p.')).join(' | ')
  )
  check(
    'markdown blocks stay separated, so the tables render as tables',
    written.includes('\n\n| Page | Tape'),
    written.split('| Page | Tape')[0]?.slice(-30)
  )

  // The live inventory tracks pages by id, so it survives a reorder. The
  // PRINTED cover cannot — it is ink — so it has to say when it has gone stale
  // rather than send a reviewer to the wrong page.
  const inv = await call('binder_inventory')
  check(
    'the inventory says where each source ended up',
    inv.text.includes('trial_balance.xlsx') && /at p\.\d/.test(inv.text),
    inv.text.split('\n').slice(2, 5).join(' | ')
  )
  const moved2 = [...(await call('binder_status')).text.matchAll(/\bpg_\d+\b/g)].map((m) => m[0])
  await call('binder_move_pages', { pageIds: [moved2[moved2.length - 1]], beforeIndex: 0 })
  const inv2 = await call('binder_inventory')
  check(
    'the inventory follows the pages when they move',
    inv2.text !== inv.text && /at p\.\d/.test(inv2.text),
    inv2.text.split('\n').slice(2, 5).join(' | ')
  )
  check(
    'a printed cover admits when it has gone stale',
    (await call('binder_status')).text.includes('OUT OF DATE'),
    (await call('binder_status')).text.split('\n').slice(0, 3).join(' | ')
  )
  await call('binder_add_cover', { path: coverPath })
  check(
    'refreshing the cover clears the warning without retyping the reasoning',
    !(await call('binder_status')).text.includes('OUT OF DATE') &&
      readFileSync(coverPath, 'utf8').includes('Assembled.'),
    (await call('binder_status')).text.split('\n')[1]
  )

  const before = order.length
  await call('binder_add_cover', { path: coverPath, narrative: 'Assembled again.' })
  const again = [...(await call('binder_status')).text.matchAll(/\bpg_\d+\b/g)].map((m) => m[0])
  check(
    're-running replaces the cover rather than stacking another',
    again.length === before,
    `${before} -> ${again.length}`
  )
}

// ------------------------------------------------------- notes and flagging
// An agent that finds a problem needs somewhere to put it that a human will
// see. Otherwise the finding dies in a chat log.
{
  await call('binder_new')
  await call('binder_add_pdfs', { paths: [a] })
  await call('binder_set_reviewer', { initials: 'ABC' })
  const ids = [...(await call('binder_status')).text.matchAll(/\bpg_\d+\b/g)].map((m) => m[0])

  check(
    'an empty note is refused — it tells a reviewer nothing',
    (await call('binder_add_note', { pageId: ids[0], note: '  ', nx: 0.5, ny: 0.5 })).isError
  )
  const noted = await call('binder_add_note', {
    pageId: ids[0],
    nx: 0.8,
    ny: 0.13,
    flag: true,
    note: 'Wages do not agree to the W-2 summary — difference 80.00.'
  })
  check('a note can be left on a page and flag it', !noted.isError && noted.text.includes('open item'), noted.text)

  check(
    'an unknown status is refused with the ones this binder has',
    (await call('binder_set_status', { pageId: ids[1], status: 'nope' })).text.includes('reviewed, open, na')
  )
  await call('binder_set_status', { pageId: ids[1], status: 'reviewed' })

  const queue = await call('binder_review_queue')
  check(
    'the review queue lists the flagged page with its note',
    queue.text.includes('Open item') && queue.text.includes('do not agree to the W-2'),
    queue.text.split('\n').slice(0, 4).join(' | ')
  )
  check(
    'the queue attributes the note to the AI',
    queue.text.includes('(AI)'),
    queue.text.split('\n').find((l) => l.includes('note:')) ?? ''
  )
  check(
    'a page marked reviewed does not clutter the queue',
    !queue.text.includes(ids[1]),
    queue.text
  )

  // A note is only useful if a reviewer meets it where they already look.
  const notePdf = path.join(REPO, 'spike', 'out', 'mcp_noted.pdf')
  rmSync(notePdf, { force: true })
  await call('binder_export', { output: notePdf })
  const probed2 = await engine({ cmd: 'probe', path: notePdf })
  const annots = probed2.ok
    ? probed2.probe.pages.flatMap((p) => p.annotations ?? []).filter((x) => x.wpt_kind === 'note')
    : []
  check(
    'a note exports as a PDF Text annotation, which is what Acrobat shows in its Comments pane',
    annots.length === 1 && annots[0].subtype === '/Text',
    JSON.stringify(annots.map((x) => x.subtype))
  )
  check(
    'the reviewer reads the whole comment, not a truncated one',
    (annots[0]?.wpt_data?.note ?? '').includes('difference 80.00'),
    (annots[0]?.wpt_data?.note ?? '').slice(0, 60)
  )
  check(
    'the note is attributed to the AI in the exported PDF',
    (annots[0]?.author ?? '').includes('(AI)'),
    annots[0]?.author
  )
}

// ---------------------------------------------------------------------- OCR
// A scan was the one thing the tie-out layer could not see at all.
{
  await call('binder_new')
  const scan = path.join(FIXTURES, 'scan_a.pdf')
  if (!existsSync(scan)) {
    check('scan_a.pdf present', false, 'run spike/make_fixtures.py')
  } else {
    await call('binder_add_pdfs', { paths: [scan] })
    const scanId = [...(await call('binder_status')).text.matchAll(/\bpg_\d+\b/g)].map((m) => m[0])[0]

    const plain = await call('binder_read_page', { pageId: scanId })
    check(
      'a scan says it has no text layer and how to read it',
      plain.text.includes('no text layer') && plain.text.includes('ocr:true'),
      plain.text
    )

    const read = await call('binder_read_page', { pageId: scanId, ocr: true })
    if (read.text.includes('OCR is unavailable')) {
      // Skipped, not failed: OCR is an optional backend and CI has none.
      console.log('[SKIP] OCR agent checks - no backend on this machine')
    } else {
      check(
        'OCR reads the figures off a page that has no text at all',
        read.text.includes('84,200.00') && read.text.includes('88,750.00'),
        read.text.split('\n').slice(0, 3).join(' | ')
      )
      check(
        'the agent is told plainly that this is a machine reading',
        read.text.includes('Read by OCR') && read.text.includes("not the document's own text"),
        read.text.split('\n').slice(-1)[0]
      )
      const hits = await call('binder_find', { query: '88,750.00', ocr: true })
      const hit = hits.text.match(/\[page (pg_\d+)\s+nx ([\d.]+)\s+ny ([\d.]+)\s+beside nx ([\d.]+)\]/)
      check('binder_find locates a figure on a scan', !!hit, hits.text.split('\n')[1] ?? hits.text)
      check(
        'an OCR hit carries its confidence, so a guess is never mistaken for a reading',
        /OCR \d/.test(hits.text),
        hits.text.split('\n')[1] ?? ''
      )
      if (hit) {
        const placed = await call('binder_place_mark', {
          pageId: hit[1],
          kind: 'tick',
          nx: Number(hit[4]),
          ny: Number(hit[3])
        })
        check(
          'a figure read off a scan can be ticked where it sits',
          !placed.isError && placed.text.includes('Placed tick'),
          placed.text
        )
      }
    }
  }
}

// ------------------------------------------------------------ attribution
// Everything this server does is agent work. A reviewer must be able to see
// which changes were automated and take them back out.
await call('binder_new')
await call('binder_add_pdfs', { paths: [a] })
await call('binder_set_reviewer', { initials: 'ABC' })
const attIds = [...(await call('binder_status')).text.matchAll(/\bpg_\d+\b/g)].map((m) => m[0])
await call('binder_place_mark', { pageId: attIds[0], kind: 'tick', nx: 0.3, ny: 0.3 })
await call('binder_add_tape', { pageId: attIds[0], nx: 0.5, ny: 0.6, entries: [10, 20] })
// A drawn shape belongs in this run too. addShape did not stamp provenance
// while only the toolbar could reach it — harmless when every shape came from
// a person, and a hole the moment binder_draw existed: the shape would have
// been filed as the reviewer's own work and survived the revert below.
await call('binder_draw', { pageId: attIds[0], kind: 'rect', nx: 0.1, ny: 0.7, nx2: 0.4, ny2: 0.85 })
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
  attAnnots.filter((x) => x.wpt_kind !== 'tape').every((x) => x.wpt_data?.author === 'ABC'),
  JSON.stringify(attAnnots.map((x) => [x.wpt_kind, x.wpt_data?.author]))
)

const reverted = await call('binder_revert_run', { run: runId })
check(
  'binder_revert_run removes the agent annotations',
  reverted.text.includes('removed 3 agent annotation(s)'),
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

// ------------------------------------------------- connectors and the legend
//
// The second front door onto the same model. An MCP tool that has never once
// been CALLED is exactly how the legend page shipped broken earlier today, so
// these drive both new tools rather than trusting that they registered.
await call('binder_new')
await call('binder_add_pdfs', { paths: [a, b] })
const cxStatus = await call('binder_status')
const cxPages = [...cxStatus.text.matchAll(/\b(pg_\d+)\b/g)].map((m) => m[1])
const first = await call('binder_place_connector', { pageId: cxPages[0], nx: 0.3, ny: 0.25 })
check(
  'binder_place_connector hands out a label and says the pair is still open',
  !first.isError && /connector 1/i.test(first.text) && /place 1 again/i.test(first.text),
  first.text.slice(0, 110)
)
const second = await call('binder_place_connector', {
  pageId: cxPages[cxPages.length - 1],
  nx: 0.6,
  ny: 0.5,
  label: '1'
})
check(
  'the second end closes the pair and reports it as clickable',
  !second.isError && /tied it to its other end/i.test(second.text),
  second.text.slice(0, 110)
)
// A third placement must be refused, not silently re-pointed. A workpaper
// reference that quietly changes what it points at is worse than a missing one.
const third = await call('binder_place_connector', { pageId: cxPages[0], nx: 0.8, ny: 0.8, label: '1' })
check(
  'a third use of the same label is refused, and names a free one',
  !!third.isError && /already ties two places/i.test(third.text) && /2 is free/.test(third.text),
  third.text.slice(0, 110)
)
const nextLabel = await call('binder_place_connector', { pageId: cxPages[0], nx: 0.2, ny: 0.7 })
check(
  'the next label skips the closed pair',
  !nextLabel.isError && /connector 2/i.test(nextLabel.text),
  nextLabel.text.slice(0, 80)
)

await call('binder_place_mark', { pageId: cxPages[0], kind: 'text', nx: 0.4, ny: 0.4, text: 'GL' })
const legendBefore = await call('binder_legend')
check(
  'binder_legend names the marks with no meaning rather than inventing one',
  !legendBefore.isError && /no meaning recorded/i.test(legendBefore.text),
  legendBefore.text.split('\n').slice(0, 2).join(' | ').slice(0, 110)
)
const legendSet = await call('binder_legend', { token: 'GL', meaning: 'Agrees to general ledger' })
check(
  'binder_legend records a meaning and reads it back with a count',
  !legendSet.isError &&
    legendSet.text.includes('Agrees to general ledger') &&
    /×1/.test(legendSet.text),
  legendSet.text.split('\n')[0].slice(0, 110)
)
check(
  'a connector is not a legend row — a circled 1 has no meaning to define',
  !/^1\t/m.test(legendSet.text),
  legendSet.text.split('\n').join(' | ').slice(0, 110)
)

await call('binder_new')
check('exporting an empty binder is refused', (await call('binder_export', { output: OUT_PDF })).isError)

await client.close()

// No root means no filesystem capability at all. This is the default when a
// user merely registers the server without deliberately scoping engagements.
const lockedTransport = new StdioClientTransport({
  command: process.execPath,
  args: [SERVER],
  // An isolated blank profile proves default deny without depending on the
  // developer's real approval list.
  env: {
    ...process.env,
    ...isolatedAgentAccess(path.join(REPO, 'spike', 'out', 'agent-profile-locked')).env,
    // Isolated like the main client: attaching to a live app would make this
    // check exercise that app's binder instead of a default-deny server.
    WPT_NO_LIVE: '1',
    // The former production override must stay inert. Before the access-model
    // correction this silently outranked the list visible in LedgerPDF.
    WPT_MCP_ROOTS: path.join(REPO, 'spike'),
    WPT_TEST_MODE: '1',
    WPT_TEST_ROOTS: path.join(REPO, 'spike'),
    WPT_AGENT_ROOTS_FILE: path.join(REPO, 'spike', 'out', 'fake-agent-roots.json')
  }
})
const lockedClient = new Client({ name: 'wpt-mcp-locked-check', version: '1.0.0' })
await lockedClient.connect(lockedTransport)
const locked = await lockedClient.callTool({ name: 'probe_pdf', arguments: { path: a } })
const lockedText = (locked.content ?? []).map((part) => part.text ?? '').join('\n')
check(
  'MCP access is disabled by default and the former env override is ignored',
  !!locked.isError && lockedText.includes('no folder has been approved'),
  lockedText
)
await lockedClient.close()

// Roots from the exact FILE the app writes, with no root override in sight.
//
// This is the path every real user takes: they approve a folder in the app, and
// the agent can read it. The synthetic profile prevents the check from reading
// or changing the developer's real approvals.
const fileAccess = isolatedAgentAccess(
  path.join(REPO, 'spike', 'out', 'agent-profile-file-roots'),
  [path.join(REPO, 'spike')]
)
const ROOTS_FILE = fileAccess.rootsFile
const fileRootsTransport = new StdioClientTransport({
  command: process.execPath,
  args: [SERVER],
  env: {
    ...process.env,
    ...fileAccess.env,
    WPT_NO_LIVE: '1',
  }
})
const fileRootsClient = new Client({ name: 'wpt-mcp-file-roots', version: '1.0.0' })
await fileRootsClient.connect(fileRootsTransport)
const viaFile = await fileRootsClient.callTool({ name: 'probe_pdf', arguments: { path: a } })
const viaFileText = (viaFile.content ?? []).map((part) => part.text ?? '').join('\n')
check(
  'a folder approved in the app grants access with no test override set',
  !viaFile.isError && viaFileText.includes('3'),
  viaFileText.split('\n')[0]
)
// And the containment still holds when the roots came from the file — a wider
// source must not mean a weaker guard.
const viaFileOutside = await fileRootsClient.callTool({
  name: 'probe_pdf',
  arguments: { path: process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/hosts' }
})
const viaFileOutsideText = (viaFileOutside.content ?? []).map((part) => part.text ?? '').join('\n')
check(
  'and a path outside an approved folder is still refused',
  !!viaFileOutside.isError && /outside the approved folders|not a supported/i.test(viaFileOutsideText),
  viaFileOutsideText.split('\n')[0].slice(0, 80)
)
// Approvals take effect on the NEXT request, without restarting the client —
// which is what makes the panel usable. Rewrite the file mid-session and the
// same server must now refuse what it just allowed.
writeFileSync(ROOTS_FILE, JSON.stringify({ roots: [path.join(REPO, 'spike', 'fixtures')] }))
const afterEdit = await fileRootsClient.callTool({
  name: 'probe_pdf',
  arguments: { path: path.join(REPO, 'spike', 'out', 'binder.pdf') }
})
const afterEditText = (afterEdit.content ?? []).map((part) => part.text ?? '').join('\n')
check(
  'narrowing the approved folders applies without restarting the agent',
  !!afterEdit.isError,
  afterEditText.split('\n')[0].slice(0, 90)
)
await fileRootsClient.close()

console.log('\n=== MCP server check ===')
let fails = 0
for (const [name, ok, detail] of checks) {
  if (!ok) fails++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? `  — ${detail}` : ''}`)
}
console.log(`\n${checks.length - fails}/${checks.length} checks passed`)
process.exit(fails ? 1 : 0)
