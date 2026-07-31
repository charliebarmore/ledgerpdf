/**
 * The binder session model — pure, serializable, no DOM or PDF dependencies
 * (so it can be verified headlessly: see app/scripts/verify-model.ts).
 *
 * Load-bearing design from the canonical spec: the session is JSON + untouched
 * source files. A PDF exists only at export. Every page carries a permanent id;
 * bookmarks (and later marks/tapes/links) reference page ids, so visible page
 * numbers are computed only at export and page moves carry everything along.
 */

export const SESSION_FORMAT_VERSION = 1

// ------------------------------------------------------------------- types

export interface OutlineNode {
  title: string
  /** 0-based page index within the source document, or null if unresolved. */
  destPage: number | null
  children: OutlineNode[]
}

/**
 * What kind of file a source is. An image becomes one Letter page at export —
 * the engine's images.py owns that — but it renders differently in the app, so
 * the distinction has to survive save/reopen.
 */
export type SourceKind = 'pdf' | 'image'

export interface SourceFingerprint {
  sha256: string
  size: number
  mtime_ns: number
}

export interface SourceDoc {
  id: string
  path: string
  name: string
  nPages: number
  kind: SourceKind
  /** Identity of the exact bytes reviewed; verified again before export. */
  fingerprint?: SourceFingerprint
  /** The source's own bookmark tree, to nest under its file-level bookmark. */
  outline: OutlineNode[]
}

export interface BinderPage {
  id: string
  source: string
  /** 0-based index in the source document. Never changes. */
  index: number
  /** User's rotation DELTA in degrees on top of the page's own /Rotate. */
  rotate: number
}

/**
 * A bookmark the user created (as opposed to one imported from a source PDF's
 * own outline). Anchored to a page id, so it moves with its page.
 */
export interface UserBookmark {
  id: string
  page: string
  title: string
  /** Nesting level in the exported outline. 0 = top level. */
  depth: number
}

/** The review-mark palette. Colors and glyphs are defined by the engine. */
export type MarkKind = 'tick' | 'cross' | 'text'

/**
 * Drawn annotations — dragged, not stamped. A mark is placed at a point and has
 * a fixed size; these take their geometry from two corners.
 */
export type ShapeKind = 'rect' | 'ellipse' | 'line' | 'arrow' | 'highlight' | 'textbox'

/** Must match engine shapes.SHAPE_COLORS — these are content, not UI theme. */
export const SHAPE_COLORS: Record<string, string> = {
  red: 'rgb(184,38,38)',
  green: 'rgb(33,140,33)',
  blue: 'rgb(26,84,153)',
  black: 'rgb(31,31,36)',
  orange: 'rgb(217,115,26)'
}
export const SHAPE_COLOR_NAMES = ['red', 'green', 'blue', 'black', 'orange'] as const
export type ShapeColor = (typeof SHAPE_COLOR_NAMES)[number]

export const SHAPE_WIDTH_DEFAULT = 1.5
export const SHAPE_WIDTH_MIN = 0.5
export const SHAPE_WIDTH_MAX = 8

/** Highlighter appearance, mirrored from engine shapes.py for the preview. */
export const HIGHLIGHT_FILL = 'rgba(255,235,59,0.4)'

export interface Shape {
  id: string
  page: string
  kind: ShapeKind
  /** The two dragged corners, normalized to the page as displayed. */
  nx: number
  ny: number
  nx2: number
  ny2: number
  color: ShapeColor
  /** Stroke width in points. */
  width: number
  /** For kind 'textbox'. */
  text?: string
  author?: string
  note?: string
  created?: string
}

/** What the toolbar can arm: a mark to stamp, a tape, or a shape to drag out. */
export type ToolKind = MarkKind | 'tape' | ShapeKind

/** Tools that are drawn by dragging rather than placed with one click. */
export const DRAG_TOOLS: readonly ShapeKind[] = [
  'rect',
  'ellipse',
  'line',
  'arrow',
  'highlight',
  'textbox'
]

export function isShapeKind(k: ToolKind): k is ShapeKind {
  return (DRAG_TOOLS as readonly string[]).includes(k)
}

/**
 * A review mark placed on a page. Coordinates are normalized against the page
 * as DISPLAYED (CropBox-relative, rotation applied), with nx left→right and
 * ny top→bottom — exactly what a click on the rendered canvas gives, and
 * exactly what the engine's geometry module consumes.
 */
export interface Mark {
  id: string
  page: string
  kind: MarkKind
  nx: number
  ny: number
  /** Displayed size in points. */
  size: number
  /** For kind 'text' — the letters, e.g. "F", "T", or reviewer initials. */
  text?: string
  author?: string
  note?: string
  /** ISO timestamp — part of the review record. */
  created?: string
}

export const MARK_SIZE_DEFAULT = 24
export const MARK_SIZE_MIN = 10
export const MARK_SIZE_MAX = 72

/**
 * Custom stamps are short by design — they sit on a workpaper next to a number,
 * not in a margin note. Anything longer belongs in the mark's note.
 */
export const STAMP_MAX_LEN = 8

/**
 * A calculator tape: the numbers a preparer added up, kept next to the total
 * they support.
 *
 * The whole point is the audit trail. A total on a workpaper with no tape is an
 * assertion; a total with its addends is evidence. So the entries are stored
 * structurally — not as the rendered text — and travel into the exported PDF as
 * /WPT_Data, which is the seam a future tie-out layer reads.
 */
/** What an adding machine actually records per line: a figure and the key. */
export type TapeOp = '+' | '-' | '×' | '÷'

export const TAPE_OPS: readonly TapeOp[] = ['+', '-', '×', '÷']

export interface TapeEntry {
  value: number
  op: TapeOp
  /** Optional per-line label — the "Note" column. */
  note?: string
}

export interface Tape {
  id: string
  page: string
  /** Center of the tape card, normalized against the page as displayed. */
  nx: number
  ny: number
  /** The lines, in the order they were keyed. */
  entries: TapeEntry[]
  /** Section number shown in the line labels ("2 - 1"). */
  section?: number
  /** Optional caption above the numbers, e.g. "Repairs & maintenance". */
  title?: string
  author?: string
  created?: string
}

