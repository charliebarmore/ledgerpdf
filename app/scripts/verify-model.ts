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
import path from 'node:path'
import {
  SESSION_FORMAT_VERSION,
  addBookmark,
  addMark,
  addSource,
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
  marksByPage,
  marksOnPage,
  removeBookmark,
  removeMarks,
  removeStamp,
  removeTapes,
  rotatePages,
  sanitizeTitle,
  setBookmarkTitle,
  tapeLines,
  tapeTotal,
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
    tapeTotal([0.1, 0.2]) === 0.3 &&
      tapeTotal([1200, 340, -50]) === 1490 &&
      tapeTotal([1.005, 2.005]) === 3.01 &&
      tapeTotal([]) === 0,
    `${tapeTotal([0.1, 0.2])} ${tapeTotal([1.005, 2.005])}`
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
    tapesOnPage(taped, taped.pages[0].id)[0].entries.join(',') === '1200,340,-50',
    String(tapesOnPage(taped, taped.pages[0].id)[0].entries)
  )
  check(
    'a tape carries reviewer initials and a timestamp like a mark does',
    taped.tapes![0].author === 'CJB' && typeof taped.tapes![0].created === 'string'
  )
  check(
    'backspace takes back the last line only',
    popTapeEntry(taped, t1.id).tapes![0].entries.join(',') === '1200,340'
  )
  check(
    'backspace on an empty tape is a no-op, not a crash',
    popTapeEntry(addTape(taped, { page: taped.pages[0].id, nx: 0.1, ny: 0.1, entries: [] }).session,
      't_missing') !== undefined
  )

  const titled = { ...taped, tapes: [{ ...taped.tapes![0], title: 'Repairs' }] }
  const lines = tapeLines(titled.tapes![0])
  check(
    'the tape draws caption, right-aligned amounts, a rule and the total',
    lines.length === 6 &&
      lines[0].startsWith('Repairs') &&
      lines[1] === '1,200.00' &&
      lines[2] === '  340.00' &&
      lines[3] === '  -50.00' &&
      /^-+$/.test(lines[4]) &&
      lines[5] === '1,490.00',
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
      const big = tapeLines({ ...titled.tapes![0], entries: [1, 1234567.89] })
      return new Set(big.map((l) => l.length)).size === 1 && big[2] === '1,234,567.89'
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
      return 'session' in junk && junk.session.tapes![0].entries.join(',') === '100,25'
    })()
  )
  check(
    'deleting a page takes its tapes with it',
    deletePages(taped, [taped.pages[0].id]).tapes?.length === 0
  )
  check('removeTapes drops just the named one', removeTapes(taped, [t1.id]).tapes?.length === 0)

  // --- the real thing: export through the engine and re-probe.
  //     A tape rides along, low on the page so it can't overlap the marks the
  //     pixel checks below are looking for.
  const exportTape = addTape(marked, {
    page: marked.pages[0].id,
    nx: 0.5,
    ny: 0.85,
    entries: [1200, 340, -50],
    title: 'Repairs'
  })
  marked = exportTape.session

  const spec = toExportSpec(marked, OUT)
  check('spec only lists used sources', Object.keys(spec.sources).length === 2)
  check('spec carries marks and tapes as annotations', spec.annotations.length === 3,
    JSON.stringify(spec.annotations.map((a) => a.kind)))
  const tapeSpec = spec.annotations.find((a) => a.kind === 'tape') as any
  check(
    'the tape spec carries BOTH the drawn lines and the structured entries',
    Array.isArray(tapeSpec?.lines) &&
      tapeSpec.lines[tapeSpec.lines.length - 1].trim() === '1,490.00' &&
      tapeSpec.tape.entries.join(',') === '1200,340,-50' &&
      tapeSpec.tape.total === 1490,
    JSON.stringify(tapeSpec?.tape)
  )
  const exported = await runEngine({ cmd: 'export', binder: spec })
  check('engine accepts app-built spec', exported.ok === true, String(exported.error ?? '').slice(0, 300))
  if (!exported.ok) return report()
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
      exportedTape.wpt_data?.entries?.join(',') === '1200,340,-50' &&
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
