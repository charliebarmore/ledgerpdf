/**
 * Phase 1 GUI smoke test — drives the real Electron app end to end with no
 * human clicking, then verifies the artifact it produced.
 *
 *   import two fixture PDFs  ->  render  ->  export through IPC + engine
 *   ->  assert page count, nested/retargeted bookmarks, qpdf --check clean
 *   ->  capture a PNG of the window for eyeballing
 *
 * Uses the dev-only WPT_DEV_* seams in src/main/index.ts. Synthetic fixtures
 * only — never client documents.
 *
 *   npm run smoke
 */

import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
const OUT_PDF = path.join(REPO, 'spike', 'out', 'app_smoke_binder.pdf')
const SHOT = path.join(REPO, 'spike', 'out', 'app_smoke_window.png')

const checks = []
const check = (name, ok, detail = '') => checks.push([name, !!ok, detail])

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    c.stdout.on('data', (d) => (out += d))
    c.stderr.on('data', (d) => (err += d))
    c.on('close', (code) => resolve({ code, out, err }))
  })
}

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

const flat = (nodes, depth = 0) =>
  nodes.flatMap((n) => [`${'  '.repeat(depth)}${n.title} -> ${n.dest_page}`, ...flat(n.children ?? [], depth + 1)])

const a = path.join(FIXTURES, 'fixture_a.pdf')
const b = path.join(FIXTURES, 'fixture_b.pdf')
// A receipt photo rides along so the app's own image preview — which draws the
// Letter page itself rather than going through PDF.js — is exercised for real.
const img = path.join(FIXTURES, 'receipt.jpg')
// A workbook rides along because the renderer speaks PDF: a spreadsheet's own
// bytes are a ZIP, and PDF.js drew "Invalid PDF structure" on every page while
// import, text and export all looked fine. Only driving the real window caught
// it, so the real window now covers it.
const book = path.join(FIXTURES, 'trial_balance.xlsx')
if (!existsSync(a) || !existsSync(b) || !existsSync(img) || !existsSync(book)) {
  console.error(`fixtures missing — run: ${RUN_SPIKE}`)
  process.exit(1)
}
rmSync(OUT_PDF, { force: true })
rmSync(SHOT, { force: true })


console.log('launching app…')
const app = await run('npm', ['run', 'dev'], {
  cwd: APP,
  // On Windows `npm` is npm.cmd, and since the CVE-2024-27980 hardening Node
  // refuses to spawn a .cmd without a shell. Scoped to this call on purpose:
  // the PY runs below pass arguments a shell would mangle.
  shell: process.platform === 'win32',
  env: {
    ...process.env,
    WPT_DEV_OPEN: [a, b, img, book].join(path.delimiter),
    WPT_DEV_EXPORT: OUT_PDF,
    WPT_DEV_SHOT: SHOT,
    WPT_DEV_MARKS: '1',
    WPT_DEV_EXIT: '1'
  }
})
check(
  'app ran and exited cleanly',
  app.code === 0,
  `exit=${app.code}${app.err.trim() ? ` stderr=${app.err.trim()}` : ''}${app.out.trim() ? ` stdout=${app.out.trim()}` : ''}`
)
check('window snapshot captured', existsSync(SHOT), SHOT)
check('binder exported', existsSync(OUT_PDF), OUT_PDF)

if (existsSync(OUT_PDF)) {
  const probed = await engine({ cmd: 'probe', path: OUT_PDF })
  check('exported binder parses', probed.ok === true)
  if (probed.ok) {
    check(
      '9 pages from 2 PDFs, an image and a 2-sheet workbook',
      probed.probe.n_pages === 9,
      `n_pages=${probed.probe.n_pages}`
    )
    const last = probed.probe.pages[6]
    check(
      'the image became a landscape Letter page',
      JSON.stringify(last.mediabox) === JSON.stringify([0, 0, 792, 612]),
      JSON.stringify(last.mediabox)
    )
    const got = flat(probed.probe.outline)
    const want = [
      'fixture_a (3 pages) -> 0',
      'fixture_b -> 3',
      '  Schedule X -> 3',
      '    Detail X-1 (2 pages) -> 4',
      '  Schedule Y (2 pages) -> 4',
      'receipt (1 page) -> 6',
      'trial_balance (2 pages) -> 7'
    ]
    check('bookmarks nested + retargeted', JSON.stringify(got) === JSON.stringify(want), got.join(' | '))
  }
  const marks = probed.ok
    ? probed.probe.pages.flatMap((p) => (p.annotations ?? []).filter((a) => a.wpt_kind))
    : []
  check(
    'review marks placed in the app land in the exported PDF',
    marks.length === 5 &&
      marks
        .filter((m) => m.wpt_kind !== 'tape')
        .every((m) => m.has_ap && m.wpt_data?.author === 'RV') &&
      marks.some((m) => m.wpt_data?.text === 'F'),
    JSON.stringify(marks.map((m) => [m.wpt_kind, m.wpt_data?.author, m.wpt_data?.text]))
  )
  check(
    'an agent-placed mark is attributed to the AI in the exported PDF',
    marks.filter((m) => (m.author ?? '').includes('(AI)')).length === 1,
    JSON.stringify(marks.map((m) => [m.wpt_kind, m.author]))
  )
  check(
    'a spreadsheet became real pages with its cells as text',
    probed.ok &&
      probed.probe.pages.length === 9 &&
      JSON.stringify(probed.probe.pages[7].mediabox) === JSON.stringify([0, 0, 792, 612]),
    JSON.stringify(probed.probe.pages[7]?.mediabox)
  )
  check(
    'a user-defined custom stamp exports with its own letters',
    marks.some((m) => m.wpt_kind === 'text' && m.wpt_data?.text === 'TB'),
    JSON.stringify(marks.map((m) => m.wpt_data?.text))
  )
  const tape = marks.find((m) => m.wpt_kind === 'tape')
  check(
    'a tape keyed in the app exports with its addends and total',
    !!tape &&
      tape.has_ap &&
      tape.wpt_data?.entries?.map((e) => `${e.op}${e.value}`).join(',') === '+1200,+340,-50' &&
      tape.wpt_data?.total === 1490,
    JSON.stringify(tape?.wpt_data)
  )

  // The Phase 2 property that actually matters: a mark must export exactly
  // where the UI showed it. Rendered with pdfium (Chrome/Edge's engine).
  const marksScript = path.join(REPO, 'spike', 'check_mark_positions.py')
  const pos = await run(PY, [
    marksScript, OUT_PDF, '0',
    'green', '0.72', '0.30', 'blue', '0.40', '0.45', 'brown', '0.68', '0.55'
  ])
  check(
    'marks and the tape export exactly where they were placed',
    pos.code === 0,
    pos.out.trim().split('\n').join(' | ')
  )
  const stampPos = await run(PY, [marksScript, OUT_PDF, '1', 'blue', '0.55', '0.25'])
  check(
    'the custom stamp lands where it was placed',
    stampPos.code === 0,
    stampPos.out.trim().split('\n').join(' | ')
  )

  const qpdf = await run(PY, ['-c', `import pikepdf,sys; j=pikepdf.Job(['qpdf','--check',${JSON.stringify(OUT_PDF)}]); j.run(); sys.exit(j.exit_code)`])
  check('qpdf --check clean', qpdf.code === 0, `exit=${qpdf.code}`)
}