export const TAPE_TITLE_MAX_LEN = 28

export interface Session {
  formatVersion: number
  sources: SourceDoc[]
  /** Final binder order. */
  pages: BinderPage[]
  /** Monotonic id counter — keeps ids unique and stable across save/reopen. */
  seq: number
  /** User-renamed bookmarks, keyed by BookmarkNode.key. Absent = use the
   *  imported/derived title. */
  titles?: Record<string, string>
  /** Bookmarks the user added. Merged into the imported outline by page order. */
  bookmarks?: UserBookmark[]
  /** Review marks (ticks, crosses, lettered stamps), anchored to page ids. */
  marks?: Mark[]
  /** Reviewer initials, stamped as the author of new marks. */
  reviewer?: string
  /**
   * Reusable custom text stamps the user defined ("TB", "PY", "A/R", ...).
   * Every firm has its own tick-mark legend; the fixed palette can't cover it,
   * so the legend travels with the binder.
   */
  stamps?: string[]
  /** Calculator tapes, anchored to page ids exactly as marks are. */
  tapes?: Tape[]
  /** Drawn annotations — rectangles, ellipses, lines, arrows, highlights, notes. */
  shapes?: Shape[]
}

export interface BookmarkNode {
  /**
   * Stable identity for user renames. Derived from where the bookmark comes
   * from, NOT from its position in the binder:
   *   `f:<sourceId>`             the file-level bookmark
   *   `o:<sourceId>:<0.1.2>`     a node in that source's imported outline
   * Reordering, rotating, or deleting pages never changes it, so a rename
   * sticks. The engine ignores this field on export.
   */
  key: string
  title: string
  page: string
  children: BookmarkNode[]
}

export interface ExportSpec {
  sources: Record<string, string>
  source_fingerprints?: Record<string, SourceFingerprint>
  pages: Array<{ id: string; source: string; index: number; rotate: number }>
  bookmarks: BookmarkNode[]
  /** Engine-side annotation specs — review marks today, tapes/links later. */
  annotations: Array<Record<string, unknown>>
  /**
   * Burn our marks into the page content instead of writing them as
   * annotations. For a binder that leaves the building: nothing to drag off,
   * nothing a viewer can silently reposition. Omitted when false so an
   * ordinary export's spec is unchanged.
   */
  flatten?: boolean
  output: string
}

/** Shape returned by the engine's `probe` command (snake_case wire format). */
export interface ProbeWire {
  path: string
  n_pages: number
  /** Absent for PDFs; "image" when the engine wrapped a picture into a page. */
  kind?: string
  pages: Array<{ index: number; rotate: number; mediabox: number[]; cropbox: number[] | null }>
  outline: Array<{ title: string; dest_page: number | null; children: unknown[] }>
  image?: { pixels: number[]; lossless: boolean; reason: string }
  fingerprint?: SourceFingerprint
}

// --------------------------------------------------------------- construction

export function newSession(): Session {
  return { formatVersion: SESSION_FORMAT_VERSION, sources: [], pages: [], seq: 0 }
}

/**
 * Scrub control characters out of text that came from a PDF.
 *
 * Real tax-software output is messy: a 62-page master file produced by one
 * package ended EVERY bookmark title with a NUL (U+0000) — presumably a
 * null-terminated string that got written verbatim. Invisible, but it defeats
 * any `$`-anchored matching, corrupts trimming, and has no business being
 * written back out into a binder. Legitimate typography (en-dashes, accents)
 * is preserved.
 */
export function sanitizeTitle(raw: string): string {
  return raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim()
}

function normalizeOutline(nodes: ProbeWire['outline']): OutlineNode[] {
  return (nodes ?? []).map((n) => ({
    title: sanitizeTitle(String(n.title ?? '')) || 'Untitled',
    destPage: typeof n.dest_page === 'number' ? n.dest_page : null,
    children: normalizeOutline((n.children ?? []) as ProbeWire['outline'])
  }))
}

export function baseName(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}

/**
 * Append every page of a probed PDF to the end of the binder.
 * Importing the same file twice is allowed and yields a distinct source.
 */
export function addSource(session: Session, probe: ProbeWire): Session {
  let seq = session.seq
  const sourceId = `src_${++seq}`
  const source: SourceDoc = {
    id: sourceId,
    path: probe.path,
    name: baseName(probe.path),
    nPages: probe.n_pages,
    kind: probe.kind === 'image' ? 'image' : 'pdf',
    ...(probe.fingerprint ? { fingerprint: probe.fingerprint } : {}),
    outline: normalizeOutline(probe.outline)
  }
  const newPages: BinderPage[] = probe.pages.map((p) => ({
    id: `pg_${++seq}`,
    source: sourceId,
    index: p.index,
    rotate: 0
  }))
  return {
    ...session,
    seq,
    sources: [...session.sources, source],
    pages: [...session.pages, ...newPages]
  }
}

// ------------------------------------------------------------------ mutations

/**
 * Move `ids` so they sit immediately before the page currently at `beforeIndex`
 * (use pages.length to move to the end). Selected pages keep their relative
 * order — matching how a thumbnail rail should behave.
 */
export function movePages(session: Session, ids: string[], beforeIndex: number): Session {
  const idSet = new Set(ids)
  const moving = session.pages.filter((p) => idSet.has(p.id))
  if (moving.length === 0) return session
  // Count how many moving pages sit before the drop point to correct the index.
  const before = session.pages.slice(0, beforeIndex).filter((p) => idSet.has(p.id)).length
  const rest = session.pages.filter((p) => !idSet.has(p.id))
  const at = Math.max(0, Math.min(beforeIndex - before, rest.length))
  return { ...session, pages: [...rest.slice(0, at), ...moving, ...rest.slice(at)] }
}

export function rotatePages(session: Session, ids: string[], delta: number): Session {
  const idSet = new Set(ids)
  return {
    ...session,
    pages: session.pages.map((p) =>
      idSet.has(p.id) ? { ...p, rotate: (((p.rotate + delta) % 360) + 360) % 360 } : p
    )
  }
}

