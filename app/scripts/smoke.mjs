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
import { stopApp } from './lib/stop-app.mjs'
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

// EVERY launch below gets its own userData directory, wiped first.
//
// Electron's single-instance lock is a file inside userData. Sharing the real
// one means this suite cannot run while the developer has the app open: the
// launch hands off to the running window, exits 0 having produced nothing, and
// the checks fail with bare paths — which reads as "export is broken" rather
// than "you left the app open". That has now been misdiagnosed four times, and
// twice as a code defect. It also made one run's slow teardown into the next
// run's mystery failure.
//
// Isolation removes the class rather than the instance: these launches cannot
// collide with a developer's app, with each other, or with a previous run's
// leftovers. It is safe for what is asserted here because nothing in this file
// depends on real stored state — seeded marks hardcode their reviewer ('RV' in
// App.tsx, deliberately not anyone's initials), the recents list is never
// asserted, and the placement run already wanted a wiped directory so that "no
// initials stored yet" is a precondition it does not destroy on first run.
const home = (name) => {
  const dir = path.join(REPO, 'spike', 'out', `userdata-${name}`)
  rmSync(dir, { force: true, recursive: true })
  return dir
}

const checks = []
const check = (name, ok, detail = '') => checks.push([name, !!ok, detail])

// Every wait in here is bounded. The app launches below are supposed to exit on
// their own (WPT_DEV_EXIT), and when one does not — a dialog nothing will
// dismiss, a wedged renderer — an unbounded wait on 'close' turns one stuck
// launch into a job timeout that kills the runner and reports nothing at all.
// A bound turns the same stuck launch into a failed check with a name on it,
// and lets every check after it still run. `detached` on POSIX gives the
// teardown a process group to signal; see scripts/lib/stop-app.mjs.
function run(cmd, args, opts = {}) {
  const { timeoutMs = 240_000, ...spawnOpts } = opts
  return new Promise((resolve) => {
    const c = spawn(cmd, args, {
      ...spawnOpts,
      // Renderer exceptions otherwise disappear into Electron and the harness
      // only reports a four-minute timeout. Forward them into the captured log
      // so CI names the failing scripted step and its actual reason.
      env: { ...(spawnOpts.env ?? process.env), ELECTRON_ENABLE_LOGGING: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32'
    })
    let out = ''
    let err = ''
    let timedOut = false
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    c.stdout.on('data', (d) => (out += d))
    c.stderr.on('data', (d) => (err += d))
    const timer = setTimeout(() => {
      timedOut = true
      // Resolve on the teardown, not on 'close': if the tree survives, 'close'
      // is exactly the event that will never arrive.
      //
      // The reason goes into `err` rather than into a field, so that it reaches
      // every check's detail line without any of them having to know this can
      // happen. `exit=null` on its own reads as a mystery; it should say what
      // it was waiting for.
      stopApp(c).then(() =>
        finish({
          code: null,
          out,
          err: `${err}\n[smoke] gave up waiting after ${timeoutMs}ms and killed the process tree`,
          timedOut: true
        })
      )
    }, timeoutMs)
    c.on('close', (code) => {
      clearTimeout(timer)
      // When the timeout tears down the process, close races stopApp's detailed
      // result. Keep the diagnostic instead of reporting only SIGTERM/143.
      if (!timedOut) finish({ code, out, err, timedOut })
    })
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


// Resolved ONCE, because home() wipes the directory as it returns the path.
// Calling it a second time to name the path in an error message would delete the
// evidence while printing instructions for inspecting it.
const SMOKE_HOME = home('smoke')

console.log('launching app…')
const app = await run('npm', ['run', 'dev'], {
  cwd: APP,
  // On Windows `npm` is npm.cmd, and since the CVE-2024-27980 hardening Node
  // refuses to spawn a .cmd without a shell. Scoped to this call on purpose:
  // the PY runs below pass arguments a shell would mangle.
  shell: process.platform === 'win32',
  env: {
    ...process.env,
    WPT_DEV_USERDATA: SMOKE_HOME,
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
// The app SAYS when the lock is why it produced nothing. Do not infer it.
//
// A blocked second launch hands off to the running window and exits 0 having
// produced nothing, so the checks below would fail with bare paths — which reads
// as "export is broken" rather than "something already held the lock". That was
// misdiagnosed three times in two days, twice as a code defect.
//
// This replaces a heuristic that guessed the cause from the SHAPE of the failure
// (no snapshot + exit 0 => "this looks like the lock"). The heuristic was wrong
// in the direction that matters: every launch here already gets its own userData
// (see the note above), so the lock is normally UNCONTENDED, and any other
// reason for a missing window — a slow machine, a renderer that never painted —
// got confidently reported as an app the developer had left open. It misled its
// own author within an hour of being written: a real failure was investigated as
// a lock collision, and quitting an unrelated app appeared to fix it.
//
// So the app writes a marker and exits non-zero, and this matches it literally.
// The marker firing means the lock WAS the cause. Its absence now means the lock
// was NOT the cause, which is the more useful half and the half a guess cannot
// give you.
if (app.err.includes('WPT_SINGLE_INSTANCE_LOCK_HELD')) {
  console.error('\nCANNOT RUN — something already holds the single-instance lock.')
  console.error('The app this launched could not claim it, so it exited without drawing')
  console.error('a window or exporting anything. Nothing was verified.')
  console.error('\nEither another LedgerPDF is running against this userData directory,')
  console.error('or a stale lock outlived a process that died without cleaning up —')
  console.error('which is what `kill -9` leaves behind. Clear it with:')
  console.error(`  rm -f "${SMOKE_HOME}/Singleton"*`)
  process.exit(1)
}

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
  detached: process.platform !== 'win32',
  // Its own shot path: the earlier checks already asserted on SHOT and this
  // run must not overwrite what they looked at.
  env: {
    ...process.env,
    WPT_DEV_USERDATA: home('orphan'),
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
// Bounded, and this one has the sharpest reason of the three: the code above
// deliberately destroys the child's stdio. 'close' needs exit AND closed pipes,
// so an app that wedges here instead of exiting can never produce one — the
// wait would hold the entire job to its timeout on the strength of a test whose
// whole subject is a broken pipe.
const orphanCode = await (async () => {
  let t
  const limit = new Promise((r) => (t = setTimeout(() => r('timed out'), 120_000)))
  const code = await Promise.race([orphanClosed, limit])
  clearTimeout(t)
  if (code === 'timed out') await stopApp(orphan)
  return code
})()
check(
  'the app survives its parent closing the pipe it logs to',
  orphanCode === 0 && severedWhileRunning,
  severedWhileRunning
    ? `exit=${orphanCode}`
    : `exit=${orphanCode} — pipe was never severed while running, so EPIPE went untested (electron started: ${sawElectron})`
)

// ------------------------------------- the placement path, driven for real
//
// `WPT_DEV_MARKS` above calls addMark directly, so until now placeTool — the
// function a preparer's every click goes through — had NO automated coverage.
// It collected three defects in two days: a blank author, a mark that moved
// when a stray click landed behind the initials prompt, and a keyboard race.
// A person clicking found all three.
//
// The script below replays the exact sequence that produced the worst of them:
// click beside a figure with no initials set, let a stray click land while the
// question is up, then answer it.
const PLACE_PDF = path.join(REPO, 'spike', 'out', 'app_place_binder.pdf')
// This run wanted an isolated userData before the other two did — see the note
// on `home()` at the top, which generalised it to every launch here.
const PLACE_HOME = home('place')
rmSync(PLACE_PDF, { force: true })
const placed = await run('npm', ['run', 'dev'], {
  cwd: APP,
  shell: process.platform === 'win32',
  env: {
    ...process.env,
    WPT_DEV_OPEN: a,
    WPT_DEV_EXPORT: PLACE_PDF,
    WPT_DEV_SHOT: path.join(REPO, 'spike', 'out', 'app_place_window.png'),
    // no WPT_DEV_MARKS: this run must start with NO reviewer, which is the
    // state that makes the question appear at all.
    WPT_DEV_PLACE: 'tick@0.72,0.30;tick@0.11,0.88;answer:RV;tick@0.40,0.60',
    // Its own userData, wiped first. Initials now persist across binders, so
    // "no initials stored yet" is a precondition this test would otherwise
    // destroy on its first run — passing once and then failing identically ever
    // after, for a reason that has nothing to do with the code. It would also
    // be overwriting the developer's own initials to do it.
    WPT_DEV_USERDATA: PLACE_HOME,
    WPT_DEV_EXIT: '1'
  }
})
check('scripted placement run exited cleanly', placed.code === 0, `exit=${placed.code}`)

if (existsSync(PLACE_PDF)) {
  const pp = await engine({ cmd: 'probe', path: PLACE_PDF })
  const ticks = pp.ok
    ? pp.probe.pages.flatMap((pg) => (pg.annotations ?? []).filter((x) => x.wpt_kind === 'tick'))
    : []
  const at = (nx, ny) =>
    ticks.find(
      (t) => Math.abs((t.wpt_data?.nx ?? -1) - nx) < 0.01 && Math.abs((t.wpt_data?.ny ?? -1) - ny) < 0.01
    )

  // THE ONE THAT MATTERS. The second click in the script lands while the
  // initials question is open. If it is allowed through, it silently moves the
  // pending mark and the tick comes to rest at 0.11,0.88 — white space, far
  // from the figure the preparer pointed at. That is worse than a blank author:
  // it looks like a completed assertion about a number nobody checked.
  check(
    'a stray click while the initials question is open does not move the mark',
    !!at(0.72, 0.3) && !at(0.11, 0.88),
    ticks.map((t) => `(${t.wpt_data?.nx},${t.wpt_data?.ny})`).join(' ') || 'no ticks'
  )
  // Answering the question places the mark that asked it, attributed — the mark
  // that seeded the initials must not be the one mark recording a blank author.
  check(
    'the mark that asked for initials lands carrying them',
    at(0.72, 0.3)?.wpt_data?.author === 'RV',
    JSON.stringify(at(0.72, 0.3)?.wpt_data?.author ?? null)
  )
  // And once answered, the question is not asked again: a later click places
  // straight away rather than opening the prompt a second time.
  check(
    'a later click places directly, without asking again',
    at(0.4, 0.6)?.wpt_data?.author === 'RV',
    ticks.length === 2 ? '2 ticks, both attributed' : `${ticks.length} tick(s)`
  )
  // Deliberately NOT named for the stray click: with the guard removed the mark
  // MOVES rather than duplicating, so this count stays at 2 and passes while the
  // bug is live. The position check above is the one with teeth. This one guards
  // a different failure — a click that places twice — and is kept for that.
  check(
    'exactly two marks exist, one per intended click',
    ticks.length === 2,
    `${ticks.length}`
  )
}

// ---------------------------------------------------------------- Keep tool
//
// A drawing tool normally deselects after one shape, because the next click is
// usually meant to grab what you just drew. "Keep tool" is the reviewer opting
// out of that to box or circle a run of figures.
//
// Driven through the REAL toggle and the REAL drawShape, and the script arms the
// rect tool ONCE. The two shapes after it can only exist if the lock kept it
// armed — re-arming in the runner would make this pass either way, which is the
// mistake that left placeTool uncovered while it collected three defects.
const LOCK_PDF = path.join(REPO, 'spike', 'out', 'app_lock_binder.pdf')
rmSync(LOCK_PDF, { force: true })
const locked = await run('npm', ['run', 'dev'], {
  cwd: APP,
  shell: process.platform === 'win32',
  env: {
    ...process.env,
    WPT_DEV_OPEN: a,
    WPT_DEV_EXPORT: LOCK_PDF,
    WPT_DEV_SHOT: path.join(REPO, 'spike', 'out', 'app_lock_window.png'),
    WPT_DEV_MARKS: '1',
    // arm:rect ONCE. The drag steps refuse to run against an unarmed tool, so
    // the second and third can only happen if the lock kept it armed.
    WPT_DEV_PLACE:
      'lock:on;arm:rect;rect@0.10,0.10>0.30,0.20;rect@0.10,0.30>0.30,0.40;rect@0.10,0.50>0.30,0.60',
    WPT_DEV_USERDATA: home('lock'),
    WPT_DEV_EXIT: '1'
  }
})
check('tool-lock run exited cleanly', locked.code === 0, `exit=${locked.code}`)
// Named, rather than letting the two checks below silently skip.
//
// This is HOW a broken lock reports itself, and it is worth knowing: the drag
// step throws in the renderer, and there is no renderer->main error channel, so
// the throw takes the export and the exit down with it and the run times out.
// Verified by running this same script with `lock:off` — no binder, no exit.
// Without this line the suite would go red only on "exited cleanly", and the two
// checks that name the feature would quietly not run at all.
check(
  'tool-lock run produced a binder',
  existsSync(LOCK_PDF),
  existsSync(LOCK_PDF)
    ? LOCK_PDF
    : 'no export — the scripted run stopped before it. A drag found no armed tool,' +
      ' which is what Keep tool failing to hold looks like.'
)

if (existsSync(LOCK_PDF)) {
  const lp = await engine({ cmd: 'probe', path: LOCK_PDF })
  const rects = lp.ok
    ? lp.probe.pages.flatMap((pg) => (pg.annotations ?? []).filter((x) => x.wpt_kind === 'rect'))
    : []
  check(
    'Keep tool draws three shapes from one tool selection',
    rects.length === 3,
    `${rects.length} rect(s) — the tool was armed once; 1 means the lock did not hold`
  )
  // Position, not just count: a lock that kept the tool armed but replayed the
  // FIRST drag would also give three, stacked on top of each other.
  const ys = [...new Set(rects.map((r) => Math.round((r.wpt_data?.ny ?? 0) * 100)))]
  check(
    'each locked shape landed where it was dragged, not stacked',
    ys.length === 3,
    `ny values: ${ys.join(', ')}`
  )
}

// ------------------------------------------- Keep tool releases a mark tool
//
// The half that was broken and shipped. "Keep tool" only ever governed shapes;
// mark tools were unconditionally sticky, so turning the toggle OFF with the ✗
// tool in hand did nothing and the tool stayed lit. This surfaced in the
// packaged app on 2026-08-08.
//
// One run proves both directions. `armed:none` is the check with teeth — the
// released tool is invisible in the exported binder, so nothing about the marks
// themselves could catch a regression here.
const MARKLOCK_PDF = path.join(REPO, 'spike', 'out', 'app_marklock_binder.pdf')
rmSync(MARKLOCK_PDF, { force: true })
const markLock = await run('npm', ['run', 'dev'], {
  cwd: APP,
  shell: process.platform === 'win32',
  env: {
    ...process.env,
    WPT_DEV_OPEN: a,
    WPT_DEV_EXPORT: MARKLOCK_PDF,
    WPT_DEV_SHOT: path.join(REPO, 'spike', 'out', 'app_marklock_window.png'),
    WPT_DEV_MARKS: '1',
    // OFF: one arm, one mark, tool released. ON: one arm, two marks, tool held.
    // Every keep: step refuses an unarmed tool and every armed: step asserts,
    // so each clause fails the run rather than passing quietly.
    WPT_DEV_PLACE:
      'lock:off;arm:cross;keep:cross@0.20,0.10;answer:ABC;armed:none;' +
      'lock:on;arm:cross;keep:cross@0.20,0.30;keep:cross@0.20,0.50;armed:cross',
    WPT_DEV_USERDATA: home('marklock'),
    WPT_DEV_EXIT: '1'
  }
})
check('mark-lock run exited cleanly', markLock.code === 0, `exit=${markLock.code}`)
check(
  'mark-lock run produced a binder',
  existsSync(MARKLOCK_PDF),
  existsSync(MARKLOCK_PDF)
    ? MARKLOCK_PDF
    : 'no export — the scripted run stopped before it. Either a mark tool did not' +
      ' release with Keep tool off, or it did not hold with Keep tool on.'
)
if (existsSync(MARKLOCK_PDF)) {
  const mp = await engine({ cmd: 'probe', path: MARKLOCK_PDF })
  const crosses = mp.ok
    ? mp.probe.pages.flatMap((pg) => (pg.annotations ?? []).filter((x) => x.wpt_kind === 'cross'))
    : []
  check(
    'three marks land: one before the release, two from one selection after',
    crosses.length === 3,
    `${crosses.length}`
  )
  const ys = [...new Set(crosses.map((r) => Math.round((r.wpt_data?.ny ?? 0) * 100)))]
  check(
    'each mark landed where it was clicked, not stacked',
    ys.length === 3,
    `ny values: ${ys.join(', ')}`
  )
}

// ------------------------------------------------- tickmark legend as a page
//
// The legend is what turns marks into evidence: a binder full of unexplained
// letters is the classic peer-review finding. It is built as a normal typeset
// page rather than conjured at export, so this drives the real button and then
// READS THE EXPORTED PAGE BACK as text — not "a page appeared", which a blank
// page would satisfy just as well.
//
// This check exists because the feature was dead on arrival the first time it
// ran: the legend markdown is written by MAIN, and the renderer's probe of it
// was refused by the input gate ("file not user-authorized this session").
// Every model check was green — none of them cross that boundary.
const LEGEND_PDF = path.join(REPO, 'spike', 'out', 'app_legend_binder.pdf')
rmSync(LEGEND_PDF, { force: true })
const legendRun = await run('npm', ['run', 'dev'], {
  cwd: APP,
  shell: process.platform === 'win32',
  // A scripted renderer assertion logs its exact failing step but does not
  // terminate Electron by itself. Healthy legend runs finish in seconds; one
  // minute preserves useful diagnostics without making a toolbar regression
  // hold CI for the generic four-minute GUI bound.
  timeoutMs: 60_000,
  env: {
    ...process.env,
    WPT_DEV_OPEN: a,
    WPT_DEV_EXPORT: LEGEND_PDF,
    WPT_DEV_SHOT: path.join(REPO, 'spike', 'out', 'app_legend_window.png'),
    WPT_DEV_MARKS: '1',
    WPT_DEV_PLACE:
      'tick@0.30,0.22;answer:ABC;tick@0.45,0.22;cross@0.60,0.22;' +
      'legend:tick=Agrees to supporting documentation;legend:cross=Does not agree;' +
      // Take up the whole standard set, then assert the ribbon still fits on
      // one line. This is the shape of the reported bug: eleven stamps
      // loose in the toolbar pushed the tools that matter off the end.
      'menu:legend;preset:all;onerow;legend:addpage',
    WPT_DEV_USERDATA: home('legend'),
    WPT_DEV_EXIT: '1'
  }
})
const legendFailure =
  legendRun.code === 0 && !legendRun.timedOut ? '' : legendRun.err.trim().slice(-2_000)
const toolbarContract = `${legendRun.out}\n${legendRun.err}`.match(
  /\[dev\] toolbar contract: \d+px design slack; \d+ compact row\(s\); no clipped controls/
)?.[0]
check(
  'legend run exited cleanly',
  legendRun.code === 0,
  `exit=${legendRun.code}${legendRun.timedOut ? ' timed out' : ''}${legendFailure ? ` stderr=${legendFailure}` : ''}`
)
check(
  'toolbar contract reports measured headroom',
  !!toolbarContract,
  toolbarContract ?? 'the renderer did not report the measured toolbar contract'
)
check(
  'legend run produced a binder',
  existsSync(LEGEND_PDF),
  existsSync(LEGEND_PDF)
    ? LEGEND_PDF
    : 'no export — the scripted run stopped before it. The legend panel did not open,' +
      ' the whole preset set could not be taken up, THE TOOLBAR WRAPPED onto a second' +
      ' row, Add legend page was disabled, or the page never landed.'
)
if (existsSync(LEGEND_PDF)) {
  const lg = await engine({ cmd: 'probe', path: LEGEND_PDF })
  check(
    'the legend lands as one extra page at the FRONT',
    lg.ok && lg.probe.n_pages === 4,
    `${lg.ok ? lg.probe.n_pages : lg.error} pages (3 source + 1 legend)`
  )
  const lt = await engine({ cmd: 'text', path: LEGEND_PDF, pages: [0] })
  const page0 = lt.ok ? (lt.text.pages[0]?.text ?? '') : ''
  check(
    'the legend page carries each mark AND what it means',
    page0.includes('Tickmark Legend') &&
      page0.includes('Agrees to supporting documentation') &&
      page0.includes('Does not agree'),
    JSON.stringify(page0.slice(0, 120))
  )
  // The counts are the part a reader uses to tell a legend row from a typo.
  check(
    'the legend counts how many times each mark is used',
    /Agrees to supporting documentation\s+2/.test(page0) && /Does not agree\s+1/.test(page0),
    JSON.stringify(page0.split('\n').slice(1, 4))
  )
  // The tick and cross are drawn glyphs, not letters. reportlab routes a
  // character it cannot draw to a black box, so an unrenderable mark would
  // silently become one — worse than missing, because it looks deliberate.
  check(
    'the mark glyphs typeset as themselves, not as a substitution box',
    page0.includes('✓') && page0.includes('✕') && !page0.includes('[U+'),
    JSON.stringify(page0.split('\n').slice(2, 4))
  )
}

let fails = 0
for (const [name, ok, detail] of checks) {
  if (!ok) fails++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? `  — ${detail}` : ''}`)
}
console.log(`\n${checks.length - fails}/${checks.length} checks passed`)
if (!fails) console.log(`window: ${SHOT}`)
process.exit(fails ? 1 : 0)
