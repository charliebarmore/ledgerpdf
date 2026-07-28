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
  buildBookmarks,
  deletePages,
  movePages,
  newSession,
  nudgeBookmarkDepth,
  parseSession,
  marksOnPage,
  removeBookmark,
  removeMarks,
  rotatePages,
  sanitizeTitle,
  setBookmarkTitle,
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

  // --- the real thing: export through the engine and re-probe
  const spec = toExportSpec(marked, OUT)
  check('spec only lists used sources', Object.keys(spec.sources).length === 2)
  check('spec carries the marks as annotations', spec.annotations.length === 2,
    JSON.stringify(spec.annotations.map((a) => a.kind)))
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
    exportedMarks.length === 2 &&
      exportedMarks.every((m: any) => m.has_ap && m.wpt_data?.author === 'CJB') &&
      exportedMarks.some((m: any) => m.wpt_data?.text === 'F'),
    JSON.stringify(exportedMarks.map((m: any) => [m.wpt_kind, m.wpt_data?.author, m.wpt_data?.text]))
  )

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