export function deletePages(session: Session, ids: string[]): Session {
  const idSet = new Set(ids)
  const pages = session.pages.filter((p) => !idSet.has(p.id))
  // Drop sources that no longer contribute any page.
  const used = new Set(pages.map((p) => p.source))
  return {
    ...session,
    pages,
    sources: session.sources.filter((s) => used.has(s.id)),
    // Anything anchored to a deleted page goes with it (undo restores both).
    ...(session.marks ? { marks: session.marks.filter((m) => !idSet.has(m.page)) } : {}),
    ...(session.tapes ? { tapes: session.tapes.filter((t) => !idSet.has(t.page)) } : {}),
    ...(session.shapes ? { shapes: session.shapes.filter((x) => !idSet.has(x.page)) } : {}),
    ...(session.bookmarks
      ? { bookmarks: session.bookmarks.filter((b) => !idSet.has(b.page)) }
      : {})
  }
}

// ---------------------------------------------------------------------- marks

/** Place a mark on a page at normalized display coordinates. */
export function addMark(
  session: Session,
  mark: Omit<Mark, 'id' | 'created' | 'author'> & { author?: string }
): { session: Session; id: string } {
  const seq = session.seq + 1
  const id = `mk_${seq}`
  const next: Mark = {
    ...mark,
    id,
    author: mark.author ?? session.reviewer ?? '',
    created: new Date().toISOString()
  }
  return { session: { ...session, seq, marks: [...(session.marks ?? []), next] }, id }
}

export function updateMark(session: Session, id: string, patch: Partial<Mark>): Session {
  return {
    ...session,
    marks: (session.marks ?? []).map((m) =>
      m.id === id
        ? {
            ...m,
            ...patch,
            // keep a mark on its page and inside it
            nx: patch.nx === undefined ? m.nx : Math.min(1, Math.max(0, patch.nx)),
            ny: patch.ny === undefined ? m.ny : Math.min(1, Math.max(0, patch.ny)),
            size:
              patch.size === undefined
                ? m.size
                : Math.min(MARK_SIZE_MAX, Math.max(MARK_SIZE_MIN, patch.size))
          }
        : m
    )
  }
}

export function removeMarks(session: Session, ids: string[]): Session {
  const set = new Set(ids)
  return { ...session, marks: (session.marks ?? []).filter((m) => !set.has(m.id)) }
}

export function marksOnPage(session: Session, pageId: string | null): Mark[] {
  if (!pageId) return []
  return (session.marks ?? []).filter((m) => m.page === pageId)
}

/** Marks grouped by page id — one pass, for views that render every page. */
export function marksByPage(session: Session): Map<string, Mark[]> {
  const out = new Map<string, Mark[]>()
  for (const m of session.marks ?? []) {
    const list = out.get(m.page)
    if (list) list.push(m)
    else out.set(m.page, [m])
  }
  return out
}

// --------------------------------------------------------------------- shapes

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))

export function addShape(
  session: Session,
  shape: Omit<Shape, 'id' | 'created' | 'author'> & { author?: string }
): { session: Session; id: string } {
  const seq = session.seq + 1
  const id = `sh_${seq}`
  const next: Shape = {
    ...shape,
    id,
    nx: clamp01(shape.nx),
    ny: clamp01(shape.ny),
    nx2: clamp01(shape.nx2),
    ny2: clamp01(shape.ny2),
    author: shape.author ?? session.reviewer ?? '',
    created: new Date().toISOString()
  }
  return { session: { ...session, seq, shapes: [...(session.shapes ?? []), next] }, id }
}

export function updateShape(session: Session, id: string, patch: Partial<Shape>): Session {
  return {
    ...session,
    shapes: (session.shapes ?? []).map((s) =>
      s.id === id
        ? {
            ...s,
            ...patch,
            nx: patch.nx === undefined ? s.nx : clamp01(patch.nx),
            ny: patch.ny === undefined ? s.ny : clamp01(patch.ny),
            nx2: patch.nx2 === undefined ? s.nx2 : clamp01(patch.nx2),
            ny2: patch.ny2 === undefined ? s.ny2 : clamp01(patch.ny2),
            width:
              patch.width === undefined
                ? s.width
                : Math.min(SHAPE_WIDTH_MAX, Math.max(SHAPE_WIDTH_MIN, patch.width))
          }
        : s
    )
  }
}

/**
 * Slide a shape by a normalized delta, keeping BOTH corners on the page. Moving
 * is clamped as a whole so a shape never silently deforms when dragged into an
 * edge — which is what per-corner clamping would do.
 */
export function moveShape(session: Session, id: string, dx: number, dy: number): Session {
  const s = (session.shapes ?? []).find((x) => x.id === id)
  if (!s) return session
  const clampedDx = Math.min(1 - Math.max(s.nx, s.nx2), Math.max(-Math.min(s.nx, s.nx2), dx))
  const clampedDy = Math.min(1 - Math.max(s.ny, s.ny2), Math.max(-Math.min(s.ny, s.ny2), dy))
  return updateShape(session, id, {
    nx: s.nx + clampedDx,
    ny: s.ny + clampedDy,
    nx2: s.nx2 + clampedDx,
    ny2: s.ny2 + clampedDy
  })
}

/** Which grab handle is being dragged. */
export type ShapeHandle = 'nw' | 'ne' | 'se' | 'sw' | 'a' | 'b'

/**
 * The new corner set after dragging one handle to (nx, ny).
 *
 * Box shapes are rewritten as (min, max), so the stored corners end up
 * normalized however the user originally dragged them out — that is what keeps
 * the handle mapping honest on a shape drawn right-to-left. Lines and arrows
 * keep their direction: the second point is the arrow head.
 */
