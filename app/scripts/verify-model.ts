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
import { readFile, readdir, stat as statFile } from 'node:fs/promises'
import path from 'node:path'
import {
  SESSION_FORMAT_VERSION,
  CONN_STROKE_RATIO,
  connectorFontSize,
  legendEntries,
  legendMarkdown,
  nextConnectorLabel,
  placeConnector,
  setLegend,
  baseName,
  imageLayout,
  addBookmark,
  addLink,
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
  pageForSourceIndex,
  refNote,
  newSession,
  normalizeStamp,
  nudgeBookmarkDepth,
  parseAmount,
  parseSession,
  rebindToBinder,
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
  agentWork,
  agentCreatedItems,
  formatCents,
  parseMoney,
  bookmarkSection,
  moveBookmarkSection,
  beginRun,
  endRun,
  record,
  revertRun,
  revertibleRunItems,
  toSaved,
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
// The command we tell the reader to run has to be the one their shell accepts.
// A venv is `bin/` on POSIX and `Scripts\` on Windows, so a hardcoded POSIX
// hint sends a Windows reader to a path that does not exist.
const RUN_SPIKE =
  process.platform === 'win32'
    ? 'engine\\.venv\\Scripts\\python spike\\run_spike.py'
    : 'engine/.venv/bin/python spike/run_spike.py'
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
    console.error(`fixtures missing — run: ${RUN_SPIKE}`)
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

  // --- link destinations resolve through the BINDER, not the source index
  //
  // A /Link points at a page of its own document. After the reorder above, B's
  // pages sit at the front, so source index and binder position deliberately
  // disagree — which is the whole reason this lookup exists. Asserting on an
  // unreordered binder would pass with `pages[index]` and prove nothing.
  {
    const srcB = s.sources[1].id
    const hit = pageForSourceIndex(s, srcB, 2)
    check(
      'a link destination resolves to the binder page holding that source page',
      hit !== undefined && hit.source === srcB && hit.index === 2,
      hit ? `binder position ${s.pages.indexOf(hit) + 1}, source index ${hit.index}` : 'not found'
    )
    // The bug this guards: using the destination as a binder index. It must be
    // asserted where the two genuinely diverge. B's pages moved to the front
    // AS A BLOCK, so for B source index and binder index still coincide — the
    // first version of this check used B and failed for that reason, which is
    // the check being specific rather than the lookup being wrong. A's pages
    // now start at position 4, so A's source index 2 is binder position 6.
    const srcA = s.sources[0].id
    const hitA = pageForSourceIndex(s, srcA, 2)
    check(
      'and a destination is NOT read as a binder index',
      hitA !== undefined && s.pages[2].id !== hitA.id && s.pages.indexOf(hitA) === 5,
      `source index 2 of A -> binder position ${hitA ? s.pages.indexOf(hitA) + 1 : '?'}, ` +
        `while pages[2] is ${s.pages[2].id}`
    )
    check(
      'a destination outside the binder resolves to nothing, rather than a wrong page',
      pageForSourceIndex(s, srcB, 99) === undefined
    )
    check(
      'a destination in an unknown source resolves to nothing',
      pageForSourceIndex(s, 'no-such-source', 0) === undefined
    )
  }

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

  // --- money. A figure read wrong in a tie-out does not fail, it AGREES
  // confidently, so every shape a workpaper writes is pinned down.
  {
    const reads: Array<[string, number | null, string?]> = [
      ['1,203.26', 120326],
      ['84,200.00', 8420000],
      ['0.01', 1],
      ['.5', 50],
      ['$1,203.26', 120326],
      ['1203.26', 120326],
      ['-350.67', -35067],
      ['(350.67)', -35067, 'parentheses'],
      ['350.67-', -35067, 'trailing minus'],
      ['(1,203.26)', -120326, 'parentheses'],
      ['1,203.2', 120320],
      ['1,203', 120300],
      ['\u2212350.67', -35067],
      ['1 203.26', 120326],
      // Not money, and must not be guessed at.
      ['', null],
      ['abc', null],
      ['1,2', null],
      ['1,23,456', null],
      ['12,34.5', null],
      ['--5', null],
      ['1.2.3', null]
    ]
    let bad = 0
    for (const [raw, want, why] of reads) {
      const got = parseMoney(raw)
      const ok = want === null ? got === null : got?.cents === want
      if (!ok) {
        bad++
        check(`parseMoney(${JSON.stringify(raw)})`, false, `got ${JSON.stringify(got)}, wanted ${want}`)
      } else if (why && !(got?.as ?? '').includes(why)) {
        bad++
        check(`parseMoney(${JSON.stringify(raw)}) explains itself`, false, got?.as ?? 'no note')
      }
    }
    check(`every money shape a workpaper writes reads correctly`, bad === 0, `${reads.length - bad}/${reads.length}`)
    check(
      'more precision than money has is rounded, and says so',
      parseMoney('1.005')?.cents === 101 && (parseMoney('1.005')?.as ?? '').includes('rounded'),
      JSON.stringify(parseMoney('1.005'))
    )
    check('cents come back the way a workpaper writes them', formatCents(-120326) === '(1,203.26)', formatCents(-120326))
    check(
      'a difference computes exactly, with no float drift',
      parseMoney('0.1')!.cents + parseMoney('0.2')!.cents === parseMoney('0.30')!.cents,
      `${parseMoney('0.1')!.cents} + ${parseMoney('0.2')!.cents}`
    )
  }

  // --- dragging a bookmark moves its SECTION. Getting the span wrong here
  // scrambles a binder silently, so the boundaries are asserted directly.
  {
    let w = s
    const order = () => w.pages.map((p) => p.id).join(',')
    const before = order()
    const tree = buildBookmarks(w)
    const first = tree[0]
    const second = tree[1]
    check('two file-level bookmarks to move between', !!first && !!second, tree.map((t) => t.title).join(' | '))

    const section = bookmarkSection(w, second.key)
    check(
      "a bookmark's section is the pages it is labelled as owning",
      section.length > 0 && section.every((id) => w.pages.some((p) => p.id === id)),
      `${section.length} page(s)`
    )
    check(
      "a section is a contiguous run, not a scatter",
      (() => {
        const idx = section.map((id) => w.pages.findIndex((p) => p.id === id))
        return idx.every((v, i) => i === 0 || v === idx[i - 1] + 1)
      })(),
      section.join(',')
    )

    // A parent carries its children: their pages are inside its span.
    const parentSection = bookmarkSection(w, first.key)
    // Pick whichever file-level node actually has an imported outline, or the
    // nesting assertion below silently never runs.
    const nested = tree.find((t) => t.children.length > 0)
    const childKeys = nested ? nested.children.map((c) => c.key) : []
    check(
      "the two file-level sections do not overlap",
      !parentSection.some((id) => section.includes(id)),
      `${parentSection.length} + ${section.length} of ${w.pages.length}`
    )
    check('the fixture provides a nested outline to test with', childKeys.length > 0)
    if (nested && childKeys.length) {
      const parentPages = bookmarkSection(w, nested.key)
      const childPages = bookmarkSection(w, childKeys[0])
      check(
        "a nested bookmark's pages sit inside its parent's section",
        childPages.length > 0 && childPages.every((id) => parentPages.includes(id)),
        `${childPages.length} in ${parentPages.length}`
      )
    }

    // Move the second section to the front; the pages move as a block.
    w = moveBookmarkSection(w, second.key, first.key)
    check(
      'moving a bookmark moves its pages to the front as one block',
      w.pages.slice(0, section.length).map((p) => p.id).join(',') === section.join(','),
      order()
    )
    check(
      'no page is lost or duplicated by the move',
      w.pages.length === s.pages.length &&
        new Set(w.pages.map((p) => p.id)).size === w.pages.length,
      `${w.pages.length} vs ${s.pages.length}`
    )

    // Dropping a section onto itself must be a no-op, not a scramble.
    const same = moveBookmarkSection(w, second.key, second.key)
    check('dropping a bookmark on itself changes nothing', same === w)
    const inside = nested
      ? moveBookmarkSection(w, nested.key, bookmarkSection(w, nested.key).length ? childKeys[0] : nested.key)
      : w
    check('dropping a section inside itself changes nothing', inside === w)
    check('an unknown bookmark key is refused', moveBookmarkSection(w, 'nope', null) === w)

    // And to the end.
    w = moveBookmarkSection(w, second.key, null)
    check(
      'a section can be moved to the end of the binder',
      w.pages.slice(-section.length).map((p) => p.id).join(',') === section.join(','),
      order()
    )
    check('the binder still holds every page it started with', w.pages.length === s.pages.length, before)
  }

  // --- attribution: a workpaper is evidence, so agent work must be findable
  // and removable without touching a person's.
  {
    let w = s
    const marksBefore = w.marks?.length ?? 0
    // A person places a mark: no run open, so nothing extra is recorded.
    w = addMark(w, { page: w.pages[0].id, kind: 'tick', nx: 0.1, ny: 0.1, size: 24 }).session
    const human = w.marks![w.marks!.length - 1]
    check('a human mark carries no agent attribution', !human.by && !human.run, JSON.stringify(human.by))
    check('a human action writes nothing to the journal', (w.journal ?? []).length === 0)

    const begun = beginRun(w)
    w = begun.session
    w = record(w, { action: 'place_mark', what: 'Ticked 84,200.00' })
    w = addMark(w, { page: w.pages[0].id, kind: 'tick', nx: 0.2, ny: 0.2, size: 24 }).session
    w = addTape(w, {
      page: w.pages[0].id,
      nx: 0.5,
      ny: 0.5,
      entries: [1, 2].map(toTapeEntry)
    }).session
    w = addShape(w, {
      page: w.pages[0].id,
      kind: 'rect',
      nx: 0.1,
      ny: 0.1,
      nx2: 0.2,
      ny2: 0.2,
      color: 'red',
      width: 1.5
    }).session
    w = addLink(w, {
      page: w.pages[0].id,
      target: w.pages[1].id,
      rect: [0.1, 0.1, 0.2, 0.2],
      label: 'Test link'
    }).session
    w = addBookmark(w, w.pages[0].id, 'Agent bookmark').session
    const agentMark = w.marks![w.marks!.length - 1]
    check(
      'a mark made during a run is stamped with the agent and the run',
      agentMark.by === 'agent' && agentMark.run === begun.run,
      `${agentMark.by} ${agentMark.run}`
    )
    check(
      'agentWork separates every kind of item the agent made',
      agentWork(w).marks === 1 &&
        agentWork(w).tapes === 1 &&
        agentWork(w).shapes === 1 &&
        agentWork(w).links === 1 &&
        agentWork(w).bookmarks === 1,
      JSON.stringify(agentWork(w))
    )
    check(
      'the status total is AI-created marks, tapes and shapes — links are not double-counted',
      agentCreatedItems(w) === 3,
      `${agentCreatedItems(w)} AI-created page item(s)`
    )
    check(
      'the history Undo count includes every item revertRun will remove',
      revertibleRunItems(w, begun.run) === 5,
      `${revertibleRunItems(w, begun.run)} item(s)`
    )

    // Structural changes are recorded as unrevertible rather than pretended.
    w = record(w, { action: 'move_pages', what: 'Moved 2 pages', structural: true })
    const reverted = revertRun(w, begun.run)
    check(
      'reverting a run removes the agent items',
      (reverted.session.marks?.length ?? 0) === marksBefore + 1 &&
        (reverted.session.tapes?.length ?? 0) === (s.tapes?.length ?? 0) &&
        (reverted.session.shapes?.length ?? 0) === (s.shapes?.length ?? 0) &&
        (reverted.session.links?.length ?? 0) === (s.links?.length ?? 0) &&
        (reverted.session.bookmarks?.length ?? 0) === (s.bookmarks?.length ?? 0) &&
        reverted.removed === 5,
      `${reverted.session.marks?.length} marks left, removed ${reverted.removed}`
    )
    check(
      "reverting leaves the person's own mark alone",
      reverted.session.marks!.some((m) => m.id === human.id),
      'human mark survived'
    )
    check(
      'reverting reports the structural changes it could not undo',
      reverted.structural.length === 1 && reverted.structural[0].what.includes('Moved'),
      JSON.stringify(reverted.structural.map((e) => e.what))
    )
    check(
      'the revert is itself recorded',
      reverted.session.journal!.at(-1)!.action === 'revert_run',
      reverted.session.journal!.at(-1)!.what
    )
    check('endRun clears the active run', !endRun(w).activeRun)

    // The audit trail must survive a save/reopen round trip; the active run
    // must NOT, or a person's later edits get stamped as the agent's.
    const round = parseSession(JSON.parse(JSON.stringify(w)))
    check(
      'the journal survives save and reopen',
      'session' in round && (round.session.journal?.length ?? 0) === (w.journal?.length ?? 0),
      'session' in round ? String(round.session.journal?.length) : round.error
    )
    check(
      'an active run does NOT survive reopen',
      'session' in round && !round.session.activeRun,
      'session' in round ? String(round.session.activeRun) : round.error
    )
    // Reading it back clean is not enough: the FILE must not claim an agent is
    // working. Checking only the parsed form let a stale activeRun sit in a
    // saved client record until the artifact itself was inspected.
    check(
      'a saved session file carries no activeRun at all',
      !('activeRun' in JSON.parse(JSON.stringify(toSaved(w)))),
      JSON.stringify(Object.keys(JSON.parse(JSON.stringify(toSaved(w)))))
    )
    check(
      'a reopened agent mark keeps its attribution',
      'session' in round && round.session.marks!.some((m) => m.by === 'agent' && m.run === begun.run)
    )
  }

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
  let marked: Session = { ...s, reviewer: 'ABC' }
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
      (m) => m.author === 'ABC' && typeof m.created === 'string'
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
      return 'session' in rt && rt.session.marks?.length === 2 && rt.session.reviewer === 'ABC'
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

  let taped = { ...s, reviewer: 'ABC' } as Session
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
    taped.tapes![0].author === 'ABC' && typeof taped.tapes![0].created === 'string'
  )
  // Editing a keyed figure must re-foot the whole tape — the reason this
  // exists: a statement said 302.50 and the tape said 305.50.
  check(
    'correcting one line recomputes the total',
    (() => {
      let t = { ...s, reviewer: 'ABC' } as Session
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
  let drawn: Session = { ...s, reviewer: 'ABC' }
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
    drawn.shapes![0].author === 'ABC' && typeof drawn.shapes![0].created === 'string'
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

  // ------------------------------------------------- connectors and legend
  //
  // A connector is one end of a cross-reference. The properties that matter are
  // not "it renders": they are that a PAIR ties two pages both ways, that the
  // printed page number is resolved rather than stored, and that the ring lands
  // where it was clicked.
  {
    let cx: Session = newSession()
    cx = addSource(cx, pa.probe as ProbeWire)
    cx = addSource(cx, pb.probe as ProbeWire)
    const [p1, p2] = [cx.pages[0].id, cx.pages[cx.pages.length - 1].id]

    const first = placeConnector(cx, { page: p1, nx: 0.3, ny: 0.25, size: 24, label: '1' })
    check(
      'one end of a connector is placed, and is honest that it is not yet a reference',
      first.paired === false && (first.session.links ?? []).length === 0,
      `paired=${first.paired} links=${(first.session.links ?? []).length}`
    )
    check(
      'an unpaired connector prints no page reference',
      refNote(first.session, first.session.marks!.find((m) => m.id === first.id)!) === undefined
    )

    const pair = placeConnector(first.session, { page: p2, nx: 0.6, ny: 0.5, size: 24, label: '1' })
    check(
      'the second end closes the pair with a link each way',
      pair.paired === true && (pair.session.links ?? []).length === 2,
      `links=${JSON.stringify((pair.session.links ?? []).map((l) => [l.page, l.target]))}`
    )
    const ends = (pair.session.marks ?? []).filter((m) => m.kind === 'conn')
    check(
      'each end points at the other PAGE, never at a position',
      ends.length === 2 && ends[0].refTarget === p2 && ends[1].refTarget === p1,
      JSON.stringify(ends.map((m) => m.refTarget))
    )

    // The whole reason refTarget holds a page id: reorder the binder and the
    // printed reference must follow. A stored number would be wrong here and
    // would still read as authoritative on a signed document.
    const beforeText = refNote(pair.session, ends[0])
    const moved = movePages(pair.session, [p2], 0)
    const afterText = refNote(moved, moved.marks!.find((m) => m.id === ends[0].id)!)
    check(
      "a connector's printed page number follows a reorder",
      beforeText !== afterText && afterText === 'see p.1',
      `${beforeText} -> ${afterText}`
    )

    // Auto-advance. The sequence must NOT skip past a label that is still
    // waiting for its other end, or the preparer is handed 2 while 1 is open.
    check(
      'the next label waits for an open pair, then moves on',
      nextConnectorLabel(first.session, 'number') === '1' &&
        nextConnectorLabel(pair.session, 'number') === '2' &&
        nextConnectorLabel(pair.session, 'letter') === 'A',
      `${nextConnectorLabel(first.session, 'number')} / ${nextConnectorLabel(pair.session, 'number')}`
    )

    // The font ratio exists in session.ts and in appearance.py. If they drift,
    // a connector reading "12" on screen exports with its digits crossing the
    // ring — the same watch the image-layout duplication is under.
    const fontProbe = await runPython([
      '-c',
      'import sys, json; sys.path.insert(0, "engine");' +
        'from workpaper_engine.appearance import conn_font_size, CONN_STROKE_RATIO;' +
        'print(json.dumps({"f": [conn_font_size(24, l) for l in ("1", "12", "ABC")],' +
        ' "s": CONN_STROKE_RATIO}))'
    ])
    let engineFonts: { f: number[]; s: number } | null = null
    try {
      engineFonts = JSON.parse(fontProbe.out.trim().split('\n').pop() ?? '')
    } catch {
      engineFonts = null
    }
    const tsFonts = ['1', '12', 'ABC'].map((l) => connectorFontSize(24, l))
    check(
      'the connector ring is sized identically in the app and the engine',
      !!engineFonts &&
        engineFonts.f.every((v, i) => Math.abs(v - tsFonts[i]) < 1e-9) &&
        Math.abs(engineFonts.s - CONN_STROKE_RATIO) < 1e-9,
      `engine ${JSON.stringify(engineFonts)} vs app ${JSON.stringify(tsFonts)}/${CONN_STROKE_RATIO}`
    )

    // Through the real engine, and then looked at in pixels: a ring that
    // exports 3% off is a reference pointing at the wrong line of a table.
    const CONN_OUT = path.join(REPO, 'spike', 'out', 'app_binder_conn.pdf')
    const connExport = await runEngine({
      cmd: 'export',
      binder: toExportSpec(pair.session, CONN_OUT)
    })
    check(
      'a binder with connectors exports cleanly',
      connExport.ok === true && connExport.result.check_problems.length === 0,
      JSON.stringify(connExport.error ?? connExport.result?.check_problems)
    )
    if (connExport.ok) {
      const cp = await runEngine({ cmd: 'probe', path: CONN_OUT })
      const conns = cp.ok
        ? cp.probe.pages.flatMap((p: any) =>
            (p.annotations ?? []).filter((a: any) => a.wpt_kind === 'conn')
          )
        : []
      check(
        'both ends survive export carrying their label',
        conns.length === 2 && conns.every((a: any) => a.wpt_data?.text === '1'),
        JSON.stringify(conns.map((a: any) => a.wpt_data?.text))
      )
      // A /Link each way, so the reference is clickable and not just printed.
      const links = cp.ok
        ? cp.probe.pages.map((p: any) => (p.annotations ?? []).filter((a: any) => String(a.subtype).endsWith('Link')).length)
        : []
      check(
        'the exported binder carries a clickable link at each end',
        links.filter((n: number) => n > 0).length === 2,
        JSON.stringify(links)
      )
      const connPos = await runPython([
        path.join(REPO, 'spike', 'check_mark_positions.py'),
        CONN_OUT,
        '0',
        'violet',
        '0.3',
        '0.25'
      ])
      check('a connector exports centred where it was clicked', connPos.code === 0, connPos.out.trim())
    }

    // The legend: only marks actually used, and a meaning that travels.
    let leg = addMark(pair.session, { page: p1, kind: 'text', nx: 0.2, ny: 0.2, size: 24, text: 'GL' })
      .session
    leg = addMark(leg, { page: p1, kind: 'tick', nx: 0.4, ny: 0.2, size: 24 }).session
    leg = addMark(leg, { page: p1, kind: 'text', nx: 0.5, ny: 0.2, size: 24, text: 'GL' }).session
    leg = setLegend(leg, 'GL', 'Agrees to general ledger')
    const rows = legendEntries(leg)
    check(
      'the legend lists each mark once, with how often it is used',
      rows.length === 2 &&
        rows.find((r) => r.token === 'GL')?.count === 2 &&
        rows.find((r) => r.token === 'tick')?.count === 1,
      JSON.stringify(rows.map((r) => [r.token, r.count]))
    )
    check(
      'connectors are not legend rows — a circled 1 has no meaning to define',
      !rows.some((r) => r.token === '1'),
      JSON.stringify(rows.map((r) => r.token))
    )
    const md = legendMarkdown(leg)
    check(
      'the legend renders as a markdown table the typesetter already takes',
      md.includes('| Mark | Meaning | Times used |') &&
        md.includes('Agrees to general ledger') &&
        md.includes('_(not defined)_'),
      md.split('\n').slice(2, 6).join(' / ')
    )
    check(
      'a legend survives the save/reopen round trip',
      (() => {
        const back = parseSession(JSON.parse(JSON.stringify(toSaved(leg))))
        return 'session' in back && back.session.legend?.GL === 'Agrees to general ledger'
      })()
    )
    // A file can say anything. The legend is typeset onto a printed workpaper,
    // so a non-string here would surface as "[object Object]" on paper.
    const hostile = JSON.parse(JSON.stringify(toSaved(leg)))
    hostile.legend = { GL: { evil: true }, '': 'blank token', TB: 'fine' }
    const back = parseSession(hostile)
    const cleaned = 'session' in back ? back.session.legend : undefined
    check(
      'a legend with junk in it is cleaned, not trusted',
      cleaned?.TB === 'fine' && !('GL' in (cleaned ?? {})) && !('' in (cleaned ?? {})),
      JSON.stringify(cleaned)
    )
  }

  // Every kind through the real engine, including the degenerate case: a
  // perfectly horizontal line has zero height, and a zero-height /BBox makes an
  // invalid annotation unless it is padded.
  let allKinds: Session = { ...s, reviewer: 'ABC' }
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
  let stat: Session = { ...s, reviewer: 'ABC' }
  const p0 = stat.pages[0].id
  const p1 = stat.pages[1].id
  stat = setPageStatus(stat, [p0, p1], 'reviewed', 'ABC')
  check(
    'a status records who set it and when',
    stat.statuses![p0].status === 'reviewed' &&
      stat.statuses![p0].by === 'ABC' &&
      typeof stat.statuses![p0].at === 'string'
  )
  check(
    'applying a second status REPLACES the first — a page is in one state',
    (() => {
      const again = setPageStatus(stat, [p0], 'open', 'ABC')
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
        (m: any) => m.has_ap && m.wpt_data?.author === 'ABC'
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

  // --- a tape can be resized, and the size reaches the PDF
  //
  // A tape is the largest object placed on a page and was the only annotation
  // with no size at all: marks have carried one from the start, while a tape's
  // dimensions came entirely from a fixed 9pt constant. This was found by
  // trying to make one smaller.
  //
  // Asserted on the annotation RECT rather than on the spec, because the whole
  // risk in scaling a tape is that one dimension follows the font and another
  // does not — text tightening inside a card that never moved. Both dimensions
  // must scale, and the same numbers drive the on-screen preview.
  {
    const sizes: Array<[number | undefined, string]> = [[undefined, 'default'], [6, 'min'], [18, 'max']]
    const got: Record<string, [number, number]> = {}
    for (const [size, label] of sizes) {
      let s = newSession()
      const probe = await runEngine({ cmd: 'probe', path: path.join(FIXTURES, 'fixture_a.pdf') })
      s = addSource(s, probe.probe)
      s = { ...s, reviewer: 'ABC' }
      const t = addTape(s, {
        page: s.pages[0].id,
        nx: 0.5,
        ny: 0.5,
        entries: [{ value: 1900, op: '+' }, { value: 1500, op: '+' }],
        ...(size ? { size } : {})
      })
      s = t.session
      const OUT_T = path.join(REPO, 'spike', 'out', `tape-${label}.pdf`)
      const wrote = await runEngine({ cmd: 'export', binder: toExportSpec(s, OUT_T) })
      const pr = wrote.ok ? await runEngine({ cmd: 'probe', path: OUT_T }) : { ok: false }
      const ann = (pr as any).ok
        ? (pr as any).probe.pages.flatMap((p: any) => (p.annotations ?? []).filter((x: any) => x.wpt_kind === 'tape'))[0]
        : null
      const r = ann?.rect ?? ann?.Rect ?? null
      got[label] = r ? [Math.round((r[2] - r[0]) * 10) / 10, Math.round((r[3] - r[1]) * 10) / 10] : [0, 0]
    }
    check(
      'a tape at the default size is unchanged',
      got.default[0] > 0 && got.default[1] > 0,
      JSON.stringify(got.default)
    )
    check(
      'a smaller tape is smaller in BOTH dimensions',
      got.min[0] < got.default[0] && got.min[1] < got.default[1],
      `min=${JSON.stringify(got.min)} default=${JSON.stringify(got.default)}`
    )
    check(
      'a larger tape is larger in BOTH dimensions',
      got.max[0] > got.default[0] && got.max[1] > got.default[1],
      `max=${JSON.stringify(got.max)} default=${JSON.stringify(got.default)}`
    )
    // Proportional, not merely bigger: the card must not gain padding a preparer
    // did not ask for, or the preview and the export drift apart.
    // Within a tolerance, not exactly: these dimensions are rounded to 0.1pt
    // for reporting, so 3.2064 and 3.2036 are the SAME aspect ratio measured
    // either side of a rounding boundary. Comparing them for equality failed
    // and would have sent someone hunting a disproportion that is not there.
    const ratio = (a: [number, number]): number => a[0] / a[1]
    const near = (a: number, b: number): boolean => Math.abs(a - b) / b < 0.01
    const base = ratio(got.default)
    check(
      'the card keeps its proportions at every size',
      near(ratio(got.min), base) && near(ratio(got.max), base),
      `min=${ratio(got.min).toFixed(3)} default=${base.toFixed(3)} max=${ratio(got.max).toFixed(3)}`
    )
  }

  // --- a caption character must never take down a save
  //
  // The first Sample demo recording crashed binder_save with a
  // UnicodeEncodeError: the tape was titled "Interest — Sch B" and the em dash
  // could not encode into the ASCII content stream. Any CPA typing an em dash,
  // a section sign, or an accented name into a caption would have hit the same
  // wall — a SAVE crashed by punctuation. Text goes out as WinAnsi octal
  // escapes now, with the encoding declared on the fonts, so the assertion is
  // both halves: the export succeeds AND the character comes back out of the
  // rendered page, because escaping that drew the wrong glyph would pass the
  // first half while showing a reviewer the wrong text.
  {
    let s = newSession()
    const probe = await runEngine({ cmd: 'probe', path: path.join(FIXTURES, 'fixture_a.pdf') })
    s = addSource(s, probe.probe)
    s = { ...s, reviewer: 'ABC' }
    const pid = s.pages[0].id
    s = addTape(s, {
      page: pid, nx: 0.5, ny: 0.35,
      entries: [{ value: 18742, op: '+' }, { value: 21487, op: '+' }],
      title: 'Interest — Sch B'
    }).session
    s = addMark(s, { page: pid, kind: 'text', text: '§482', nx: 0.3, ny: 0.6, size: 24 }).session

    const OUT_U = path.join(REPO, 'spike', 'out', 'unicode-captions.pdf')
    const wrote = await runEngine({ cmd: 'export', binder: toExportSpec(s, OUT_U) })
    check(
      'an em dash in a tape title survives save instead of crashing it',
      wrote.ok === true && wrote.result.check_problems.length === 0,
      wrote.error ?? ''
    )
    if (wrote.ok) {
      // Extracted from the FLATTENED copy, deliberately. Annotation appearance
      // streams are invisible to text extraction — get_textpage() reads page
      // content — so probing the annotated export would report "missing" no
      // matter what the tape drew (the first draft of this check did exactly
      // that). Flattening paints the appearance INTO the content, so pdfium's
      // own parser decoding the em dash back out proves bytes and declared
      // encoding agree end to end.
      const OUT_UF = path.join(REPO, 'spike', 'out', 'unicode-captions-flat.pdf')
      const flat = await runEngine({
        cmd: 'export',
        binder: toExportSpec(s, OUT_UF, { flatten: true })
      })
      const read = flat.ok
        ? await runPython([
            '-c',
            [
              'import sys, pypdfium2 as pdfium',
              "d = pdfium.PdfDocument(sys.argv[1])",
              't = d[0].get_textpage().get_text_range()',
              // Each character names ITSELF in the result. The first version
              // printed a bare positional 'missing', so a real failure read
              // "missing SECTION" \u2014 which looks like the section sign is the
              // problem when it was the em dash, and sends the next person
              // reading CI straight to the wrong character.
              "print('emdash=' + ('ok' if '\u2014' in t else 'LOST'),",
              "      'section=' + ('ok' if '\u00a7' in t else 'LOST'))"
            ].join('\n'),
            OUT_UF
          ])
        : { out: `flatten failed: ${flat.error}` }
      check(
        'the em dash and section sign render as themselves, not as escapes',
        /emdash=ok section=ok/.test(read.out),
        read.out.trim()
      )
    }

    // The check above is drawing; this one is the PROCESS BOUNDARY, which is
    // where the bug actually was. The engine read stdin with the locale
    // encoding — UTF-8 on macOS, cp1252 on Windows — while the shell always
    // writes UTF-8, so a preparer's characters were corrupted on the way IN,
    // before any escaping could see them. Every drawing path inherited it, so
    // testing one of them only catches it by luck; asserting the round trip
    // catches it wherever the text is later used. An accented client name
    // rather than punctuation, because that is the one a firm actually types
    // and it must come back byte-for-byte.
    const NAME = 'Peña & Fuentes — §1031 exchange'
    let u = newSession()
    const uprobe = await runEngine({ cmd: 'probe', path: path.join(FIXTURES, 'fixture_a.pdf') })
    u = addSource(u, uprobe.probe)
    u = { ...u, reviewer: 'ABC' }
    u = addTape(u, {
      page: u.pages[0].id, nx: 0.5, ny: 0.5,
      entries: [{ value: 100, op: '+' }], title: NAME
    }).session
    const OUT_RT = path.join(REPO, 'spike', 'out', 'unicode-roundtrip.pdf')
    const uwrote = await runEngine({
      cmd: 'export',
      binder: toExportSpec(u, OUT_RT, { embedSession: true })
    })
    const ureopened = uwrote.ok ? await runEngine({ cmd: 'open_binder', path: OUT_RT }) : null
    const back = parseSession(ureopened?.binder?.session)
    const why = !uwrote.ok
      ? `export failed: ${uwrote.error}`
      : !ureopened?.binder?.found
        ? `reopen found no session: ${ureopened?.error ?? JSON.stringify(ureopened?.binder)}`
        : 'error' in (back as any)
          ? `session did not parse: ${(back as any).error}`
          : ''
    const title = why ? null : (back as { session: any }).session?.tapes?.[0]?.title
    check(
      'a name with an accent survives the engine boundary byte for byte',
      title === NAME,
      why || `got ${JSON.stringify(title)}`
    )
  }

  // --- the agent outline
  //
  // Attribution has two halves. The author field says "ABC (AI)" in a comments
  // pane a reviewer has to open; the outline says it on the page, at a glance,
  // on the marks that ASSERT something. Colour is deliberately not the carrier:
  // it already means mark KIND, and in workpaper convention often which
  // procedure was performed.
  //
  // Asserted on the appearance stream rather than by looking at pixels, and
  // BOTH ways round — a check that only proved the agent mark has an outline
  // would pass just as happily if every mark had one, which would be the same
  // bug wearing a different hat.
  {
    const outlineProbe = `import sys, pikepdf
from pikepdf import Name
want = sys.argv[2]
with pikepdf.open(sys.argv[1]) as pdf:
    hits = []
    for pg in pdf.pages:
        for a in (pg.obj.get(Name('/Annots')) or []):
            ap = a.get(Name('/AP'))
            if ap is None: continue
            body = bytes(ap.get(Name('/N')).read_bytes())
            author = str(a.get(Name('/T')) or '')
            hits.append((author, b're S Q' in body[:80]))
print(';'.join(f'{a}={o}' for a, o in hits))`

    let s = newSession()
    const probe = await runEngine({ cmd: 'probe', path: path.join(FIXTURES, 'fixture_a.pdf') })
    s = addSource(s, probe.probe)
    const pid = s.pages[0].id
    // A human tick and a stamp...
    s = addMark(s, { page: pid, kind: 'tick', nx: 0.2, ny: 0.2, size: 24, author: 'ABC' }).session
    s = addMark(s, { page: pid, kind: 'text', text: 'TB', nx: 0.4, ny: 0.2, size: 24, author: 'ABC' }).session
    // ...then the same two from an agent run.
    s = beginRun(s).session
    s = addMark(s, { page: pid, kind: 'tick', nx: 0.6, ny: 0.2, size: 24, author: 'ABC' }).session
    s = addMark(s, { page: pid, kind: 'cross', nx: 0.8, ny: 0.2, size: 24, author: 'ABC' }).session

    const OUTLINED = path.join(REPO, 'spike', 'out', 'agent-outline.pdf')
    const wrote = await runEngine({ cmd: 'export', binder: toExportSpec(s, OUTLINED) })
    check('agent outline: binder exported', wrote.ok === true, wrote.error ?? '')

    const got = await runPython(['-c', outlineProbe, OUTLINED, 'x'])
    const rows = got.out.trim().split(';').filter(Boolean)
    const agentRows = rows.filter((r) => r.startsWith('ABC (AI)='))
    const humanRows = rows.filter((r) => r.startsWith('ABC=') )
    check(
      'agent outline: every AI-placed mark carries it',
      agentRows.length === 2 && agentRows.every((r) => r.endsWith('=True')),
      rows.join(' | ')
    )
    check(
      "agent outline: no human-placed mark carries it",
      humanRows.length === 2 && humanRows.every((r) => r.endsWith('=False')),
      rows.join(' | ')
    )
  }

  // ------------------------------------------- the single-file round trip (#3)
  //
  // Everything above proves a binder can be WRITTEN. This proves it can be
  // opened again, which is the half that makes the file the document. It walks
  // the exact path the app walks on Open: recover the session from the PDF,
  // build the de-marked working copy, probe it, and re-point the session at the
  // binder's own pages.
  {
    const RT = path.join(REPO, 'spike', 'out', 'roundtrip.pdf')
    const RT_WORK = path.join(REPO, 'spike', 'out', '.roundtrip.wpt-working.pdf')
    const RT2 = path.join(REPO, 'spike', 'out', 'roundtrip-2.pdf')

    let s = newSession()
    for (const f of ['fixture_a.pdf', 'fixture_b.pdf']) {
      const probe = await runEngine({ cmd: 'probe', path: path.join(FIXTURES, f) })
      s = addSource(s, probe.probe)
    }
    s = rotatePages(s, [s.pages[1].id], 90)
    s = addMark(s, { page: s.pages[0].id, kind: 'tick', nx: 0.75, ny: 0.25, size: 24, author: 'ABC' }).session
    s = addMark(s, { page: s.pages[3].id, kind: 'text', text: 'F', nx: 0.4, ny: 0.6, size: 24, author: 'ABC' }).session
    s = addTape(s, { page: s.pages[0].id, nx: 0.5, ny: 0.5, entries: [], author: 'ABC' }).session
    s = { ...s, reviewer: 'ABC', stamps: ['TB'] }

    const wrote = await runEngine({
      cmd: 'export',
      binder: toExportSpec(s, RT, { embedSession: true })
    })
    check('round trip: binder saved with a session inside', wrote.ok === true, wrote.error ?? '')
    check(
      'round trip: the session is actually in the file',
      (wrote.result?.session_bytes ?? 0) > 0,
      `${wrote.result?.session_bytes} bytes`
    )

    const opened = await runEngine({ cmd: 'open_binder', path: RT })
    check('round trip: reopening finds the session', opened.binder?.found === true)
    check('round trip: the session is undamaged', opened.binder?.payload_intact === true)
    check('round trip: the pages have not moved', opened.binder?.geometry_matches === true)

    const parsed = parseSession(opened.binder?.session)
    check('round trip: the recovered session is valid', !('error' in parsed), (parsed as any).error ?? '')

    const cleaned = await runEngine({ cmd: 'clean_copy', path: RT, output: RT_WORK })
    check('round trip: working copy written', cleaned.ok === true, cleaned.error ?? '')
    if (process.platform !== 'win32' && cleaned.ok === true) {
      const mode = (await statFile(RT_WORK)).mode & 0o777
      check('round trip: working copy is owner-only', mode === 0o600, `mode ${mode.toString(8)}`)
    }
    const workProbe = await runEngine({ cmd: 'probe', path: RT_WORK })

    const rebound = rebindToBinder(
      (parsed as { session: any }).session,
      workProbe.probe,
      RT_WORK,
      'roundtrip.pdf'
    )
    check('round trip: re-pointed at the binder', !rebound.error, rebound.error ?? '')

    const back = rebound.session
    check(
      'round trip: every page survived, in order',
      back.pages.length === s.pages.length &&
        back.pages.every((p: any, i: number) => p.id === s.pages[i].id),
      `${back.pages.length} pages`
    )
    check(
      'round trip: the binder is now its own and only source',
      back.sources.length === 1 && back.pages.every((p: any) => p.source === back.sources[0].id),
      back.sources.map((x: any) => x.name).join(',')
    )
    check(
      'round trip: marks and tapes still attached to their pages',
      back.marks?.length === s.marks?.length &&
        back.tapes?.length === s.tapes?.length &&
        (back.marks ?? []).every((m: any, i: number) => m.page === (s.marks ?? [])[i]?.page),
      `${back.marks?.length} marks, ${back.tapes?.length} tapes`
    )
    check(
      'round trip: the firm legend and reviewer travelled with the file',
      back.reviewer === 'ABC' && back.stamps?.[0] === 'TB'
    )
    // The rotation was baked into the page when the binder was written. Carrying
    // the delta forward would turn the page a second time on every save.
    check(
      'round trip: rotation is not applied twice',
      back.pages.every((p: any) => p.rotate === 0),
      back.pages.map((p: any) => p.rotate).join(',')
    )
    const rotatedPage = back.pages[1]
    check(
      'round trip: the rotated page is landscape in the reopened binder',
      (rotatedPage.w ?? 0) > (rotatedPage.h ?? 0),
      `${rotatedPage.w}x${rotatedPage.h}`
    )

    // Save again from the reopened state — where duplicate marks would appear.
    const wrote2 = await runEngine({
      cmd: 'export',
      binder: toExportSpec(back, RT2, { embedSession: true })
    })
    check('round trip: saving the reopened binder works', wrote2.ok === true, wrote2.error ?? '')
    const countMarks = await runPython([
      '-c',
      `import pikepdf,sys
from pikepdf import Name
n=0
with pikepdf.open(sys.argv[1]) as pdf:
    for pg in pdf.pages:
        for a in pg.obj.get(Name('/Annots')) or []:
            if Name('/WPT_Data') in a: n+=1
print(n)`,
      RT2
    ])
    check(
      'round trip: marks did not double on the second save',
      countMarks.out.trim() === '3',
      `${countMarks.out.trim()} marks (expected 3: 2 marks + 1 tape)`
    )

    // --- "Save a copy to send out" must not carry the working record with it.
    //
    // This is the claim in DATA-FLOW.md that costs the most if it is ever
    // quietly wrong: the distribution copy is what leaves the firm, and the
    // session inside a binder holds reviewer names, review notes, tape addends
    // and the ORIGINAL FILESYSTEM PATHS every page came from. `back` is a
    // session recovered from a binder that demonstrably had one embedded
    // (asserted above), so this is the inherited-session path specifically —
    // not merely "a fresh session was not added".
    //
    // toExportSpec makes flatten and embedSession mutually exclusive, and
    // binder.py strips any inherited session unconditionally. Two independent
    // mechanisms, no assertion until now.
    const SENDOUT = path.join(REPO, 'spike', 'out', 'roundtrip-sendout.pdf')
    const sent = await runEngine({
      cmd: 'export',
      binder: toExportSpec(back, SENDOUT, { flatten: true })
    })
    check('send-out copy: exported', sent.ok === true, sent.error ?? '')
    check(
      'send-out copy: the engine wrote no session into it',
      (sent.result?.session_bytes ?? 0) === 0,
      `${sent.result?.session_bytes ?? 0} bytes`
    )
    const sentOpen = await runEngine({ cmd: 'open_binder', path: SENDOUT })
    check(
      'send-out copy: reopening it finds NO inherited session',
      sentOpen.binder?.found === false,
      `found=${sentOpen.binder?.found}`
    )
    // Belt and braces: the session rides at BOTH anchors described in
    // session_store.py — a document-level attachment and an /AF entry on the
    // catalog and on page 1 — so look for the anchors themselves rather than
    // trusting the reader that is supposed to find them.
    //
    // Run against the session-carrying binder as well as the send-out copy.
    // Asserting only "the send-out copy has none" is a check that passes just
    // as happily when the probe is broken and finds nothing anywhere; the
    // first assertion is what stops this going quietly vacuous.
    const anchorProbe = `import pikepdf,sys
from pikepdf import Name
P='workpaper.session.json'
with pikepdf.open(sys.argv[1]) as pdf:
    hits=[]
    if P in pdf.attachments: hits.append('attachment')
    def af(o,l):
        for s in (o.get(Name('/AF')) or []):
            try: n=str(s.get(Name('/UF')) or s.get(Name('/F')) or '')
            except AttributeError: n=''
            if n==P: hits.append(l)
    af(pdf.Root,'root-af')
    for i,pg in enumerate(pdf.pages): af(pg.obj,'page%d-af'%i)
print(','.join(hits) or 'none')`
    const anchorsKept = await runPython(['-c', anchorProbe, RT])
    check(
      'send-out control: the probe DOES find both anchors on a working binder',
      anchorsKept.out.trim() === 'attachment,root-af,page0-af',
      anchorsKept.out.trim() || '(no output)'
    )
    const anchorsGone = await runPython(['-c', anchorProbe, SENDOUT])
    check(
      'send-out copy: neither session anchor is present in the file',
      anchorsGone.out.trim() === 'none',
      anchorsGone.out.trim() || '(no output)'
    )
  }

  // ------------------------------------- cross-page links survive a reorder
  //
  // The bug this replaced: binder_tie resolved the target page id to a POSITION
  // and wrote it into the note, so "ties to p.4" pointed at whatever was fourth
  // after the next reorder — authoritatively, on evidence.
  {
    // Fresh two-source binder, built the way the UI does it.
    let base: Session = newSession()
    base = addSource(base, pa.probe as ProbeWire)
    base = addSource(base, pb.probe as ProbeWire)
    const first = base.pages[0].id
    const last = base.pages[base.pages.length - 1].id
    let tied = addMark(base, {
      page: first, kind: 'tick', nx: 0.7, ny: 0.2, size: 20,
      note: 'Interest — ties', refTarget: last
    }).session
    tied = addLink(tied, {
      page: first, target: last, rect: [0.68, 0.18, 0.72, 0.22], label: 'Interest'
    }).session

    const before = refNote(tied, tied.marks![0])
    check(
      'a reference resolves to the target page position',
      before === `Interest — ties — see p.${tied.pages.length}`,
      String(before)
    )

    // Move the target to the front. A stored number would now be wrong.
    const moved = movePages(tied, [last], 0)
    const after = refNote(moved, moved.marks![0])
    check(
      'the reference FOLLOWS its page through a reorder',
      after === 'Interest — ties — see p.1',
      `${String(before)} -> ${String(after)}`
    )
    check(
      'the link still names page ids, not positions',
      moved.links![0].target === last && moved.links![0].page === first,
      JSON.stringify(moved.links![0])
    )

    const linkSpec = toExportSpec(moved, OUT)
    check(
      'links reach the engine spec as page ids',
      linkSpec.links?.length === 1 &&
        linkSpec.links[0].target_page === last &&
        linkSpec.links[0].page === first,
      JSON.stringify(linkSpec.links)
    )

    // A link whose far end is gone is a wrong link, not a degraded one.
    const targetGone = deletePages(moved, [last])
    check(
      'deleting the target drops the link',
      (targetGone.links ?? []).length === 0,
      JSON.stringify(targetGone.links)
    )
    check(
      'and the orphaned reference degrades to prose, never a wrong number',
      refNote(targetGone, targetGone.marks![0]) === 'Interest — ties',
      String(refNote(targetGone, targetGone.marks![0]))
    )
    check(
      'a spec with no surviving links omits the key entirely',
      toExportSpec(targetGone, OUT).links === undefined
    )

    // And the engine turns them into real /Link annotations.
    const linkOut = path.join(REPO, 'spike', 'out', 'app_binder_links.pdf')
    const linked = await runEngine({ cmd: 'export', binder: toExportSpec(moved, linkOut) })
    check(
      'engine exports the binder with the link',
      linked.ok === true && linked.result.check_problems.length === 0,
      JSON.stringify(linked.error ?? linked.result?.check_problems)
    )
    if (linked.ok) {
      const probed = await runEngine({ cmd: 'probe', path: linkOut })
      const links = probed.ok
        ? probed.probe.pages.flatMap((pg: any, i: number) =>
            (pg.annotations ?? [])
              .filter((an: any) => an.subtype === '/Link')   // pikepdf Names stringify with the slash
              .map((an: any) => ({ on: i, to: an.dest_page }))
          )
        : []
      check(
        'the exported link points at the target page in its FINAL position',
        // last was moved to index 0, so first is now index 1 and links back to 0
        links.length === 1 && links[0].on === 1 && links[0].to === 0,
        JSON.stringify(links)
      )
    }
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
