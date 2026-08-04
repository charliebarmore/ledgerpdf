/**
 * Headless verification of the binder model + a real engine round-trip.
 *
 * This is the automated backstop for Phase 1: it exercises the same pure
 * functions the UI calls, then hands the resulting spec to the actual Python
 * engine and re-probes the exported PDF. It proves the app's model produces a
 * valid binder without needing to click anything.
 *
 *   npm run verify:model
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import {
  SESSION_FORMAT_VERSION,
  baseName,
  imageLayout,
  addBookmark,
  addMark,
  addSource,
  addShape,
  assignBookmarkPage,
  clearBookmarkPage,
  addStamp,
  addTape,
  buildBookmarks,
  deletePages,
  formatAmount,
  movePages,
  newSession,
  normalizeStamp,
  nudgeBookmarkDepth,
  parseAmount,
  parseSession,
  popTapeEntry,
  pushTapeEntry,
  markCursor,
  marksByPage,
  marksOnPage,
  removeBookmark,
  removeMarks,
  isDragMeaningful,
  moveShape,
  removeShapes,
  resizeShape,
  removeStamp,
  removeTapes,
  shapesOnPage,
  updateShape,
  rotatePages,
  rotateVisual,
  sanitizeTitle,
  clearPageStatus,
  setBookmarkTitle,
  setPageStatus,
  formatPageNumber,
  numbering,
  statusCounts,
  statusDefs,
  statusOf,
  statusParts,
  tapeLines,
  tapeKeyPress,
  type TapeKeyState,
  tapeRunning,
  updateTapeEntry,
  tapeTotal,
  toTapeEntry,
  tapesOnPage,
  updateMark,
  stripPageCount,
  toExportSpec,
  type ProbeWire,
  type Session
} from '../src/renderer/src/session'

const APP = path.resolve(__dirname, '..')
const REPO = path.resolve(APP, '..')
const ENGINE = path.join(REPO, 'engine')
const PY = path.join(ENGINE, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python')
const FIXTURES = path.join(REPO, 'spike', 'fixtures')
const OUT = path.join(REPO, 'spike', 'out', 'app_binder.pdf')
const OUT_FLAT = path.join(REPO, 'spike', 'out', 'app_binder_flat.pdf')

const results: Array<[string, boolean, string]> = []
function check(name: string, ok: boolean, detail = ''): void {
  results.push([name, ok, detail])
}

function runEngine(command: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(PY, ['-m', 'workpaper_engine.cli'], {
      cwd: ENGINE,
      env: { ...process.env, PYTHONPATH: ENGINE }
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', reject)
    child.on('close', () => {
      try {
        resolve(JSON.parse(out.trim()))
      } catch {
        reject(new Error(`engine gave no JSON: ${err.slice(0, 400)}`))
      }
    })
    child.stdin.write(JSON.stringify(command))
    child.stdin.end()
  })
}

/** Run a python script in the engine venv and hand back its exit code + output. */
function runPython(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(PY, args, { cwd: REPO })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('error', (e) => resolve({ code: 1, out: String(e) }))
    child.on('close', (code) => resolve({ code: code ?? 1, out }))
  })
}

function flatten(nodes: any[], depth = 0): Array<[number, string, number | null]> {
  return nodes.flatMap((n) => [
    [depth, n.title, n.dest_page] as [number, string, number | null],
    ...flatten(n.children ?? [], depth + 1)
  ])
}