export function resizeShape(
  s: Shape,
  handle: ShapeHandle,
  nx: number,
  ny: number
): Partial<Shape> {
  if (s.kind === 'line' || s.kind === 'arrow') {
    return handle === 'a' ? { nx, ny } : { nx2: nx, ny2: ny }
  }
  let x0 = Math.min(s.nx, s.nx2)
  let x1 = Math.max(s.nx, s.nx2)
  let y0 = Math.min(s.ny, s.ny2)
  let y1 = Math.max(s.ny, s.ny2)
  if (handle === 'nw' || handle === 'sw') x0 = nx
  else x1 = nx
  if (handle === 'nw' || handle === 'ne') y0 = ny
  else y1 = ny
  return {
    nx: Math.min(x0, x1),
    ny: Math.min(y0, y1),
    nx2: Math.max(x0, x1),
    ny2: Math.max(y0, y1)
  }
}

export function removeShapes(session: Session, ids: string[]): Session {
  const set = new Set(ids)
  return { ...session, shapes: (session.shapes ?? []).filter((s) => !set.has(s.id)) }
}

export function shapesOnPage(session: Session, pageId: string | null): Shape[] {
  if (!pageId) return []
  return (session.shapes ?? []).filter((s) => s.page === pageId)
}

/** Is this drag big enough to be a shape, or was it a stray click? */
export const SHAPE_MIN_DRAG = 0.004

export function isDragMeaningful(nx: number, ny: number, nx2: number, ny2: number): boolean {
  return Math.abs(nx2 - nx) >= SHAPE_MIN_DRAG || Math.abs(ny2 - ny) >= SHAPE_MIN_DRAG
}

// --------------------------------------------------------------- image pages

/**
 * Where an image sits on the page it becomes.
 *
 * MUST match engine images.py (LETTER, MARGIN, `_layout`). Marks are stored in
 * normalized PAGE coordinates, so if the app's preview frames the picture
 * differently from the export, a tick placed on a receipt lands somewhere else
 * in the PDF. `verify:model` compares the two implementations directly rather
 * than trusting them to agree.
 *
 * Lives in the model, not the render layer, because it decides page geometry —
 * and because the render layer can't be imported outside a browser build.
 */
const LETTER: readonly [number, number] = [612, 792]
const IMAGE_MARGIN = 18

export interface ImageLayout {
  /** Page size in points, before any user rotation. */
  pageW: number
  pageH: number
  /** Image rect within the page, measured from the TOP-left. */
  x: number
  y: number
  w: number
  h: number
}

/** Fit to Letter, auto-oriented: a portrait image gets a portrait page. */
export function imageLayout(imgW: number, imgH: number): ImageLayout {
  const [pw, ph] = imgH >= imgW ? LETTER : [LETTER[1], LETTER[0]]
  const scale = Math.min((pw - 2 * IMAGE_MARGIN) / imgW, (ph - 2 * IMAGE_MARGIN) / imgH)
  const w = imgW * scale
  const h = imgH * scale
  // Centred, so measuring y from the top matches the engine measuring from the
  // bottom — no flip is needed here, and none should ever creep in.
  return { pageW: pw, pageH: ph, x: (pw - w) / 2, y: (ph - h) / 2, w, h }
}

// ---------------------------------------------------------------------- tapes

/**
 * Tape geometry. Must match engine appearance.py — the on-screen card and the
 * exported card are the same object at two moments, and a preparer who lines a
 * tape up beside a number expects it to still be there after export.
 */
export const TAPE_FONT_SIZE = 9
export const TAPE_LINE_HEIGHT = 11
export const TAPE_PAD = 6
export const TAPE_CHAR_W = TAPE_FONT_SIZE * 0.6 // Courier advance = 0.6 em

/**
 * Sum in whole cents.
 *
 * Money summed as floats gives 1490.0000000001, and a workpaper total that
 * doesn't foot to the cent is a defect, not a rounding curiosity.
 */
/**
 * The running total after each line — 10-key chain semantics: every operator
 * applies to the total so far, not to a column of independent addends.
 *
 * Arithmetic is carried in INTEGER CENTS and rounded at every step, which is
 * what a physical adding machine does and what makes the tape auditable: each
 * printed line is exact, so the figures shown always foot to the total shown.
 * Carrying full precision and rounding only at the end produces tapes whose
 * printed lines do not add up to their printed total — indefensible in a
 * workpaper.
 */
export function tapeRunning(entries: TapeEntry[]): number[] {
  let cents = 0
  return entries.map((e, i) => {
    const v = e.value
    if (i === 0) {
      // The first line seeds the total. Starting a tape with × or ÷ against an
      // implicit zero would silently zero the whole thing.
      cents = Math.round((e.op === '-' ? -v : v) * 100)
    } else if (e.op === '+') {
      cents = cents + Math.round(v * 100)
    } else if (e.op === '-') {
      cents = cents - Math.round(v * 100)
    } else if (e.op === '×') {
      cents = Math.round(cents * v)
    } else if (e.op === '÷') {
      // Division by zero leaves the total untouched rather than producing
      // Infinity. The UI refuses to commit such a line; a hand-edited or
      // agent-written session must not be able to poison a total.
      if (v !== 0) cents = Math.round(cents / v)
    }
    return cents / 100
  })
}

export function tapeTotal(entries: TapeEntry[]): number {
  const running = tapeRunning(entries)
  return running.length ? running[running.length - 1] : 0
}

/** Accept a bare number as a "+" line — the old shape, and a convenient input. */
export function toTapeEntry(v: TapeEntry | number): TapeEntry {
  if (typeof v === 'number') {
    return v < 0 ? { value: -v, op: '-' } : { value: v, op: '+' }
  }
  const op = (TAPE_OPS as readonly string[]).includes(v.op) ? v.op : '+'
  return { value: v.value, op, ...(v.note ? { note: v.note } : {}) }
}