console.log('\n=== Phase 1 GUI smoke ===')
// ---------------------------------------------------- a dead parent pipe
// Launched from a terminal, stdout and stderr belong to the parent. Close that
// terminal and the next write fails with EPIPE — which, unhandled in the main
// process, is an uncaught exception and a "A JavaScript error occurred" dialog
// over a running app with unsaved work in it. Diagnostics are not worth a crash.
const orphan = spawn('npm', ['run', 'dev'], {
  cwd: APP,
  shell: process.platform === 'win32',
  stdio: ['ignore', 'pipe', 'pipe'],
  // Its own shot path: the earlier checks already asserted on SHOT and this
  // run must not overwrite what they looked at.
  env: {
    ...process.env,
    WPT_DEV_SHOT: path.join(REPO, 'spike', 'out', 'app_orphan_window.png'),
    WPT_DEV_EXIT: '1'
  }
})
// Attach the close listener BEFORE waiting for anything. Attaching it after a
// wait means an app that exits during that wait fires 'close' into a listener
// that does not exist yet, and the await never settles.
const orphanClosed = new Promise((resolve) => orphan.on('close', resolve))
let orphanExited = false
orphanClosed.then(() => (orphanExited = true))

let orphanOut = ''
orphan.stdout.on('data', (d) => (orphanOut += d))
orphan.stderr.on('data', () => {})

// WAIT FOR ELECTRON, do not guess with a timer.
//
// This used to sever the pipe after a flat 2500ms. `npm run dev` needs roughly
// fifteen seconds to reach a window, so 2500ms landed mid-Vite-build: the exit
// code being asserted belonged to the npm/vite chain rather than to the main
// process whose EPIPE guard is the thing under test. Whether that chain minded
// having its reader removed came down to what happened to be writing at the
// time, so the check passed on one runner and failed on the next.
//
// electron-vite prints "starting electron app" once it hands off, so wait for
// that, give main a moment to be writing, and only then take the reader away.
// The fallback timeout keeps a hung build from hanging the suite — and it
// cannot silently weaken the check, because the assertion is still exit 0.
const READY = 'starting electron app'
const upBy = Date.now() + 90_000
while (Date.now() < upBy && !orphanOut.includes(READY) && !orphanExited) {
  await new Promise((r) => setTimeout(r, 200))
}
const sawElectron = orphanOut.includes(READY)
// Take the reader away while Electron is booting and therefore writing. If it
// has already exited there is nothing left to sever, and the check would pass
// without having tested anything — so that case is reported, not counted.
const severedWhileRunning = sawElectron && !orphanExited
if (severedWhileRunning) {
  await new Promise((r) => setTimeout(r, 500))
  orphan.stdout.destroy()
  orphan.stderr.destroy()
}
const orphanCode = await orphanClosed
check(
  'the app survives its parent closing the pipe it logs to',
  orphanCode === 0 && severedWhileRunning,
  severedWhileRunning
    ? `exit=${orphanCode}`
    : `exit=${orphanCode} — pipe was never severed while running, so EPIPE went untested (electron started: ${sawElectron})`
)

let fails = 0
for (const [name, ok, detail] of checks) {
  if (!ok) fails++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? `  — ${detail}` : ''}`)
}
console.log(`\n${checks.length - fails}/${checks.length} checks passed`)
if (!fails) console.log(`window: ${SHOT}`)
process.exit(fails ? 1 : 0)