async function main(): Promise<number> {
  const fa = path.join(FIXTURES, 'fixture_a.pdf')
  const fb = path.join(FIXTURES, 'fixture_b.pdf')
  if (!existsSync(fa) || !existsSync(fb)) {
    console.error('fixtures missing — run: engine/.venv/bin/python spike/run_spike.py')
    return 1
  }

  const pa = await runEngine({ cmd: 'probe', path: fa })
  const pb = await runEngine({ cmd: 'probe', path: fb })
  check('probe fixtures', pa.ok === true && pb.ok === true, `${pa.error ?? ''}${pb.error ?? ''}`)
  if (!pa.ok || !pb.ok) return report()

  // --- build a binder the way the UI would
  let s: Session = newSession()
  s = addSource(s, pa.probe as ProbeWire)
  s = addSource(s, pb.probe as ProbeWire)
  check('import two sources', s.sources.length === 2 && s.pages.length === 6, `pages=${s.pages.length}`)
  check('page ids unique', new Set(s.pages.map((p) => p.id)).size === 6)
  check(
    'imports fingerprint the exact source bytes',
    s.sources.every((source) => /^[a-f0-9]{64}$/.test(source.fingerprint?.sha256 ?? ''))
  )

  const bIds = s.pages.filter((p) => p.source === s.sources[1].id).map((p) => p.id)
  const aIds = s.pages.filter((p) => p.source === s.sources[0].id).map((p) => p.id)

  // --- reorder: move B's three pages to the front, preserving their order
  s = movePages(s, bIds, 0)
  check(
    'move keeps relative order and lands at target',
    s.pages.slice(0, 3).map((p) => p.id).join(',') === bIds.join(','),
    s.pages.map((p) => p.id).join(',')
  )

  // --- move to end (regression: index correction when items precede target)
  let t = movePages(s, [s.pages[0].id], s.pages.length)
  check('move to end', t.pages[t.pages.length - 1].id === s.pages[0].id)

  // --- rotate
  s = rotatePages(s, [aIds[0]], 90)
  s = rotatePages(s, [aIds[0]], 90)
  check(
    'rotation accumulates mod 360',
    s.pages.find((p) => p.id === aIds[0])!.rotate === 180,
    String(s.pages.find((p) => p.id === aIds[0])!.rotate)
  )
  t = rotatePages(s, [aIds[0]], -270)
  check('negative rotation normalizes', t.pages.find((p) => p.id === aIds[0])!.rotate === 270)

  // --- rotateVisual: turns extracted text coordinates into the binder's own
  // display space. A wrong quadrant here puts an agent's tick on the wrong
  // edge of every page someone straightened after import.
  check(
    'rotateVisual 90° sends the top-left corner to the top-right',
    JSON.stringify(rotateVisual(0, 0, 90)) === JSON.stringify({ nx: 1, ny: 0 }),
    JSON.stringify(rotateVisual(0, 0, 90))
  )
  check('rotateVisual 0° is identity', rotateVisual(0.3, 0.7, 0).nx === 0.3)
  {
    const start = { nx: 0.31, ny: 0.86 }
    let p = start
    for (let i = 0; i < 4; i++) p = rotateVisual(p.nx, p.ny, 90)
    check(
      'four 90° turns return a point to itself',
      Math.abs(p.nx - start.nx) < 1e-12 && Math.abs(p.ny - start.ny) < 1e-12,
      JSON.stringify(p)
    )
    const half = rotateVisual(start.nx, start.ny, 180)
    const once = rotateVisual(start.nx, start.ny, 90)
    const twice = rotateVisual(once.nx, once.ny, 90)
    check(
      '180° equals two 90° turns',
      Math.abs(half.nx - twice.nx) < 1e-12 && Math.abs(half.ny - twice.ny) < 1e-12,
      `${JSON.stringify(half)} vs ${JSON.stringify(twice)}`
    )
    check(
      '-90° and 270° agree',
      JSON.stringify(rotateVisual(0.2, 0.4, -90)) === JSON.stringify(rotateVisual(0.2, 0.4, 270))
    )
  }

  // --- bookmarks before deletion: file-level + nested imported outline
  const before = buildBookmarks(s)
  check(
    'bookmarks: 2 file-level, B first (binder order)',
    before.length === 2 && before[0].title === 'fixture_b' && before[1].title === 'fixture_a',
    before.map((b) => b.title).join(',')
  )
  check(
    'imported outline nested under its file',
    before[0].children.map((c) => c.title).join(',') === 'Schedule X,Schedule Y' &&
      before[0].children[0].children.map((c) => c.title).join(',') === 'Detail X-1',
    JSON.stringify(before[0].children.map((c) => [c.title, c.children.map((g) => g.title)]))
  )

  // --- single-source collapse: the filename wrapper is a dead level when one
  //     source already carries its own outline (real-file finding)
  let solo: Session = newSession()
  solo = addSource(solo, pb.probe as ProbeWire)
  const collapsed = buildBookmarks(solo)
  check(
    'single source with own outline: wrapper collapsed',
    collapsed.length === 2 && collapsed[0].title === 'Schedule X',
    collapsed.map((b) => b.title).join(',')
  )
  const kept = buildBookmarks(solo, { collapseSingleSource: false })
  check(
    'wrapper kept when asked, .pdf stripped',
    kept.length === 1 && kept[0].title === 'fixture_b',
    kept.map((b) => b.title).join(',')
  )
  let soloA: Session = newSession()
  soloA = addSource(soloA, pa.probe as ProbeWire)
  check(
    'single source WITHOUT outline keeps its file bookmark',
    buildBookmarks(soloA).length === 1 && buildBookmarks(soloA)[0].title === 'fixture_a',
    buildBookmarks(soloA).map((b) => b.title).join(',')
  )

  // --- page counts land on LEAVES only (the real-file convention): Schedule X
  //     is a section heading so it stays bare; its child and Schedule Y count.
  const counted = buildBookmarks(solo, { pageCounts: true })
  check(
    'page counts on leaves only, from bookmark spans',
    counted[0].title === 'Schedule X' &&
      counted[0].children[0].title === 'Detail X-1 (2 pages)' &&
      counted[1].title === 'Schedule Y (2 pages)',
    JSON.stringify([counted[0].title, counted[0].children[0].title, counted[1].title])
  )
  // a hand-typed count must be replaced, not doubled
  const handTyped: Session = {
    ...solo,
    sources: [
      {
        ...solo.sources[0],
        outline: [{ title: 'Schedule X (7 pages)', destPage: 0, children: [] }]
      }
    ]
  }
  check(
    'existing "(N pages)" suffix replaced, not doubled',
    buildBookmarks(handTyped, { pageCounts: true })[0].title === 'Schedule X (3 pages)',
    buildBookmarks(handTyped, { pageCounts: true })[0].title
  )

  // --- REGRESSION: real tax software wrote a NUL after every bookmark title,
  //     which is invisible, defeats end-of-string matching, and survived trim.
  //     Symptom was "General_Ledger (2 pages) (2 pages)". Titles are now
  //     scrubbed of control characters at import.
  const NUL = String.fromCharCode(0)
  check(
    'control characters are stripped from imported titles',
    sanitizeTitle(`General_Ledger (2 pages)${NUL}`) === 'General_Ledger (2 pages)' &&
      sanitizeTitle(`Continuing Education ${NUL}`) === 'Continuing Education' &&
      sanitizeTitle(`Revenue – Triland Partners LLC${NUL}`) === 'Revenue – Triland Partners LLC',
    JSON.stringify(sanitizeTitle(`Continuing Education ${NUL}`))
  )
  const nulSession: Session = {
    ...solo,
    sources: [
      {
        ...solo.sources[0],
        outline: [
          { title: sanitizeTitle(`General_Ledger (2 pages)${NUL}`), destPage: 0, children: [] },
          { title: sanitizeTitle(`Continuing Education ${NUL}`), destPage: 1, children: [] }
        ]
      }
    ]
  }
  const nulTree = buildBookmarks(nulSession, { pageCounts: true })
  check(
    'NUL-suffixed titles get exactly one page count',
    nulTree[0].title === 'General_Ledger (1 page)' &&
      nulTree[1].title === 'Continuing Education (2 pages)',
    nulTree.map((b) => b.title).join(' | ')
  )

  // --- page-count stripping has to survive whatever a human typed in Acrobat
  const nasty: Array<[string, string]> = [
    ['General_Ledger (2 pages)', 'General_Ledger'],
    ['General_Ledger (2 pages) (2 pages)', 'General_Ledger'], // already doubled
    ['General_Ledger (2 pages)', 'General_Ledger'], // non-breaking spaces
    ['CC Annual Report - 2025 (6 pgs)', 'CC Annual Report - 2025'],
    ['Distributions Detail (1 page.)', 'Distributions Detail'],
    ['Revenue – Triland Partners LLC (2 Pages)', 'Revenue – Triland Partners LLC'],
    ['Continuing Education ', 'Continuing Education'],
    ['Cash_Disbursements_Listing', 'Cash_Disbursements_Listing'],
    ['Form 1120S (2024)', 'Form 1120S (2024)'] // a YEAR must not be eaten
  ]
  const stripFails = nasty.filter(([input, want]) => stripPageCount(input) !== want)
  check(
    'page-count stripping handles real-world title noise',
    stripFails.length === 0,
    stripFails.map(([i]) => `${JSON.stringify(i)} -> ${JSON.stringify(stripPageCount(i))}`).join(' ; ')
  )

  // --- renaming bookmarks
  const scheduleXKey = buildBookmarks(solo)[0].key
  let renamed = setBookmarkTitle(solo, scheduleXKey, 'Sch. X — Interest Income')
  check(
    'rename overrides the imported title',
    buildBookmarks(renamed)[0].title === 'Sch. X — Interest Income',
    buildBookmarks(renamed)[0].title
  )
  check(
    'rename survives a reorder (key is not positional)',
    buildBookmarks(movePages(renamed, [renamed.pages[2].id], 0))[0].title ===
      'Sch. X — Interest Income'
  )
  check(
    'rename composes with generated page counts',
    buildBookmarks(renamed, { pageCounts: true })[0].children[0].title === 'Detail X-1 (2 pages)' &&
      buildBookmarks(renamed, { pageCounts: true })[0].title === 'Sch. X — Interest Income',
    buildBookmarks(renamed, { pageCounts: true })[0].title
  )
  const rtRenamed = parseSession(JSON.parse(JSON.stringify(renamed)))
  check(
    'renames persist through save/reopen',
    'session' in rtRenamed && buildBookmarks(rtRenamed.session)[0].title === 'Sch. X — Interest Income'
  )
  renamed = setBookmarkTitle(renamed, scheduleXKey, '')
  check(
    'empty rename reverts to the imported title',
    buildBookmarks(renamed)[0].title === 'Schedule X' && renamed.titles?.[scheduleXKey] === undefined
  )
  // a rename on a child whose PARENT bookmark gets dropped must still apply
  const detailKey = buildBookmarks(solo)[0].children[0].key
  const childRenamed = setBookmarkTitle(solo, detailKey, 'Detail (renamed)')
  const parentGone = deletePages(childRenamed, [
    childRenamed.pages.find((p) => p.index === 0)!.id
  ])
  check(
    'rename survives its parent bookmark being dropped',
    buildBookmarks(parentGone).some((b) => b.title === 'Detail (renamed)'),
    buildBookmarks(parentGone).map((b) => b.title).join(',')
  )

  // --- user-created bookmarks (the ALFA case: a PDF with no outline at all)
  let noOutline: Session = newSession()
  noOutline = addSource(noOutline, pa.probe as ProbeWire) // fixture_a has no outline
  check('file with no outline has one bookmark', buildBookmarks(noOutline).length === 1)

  const add1 = addBookmark(noOutline, noOutline.pages[1].id, 'Standard deduction')
  const add2 = addBookmark(add1.session, noOutline.pages[2].id, 'Payments')
  let withUser = add2.session
  const userTree = buildBookmarks(withUser)
  check(
    'user bookmarks appear in page order after the file bookmark',
    userTree.map((b) => b.title).join(' | ') === 'fixture_a | Standard deduction | Payments',
    userTree.map((b) => b.title).join(' | ')
  )

  // indent nests under the preceding entry
  withUser = nudgeBookmarkDepth(withUser, add1.key, 1)
  const nested = buildBookmarks(withUser)
  check(
    'indent nests a user bookmark under the previous one',
    nested.length === 2 &&
      nested[0].title === 'fixture_a' &&
      nested[0].children[0].title === 'Standard deduction',
    JSON.stringify(nested.map((b) => [b.title, b.children.map((c) => c.title)]))
  )

  // renaming and removing user bookmarks
  withUser = setBookmarkTitle(withUser, add2.key, 'Payments & credits')
  check(
    'user bookmark renames',
    buildBookmarks(withUser).some((b) => b.title === 'Payments & credits')
  )
  check(
    'user bookmarks survive save/reopen',
    (() => {
      const rt = parseSession(JSON.parse(JSON.stringify(withUser)))
      return 'session' in rt && rt.session.bookmarks?.length === 2
    })()
  )
  check(
    'user bookmark on a deleted page is dropped',
    (() => {
      const gone = deletePages(withUser, [withUser.pages[2].id])
      return !buildBookmarks(gone).some((b) => b.title === 'Payments & credits')
    })()
  )
  check(
    'removeBookmark deletes just that one',
    buildBookmarks(removeBookmark(withUser, add2.key)).length === 1
  )

  // a user bookmark must not scramble an imported outline's nesting
  const inB = addBookmark(solo, solo.pages[2].id, 'Added at the end')
  const mixed = buildBookmarks(inB.session)
  check(
    'user bookmark merges without disturbing imported nesting',
    mixed.map((b) => b.title).join(' | ') === 'Schedule X | Schedule Y | Added at the end' &&
      mixed[0].children[0].title === 'Detail X-1',
    mixed.map((b) => b.title).join(' | ')
  )

  // --- delete the page two imported bookmarks point at (B index 1)
  const bPage1 = s.pages.find((p) => p.source === s.sources[1].id && p.index === 1)!
  s = deletePages(s, [bPage1.id])
  check('delete removes page', s.pages.length === 5 && !s.pages.some((p) => p.id === bPage1.id))

  const after = buildBookmarks(s)
  check(
    'bookmarks to deleted page are dropped, children hoisted',
    after[0].children.map((c) => c.title).join(',') === 'Schedule X' &&
      after[0].children[0].children.length === 0,
    JSON.stringify(after[0].children.map((c) => [c.title, c.children.map((g) => g.title)]))
  )

  // --- deleting every page of a source drops the source
  t = deletePages(s, s.pages.filter((p) => p.source === s.sources[0].id).map((p) => p.id))
  check('unused source pruned', t.sources.length === 1 && t.sources[0].id === s.sources[1].id)

  // --- session round-trip + version guard
  const rt = parseSession(JSON.parse(JSON.stringify(s)))
  check('session round-trips', 'session' in rt && rt.session.pages.length === 5)
  const tooNew = parseSession({ ...s, formatVersion: SESSION_FORMAT_VERSION + 1 })
  check('newer format rejected', 'error' in tooNew, 'error' in tooNew ? tooNew.error : 'accepted!')
  const dangling = parseSession({ ...s, sources: [] })
  check('dangling source rejected', 'error' in dangling)

  // --- Phase 2: review marks
  let marked: Session = { ...s, reviewer: 'CJB' }
  const m1 = addMark(marked, { page: marked.pages[0].id, kind: 'tick', nx: 0.5, ny: 0.4, size: 24 })
  marked = m1.session
  const m2 = addMark(marked, {
    page: marked.pages[0].id,
    kind: 'text',
    nx: 0.3,
    ny: 0.6,
    size: 24,
    text: 'F',
    note: 'Footed'
  })
  marked = m2.session
  check(
    'marks carry reviewer initials and a timestamp',
    marksOnPage(marked, marked.pages[0].id).every(
      (m) => m.author === 'CJB' && typeof m.created === 'string'
    ),
    JSON.stringify(marksOnPage(marked, marked.pages[0].id).map((m) => [m.author, !!m.created]))
  )
  check('marks are scoped to their page', marksOnPage(marked, marked.pages[1].id).length === 0)

  marked = updateMark(marked, m1.id, { nx: 0.9, ny: 0.1 })
  check(
    'moving a mark updates its coordinates',
    marksOnPage(marked, marked.pages[0].id).find((m) => m.id === m1.id)?.nx === 0.9
  )
  check(
    'coordinates are clamped to the page',
    updateMark(marked, m1.id, { nx: 5, ny: -2 }).marks!.find((m) => m.id === m1.id)!.nx === 1
  )
  check(
    'size is clamped to the allowed range',
    updateMark(marked, m1.id, { size: 999 }).marks!.find((m) => m.id === m1.id)!.size === 72
  )
  check(
    'marks survive save/reopen',
    (() => {
      const rt = parseSession(JSON.parse(JSON.stringify(marked)))
      return 'session' in rt && rt.session.marks?.length === 2 && rt.session.reviewer === 'CJB'
    })()
  )
  check(
    'deleting a page removes its marks',
    deletePages(marked, [marked.pages[0].id]).marks?.length === 0
  )
  check('removeMarks drops just the named ones', removeMarks(marked, [m2.id]).marks?.length === 1)

  // --- Phase 2 remainder: the mark inspector edits an existing mark in place
  const inspected = updateMark(marked, m2.id, {
    text: 'TB',
    note: 'Tied to trial balance',
    author: 'RD'
  })
  const edited = inspected.marks!.find((m) => m.id === m2.id)!
  check(
    'inspector edits letters, note and author after the fact',
    edited.text === 'TB' && edited.note === 'Tied to trial balance' && edited.author === 'RD',
    JSON.stringify([edited.text, edited.note, edited.author])
  )
  check(
    'editing a mark never moves it or rewrites its timestamp',
    edited.nx === 0.3 && edited.ny === 0.6 && edited.created === marked.marks![1].created,
    `${edited.nx},${edited.ny} created=${edited.created === marked.marks![1].created}`
  )
  check(
    'inspector edits persist through save/reopen',
    (() => {
      const rt = parseSession(JSON.parse(JSON.stringify(inspected)))
      return 'session' in rt && rt.session.marks!.find((m) => m.id === m2.id)?.note ===
        'Tied to trial balance'
    })()
  )

  // --- Phase 2 remainder: marks grouped per page (the thumbnail rail's view)
  const grouped = marksByPage(marked)
  check(
    'marksByPage groups every mark under its own page',
    grouped.get(marked.pages[0].id)?.length === 2 && grouped.size === 1,
    `size=${grouped.size}`
  )
  check(
    'marksByPage totals match the session',
    [...grouped.values()].flat().length === (marked.marks?.length ?? 0)
  )

  // --- Phase 2 remainder: custom stamps (a firm's own tick-mark legend)
  check(
    'stamps are trimmed, de-noised and length-capped',
    normalizeStamp('  TB  ') === 'TB' &&
      normalizeStamp(`A/R${String.fromCharCode(0)}`) === 'A/R' &&
      normalizeStamp('averyverylongstamp').length === 8 &&
      normalizeStamp('   ') === '',
    JSON.stringify([normalizeStamp('  TB  '), normalizeStamp('averyverylongstamp')])
  )
  let stamped = addStamp(marked, 'TB')
  stamped = addStamp(stamped, 'PY')
  check('stamps are saved in order', stamped.stamps?.join(',') === 'TB,PY', String(stamped.stamps))
  check('duplicate stamps are ignored', addStamp(stamped, 'TB').stamps?.length === 2)
  check('blank stamps are ignored', addStamp(stamped, '   ') === stamped)
  check(
    'removing a stamp leaves marks already placed with it alone',
    (() => {
      const withMark = addStamp(stamped, 'ZZ')
      const placed = addMark(withMark, {
        page: withMark.pages[0].id,
        kind: 'text',
        nx: 0.1,
        ny: 0.1,
        size: 24,
        text: 'ZZ'
      }).session
      const dropped = removeStamp(placed, 'ZZ')
      return !dropped.stamps?.includes('ZZ') && dropped.marks?.some((m) => m.text === 'ZZ') === true
    })()
  )
  check(
    'stamps survive save/reopen',
    (() => {
      const rt = parseSession(JSON.parse(JSON.stringify(stamped)))
      return 'session' in rt && rt.session.stamps?.join(',') === 'TB,PY'
    })()
  )
  check(
    'a session file with junk stamps is cleaned, not rejected',
    (() => {
      const rt = parseSession({ ...stamped, stamps: ['TB', 'TB', '  ', 42, 'PY'] })
      return 'session' in rt && rt.session.stamps?.join(',') === 'TB,PY'
    })()
  )

  // --- Phase 3: calculator tape
  //
  // The arithmetic is the whole product here. A workpaper total that doesn't
  // foot to the cent is a defect, so the money path is checked before anything
  // about how it looks.
  check(
    'tape sums in whole cents, not floats',
    tapeTotal([0.1, 0.2].map(toTapeEntry)) === 0.3 &&
      tapeTotal([1200, 340, -50].map(toTapeEntry)) === 1490 &&
      tapeTotal([1.005, 2.005].map(toTapeEntry)) === 3.01 &&
      tapeTotal([]) === 0,
    `${tapeTotal([0.1, 0.2].map(toTapeEntry))} ${tapeTotal([1.005, 2.005].map(toTapeEntry))}`
  )
  // --- chain arithmetic: every operator applies to the RUNNING TOTAL, and each
  //     step rounds to cents so the printed lines always foot to the printed
  //     total. A tape that doesn't foot is a defect, not a rounding curiosity.
  const chain = [
    { value: 1200, op: '+' as const },
    { value: 340, op: '+' as const },
    { value: 0.35, op: '×' as const }
  ]
  check(
    'x and / act on the running total, 10-key style',
    tapeRunning(chain).join(',') === '1200,1540,539' && tapeTotal(chain) === 539,
    tapeRunning(chain).join(',')
  )
  check(
    'every step rounds to cents, so the printed lines foot to the printed total',
    (() => {
      // 100.00 / 3 = 33.333... -> 33.33 printed, and x 3 must give 99.99,
      // not 100.00 — the tape shows what it actually did.
      const r = tapeRunning([
        { value: 100, op: '+' },
        { value: 3, op: '÷' },
        { value: 3, op: '×' }
      ])
      return r.join(',') === '100,33.33,99.99'
    })(),
    tapeRunning([
      { value: 100, op: '+' },
      { value: 3, op: '÷' },
      { value: 3, op: '×' }
    ]).join(',')
  )
  check(
    'the first line seeds the total, so a tape starting with x is not silently zero',
    tapeTotal([{ value: 250, op: '×' }]) === 250 &&
      tapeTotal([{ value: 250, op: '-' }]) === -250
  )
  check(
    'dividing by zero leaves the total untouched rather than producing Infinity',
    (() => {
      const t = tapeTotal([
        { value: 500, op: '+' },
        { value: 0, op: '÷' }
      ])
      return t === 500 && Number.isFinite(t)
    })()
  )
  check(
    'a chain tape shows a Result column; an add-only tape does not',
    (() => {
      const withChain = tapeLines({
        id: 't',
        page: 'p',
        nx: 0,
        ny: 0,
        section: 1,
        entries: chain
      })
      const addOnly = tapeLines({
        id: 't',
        page: 'p',
        nx: 0,
        ny: 0,
        section: 1,
        entries: [{ value: 5, op: '+' }]
      })
      return (
        /\| × \| +539\.00$/.test(withChain[3]) &&
        withChain[withChain.length - 1].trim().endsWith('539.00') &&
        !addOnly.some((l) => l.split('|').length > 4)
      )
    })(),
    JSON.stringify(
      tapeLines({ id: 't', page: 'p', nx: 0, ny: 0, section: 1, entries: chain })
    )
  )

  // --- keying, as a pure transition. "5 x 5 =" is the case that was broken:
  //     x used to commit the figure just typed instead of arming the operator
  //     for the next one.
  const keys = (seq: string[]): TapeKeyState =>
    seq.reduce<TapeKeyState>((st, k) => tapeKeyPress(st, k), {
      entries: [],
      buffer: '',
      op: '+'
    })
  check(
    '5 x 5 = gives 25',
    tapeTotal(keys(['5', '*', '5', '=']).entries) === 25,
    JSON.stringify(keys(['5', '*', '5', '=']).entries)
  )
  check(
    'a running subtotal times a rate: 1200 + 340 + then x 0.35 = gives 539.00',
    tapeTotal(keys(['1', '2', '0', '0', '+', '3', '4', '0', '+', '*', '.', '3', '5', '=']).entries) === 539,
    String(
      tapeTotal(keys(['1', '2', '0', '0', '+', '3', '4', '0', '+', '*', '.', '3', '5', '=']).entries)
    )
  )
  check(
    '+ and - stay postfix: 1200 + 340 + 50 - totals 1490',
    tapeTotal(keys(['1', '2', '0', '0', '+', '3', '4', '0', '+', '5', '0', '-']).entries) === 1490,
    String(tapeTotal(keys(['1', '2', '0', '0', '+', '3', '4', '0', '+', '5', '0', '-']).entries))
  )
  check(
    'x stays armed until = closes it, and shows in the pending operator',
    keys(['5', '*']).op === '×' && keys(['5', '*', '5', '=']).op === '+'
  )
  check(
    'numeric keys, the decimal point and 00 all reach the buffer',
    keys(['1', '2', '.', '5']).buffer === '12.5' &&
      keys(['5', '00']).buffer === '500' &&
      keys(['.', '7']).buffer === '0.7'
  )
  check(
    'C clears everything keyed, CE only the current figure',
    keys(['5', '+', '9', 'C']).entries.length === 1 &&
      keys(['5', '+', '9', 'C']).buffer === '' &&
      keys(['5', '+', '9', 'CE']).entries.length === 1
  )
  check(
    'dividing by zero is refused at the key, leaving the tape untouched',
    (() => {
      const before = keys(['5', '0', '0', '+'])
      const after = tapeKeyPress(tapeKeyPress(before, '0'), '=')
      // 0 with a pending '+' is a legitimate zero line; the refusal is on ÷.
      const div = tapeKeyPress(tapeKeyPress({ ...before, op: '÷' }, '0'), '=')
      return after.entries.length === 2 && div.entries.length === 1
    })()
  )

  check(
    'amounts format with grouping and a leading minus',
    formatAmount(1490) === '1,490.00' &&
      formatAmount(-50.5) === '-50.50' &&
      formatAmount(0) === '0.00' &&
      formatAmount(1234567.891) === '1,234,567.89',
    [formatAmount(1490), formatAmount(-50.5), formatAmount(1234567.891)].join(' ')
  )
  const badKeys = ['', '.', '-', 'abc', '1.2.3', '1-2', ' ']
  check(
    'the 10-key buffer parses what a preparer types, and rejects the rest',
    parseAmount('1200') === 1200 &&
      parseAmount('1200.5') === 1200.5 &&
      parseAmount('1,200.50') === 1200.5 &&
      parseAmount('.75') === 0.75 &&
      parseAmount('-50') === -50 &&
      badKeys.every((k) => parseAmount(k) === null),
    badKeys.filter((k) => parseAmount(k) !== null).join(',')
  )

  let taped = { ...s, reviewer: 'CJB' } as Session
  const t1 = addTape(taped, { page: taped.pages[0].id, nx: 0.5, ny: 0.85, entries: [] })
  taped = t1.session
  for (const v of [1200, 340, -50]) taped = pushTapeEntry(taped, t1.id, v)
  check(
    'keying lines onto a tape accumulates in order',
    tapesOnPage(taped, taped.pages[0].id)[0]
      .entries.map((e) => `${e.op}${e.value}`)
      .join(',') === '+1200,+340,-50',
    JSON.stringify(tapesOnPage(taped, taped.pages[0].id)[0].entries)
  )
  check(
    'a tape carries reviewer initials and a timestamp like a mark does',
    taped.tapes![0].author === 'CJB' && typeof taped.tapes![0].created === 'string'
  )
  // Editing a keyed figure must re-foot the whole tape — the reason this
  // exists: a statement said 302.50 and the tape said 305.50.
  check(
    'correcting one line recomputes the total',
    (() => {
      let t = { ...s, reviewer: 'CJB' } as Session
      const tp = addTape(t, {
        page: t.pages[0].id,
        nx: 0.5,
        ny: 0.5,
        entries: [
          { value: 305.5, op: '+' },
          { value: 461.03, op: '-' },
          { value: 745.61, op: '+' }
        ]
      })
      t = tp.session
      const before = tapeTotal(t.tapes![0].entries)
      t = updateTapeEntry(t, tp.id, 0, { value: 302.5 })
      return before === 590.08 && tapeTotal(t.tapes![0].entries) === 587.08
    })()
  )
  check(
    'correcting a line leaves the others, and their operators, alone',
    (() => {
      let t = { ...s } as Session
      const tp = addTape(t, {
        page: t.pages[0].id,
        nx: 0.5,
        ny: 0.5,
        entries: [
          { value: 10, op: '+', note: 'first' },
          { value: 4, op: '-', note: 'second' }
        ]
      })
      t = updateTapeEntry(tp.session, tp.id, 1, { value: 6 })
      const e = t.tapes![0].entries
      return (
        e[0].value === 10 &&
        e[0].note === 'first' &&
        e[1].op === '-' &&
        e[1].note === 'second' &&
        tapeTotal(e) === 4
      )
    })()
  )

  check(
    'backspace takes back the last line only',
    popTapeEntry(taped, t1.id).tapes![0].entries.map((e) => e.value).join(',') === '1200,340'
  )
  check(
    'backspace on an empty tape is a no-op, not a crash',
    popTapeEntry(addTape(taped, { page: taped.pages[0].id, nx: 0.1, ny: 0.1, entries: [] }).session,
      't_missing') !== undefined
  )

  const titled = { ...taped, tapes: [{ ...taped.tapes![0], title: 'Repairs' }] }
  const lines = tapeLines(titled.tapes![0])
  check(
    'the tape draws the adding-machine grid: line labels, note, amount, operator',
    lines.length === 6 &&
      lines[0].startsWith('Repairs') &&
      lines[1].startsWith('1 - 0') &&
      /^1 - 1 \|.*\| +1,200\.00 \| \+$/.test(lines[2]) &&
      /^1 - 3 \|.*\| +50\.00 \| -$/.test(lines[4]) &&
      /^1 - T \| Total .*\| +1,490\.00 \| \*$/.test(lines[5]),
    JSON.stringify(lines)
  )
  check(
    'every drawn line is the same width — monospace padding IS the alignment',
    new Set(lines.map((l) => l.length)).size === 1,
    JSON.stringify(lines.map((l) => l.length))
  )
  check(
    'a tape wide enough for its total stays aligned when a longer number lands',
    (() => {
      const big = tapeLines({ ...titled.tapes![0], entries: [1, 1234567.89].map(toTapeEntry) })
      // Every drawn row is the same width, and the long figure is right-aligned
      // in the amount column rather than widening only its own row.
      return new Set(big.map((l) => l.length)).size === 1 && big.some((l) => l.includes('1,234,567.89'))
    })()
  )

  check(
    'tapes survive save/reopen with their entries intact',
    (() => {
      const rt = parseSession(JSON.parse(JSON.stringify(titled)))
      return 'session' in rt && tapeTotal(rt.session.tapes![0].entries) === 1490 &&
        rt.session.tapes![0].title === 'Repairs'
    })()
  )
  check(
    'a tape with junk entries is cleaned, not rejected — a total needs its addends',
    (() => {
      const junk = parseSession({
        ...titled,
        tapes: [{ ...titled.tapes![0], entries: [100, 'x', null, NaN, 25] }]
      })
      return (
        'session' in junk &&
        junk.session.tapes![0].entries.map((e) => e.value).join(',') === '100,25'
      )
    })()
  )
  check(
    'deleting a page takes its tapes with it',
    deletePages(taped, [taped.pages[0].id]).tapes?.length === 0
  )
  check('removeTapes drops just the named one', removeTapes(taped, [t1.id]).tapes?.length === 0)

  // --- images as pages: a receipt photo and a screenshot are workpaper pages
  //     like any other. The engine wraps them into Letter pages at export; the
  //     source files are never touched.
  const jpg = path.join(FIXTURES, 'receipt.jpg')
  const jpgRot = path.join(FIXTURES, 'receipt_rot.jpg')
  const png = path.join(FIXTURES, 'screenshot.png')
  if (!existsSync(jpg)) {
    check('image fixtures present', false, 'run spike/make_fixtures.py')
    return report()
  }

  const pj = await runEngine({ cmd: 'probe', path: jpg })
  const pjr = await runEngine({ cmd: 'probe', path: jpgRot })
  const pp = await runEngine({ cmd: 'probe', path: png })
  check(
    'probe treats an image as a one-page source',
    pj.ok && pj.probe.kind === 'image' && pj.probe.n_pages === 1 && pj.probe.outline.length === 0,
    JSON.stringify(pj.probe?.kind)
  )
  check(
    'a landscape image gets a landscape Letter page, a portrait one portrait',
    JSON.stringify(pj.probe.pages[0].mediabox) === JSON.stringify([0, 0, 792, 612]) &&
      JSON.stringify(pp.probe.pages[0].mediabox) === JSON.stringify([0, 0, 612, 792]),
    `${JSON.stringify(pj.probe.pages[0].mediabox)} ${JSON.stringify(pp.probe.pages[0].mediabox)}`
  )
  check(
    'EXIF rotation rides on the page /Rotate so the JPEG stays byte-for-byte',
    pjr.probe.pages[0].rotate === 90 && pjr.probe.image.lossless === true,
    `rotate=${pjr.probe.pages[0].rotate} lossless=${pjr.probe.image?.lossless}`
  )
  check(
    'a PNG is reported as re-encoded, and says why',
    pp.probe.image.lossless === false && /JPEG/.test(pp.probe.image.reason),
    JSON.stringify(pp.probe.image)
  )

  // The app draws the image preview itself rather than through PDF.js, so the
  // Letter framing exists twice — imageLayout() in pdf.ts and _layout() in
  // images.py. If they ever disagree, a mark placed over the picture exports
  // somewhere else, silently. Check them against each other rather than trust.
  const layoutMismatches: string[] = []
  for (const p of [pj, pjr, pp]) {
    const [pxW, pxH] = p.probe.image.pixels as [number, number]
    const rot = p.probe.pages[0].rotate as number
    const quarter = rot === 90 || rot === 270
    // TS works in DISPLAY space; the engine states the page before /Rotate.
    const [dispW, dispH] = quarter ? [pxH, pxW] : [pxW, pxH]
    const ts = imageLayout(dispW, dispH)
    const want = quarter
      ? [ts.pageH, ts.pageW, ts.y, ts.x, ts.h, ts.w]
      : [ts.pageW, ts.pageH, ts.x, ts.y, ts.w, ts.h]
    const got = [...(p.probe.image.box as number[]), ...(p.probe.image.placement as number[])]
    if (want.some((v, i) => Math.abs(v - got[i]) > 0.01)) {
      layoutMismatches.push(
        `${baseName(p.probe.path)}: app ${want.map((v) => v.toFixed(1))} vs engine ${got.map((v) => v.toFixed(1))}`
      )
    }
  }
  check(
    'the app frames an image page exactly as the engine will',
    layoutMismatches.length === 0,
    layoutMismatches.join(' | ')
  )

  let withImages: Session = newSession()
  withImages = addSource(withImages, pa.probe as ProbeWire)
  withImages = addSource(withImages, pj.probe as ProbeWire)
  withImages = addSource(withImages, pp.probe as ProbeWire)
  check(
    'the session records which sources are images',
    withImages.sources.map((s) => s.kind).join(',') === 'pdf,image,image',
    withImages.sources.map((s) => s.kind).join(',')
  )
  check(
    'an image contributes exactly one page to the binder',
    withImages.pages.length === 5,
    `pages=${withImages.pages.length}`
  )
  check(
    'source kind survives save/reopen',
    (() => {
      const rt = parseSession(JSON.parse(JSON.stringify(withImages)))
      return 'session' in rt && rt.session.sources[1].kind === 'image'
    })()
  )
  check(
    'a session written before image support still reads as all-PDF',
    (() => {
      const legacy = JSON.parse(JSON.stringify(withImages))
      for (const s of legacy.sources) delete s.kind
      const rt = parseSession(legacy)
      return 'session' in rt && rt.session.sources.every((s) => s.kind === 'pdf')
    })()
  )

  const MIXED_OUT = path.join(REPO, 'spike', 'out', 'app_binder_images.pdf')
  const mixedExport = await runEngine({
    cmd: 'export',
    binder: toExportSpec(withImages, MIXED_OUT)
  })
  check(
    'a binder mixing PDF pages and images exports cleanly',
    mixedExport.ok === true &&
      mixedExport.result.pages === 5 &&
      mixedExport.result.check_problems.length === 0,
    JSON.stringify(mixedExport.error ?? mixedExport.result?.check_problems)
  )

  // The property that matters for a photo: the picture must not come out
  // sideways. Each fixture has a red block in its top-left corner.
  const rotOut = path.join(REPO, 'spike', 'out', 'app_binder_rotimg.pdf')
  let rotOnly: Session = newSession()
  rotOnly = addSource(rotOnly, pjr.probe as ProbeWire)
  const rotExport = await runEngine({ cmd: 'export', binder: toExportSpec(rotOnly, rotOut) })
  check('an EXIF-rotated photo exports cleanly', rotExport.ok === true, String(rotExport.error))
  if (rotExport.ok) {
    // Upright, the red block sits top-LEFT. Rotated 90 CW it must be top-RIGHT.
    const corner = await runPython([
      '-c',
      [
        'import sys, numpy as np, pypdfium2 as pdfium',
        'd = pdfium.PdfDocument(sys.argv[1])',
        'img = np.asarray(d[0].render(scale=1.0).to_pil().convert("RGB")); d.close()',
        'r, g, b = (img[:, :, i].astype(int) for i in range(3))',
        'm = (r > 150) & (r > g + 60) & (r > b + 60)',
        'ys, xs = np.nonzero(m)',
        'h, w = m.shape',
        'cx, cy = xs.mean() / w, ys.mean() / h',
        'print(f"red at ({cx:.2f},{cy:.2f}) on a {w}x{h} page")',
        'sys.exit(0 if cx > 0.6 and cy < 0.4 and h > w else 1)'
      ].join('\n'),
      rotOut
    ])
    check(
      'an EXIF-rotated photo lands upright, not sideways',
      corner.code === 0,
      corner.out.trim()
    )
  }

  // --- drawn annotations: rectangle, ellipse, line, arrow, highlight, note.
  //     These are DRAGGED, so the model works in two corners rather than a
  //     point — a different shape of bug is possible and worth pinning down.
  let drawn: Session = { ...s, reviewer: 'CJB' }
  const sh1 = addShape(drawn, {
    page: drawn.pages[0].id,
    kind: 'rect',
    nx: 0.2,
    ny: 0.3,
    nx2: 0.6,
    ny2: 0.5,
    color: 'red',
    width: 2
  })
  drawn = sh1.session
  check(
    'a drawn shape keeps both corners, its color and its weight',
    (() => {
      const x = shapesOnPage(drawn, drawn.pages[0].id)[0]
      return x.nx === 0.2 && x.ny2 === 0.5 && x.color === 'red' && x.width === 2
    })()
  )
  check(
    'shapes carry reviewer initials and a timestamp like marks do',
    drawn.shapes![0].author === 'CJB' && typeof drawn.shapes![0].created === 'string'
  )
  check(
    'corners are clamped onto the page',
    (() => {
      const x = addShape(drawn, {
        page: drawn.pages[0].id,
        kind: 'line',
        nx: -3,
        ny: 0.5,
        nx2: 9,
        ny2: 0.5,
        color: 'blue',
        width: 1
      }).session.shapes!.slice(-1)[0]
      return x.nx === 0 && x.nx2 === 1
    })()
  )
  check(
    'stroke weight is clamped to the allowed range',
    updateShape(drawn, sh1.id, { width: 99 }).shapes![0].width === 8 &&
      updateShape(drawn, sh1.id, { width: 0 }).shapes![0].width === 0.5
  )
  check(
    'moving a shape slides both corners together and stops at the edge',
    (() => {
      // Pushed hard right: the shape must stop flush, not deform.
      const moved = moveShape(drawn, sh1.id, 5, 0).shapes![0]
      return (
        Math.abs(moved.nx2 - 1) < 1e-9 &&
        Math.abs(moved.nx2 - moved.nx - 0.4) < 1e-9 &&
        moved.ny === 0.3
      )
    })(),
    JSON.stringify(moveShape(drawn, sh1.id, 5, 0).shapes![0])
  )
  // Resizing: the handles rewrite corners, and a shape dragged out
  // right-to-left must still resize the way it looks, not the way it was keyed.
  const boxShape = drawn.shapes![0] // (0.2,0.3) -> (0.6,0.5)
  check(
    'dragging a corner handle moves that corner only',
    (() => {
      const r = resizeShape(boxShape, 'nw', 0.1, 0.15)
      return r.nx === 0.1 && r.ny === 0.15 && r.nx2 === 0.6 && r.ny2 === 0.5
    })(),
    JSON.stringify(resizeShape(boxShape, 'nw', 0.1, 0.15))
  )
  check(
    'a box drawn right-to-left still resizes by what you see',
    (() => {
      const backwards = { ...boxShape, nx: 0.6, ny: 0.5, nx2: 0.2, ny2: 0.3 }
      // 'se' is visually the bottom-right regardless of how it was dragged.
      const r = resizeShape(backwards, 'se', 0.8, 0.7)
      return r.nx === 0.2 && r.ny === 0.3 && r.nx2 === 0.8 && r.ny2 === 0.7
    })(),
    JSON.stringify(
      resizeShape({ ...boxShape, nx: 0.6, ny: 0.5, nx2: 0.2, ny2: 0.3 }, 'se', 0.8, 0.7)
    )
  )
  check(
    'dragging a corner past its opposite flips the box instead of inverting it',
    (() => {
      const r = resizeShape(boxShape, 'nw', 0.9, 0.9)
      return r.nx === 0.6 && r.nx2 === 0.9 && r.ny === 0.5 && r.ny2 === 0.9
    })(),
    JSON.stringify(resizeShape(boxShape, 'nw', 0.9, 0.9))
  )
  check(
    'an arrow keeps its direction when either end is dragged — the head is the second point',
    (() => {
      const arrow = { ...boxShape, kind: 'arrow' as const }
      const tail = resizeShape(arrow, 'a', 0.05, 0.05)
      const head = resizeShape(arrow, 'b', 0.95, 0.95)
      return (
        tail.nx === 0.05 && tail.nx2 === undefined && head.nx2 === 0.95 && head.nx === undefined
      )
    })()
  )

  check(
    'a stray click is not a shape, but a real drag is',
    !isDragMeaningful(0.5, 0.5, 0.5, 0.5) &&
      !isDragMeaningful(0.5, 0.5, 0.501, 0.501) &&
      isDragMeaningful(0.5, 0.5, 0.52, 0.5),
    'min-drag guard'
  )
  check(
    'shapes survive save/reopen',
    (() => {
      const rt = parseSession(JSON.parse(JSON.stringify(drawn)))
      return 'session' in rt && rt.session.shapes?.length === 1 && rt.session.shapes[0].color === 'red'
    })()
  )
  check(
    'a shape with a junk color or weight is repaired, not rejected',
    (() => {
      const junk = parseSession({
        ...drawn,
        shapes: [{ ...drawn.shapes![0], color: 'chartreuse', width: 'thick' }]
      })
      return (
        'session' in junk && junk.session.shapes![0].color === 'red' && junk.session.shapes![0].width === 1.5
      )
    })()
  )
  check(
    'deleting a page takes its shapes with it',
    deletePages(drawn, [drawn.pages[0].id]).shapes?.length === 0
  )
  check('removeShapes drops just the named one', removeShapes(drawn, [sh1.id]).shapes?.length === 0)

  // Every kind through the real engine, including the degenerate case: a
  // perfectly horizontal line has zero height, and a zero-height /BBox makes an
  // invalid annotation unless it is padded.
  let allKinds: Session = { ...s, reviewer: 'CJB' }
  const KINDS = ['rect', 'ellipse', 'line', 'arrow', 'highlight', 'textbox'] as const
  KINDS.forEach((kind, i) => {
    allKinds = addShape(allKinds, {
      page: allKinds.pages[0].id,
      kind,
      nx: 0.1,
      ny: 0.1 + i * 0.12,
      nx2: 0.6,
      // line/arrow deliberately flat -> zero height
      ny2: kind === 'line' || kind === 'arrow' ? 0.1 + i * 0.12 : 0.18 + i * 0.12,
      color: 'red',
      width: 2,
      ...(kind === 'textbox' ? { text: 'Agreed to the general ledger.' } : {})
    }).session
  })
  const SHAPES_OUT = path.join(REPO, 'spike', 'out', 'app_binder_shapes.pdf')
  const shapeExport = await runEngine({
    cmd: 'export',
    binder: toExportSpec(allKinds, SHAPES_OUT)
  })
  check(
    'every shape kind exports cleanly, flat lines included',
    shapeExport.ok === true && shapeExport.result.check_problems.length === 0,
    JSON.stringify(shapeExport.error ?? shapeExport.result?.check_problems)
  )
  if (shapeExport.ok) {
    const sp = await runEngine({ cmd: 'probe', path: SHAPES_OUT })
    const got = sp.ok
      ? sp.probe.pages
          .flatMap((p: any) => (p.annotations ?? []).filter((a: any) => a.wpt_kind))
          .map((a: any) => a.wpt_kind)
      : []
    check(
      'all six kinds land in the PDF with their metadata',
      KINDS.every((k) => got.includes(k)),
      JSON.stringify(got)
    )
  }

  // The property that matters: a shape must export where it was drawn. A red
  // rectangle alone on a page — its outline's centroid is the drag's centre.
  const RECT_OUT = path.join(REPO, 'spike', 'out', 'app_binder_rect.pdf')
  let rectOnly: Session = newSession()
  rectOnly = addSource(rectOnly, pa.probe as ProbeWire)
  rectOnly = addShape(rectOnly, {
    page: rectOnly.pages[0].id,
    kind: 'rect',
    nx: 0.3,
    ny: 0.25,
    nx2: 0.7,
    ny2: 0.55,
    color: 'red',
    width: 3
  }).session
  const rectExport = await runEngine({ cmd: 'export', binder: toExportSpec(rectOnly, RECT_OUT) })
  if (rectExport.ok) {
    const pos = await runPython([
      path.join(REPO, 'spike', 'check_mark_positions.py'),
      RECT_OUT,
      '0',
      'red',
      '0.5',
      '0.4'
    ])
    check('a drawn rectangle exports centred where it was dragged', pos.code === 0, pos.out.trim())
  } else {
    check('a drawn rectangle exports centred where it was dragged', false, String(rectExport.error))
  }

  // --- re-assigning a bookmark to another page
  check(
    'a user bookmark can be moved to another page',
    (() => {
      const add = addBookmark(solo, solo.pages[0].id, 'Ledger')
      const moved = assignBookmarkPage(add.session, add.key, solo.pages[2].id)
      const node = buildBookmarks(moved).find((b) => b.key === add.key)
      return node?.page === solo.pages[2].id
    })()
  )
  check(
    'an imported bookmark re-targets through an override, leaving the source alone',
    (() => {
      const key = buildBookmarks(solo)[0].key // an imported node
      const moved = assignBookmarkPage(solo, key, solo.pages[2].id)
      const node = buildBookmarks(moved).find((b) => b.key === key)
      // The override moved it, and the source outline is untouched.
      return (
        node?.page === solo.pages[2].id &&
        moved.sources[0].outline === solo.sources[0].outline &&
        moved.bookmarkPages?.[key] === solo.pages[2].id
      )
    })()
  )
  check(
    'clearing the override sends an imported bookmark home',
    (() => {
      const key = buildBookmarks(solo)[0].key
      const home = buildBookmarks(solo).find((b) => b.key === key)?.page
      const moved = assignBookmarkPage(solo, key, solo.pages[2].id)
      const back = clearBookmarkPage(moved, key)
      return buildBookmarks(back).find((b) => b.key === key)?.page === home
    })()
  )
  check(
    're-assignment survives save/reopen and a reorder',
    (() => {
      const key = buildBookmarks(solo)[0].key
      const target = solo.pages[2].id
      const moved = assignBookmarkPage(solo, key, target)
      const rt = parseSession(JSON.parse(JSON.stringify(moved)))
      if (!('session' in rt)) return false
      // Anchored to a page ID, so moving that page carries the bookmark along.
      const reordered = movePages(rt.session, [target], 0)
      return buildBookmarks(reordered).find((b) => b.key === key)?.page === target
    })()
  )
  check(
    'an override onto a deleted page is dropped, not left dangling',
    (() => {
      const key = buildBookmarks(solo)[0].key
      const moved = assignBookmarkPage(solo, key, solo.pages[2].id)
      const gone = deletePages(moved, [solo.pages[2].id])
      // Falls back to the imported destination rather than vanishing.
      return gone.bookmarkPages?.[key] === undefined && buildBookmarks(gone).length > 0
    })()
  )
  check(
    'assigning to a page that is not in the binder is refused',
    assignBookmarkPage(solo, buildBookmarks(solo)[0].key, 'pg_nope') === solo
  )

  // --- page numbering: derived from binder ORDER, never stored per page
  const NUM = numbering({ ...s, numbering: { ...numbering(s), enabled: true } })
  check(
    'the three numbering styles print what they say',
    formatPageNumber(0, 62, { ...NUM, style: 'number', start: 1 }) === '1' &&
      formatPageNumber(13, 62, { ...NUM, style: 'pageOfTotal', start: 1 }) === 'Page 14 of 62' &&
      formatPageNumber(13, 62, { ...NUM, style: 'bates', prefix: 'WP-', digits: 6 }) ===
        'WP-000014',
    formatPageNumber(13, 62, { ...NUM, style: 'bates', prefix: 'WP-', digits: 6 })
  )
  check(
    'a start offset carries through every style',
    formatPageNumber(0, 3, { ...NUM, style: 'number', start: 100 }) === '100' &&
      formatPageNumber(2, 3, { ...NUM, style: 'pageOfTotal', start: 100 }) === 'Page 102 of 102',
    formatPageNumber(2, 3, { ...NUM, style: 'pageOfTotal', start: 100 })
  )
  check(
    'numbering is off unless asked for — no silent stamping on an export',
    toExportSpec(s, 'x.pdf').annotations.filter((a) => a.kind === 'pagenumber').length === 0
  )
  check(
    'every page gets exactly one number, in binder order',
    (() => {
      const numbered = { ...s, numbering: { ...numbering(s), enabled: true } }
      const anns = toExportSpec(numbered, 'x.pdf').annotations.filter(
        (a) => a.kind === 'pagenumber'
      )
      return (
        anns.length === s.pages.length &&
        anns.map((a) => a.text).join(',') ===
          s.pages.map((_, i) => String(i + 1)).join(',')
      )
    })()
  )
  check(
    'REORDERING RENUMBERS — the reason numbers are not stored per page',
    (() => {
      const numbered = { ...s, numbering: { ...numbering(s), enabled: true } }
      const before = toExportSpec(numbered, 'x.pdf').annotations.filter(
        (a) => a.kind === 'pagenumber'
      )
      const firstId = numbered.pages[0].id
      const moved = movePages(numbered, [firstId], numbered.pages.length)
      const after = toExportSpec(moved, 'x.pdf').annotations.filter((a) => a.kind === 'pagenumber')
      // The page that was "1" must now print the last number, not carry a 1.
      const wasFirst = after.find((a) => a.page === firstId)
      return (
        before.find((a) => a.page === firstId)?.text === '1' &&
        wasFirst?.text === String(moved.pages.length)
      )
    })()
  )

  // --- the armed-tool cursor: the mark drawn at the point of aim
  check(
    'a stamp tool gives a cursor of its own glyph, centred on the click',
    (() => {
      const c = markCursor('tick')
      return (
        c.startsWith('url("data:image/svg+xml,') &&
        // 16 16 is the hotspot: a mark is centred on the point clicked.
        c.endsWith('") 16 16, crosshair') &&
        decodeURIComponent(c).includes('✓')
      )
    })(),
    markCursor('tick').slice(0, 48)
  )
  check(
    'a lettered stamp uses its letters, XML-escaped so odd ones cannot break the SVG',
    (() => {
      const c = decodeURIComponent(markCursor('text', 'A&R'))
      return c.includes('A&amp;R') && !c.includes('A&R')
    })(),
    decodeURIComponent(markCursor('text', 'A&R')).slice(-90)
  )
  check(
    'longer stamps shrink to fit the 32px cursor macOS will actually draw',
    (() => {
      const one = decodeURIComponent(markCursor('text', 'F'))
      const four = decodeURIComponent(markCursor('text', 'ABCD'))
      const sz = (x: string): number => Number(/font-size="([\d.]+)"/.exec(x)?.[1] ?? 0)
      return sz(four) < sz(one) && sz(four) >= 9
    })()
  )
  check(
    'the cursor falls back to a crosshair, so a tool is never invisible',
    markCursor('cross').includes(', crosshair')
  )

  // --- page status: one state per page, drawn three ways
  let stat: Session = { ...s, reviewer: 'CJB' }
  const p0 = stat.pages[0].id
  const p1 = stat.pages[1].id
  stat = setPageStatus(stat, [p0, p1], 'reviewed', 'CJB')
  check(
    'a status records who set it and when',
    stat.statuses![p0].status === 'reviewed' &&
      stat.statuses![p0].by === 'CJB' &&
      typeof stat.statuses![p0].at === 'string'
  )
  check(
    'applying a second status REPLACES the first — a page is in one state',
    (() => {
      const again = setPageStatus(stat, [p0], 'open', 'CJB')
      return again.statuses![p0].status === 'open' && again.statuses![p1].status === 'reviewed'
    })()
  )
  check(
    'counts add up to the page count',
    (() => {
      const c = statusCounts(stat)
      return c.byId.reviewed === 2 && c.unset === stat.pages.length - 2
    })(),
    JSON.stringify(statusCounts(stat))
  )
  check('clearing a status leaves the page unset', !clearPageStatus(stat, [p0]).statuses![p0])
  check(
    'deleting a page takes its status with it',
    deletePages(stat, [p0]).statuses?.[p0] === undefined
  )
  check(
    'statuses survive save/reopen, and one on a deleted page is dropped',
    (() => {
      const rt = parseSession(JSON.parse(JSON.stringify(stat)))
      if (!('session' in rt)) return false
      const junk = parseSession({ ...stat, statuses: { ...stat.statuses, pg_nope: { status: 'reviewed' } } })
      return (
        rt.session.statuses![p0].status === 'reviewed' &&
        'session' in junk &&
        junk.session.statuses!.pg_nope === undefined
      )
    })()
  )
  check(
    'a status colours the bookmark of its page, and only that one',
    (() => {
      const tree = buildBookmarks(stat)
      const def = statusOf(stat, tree[0].page)
      return def ? tree[0].color === def.color && tree[0].bold === true : tree[0].color === undefined
    })(),
    JSON.stringify(buildBookmarks(stat).map((b) => [b.title, b.color ?? null]))
  )
  check(
    'turning the bookmark part off leaves the outline unstyled',
    buildBookmarks({ ...stat, statusParts: { ...statusParts(stat), bookmark: false } }).every(
      (b) => b.color === undefined
    )
  )
  const statSpec = toExportSpec(stat, path.join(REPO, 'spike', 'out', 'app_status.pdf'))
  check(
    'a status exports as a stamp AND a page border',
    statSpec.annotations.filter((a) => a.kind === 'statusstamp').length === 2 &&
      statSpec.annotations.filter((a) => a.kind === 'pageborder').length === 2,
    JSON.stringify(statSpec.annotations.map((a) => a.kind))
  )
  check(
    'switching a part off stops it being drawn, without touching the status',
    (() => {
      const noBorder = toExportSpec(
        { ...stat, statusParts: { ...statusParts(stat), border: false } },
        'x.pdf'
      )
      return (
        noBorder.annotations.filter((a) => a.kind === 'pageborder').length === 0 &&
        noBorder.annotations.filter((a) => a.kind === 'statusstamp').length === 2
      )
    })()
  )
  const statExport = await runEngine({
    cmd: 'export',
    binder: toExportSpec(stat, path.join(REPO, 'spike', 'out', 'app_status.pdf'))
  })
  check(
    'the engine exports statuses cleanly',
    statExport.ok === true && statExport.result.check_problems.length === 0,
    JSON.stringify(statExport.error ?? statExport.result?.check_problems)
  )

  // --- the real thing: export through the engine and re-probe.
  //     A tape rides along, low on the page so it can't overlap the marks the
  //     pixel checks below are looking for.
  const exportTape = addTape(marked, {
    page: marked.pages[0].id,
    nx: 0.5,
    ny: 0.85,
    entries: [1200, 340, -50].map(toTapeEntry),
    title: 'Repairs'
  })
  marked = exportTape.session

  const spec = toExportSpec(marked, OUT)
  check('spec only lists used sources', Object.keys(spec.sources).length === 2)
  check(
    'export spec carries every used source fingerprint',
    Object.keys(spec.source_fingerprints ?? {}).length === Object.keys(spec.sources).length
  )
  check('spec carries marks and tapes as annotations', spec.annotations.length === 3,
    JSON.stringify(spec.annotations.map((a) => a.kind)))
  const tapeSpec = spec.annotations.find((a) => a.kind === 'tape') as any
  check(
    'the tape spec carries BOTH the drawn lines and the structured entries',
    Array.isArray(tapeSpec?.lines) &&
      /^1 - T \| Total .*\| +1,490\.00 \| \*$/.test(tapeSpec.lines[tapeSpec.lines.length - 1]) &&
      tapeSpec.tape.entries.map((e: any) => `${e.op}${e.value}`).join(',') === '+1200,+340,-50' &&
      tapeSpec.tape.total === 1490,
    JSON.stringify(tapeSpec?.tape)
  )
  const exported = await runEngine({ cmd: 'export', binder: spec })
  check('engine accepts app-built spec', exported.ok === true, String(exported.error ?? '').slice(0, 300))
  if (!exported.ok) return report()

  const wrongIdentity = structuredClone(spec)
  const fingerprintId = Object.keys(wrongIdentity.source_fingerprints ?? {})[0]
  if (fingerprintId) wrongIdentity.source_fingerprints![fingerprintId].sha256 = '0'.repeat(64)
  const priorOutput = await readFile(OUT)
  wrongIdentity.output = OUT
  const refused = await runEngine({ cmd: 'export', binder: wrongIdentity })
  check(
    'engine refuses a source whose bytes no longer match the reviewed file',
    refused.ok === false && /source changed since import/i.test(refused.error ?? ''),
    String(refused.error ?? '').slice(0, 240)
  )
  check(
    'a failed export preserves the previous complete binder',
    (await readFile(OUT)).equals(priorOutput)
  )
  check(
    'failed/successful exports leave no temporary PDF behind',
    !(await readdir(path.dirname(OUT))).some((name) => name.endsWith('.tmp.pdf'))
  )

  const overwriteSource = structuredClone(spec)
  overwriteSource.output = Object.values(overwriteSource.sources)[0]
  const protectedSource = await runEngine({ cmd: 'export', binder: overwriteSource })
  check(
    'export can never overwrite one of its source files',
    protectedSource.ok === false && /must not overwrite a source/i.test(protectedSource.error ?? '')
  )
  check(
    'exported page count + clean check',
    exported.result.pages === 5 && exported.result.check_problems.length === 0,
    `pages=${exported.result.pages} problems=${JSON.stringify(exported.result.check_problems)}`
  )

  const out = await runEngine({ cmd: 'probe', path: OUT })
  check('exported binder probes', out.ok === true)
  if (!out.ok) return report()

  // rotation delta landed: page a[0] had /Rotate 0 + 180 delta
  const finalIdx = spec.pages.findIndex((p) => p.id === aIds[0])
  check(
    'user rotation applied on export',
    out.probe.pages[finalIdx].rotate === 180,
    `idx${finalIdx} rotate=${out.probe.pages[finalIdx].rotate}`
  )

  // B's source page 0 kept its own /Rotate 0; B page 2 is legal-size — provenance
  const heights = out.probe.pages.map((p: any) => Math.round(p.mediabox[3] - p.mediabox[1]))
  check('page provenance survives export', heights.includes(1008), `heights=${heights}`)

  // Bookmarks resolved to final indexes. Binder order after the reorder and the
  // B-page-1 deletion is [B0, B2, A0, A1, A2], so:
  //   fixture_b.pdf -> 0, its surviving imported "Schedule X" -> 0
  //   fixture_a.pdf -> 2 (A has no outline of its own)
  const got = flatten(out.probe.outline)
  const want: Array<[number, string, number | null]> = [
    [0, 'fixture_b', 0],
    [1, 'Schedule X', 0],
    [0, 'fixture_a', 2]
  ]
  check('exported bookmarks retargeted', JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got))

  // marks made it into the PDF with their structured payload intact
  const exportedMarks = out.probe.pages.flatMap((p: any) =>
    (p.annotations ?? []).filter((a: any) => a.wpt_kind)
  )
  check(
    'marks land in the exported PDF with metadata',
    exportedMarks.length === 3 &&
      exportedMarks.filter((m: any) => m.wpt_kind !== 'tape').every(
        (m: any) => m.has_ap && m.wpt_data?.author === 'CJB'
      ) &&
      exportedMarks.some((m: any) => m.wpt_data?.text === 'F'),
    JSON.stringify(exportedMarks.map((m: any) => [m.wpt_kind, m.wpt_data?.author, m.wpt_data?.text]))
  )
  const exportedTape = exportedMarks.find((m: any) => m.wpt_kind === 'tape')
  check(
    'the tape exports with its addends, not just its total',
    !!exportedTape &&
      exportedTape.has_ap &&
      exportedTape.wpt_data?.total === 1490 &&
      exportedTape.wpt_data?.entries?.map((e: any) => `${e.op}${e.value}`).join(',') === '+1200,+340,-50' &&
      exportedTape.wpt_data?.title === 'Repairs',
    JSON.stringify(exportedTape?.wpt_data)
  )

  // --- Phase 2 remainder: flatten-on-export
  //
  // The property that matters: flattening changes WHERE the mark lives in the
  // file (page content, not an annotation) and must not change WHERE it lands
  // on the sheet. `marked` has a green tick at (0.9, 0.1) and a blue "F" at
  // (0.3, 0.6), both on the binder's first page.
  const flatSpec = toExportSpec(marked, OUT_FLAT, { flatten: true })
  check('flatten flag reaches the engine spec', flatSpec.flatten === true)
  check(
    'an ordinary export does not carry the flag at all',
    toExportSpec(marked, OUT).flatten === undefined
  )

  const flatExport = await runEngine({ cmd: 'export', binder: flatSpec })
  check(
    'engine exports a flattened binder cleanly — marks AND tapes',
    flatExport.ok === true &&
      flatExport.result.pages === 5 &&
      flatExport.result.marks === 3 &&
      flatExport.result.flattened === true &&
      flatExport.result.check_problems.length === 0,
    JSON.stringify(flatExport.error ?? flatExport.result?.check_problems)
  )

  if (flatExport.ok) {
    const flatProbe = await runEngine({ cmd: 'probe', path: OUT_FLAT })
    const leftover = flatProbe.ok
      ? flatProbe.probe.pages.flatMap((p: any) => (p.annotations ?? []).filter((a: any) => a.wpt_kind))
      : [null]
    check(
      'a flattened binder carries no mark annotations at all',
      leftover.length === 0,
      JSON.stringify(leftover.map((m: any) => m?.wpt_kind))
    )

    // Rendered with pdfium (Chrome/Edge's engine) — same coordinates as the
    // annotated export, checked pixel-side rather than trusted.
    const args = ['0', 'green', '0.9', '0.1', 'blue', '0.3', '0.6']
    const script = path.join(REPO, 'spike', 'check_mark_positions.py')
    const annotPos = await runPython([script, OUT, ...args])
    const flatPos = await runPython([script, OUT_FLAT, ...args])
    check(
      'flattened marks land exactly where the annotated ones do',
      annotPos.code === 0 && flatPos.code === 0,
      flatPos.out.trim().split('\n').join(' | ')
    )

    // The proof that it is really page content: render with annotations turned
    // OFF. The annotated binder goes blank; the flattened one still shows.
    const isContent = await runPython([
      '-c',
      [
        'import sys, numpy as np, pypdfium2 as pdfium',
        'def green(p):',
        '    d = pdfium.PdfDocument(p)',
        '    img = np.asarray(d[0].render(scale=2.0, draw_annots=False).to_pil().convert("RGB"))',
        '    d.close()',
        '    r, g, b = (img[:, :, i].astype(int) for i in range(3))',
        '    return int(((g > 90) & (g > r + 30) & (g > b + 30)).sum())',
        'a, f = green(sys.argv[1]), green(sys.argv[2])',
        'print(f"annots-off pixels: annotated={a} flattened={f}")',
        'sys.exit(0 if a == 0 and f > 50 else 1)'
      ].join('\n'),
      OUT,
      OUT_FLAT
    ])
    check(
      'flattened marks are page content, not annotations',
      isContent.code === 0,
      isContent.out.trim()
    )
  }

  return report()
}

function report(): number {
  console.log('\n=== binder model verification ===')
  let fails = 0
  for (const [name, ok, detail] of results) {
    if (!ok) fails++
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? `  — ${detail}` : ''}`)
  }
  console.log(`\n${results.length - fails}/${results.length} checks passed`)
  return fails ? 1 : 0
}

main().then((code) => process.exit(code))