/** "1,200.00" / "-50.00" — adding-machine convention, minus sign not parens. */
export function formatAmount(value: number): string {
  const neg = value < 0 || Object.is(value, -0)
  const abs = Math.abs(value)
  const [whole, frac] = abs.toFixed(2).split('.')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${neg ? '-' : ''}${grouped}.${frac}`
}

/**
 * Parse what the 10-key buffer holds into a number, or null if it isn't one.
 * Accepts what a preparer actually types: "1200", "1200.5", "1,200.50", ".75".
 */
export function parseAmount(raw: string): number | null {
  const cleaned = raw.replace(/,/g, '').trim()
  if (!/^-?(\d+(\.\d*)?|\.\d+)$/.test(cleaned)) return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

/**
 * The tape exactly as it will be drawn — the columnar adding-machine grid:
 *
 *     1 - 0 |          |            |   |
 *     1 - 1 | Fees     |   1,200.00 | + |  1,200.00
 *     1 - 2 | Fees     |     340.00 | + |  1,540.00
 *     1 - 3 | x 35%    |       0.35 | × |    539.00
 *     1 - T | Total    |            | * |    539.00
 *
 * Section-and-line labels make every figure addressable, which is what turns a
 * column of numbers into something a reviewer can point at.
 *
 * The RESULT column is what makes × and ÷ verifiable: an operand alone
 * ("0.35") says nothing without the running value it acted on. The column is
 * omitted entirely on a tape that only adds and subtracts, where the amounts
 * already foot by eye and a second number column is just noise.
 *
 * The engine draws these strings verbatim in Courier, so padding with spaces IS
 * the alignment.
 */
export function tapeLines(tape: Tape): string[] {
  const section = tape.section ?? 1
  const running = tapeRunning(tape.entries)
  // A chain operator is what makes the running value worth showing.
  const showResult = tape.entries.some((e) => e.op === '×' || e.op === '÷')

  const rows = tape.entries.map((e, i) => ({
    label: `${section} - ${i + 1}`,
    note: e.note?.trim() ?? '',
    amount: formatAmount(e.value),
    op: e.op,
    result: formatAmount(running[i])
  }))
  const total = formatAmount(tapeTotal(tape.entries))
  const headLabel = `${section} - 0`
  const totalLabel = `${section} - T`

  const labelW = Math.max(headLabel.length, totalLabel.length, ...rows.map((r) => r.label.length))
  const noteW = Math.max(8, ...rows.map((r) => r.note.length), 'Total'.length)
  const amtW = Math.max(total.length, ...rows.map((r) => r.amount.length), 8)
  const resW = Math.max(total.length, ...rows.map((r) => r.result.length), 8)

  // The op column is one character wide even when empty, or the header row
  // comes out a character short and the card's right edge looks ragged.
  const line = (label: string, note: string, amount: string, op: string, result: string): string =>
    `${label.padEnd(labelW)} | ${note.padEnd(noteW)} | ${amount.padStart(amtW)} | ${op.padEnd(1)}` +
    (showResult ? ` | ${result.padStart(resW)}` : '')

  const gridW = line(headLabel, '', '', '', '').length
  const title = tape.title?.trim() ?? ''
  return [
    ...(title ? [title.padEnd(gridW)] : []),
    line(headLabel, '', '', '', ''),
    ...rows.map((r) => line(r.label, r.note, r.amount, r.op, r.result)),
    // On a chain tape the total belongs in the Result column, under the running
    // values it continues — not in the operand column.
    showResult
      ? line(totalLabel, 'Total', '', '*', total)
      : line(totalLabel, 'Total', total, '*', '')
  ]
}

/** Displayed size of a tape in points — mirrors engine appearance.tape_size. */
export function tapeSize(tape: Tape): { w: number; h: number } {
  const lines = tapeLines(tape)
  const maxChars = Math.max(1, ...lines.map((l) => l.length))
  return {
    w: maxChars * TAPE_CHAR_W + 2 * TAPE_PAD,
    h: lines.length * TAPE_LINE_HEIGHT + 2 * TAPE_PAD
  }
}

export function addTape(
  session: Session,
  tape: Omit<Tape, 'id' | 'created' | 'author'> & { author?: string }
): { session: Session; id: string } {
  const seq = session.seq + 1
  const id = `tp_${seq}`
  const next: Tape = {
    ...tape,
    id,
    author: tape.author ?? session.reviewer ?? '',
    created: new Date().toISOString()
  }
  return { session: { ...session, seq, tapes: [...(session.tapes ?? []), next] }, id }
}

export function updateTape(session: Session, id: string, patch: Partial<Tape>): Session {
  return {
    ...session,
    tapes: (session.tapes ?? []).map((t) =>
      t.id === id
        ? {
            ...t,
            ...patch,
            nx: patch.nx === undefined ? t.nx : Math.min(1, Math.max(0, patch.nx)),
            ny: patch.ny === undefined ? t.ny : Math.min(1, Math.max(0, patch.ny))
          }
        : t
    )
  }
}

/** Key one more line onto a tape. */
export function pushTapeEntry(
  session: Session,
  id: string,
  entry: TapeEntry | number
): Session {
  const tape = (session.tapes ?? []).find((t) => t.id === id)
  if (!tape) return session
  return updateTape(session, id, { entries: [...tape.entries, toTapeEntry(entry)] })
}

/** Undo the last keyed line — the ⌫ a preparer reaches for on a mis-key. */
export function popTapeEntry(session: Session, id: string): Session {
  const tape = (session.tapes ?? []).find((t) => t.id === id)
  if (!tape || tape.entries.length === 0) return session
  return updateTape(session, id, { entries: tape.entries.slice(0, -1) })
}

/** Edit one line in place — its figure, its operator, or its note. */
export function updateTapeEntry(
  session: Session,
  id: string,
  index: number,
  patch: Partial<TapeEntry>
): Session {
  const tape = (session.tapes ?? []).find((t) => t.id === id)
  if (!tape || index < 0 || index >= tape.entries.length) return session
  const entries = tape.entries.map((e, i) => (i === index ? { ...e, ...patch } : e))
  return updateTape(session, id, { entries })
}

/** Remove one line, so a mis-key in the middle doesn't mean retyping the tape. */
export function removeTapeEntry(session: Session, id: string, index: number): Session {
  const tape = (session.tapes ?? []).find((t) => t.id === id)
  if (!tape || index < 0 || index >= tape.entries.length) return session
  return updateTape(session, id, { entries: tape.entries.filter((_, i) => i !== index) })
}

export function removeTapes(session: Session, ids: string[]): Session {
  const set = new Set(ids)
  return { ...session, tapes: (session.tapes ?? []).filter((t) => !set.has(t.id)) }
}

export function tapesOnPage(session: Session, pageId: string | null): Tape[] {
  if (!pageId) return []
  return (session.tapes ?? []).filter((t) => t.page === pageId)
}

// -------------------------------------------------------------- custom stamps

/** Clean a stamp the user typed: one line, no control characters, capped. */
export function normalizeStamp(raw: string): string {
  return sanitizeTitle(raw).replace(/\s+/g, ' ').slice(0, STAMP_MAX_LEN).trim()
}

/**
 * Save a custom stamp for reuse. Blank and exact duplicates are no-ops, so the
 * caller can just hand over whatever is in the input box.
 */
export function addStamp(session: Session, raw: string): Session {
  const text = normalizeStamp(raw)
  if (!text) return session
  const stamps = session.stamps ?? []
  if (stamps.includes(text)) return session
  return { ...session, stamps: [...stamps, text] }
}

/** Forget a custom stamp. Marks already placed with it are untouched. */
export function removeStamp(session: Session, text: string): Session {
  const stamps = (session.stamps ?? []).filter((s) => s !== text)
  return { ...session, stamps }
}

// ------------------------------------------------------------------ bookmarks

export interface BookmarkOptions {
  /**
   * Append "(N pages)" to every bookmark — the span from its page up to the
   * next bookmark's page. Replicates the count preparers type by hand.
   */
  pageCounts?: boolean
  /**
   * When a single source supplies the whole binder AND already has its own
   * outline, skip the redundant file-level wrapper. Default true.
   */
  collapseSingleSource?: boolean
}

/**
 * A trailing page count. Deliberately permissive: real workpaper titles come
 * from whatever a human typed in Acrobat years ago, so this tolerates
 * non-breaking / unicode spaces, full-width parentheses, "pgs", and a trailing
 * period.
 */
const SP = '[\\s\\u00a0\\u2000-\\u200b\\u202f\\u205f\\u3000]'
const PAGE_COUNT_SUFFIX = new RegExp(
  `${SP}*[(（]${SP}*\\d+${SP}*(?:pages?|pgs?|p)\\.?${SP}*[)）]${SP}*$`,
  'i'
)

/**
 * Drop a hand-typed "(2 pages)" so a generated count can't double up.
 * Loops, so a title that already picked up two of them collapses back to one.
 */
export function stripPageCount(title: string): string {
  let out = title
  for (let i = 0; i < 8; i++) {
    const next = out.replace(PAGE_COUNT_SUFFIX, '')
    if (next === out) break
    out = next
  }
  return out.replace(new RegExp(`^${SP}+|${SP}+$`, 'g'), '')
}

export const USER_BOOKMARK_PREFIX = 'u:'

/**
 * Rename a bookmark. For an imported/file bookmark, null or '' reverts to the
 * original title. For a user-created one the title is stored directly (and a
 * blank falls back to "Untitled").
 *
 * Renames live on the session, so they persist across save/reopen and survive
 * any amount of page reordering.
 */
export function setBookmarkTitle(
  session: Session,
  key: string,
  title: string | null
): Session {
  const next = title?.trim() ?? ''

  if (key.startsWith(USER_BOOKMARK_PREFIX)) {
    const id = key.slice(USER_BOOKMARK_PREFIX.length)
    return {
      ...session,
      bookmarks: (session.bookmarks ?? []).map((b) =>
        b.id === id ? { ...b, title: next === '' ? 'Untitled' : next } : b
      )
    }
  }

  const titles = { ...(session.titles ?? {}) }
  if (next === '') delete titles[key]
  else titles[key] = next
  return { ...session, titles }
}

/** Add a bookmark on a page. Returns the session and the new bookmark's key. */
export function addBookmark(
  session: Session,
  pageId: string,
  title = 'New bookmark',
  depth = 0
): { session: Session; key: string } {
  const seq = session.seq + 1
  const id = `bm_${seq}`
  return {
    session: {
      ...session,
      seq,
      bookmarks: [...(session.bookmarks ?? []), { id, page: pageId, title, depth }]
    },
    key: `${USER_BOOKMARK_PREFIX}${id}`
  }
}

export function removeBookmark(session: Session, key: string): Session {
  if (!key.startsWith(USER_BOOKMARK_PREFIX)) return session
  const id = key.slice(USER_BOOKMARK_PREFIX.length)
  return { ...session, bookmarks: (session.bookmarks ?? []).filter((b) => b.id !== id) }
}

/** Indent (+1) or outdent (-1) a user bookmark. Imported ones keep their level. */
export function nudgeBookmarkDepth(session: Session, key: string, delta: number): Session {
  if (!key.startsWith(USER_BOOKMARK_PREFIX)) return session
  const id = key.slice(USER_BOOKMARK_PREFIX.length)
  return {
    ...session,
    bookmarks: (session.bookmarks ?? []).map((b) =>
      b.id === id ? { ...b, depth: Math.max(0, Math.min(5, b.depth + delta)) } : b
    )
  }
}

/** File-level bookmarks read as document names, not filenames. */
function stripSourceExt(name: string): string {
  return name.replace(/\.(pdf|png|jpe?g|jpe|gif|bmp|tiff?|webp)$/i, '')
}

/**
 * Annotate LEAF bookmarks with the number of binder pages they cover: from the
 * bookmark's own page up to the next bookmark's page (in binder order), or to
 * the end of the binder for the last one.
 *
 * Leaves only, deliberately. In real workpaper files the count is a property of
 * a *document* ("General_Ledger (2 pages)" on page 3, next bookmark on page 5),
 * never of a section heading — and a heading whose first child sits on the same
 * page would otherwise be labelled "(1 page)" while covering a dozen.
 */
function applyPageCounts(
  nodes: BookmarkNode[],
  indexOf: Map<string, number>,
  totalPages: number
): BookmarkNode[] {
  const targets = new Set<number>()
  const collect = (ns: BookmarkNode[]): void => {
    for (const n of ns) {
      const i = indexOf.get(n.page)
      if (i !== undefined) targets.add(i)
      collect(n.children)
    }
  }
  collect(nodes)
  const sorted = [...targets].sort((a, b) => a - b)

  const spanAt = (i: number): number => {
    const next = sorted.find((t) => t > i)
    return (next ?? totalPages) - i
  }

  const walk = (ns: BookmarkNode[]): BookmarkNode[] =>
    ns.map((n) => {
      const base = stripPageCount(n.title)
      const i = indexOf.get(n.page)
      const isLeaf = n.children.length === 0
      if (!isLeaf || i === undefined) {
        return { ...n, title: base, children: walk(n.children) }
      }
      const span = spanAt(i)
      return { ...n, title: `${base} (${span} ${span === 1 ? 'page' : 'pages'})`, children: [] }
    })

  return walk(nodes)
}

/**
 * File-level bookmark per source (in binder order), with that source's own
 * imported outline nested beneath, retargeted to surviving pages.
 *
 * If an imported bookmark's target page was deleted, the bookmark is dropped
 * but its children are hoisted, so a deleted parent page never silently
 * removes navigation to pages that are still present.
 */
export function buildBookmarks(session: Session, opts: BookmarkOptions = {}): BookmarkNode[] {
  const { pageCounts = false, collapseSingleSource = true } = opts
  const firstPageOf = new Map<string, string>()
  for (const p of session.pages) {
    if (!firstPageOf.has(p.source)) firstPageOf.set(p.source, p.id)
  }

  const pageIdFor = (sourceId: string, index: number): string | null =>
    session.pages.find((p) => p.source === sourceId && p.index === index)?.id ?? null

  /** User rename wins over the imported title. */
  const titled = (key: string, fallback: string): string => session.titles?.[key] ?? fallback

  const mapNodes = (
    sourceId: string,
    nodes: OutlineNode[],
    prefix: number[] = []
  ): BookmarkNode[] =>
    nodes.flatMap((n, i) => {
      const path = [...prefix, i]
      const key = `o:${sourceId}:${path.join('.')}`
      const children = mapNodes(sourceId, n.children, path)
      const target = n.destPage === null ? null : pageIdFor(sourceId, n.destPage)
      // Target page deleted: drop this bookmark but keep its children (which
      // retain their own keys, so their renames survive too).
      if (!target) return children
      return [{ key, title: titled(key, n.title), page: target, children }]
    })

  // Order sources by where they first appear in the binder.
  const order = [...firstPageOf.keys()]
  const perSource = order.flatMap((sourceId) => {
    const source = session.sources.find((s) => s.id === sourceId)
    const page = firstPageOf.get(sourceId)
    if (!source || !page) return []
    const children = mapNodes(sourceId, source.outline)
    return [{ source, page, children }]
  })

  let tree: BookmarkNode[]
  if (collapseSingleSource && perSource.length === 1 && perSource[0].children.length > 0) {
    // One source that already carries its own outline: the filename wrapper is
    // a dead level the user has to expand past.
    tree = perSource[0].children
  } else {
    tree = perSource.map(({ source, page, children }) => {
      const key = `f:${source.id}`
      return { key, title: titled(key, stripSourceExt(source.name)), page, children }
    })
  }

  const indexOf = new Map(session.pages.map((p, i) => [p.id, i]))
  tree = mergeUserBookmarks(tree, session, indexOf)

  if (!pageCounts) return tree
  return applyPageCounts(tree, indexOf, session.pages.length)
}

interface FlatEntry {
  key: string
  title: string
  page: string
  depth: number
}

function flattenTree(nodes: BookmarkNode[], depth = 0): FlatEntry[] {
  return nodes.flatMap((n) => [
    { key: n.key, title: n.title, page: n.page, depth },
    ...flattenTree(n.children, depth + 1)
  ])
}

/** Rebuild a nested tree from a flat depth sequence (levels can't be skipped). */
function rebuildTree(entries: FlatEntry[]): BookmarkNode[] {
  const root: BookmarkNode[] = []
  const stack: BookmarkNode[][] = [root]
  for (const e of entries) {
    const depth = Math.min(e.depth, stack.length - 1)
    const node: BookmarkNode = { key: e.key, title: e.title, page: e.page, children: [] }
    stack[depth].push(node)
    stack.length = depth + 1
    stack.push(node.children)
  }
  return root
}

/**
 * Splice user bookmarks into the imported outline by binder page order.
 *
 * The imported entries are deliberately NOT re-sorted: an outline may legally
 * point a parent at a later page than its child, and sorting by page would
 * scramble that nesting. Instead each user bookmark is inserted after the last
 * imported entry that sits on the same page or earlier.
 */
function mergeUserBookmarks(
  tree: BookmarkNode[],
  session: Session,
  indexOf: Map<string, number>
): BookmarkNode[] {
  const users = (session.bookmarks ?? []).filter((b) => indexOf.has(b.page))
  if (users.length === 0) return tree

  const entries = flattenTree(tree)
  for (const b of [...users].sort((x, y) => indexOf.get(x.page)! - indexOf.get(y.page)!)) {
    const target = indexOf.get(b.page)!
    let pos = 0
    for (let i = 0; i < entries.length; i++) {
      const at = indexOf.get(entries[i].page)
      if (at !== undefined && at <= target) pos = i + 1
    }
    entries.splice(pos, 0, {
      key: `${USER_BOOKMARK_PREFIX}${b.id}`,
      title: b.title,
      page: b.page,
      depth: b.depth
    })
  }
  return rebuildTree(entries)
}

// --------------------------------------------------------------------- export

export interface ExportOptions extends BookmarkOptions {
  /** Burn marks into page content rather than writing them as annotations. */
  flatten?: boolean
}

export function toExportSpec(
  session: Session,
  output: string,
  opts: ExportOptions = {}
): ExportSpec {
  const { flatten = false, ...bookmarkOpts } = opts
  const used = new Set(session.pages.map((p) => p.source))
  const sources: Record<string, string> = {}
  const sourceFingerprints: Record<string, SourceFingerprint> = {}
  for (const s of session.sources) {
    if (used.has(s.id)) {
      sources[s.id] = s.path
      if (s.fingerprint) sourceFingerprints[s.id] = s.fingerprint
    }
  }
  return {
    sources,
    ...(Object.keys(sourceFingerprints).length ? { source_fingerprints: sourceFingerprints } : {}),
    pages: session.pages.map((p) => ({
      id: p.id,
      source: p.source,
      index: p.index,
      rotate: p.rotate
    })),
    bookmarks: buildBookmarks(session, bookmarkOpts),
    // Marks and tapes whose page survived; the engine reads these as annotations.
    annotations: [
      ...(session.marks ?? [])
      .filter((m) => session.pages.some((p) => p.id === m.page))
      .map((m) => ({
        kind: m.kind,
        page: m.page,
        nx: m.nx,
        ny: m.ny,
        size: m.size,
        ...(m.text ? { text: m.text } : {}),
        ...(m.author ? { author: m.author } : {}),
        ...(m.note ? { note: m.note } : {}),
        ...(m.created ? { created: m.created } : {})
      })),
      // Drawn annotations. Two corners, not a point — the engine turns them
      // into stroked paths sized to the drag.
      ...(session.shapes ?? [])
        .filter((x) => session.pages.some((p) => p.id === x.page))
        .map((x) => ({
          kind: x.kind,
          page: x.page,
          nx: x.nx,
          ny: x.ny,
          nx2: x.nx2,
          ny2: x.ny2,
          color: x.color,
          width: x.width,
          ...(x.text ? { text: x.text } : {}),
          ...(x.author ? { author: x.author } : {}),
          ...(x.note ? { note: x.note } : {}),
          ...(x.created ? { created: x.created } : {})
        })),
      // Tapes carry BOTH the drawn lines and the structured entries: the lines
      // are what a viewer shows, the entries are what a tie-out layer reads.
      ...(session.tapes ?? [])
        .filter((t) => session.pages.some((p) => p.id === t.page))
        .map((t) => ({
          kind: 'tape',
          page: t.page,
          nx: t.nx,
          ny: t.ny,
          lines: tapeLines(t),
          tape: {
            entries: t.entries,
            total: tapeTotal(t.entries),
            ...(t.title ? { title: t.title } : {}),
            ...(t.created ? { created: t.created } : {})
          },
          ...(t.author ? { author: t.author } : {})
        }))
    ],
    ...(flatten ? { flatten: true } : {}),
    output
  }
}

// ---------------------------------------------------------------- validation

/** Accept a session read from disk, or explain why it can't be used. */
export function parseSession(raw: unknown): { session: Session } | { error: string } {
  if (typeof raw !== 'object' || raw === null) return { error: 'not a session file' }
  const s = raw as Partial<Session>
  if (typeof s.formatVersion !== 'number') return { error: 'missing formatVersion' }
  if (s.formatVersion > SESSION_FORMAT_VERSION) {
    return {
      error: `session was written by a newer version (format ${s.formatVersion}, this build reads ${SESSION_FORMAT_VERSION})`
    }
  }
  if (!Array.isArray(s.sources) || !Array.isArray(s.pages)) return { error: 'malformed session' }
  const known = new Set(s.sources.map((x) => x.id))
  for (const p of s.pages) {
    if (!known.has(p.source)) return { error: `page ${p.id} references unknown source ${p.source}` }
  }
  const pageIds = new Set(s.pages.map((p) => p.id))
  const seq = typeof s.seq === 'number' ? s.seq : s.pages.length + s.sources.length
  return {
    session: {
      formatVersion: SESSION_FORMAT_VERSION,
      // Sessions written before image support have no `kind`; they were all PDFs.
      sources: s.sources.map((x) => ({ ...x, kind: x.kind === 'image' ? 'image' : 'pdf' })),
      pages: s.pages.map((p) => ({ ...p, rotate: p.rotate ?? 0 })),
      seq,
      ...(s.titles && typeof s.titles === 'object' ? { titles: s.titles } : {}),
      ...(Array.isArray(s.bookmarks)
        ? { bookmarks: s.bookmarks.filter((b) => pageIds.has(b.page)) }
        : {}),
      ...(Array.isArray(s.marks)
        ? { marks: s.marks.filter((m) => pageIds.has(m.page)) }
        : {}),
      ...(Array.isArray(s.shapes)
        ? {
            shapes: s.shapes
              .filter((x) => pageIds.has(x.page))
              .map((x) => ({
                ...x,
                color: (SHAPE_COLOR_NAMES as readonly string[]).includes(x.color)
                  ? x.color
                  : 'red',
                width:
                  typeof x.width === 'number' && Number.isFinite(x.width)
                    ? x.width
                    : SHAPE_WIDTH_DEFAULT
              }))
          }
        : {}),
      ...(Array.isArray(s.tapes)
        ? {
            tapes: s.tapes
              .filter((t) => pageIds.has(t.page))
              // A tape whose entries didn't survive the round trip would render
              // a total with nothing behind it — drop the junk, keep the tape.
              .map((t) => ({
                ...t,
                // Sessions written before per-line operators stored bare
                // numbers; a negative one was a subtraction.
                entries: (Array.isArray(t.entries) ? t.entries : [])
                  .filter(
                    (v) =>
                      (typeof v === 'number' && Number.isFinite(v)) ||
                      (v && typeof v === 'object' && Number.isFinite((v as TapeEntry).value))
                  )
                  .map(toTapeEntry)
              }))
          }
        : {}),
      ...(typeof s.reviewer === 'string' ? { reviewer: s.reviewer } : {}),
      ...(Array.isArray(s.stamps)
        ? {
            stamps: [
              ...new Set(
                s.stamps
                  .filter((x): x is string => typeof x === 'string')
                  .map(normalizeStamp)
                  .filter(Boolean)
              )
            ]
          }
        : {})
    }
  }
}

// ------------------------------------------------------------------- helpers

export function sourceOf(session: Session, page: BinderPage): SourceDoc | undefined {
  return session.sources.find((s) => s.id === page.source)
}

/** "TaxForm-A.pdf p.3" — provenance, shown on hover per DESIGN.md. */
export function pageProvenance(session: Session, page: BinderPage): string {
  const src = sourceOf(session, page)
  return `${src?.name ?? page.source} p.${page.index + 1}`
}
