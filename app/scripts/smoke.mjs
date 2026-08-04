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
if (!existsSync(a) || !existsSync(b) || !existsSync(img)) {
  console.error('fixtures missing — run: engine/.venv/bin/python spike/run_spike.py')
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
    WPT_DEV_OPEN: [a, b, img].join(path.delimiter),
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
      '7 pages from 2 PDFs and an image',
      probed.probe.n_pages === 7,
      `n_pages=${probed.probe.n_pages}`
    )
    const last = probed.probe.pages[6]
    check(
      'the image became a landscape Letter page at the end of the binder',
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
      'receipt (1 page) -> 6'
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
        .every((m) => m.has_ap && m.wpt_data?.author === 'CJB') &&
      marks.some((m) => m.wpt_data?.text === 'F'),
    JSON.stringify(marks.map((m) => [m.wpt_kind, m.wpt_data?.author, m.wpt_data?.text]))
  )
  check(
    'an agent-placed mark is attributed to the AI in the exported PDF',
    marks.filter((m) => (m.author ?? '').includes('(AI)')).length === 1,
    JSON.stringify(marks.map((m) => [m.wpt_kind, m.author]))
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
let fails = 0
for (const [name, ok, detail] of checks) {
  if (!ok) fails++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? `  — ${detail}` : ''}`)
}
console.log(`\n${checks.length - fails}/${checks.length} checks passed`)
if (!fails) console.log(`window: ${SHOT}`)
process.exit(fails ? 1 : 0)
