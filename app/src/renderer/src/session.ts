/**
 * The binder session model — pure, serializable, no DOM or PDF dependencies
 * (so it can be verified headlessly: see app/scripts/verify-model.ts).
 *
 * Load-bearing design from the canonical spec: the session is JSON + untouched
 * source files. A PDF exists only at export. Every page carries a permanent id;
 * bookmarks (and later marks/tapes/links) reference page ids, so visible page
 * numbers are computed only at export and page moves carry everything along.
 */

/**
 * 2 — added agent attribution: provenance on annotations plus the journal.
 *
 * Bumped rather than added quietly. A build that predates attribution would
 * open a v2 session, ignore the journal, and drop it on the next save —
 * silently destroying an audit trail. The version guard makes such a build
 * refuse to open the file instead, which is the right failure for a record.
 */
export const SESSION_FORMAT_VERSION = 2

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
export type SourceKind = 'pdf' | 'image' | 'sheet' | 'document'

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
  /**
   * Displayed size in points WITH the page's own /Rotate already applied, but
   * not the user's delta. Recorded at import so the continuous scroller can lay
   * out 62 page slots without rendering them first — windowed rendering needs
   * to know how tall a page is before it decides not to draw it.
   */
  w?: number
  h?: number
}

/** Displayed size of a binder page, including the user's rotation delta. */
export function pageSize(p: BinderPage): { w: number; h: number } {
  const w = p.w ?? 612
  const h = p.h ?? 792
  const quarter = (((p.rotate % 360) + 360) % 360) % 180 !== 0
  return quarter ? { w: h, h: w } : { w, h }
}

/**
 * A bookmark the user created (as opposed to one imported from a source PDF's
 * own outline). Anchored to a page id, so it moves with its page.
 */
/**
 * Who made a change. Absent means a person: everything written before
 * attribution shipped was, and saying so implicitly keeps files small.
 */
export type Actor = 'human' | 'agent'

/**
 * Attribution carried by anything an agent creates.
 *
 * A workpaper is evidence. "The AI changed something and I cannot tell what"
 * is the first thing that fails a file review, so every artifact an agent
 * produces names itself and names the run it belongs to.
 */
export interface Provenance {
  by?: Actor
  /** Groups one agent session's work, so it can be reviewed or undone as a batch. */
  run?: string
}

/**
 * Exact bytes written by an agent export.
 *
 * This is evidence, not permission supplied by the caller. `binder_export`
 * may replace an existing file only when its canonical path and current
 * SHA-256 both match one of these records in this binder's journal.
 */
export interface JournalArtifact {
  kind: 'binder_export'
  path: string
  sha256: string
}

/**
 * One recorded action. The journal answers "what did the AI do to this file",
 * in order, in the reviewer's language.
 *
 * Deliberately records AGENT actions only. Journaling every human keystroke
 * would turn an engagement record into an input log without answering the
 * question anyone actually asks of it.
 */
export interface JournalEntry {
  id: string
  /** ISO timestamp. */
  at: string
  by: Actor
  run?: string
  /** Machine-readable, e.g. 'place_mark'. */
  action: string
  /** Human-readable, e.g. 'Ticked 84,200.00 on pg_7'. */
  what: string
  /**
   * Set when reverting the run cannot undo this. Reordering, rotation and
   * deletion change the binder itself rather than adding something removable,
   * so revert reports them instead of pretending.
   */
  structural?: boolean
  /** Present for a file-producing action whose exact bytes matter later. */
  artifact?: JournalArtifact
}

export interface UserBookmark extends Provenance {
  id: string
  page: string
  title: string
  /** Nesting level in the exported outline. 0 = top level. */
  depth: number
}

/** The review-mark palette. Colors and glyphs are defined by the engine. */
/**
 * 'note' is a review comment, not a verdict. A tick means agreed and a cross
 * means it does not — an agent flagging something to look at had neither, and
 * hanging the question off a tick puts an "agreed" glyph on the very thing it
 * is questioning.
 */
export type MarkKind = 'tick' | 'cross' | 'text' | 'note' | 'conn'

/**
 * Mark glyphs and colours. These mirror engine appearance.MARK_COLORS: they are
 * annotation CONTENT — they must look the same on screen and in the exported
 * PDF — not UI theme, which is why they live in the model beside the shape
 * colours rather than in a component.
 */
export const MARK_GLYPH: Record<MarkKind, string> = {
  tick: '✓',
  cross: '✕',
  text: '',
  // A universal symbol, per the project's glyph rule — this one needs no word.
  note: '✎',
  // Drawn as a ring around its label, so the glyph is the label itself.
  conn: ''
}

export const MARK_COLOR: Record<MarkKind, string> = {
  tick: 'rgb(33,140,33)',
  cross: 'rgb(184,38,38)',
  text: 'rgb(26,84,153)',
  // Amber: asks for attention without asserting a fault the way the cross does.
  // Must match engine appearance.MARK_COLORS['note'] — annotation content, not
  // UI theme.
  note: 'rgb(199,130,26)',
  // Violet, deliberately outside the green/red/blue the judgment marks use. A
  // connector asserts NOTHING about the figure — it says "this is the same
  // number as that one over there" — so it must not read as an agreed or a
  // disagreed. Must match engine appearance.MARK_COLORS['conn'].
  conn: 'rgb(112,58,148)'
}

const XML_ESCAPE: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;'
}

/**
 * A CSS cursor drawn as the mark itself, so an armed stamp is visible at the
 * point of aim rather than only in the toolbar.
 *
 * Point-placed marks only. A rectangle or an ellipse is DRAGGED OUT, so its
 * cursor should be a crosshair showing the corner you are starting from — a
 * glyph there would sit where nothing is about to appear.
 *
 * The hotspot is the image centre because a mark is centred on the click.
 * 32×32 is deliberate: macOS silently ignores larger cursors.
 */
export function markCursor(kind: MarkKind, text = ''): string {
  const glyph = (kind === 'text' || kind === 'conn' ? text : MARK_GLYPH[kind]) || '?'
  const safe = glyph.replace(/[&<>"']/g, (c) => XML_ESCAPE[c])
  // Shrink lettered stamps so longer ones ("A/R", initials) still fit the box.
  // A connector's ring is fixed, so its label shrinks harder to stay inside it.
  const size =
    kind === 'text'
      ? Math.max(9, Math.min(20, 34 / Math.max(1, glyph.length)))
      : kind === 'conn'
        ? Math.max(8, Math.min(15, 26 / Math.max(1, glyph.length)))
        : 23
  // The connector's ring, drawn under the label. Showing the NEXT label at the
  // point of aim is the whole reason auto-advance is usable — otherwise you
  // find out which number you placed after you have placed it.
  const ring =
    kind === 'conn'
      ? `<circle cx="16" cy="16" r="10" fill="#ffffff" fill-opacity="0.85" ` +
        `stroke="${MARK_COLOR.conn}" stroke-width="1.8" />`
      : ''
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">` +
    ring +
    `<text x="16" y="16" text-anchor="middle" dominant-baseline="central" ` +
    `font-family="-apple-system,Segoe UI,sans-serif" font-weight="700" font-size="${size}" ` +
    // A white halo keeps the glyph readable over dark scans as well as white
    // paper; paint-order draws the stroke behind the fill. The connector paints
    // its own ring instead — a halo would eat the ring it sits inside.
    (kind === 'conn'
      ? `fill="${MARK_COLOR[kind]}">`
      : `paint-order="stroke" stroke="#ffffff" stroke-width="3" fill="${MARK_COLOR[kind]}">`) +
    `${safe}</text></svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 16 16, crosshair`
}

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
  orange: 'rgb(217,115,26)',
  grey: 'rgb(122,121,116)'
}
export const SHAPE_COLOR_NAMES = ['red', 'green', 'blue', 'black', 'orange', 'grey'] as const
export type ShapeColor = (typeof SHAPE_COLOR_NAMES)[number]

export const SHAPE_WIDTH_DEFAULT = 1.5
export const SHAPE_WIDTH_MIN = 0.5
export const SHAPE_WIDTH_MAX = 8

/** Highlighter appearance, mirrored from engine shapes.py for the preview. */
export const HIGHLIGHT_FILL = 'rgba(255,235,59,0.4)'

export interface Shape extends Provenance {
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

/**
 * A page status: "Reviewed", "Open item", "N/A" — a small legend the firm
 * defines, applied a page at a time.
 *
 * Applying one does three things at once, each independently switchable:
 * stamps the page with initials and a timestamp, draws a colored page border,
 * and colors that page's bookmark. Together they turn a 62-page binder into a
 * coverage map you can read from the rail and the bookmark tree.
 */
export interface StatusDef {
  id: string
  label: string
  color: ShapeColor
}

export interface PageStatus {
  /** StatusDef id. */
  status: string
  /** Who set it, and when — the same review record marks and tapes carry. */
  by?: string
  at?: string
}

/** Which parts of a status get drawn. Mirrors PDFlyer's Set Status dialog. */
export interface StatusParts {
  stamp: boolean
  border: boolean
  bookmark: boolean
  /** Which corner the stamp sits in, so it can dodge page content. */
  corner: 'tl' | 'tr' | 'bl' | 'br'
  borderWidth: number
}

export const DEFAULT_STATUS_PARTS: StatusParts = {
  stamp: true,
  border: true,
  bookmark: true,
  corner: 'tr',
  borderWidth: 4
}

/**
 * Binder page numbering.
 *
 * Numbers follow BINDER ORDER, so they are computed at export from each page's
 * final position — never stored per page. Store them and the first reorder
 * leaves a binder numbered 1, 2, 5, 3, 4, which is worse than no numbers at
 * all because it looks authoritative.
 */
export type NumberStyle = 'number' | 'pageOfTotal' | 'bates'

export interface Numbering {
  enabled: boolean
  style: NumberStyle
  /** Bates prefix, e.g. "WP-". */
  prefix: string
  /** Number given to the first page. */
  start: number
  /** Zero-padding for Bates, e.g. 6 -> WP-000014. */
  digits: number
  corner: 'tl' | 'tr' | 'bl' | 'br'
  /** Point size of the printed number. */
  size: number
}

export const DEFAULT_NUMBERING: Numbering = {
  enabled: false,
  style: 'number',
  prefix: 'WP-',
  start: 1,
  digits: 4,
  corner: 'br',
  size: 9
}

/** What gets printed on page `index` (0-based) of a binder of `total`. */
export function formatPageNumber(index: number, total: number, cfg: Numbering): string {
  const n = cfg.start + index
  if (cfg.style === 'bates') {
    return `${cfg.prefix}${String(Math.max(0, n)).padStart(Math.max(1, cfg.digits), '0')}`
  }
  if (cfg.style === 'pageOfTotal') {
    return `Page ${n} of ${cfg.start + total - 1}`
  }
  return String(n)
}

export function numbering(session: Session): Numbering {
  return { ...DEFAULT_NUMBERING, ...(session.numbering ?? {}) }
}

/** Where the number sits, normalized to the page as displayed. */
export function numberAnchor(corner: Numbering['corner']): { nx: number; ny: number } {
  const inset = 0.055
  return {
    nx: corner === 'tl' || corner === 'bl' ? inset : 1 - inset,
    ny: corner === 'tl' || corner === 'tr' ? inset : 1 - inset
  }
}

export const DEFAULT_STATUS_DEFS: StatusDef[] = [
  { id: 'reviewed', label: 'Reviewed', color: 'green' },
  { id: 'open', label: 'Open item', color: 'red' },
  { id: 'na', label: 'N/A', color: 'grey' }
]

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
export interface Mark extends Provenance {
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
  /**
   * Page this mark's note refers to. The PRINTED page number is rendered from
   * it at export time, never stored — a stored number is right when it is
   * written and wrong after the next reorder. Paired with a `Link` for the
   * clickable half; this is the half that survives being printed.
   */
  refTarget?: string
  /** ISO timestamp — part of the review record. */
  created?: string
}

/**
 * A cross-reference from a spot on one page to another page.
 *
 * BOTH ENDS ARE PAGE IDS, never positions. That is the whole point: a tie
 * reference used to be written as prose — "ties to p.4" — with the position
 * resolved at tie time, so reordering the binder left it pointing confidently
 * at the wrong page. A link is the same kind of object a bookmark is, and
 * survives reorder for the same reason.
 *
 * The engine turns these into real PDF `/Link` annotations (binder.py step 4),
 * so they are clickable in Acrobat, Edge, Chrome and Preview — and the printed
 * page number that goes with them is resolved at EXPORT, via `Mark.refTarget`,
 * so paper and screen agree with the binder as it actually shipped.
 */
export interface Link extends Provenance {
  id: string
  /** Page carrying the clickable region. */
  page: string
  /** Page it jumps to. */
  target: string
  /** Clickable rect in visual coords: [nx0, ny0, nx1, ny1]. */
  rect: [number, number, number, number]
  /** What the reference is about — for the journal and the inventory. */
  label?: string
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

export interface Tape extends Provenance {
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
  /**
   * Courier point size. Every other dimension — character advance, line
   * height, padding — follows from it, so one number scales the whole card and
   * the preview cannot end up a different shape from the export. Absent means
   * the default; a tape made before tapes could be resized stays exactly as it
   * was drawn.
   */
  size?: number
  author?: string
  created?: string
}

/**
 * Longest caption a tape will hold. The card is sized to its widest line, so
 * an uncapped title would let one caption drag the card across the figures it
 * is meant to sit beside.
 *
 * Enforcing it is not the whole job. It used to be a bare `maxLength`, which
 * stops accepting keystrokes and says nothing — a longer caption was silently
 * shortened and the preparer had no way to know the binder disagreed with what
 * they typed. TapeLayer now says when the cap is reached. If this number
 * changes, that notice reads from the same constant and follows it.
 */
export const TAPE_TITLE_MAX_LEN = 28
/** Mirrors engine appearance.TAPE_FONT_SIZE / TAPE_SIZE_MIN / TAPE_SIZE_MAX. */
export const TAPE_SIZE_DEFAULT = 9
export const TAPE_SIZE_MIN = 6
export const TAPE_SIZE_MAX = 18
export const TAPE_SIZE_STEP = 1

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
  /**
   * Re-targeted bookmarks, keyed by BookmarkNode.key — the page-level twin of
   * `titles`. Only imported bookmarks need this: a user bookmark owns its page
   * outright, so re-assigning one just moves it.
   */
  bookmarkPages?: Record<string, string>
  /** Review marks (ticks, crosses, lettered stamps), anchored to page ids. */
  marks?: Mark[]
  /** Cross-page references, anchored to page ids at both ends. */
  links?: Link[]
  /** Reviewer initials, stamped as the author of new marks. */
  reviewer?: string
  /**
   * Reusable custom text stamps the user defined ("TB", "PY", "A/R", ...).
   * Every firm has its own tick-mark legend; the fixed palette can't cover it,
   * so the legend travels with the binder.
   */
  stamps?: string[]
  /**
   * What each tickmark MEANS in this binder — the legend a reader needs and a
   * peer reviewer asks for. Travels with the session, so a binder carries its
   * own key rather than depending on the firm's palette being installed
   * wherever it is opened next.
   */
  legend?: Legend
  /** Calculator tapes, anchored to page ids exactly as marks are. */
  tapes?: Tape[]
  /** Drawn annotations — rectangles, ellipses, lines, arrows, highlights, notes. */
  shapes?: Shape[]
  /** The firm's status legend. Absent = the built-in three. */
  statusDefs?: StatusDef[]
  /** Page id -> status. */
  statuses?: Record<string, PageStatus>
  /** Which parts of a status are drawn. */
  statusParts?: StatusParts
  /** Binder page numbering, applied at export. */
  numbering?: Numbering
  /**
   * What agents have done to this binder, oldest first. Part of the record —
   * it travels with the session and is never pruned automatically.
   */
  journal?: JournalEntry[]
  /**
   * The run currently being recorded into. Set while an agent is working; new
   * artifacts are stamped with it. Absent means a person is at the keyboard.
   */
  activeRun?: string
  /**
   * The cover memo, if one was generated.
   *
   * `pages` is the binder's page order at the moment it was written. A printed
   * summary is a SNAPSHOT — reorder the binder afterwards and its page
   * references are wrong — so this is what lets the app say so rather than let
   * a reviewer follow a reference to the wrong page.
   */
  cover?: { path: string; narrative?: string; pages: string }
}

export interface BookmarkNode {
  /** Set when the target page carries a status and bookmark styling is on. */
  color?: ShapeColor
  bold?: boolean
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
  /** The editable session, stored inside the binder. Absent on a flattened copy. */
  session?: Session
  source_fingerprints?: Record<string, SourceFingerprint>
  pages: Array<{ id: string; source: string; index: number; rotate: number }>
  bookmarks: BookmarkNode[]
  /** Engine-side annotation specs — review marks, tapes and shapes. */
  annotations: Array<Record<string, unknown>>
  /**
   * Internal links, a separate array because the engine builds them in its own
   * pass (binder.py step 4) against the final page order.
   */
  links?: Array<{ page: string; target_page: string; rect_n: number[] }>
  /**
   * Burn our marks into the page content instead of writing them as
   * annotations. For a binder that leaves the building: nothing to drag off,
   * nothing a viewer can silently reposition. Omitted when false so an
   * ordinary export's spec is unchanged.
   */
  flatten?: boolean
  /**
   * Final engine-side destination assertion. MCP exports set one while holding
   * the path lease so a non-cooperating editor cannot change/create the file
   * during materialization and still be overwritten at commit.
   */
  output_guard?: { must_not_exist: true } | { sha256: string }
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
  /**
   * Present when the source was a spreadsheet. `warnings` is how the engine
   * reports that it had to GUESS or gave up on something — a CSV whose encoding
   * had to be inferred, a sheet cut off at the row cap.
   *
   * The engine has always returned this and nothing ever read it: the field was
   * not declared here, so the one channel for "your spreadsheet did not import
   * exactly as written" ended at the process boundary. A warning nobody can see
   * is the same as no warning.
   */
  sheet?: {
    sheets: Array<{ name: string; rows: number; columns: number }>
    warnings: string[]
  }
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
    kind:
      probe.kind === 'image'
        ? 'image'
        : probe.kind === 'sheet'
          ? 'sheet'
          : probe.kind === 'document'
            ? 'document'
            : 'pdf',
    ...(probe.fingerprint ? { fingerprint: probe.fingerprint } : {}),
    outline: normalizeOutline(probe.outline)
  }
  const newPages: BinderPage[] = probe.pages.map((p) => {
    // CropBox is what viewers show; fall back to MediaBox when absent.
    const box = p.cropbox ?? p.mediabox
    const cw = Math.abs(box[2] - box[0])
    const ch = Math.abs(box[3] - box[1])
    const quarter = (((p.rotate % 360) + 360) % 360) % 180 !== 0
    return {
      id: `pg_${++seq}`,
      source: sourceId,
      index: p.index,
      rotate: 0,
      w: quarter ? ch : cw,
      h: quarter ? cw : ch
    }
  })
  return {
    ...session,
    seq,
    sources: [...session.sources, source],
    pages: [...session.pages, ...newPages]
  }
}

/** The single source id a reopened binder uses. */
export const BINDER_SOURCE_ID = 'binder'

/**
 * Re-point a session recovered from a binder at the binder's own pages.
 *
 * This is what makes the file self-contained. The session that was embedded
 * still lists the original PDFs it was assembled from, but those are now
 * *provenance* — a record of where each page came from — not something the app
 * needs on disk to open the file. Moving a binder to another machine, or
 * archiving the originals, must not stop it opening.
 *
 * The mapping is direct because export wrote the pages in binder order: binder
 * page N is `session.pages[N]`. Page ids are preserved, so every mark, tape,
 * shape and status stays attached to the page it was placed on.
 *
 * Rotation resets to zero: the user's rotation was applied to the page when the
 * binder was written, so the page in the file is already the right way up.
 * Carrying the old delta forward would rotate it a second time.
 *
 * Bookmarks come from the binder's own outline (`probe.outline`), which export
 * wrote with the final titles already in place. The rename and re-target
 * overrides are therefore dropped: they are keyed to source documents that this
 * session no longer has, and re-applying them would rename things twice.
 */
export function rebindToBinder(
  session: Session,
  probe: ProbeWire,
  workingPath: string,
  binderName: string
): { session: Session; error?: string } {
  if (probe.n_pages !== session.pages.length) {
    return {
      session,
      error:
        `this binder has ${probe.n_pages} pages but its saved session describes ` +
        `${session.pages.length} — it was changed by another program`
    }
  }

  const source: SourceDoc = {
    id: BINDER_SOURCE_ID,
    path: workingPath,
    name: binderName,
    nPages: probe.n_pages,
    kind: 'pdf',
    ...(probe.fingerprint ? { fingerprint: probe.fingerprint } : {}),
    outline: normalizeOutline(probe.outline)
  }

  const pages: BinderPage[] = session.pages.map((page, index) => {
    const geometry = probe.pages[index]
    const box = geometry.cropbox ?? geometry.mediabox
    const cw = Math.abs(box[2] - box[0])
    const ch = Math.abs(box[3] - box[1])
    const quarter = (((geometry.rotate % 360) + 360) % 360) % 180 !== 0
    return {
      id: page.id,
      source: BINDER_SOURCE_ID,
      index,
      rotate: 0,
      w: quarter ? ch : cw,
      h: quarter ? cw : ch
    }
  })

  const { titles: _titles, bookmarkPages: _pages, bookmarks: _bookmarks, ...rest } = session
  return { session: { ...rest, sources: [source], pages } }
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

/**
 * Apply a page's user rotation delta to a normalized display-space point.
 *
 * The engine reports text positions in the SOURCE page's display space, which
 * accounts for that page's own /Rotate but knows nothing about a rotation the
 * user applied inside the binder. Marks live in the binder's display space. On
 * any page someone straightened after import, the two differ by exactly this
 * delta — so text coordinates must come through here before they can be handed
 * to `addMark`, or the tick lands on the wrong edge of the page.
 */
export function rotateVisual(nx: number, ny: number, deg: number): { nx: number; ny: number } {
  const r = ((deg % 360) + 360) % 360
  if (r === 90) return { nx: 1 - ny, ny: nx }
  if (r === 180) return { nx: 1 - nx, ny: 1 - ny }
  if (r === 270) return { nx: ny, ny: 1 - nx }
  return { nx, ny }
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
    // A link dies with EITHER endpoint — a cross-reference to a page that is
    // gone is not a degraded link, it is a wrong one.
    ...(session.links
      ? { links: session.links.filter((l) => !idSet.has(l.page) && !idSet.has(l.target)) }
      : {}),
    ...(session.tapes ? { tapes: session.tapes.filter((t) => !idSet.has(t.page)) } : {}),
    ...(session.shapes ? { shapes: session.shapes.filter((x) => !idSet.has(x.page)) } : {}),
    ...(session.statuses
      ? {
          statuses: Object.fromEntries(
            Object.entries(session.statuses).filter(([pid]) => !idSet.has(pid))
          )
        }
      : {}),
    ...(session.bookmarks
      ? { bookmarks: session.bookmarks.filter((b) => !idSet.has(b.page)) }
      : {}),
    ...(session.bookmarkPages
      ? {
          bookmarkPages: Object.fromEntries(
            Object.entries(session.bookmarkPages).filter(([, pid]) => !idSet.has(pid))
          )
        }
      : {})
  }
}

// ---------------------------------------------------------------------- marks

/** Place a mark on a page at normalized display coordinates. */
// ------------------------------------------------------------ attribution

/**
 * Open an agent run. Everything created until `endRun` is stamped with it and
 * can be reviewed — or removed — as one batch.
 */
export function beginRun(session: Session): { session: Session; run: string } {
  const seq = session.seq + 1
  const run = `run_${seq}`
  return { session: { ...session, seq, activeRun: run }, run }
}

export function endRun(session: Session): Session {
  const { activeRun: _dropped, ...rest } = session
  return rest
}

/**
 * The session as it should be written to disk.
 *
 * `activeRun` is process state, not record state — it means "an agent is
 * working right now", which is never true of a file sitting on disk. Writing
 * it would put a false claim into a client record, and any reader that did not
 * go through `parseSession` would believe it. Stripped at the one place every
 * writer goes through, rather than trusting each caller to remember.
 */
export function toSaved(session: Session): Session {
  return endRun(session)
}

/** Append to the record. No-op for human actions — see JournalEntry. */
export function record(
  session: Session,
  entry: { action: string; what: string; structural?: boolean; artifact?: JournalArtifact }
): Session {
  if (!session.activeRun) return session
  const seq = session.seq + 1
  const next: JournalEntry = {
    id: `je_${seq}`,
    at: new Date().toISOString(),
    by: 'agent',
    run: session.activeRun,
    action: entry.action,
    what: entry.what,
    ...(entry.structural ? { structural: true } : {}),
    ...(entry.artifact ? { artifact: entry.artifact } : {})
  }
  return { ...session, seq, journal: [...(session.journal ?? []), next] }
}

/**
 * Undo an agent run by removing everything it added.
 *
 * Deliberately NOT a snapshot restore. Restoring the binder to its pre-run
 * state would also discard whatever a person did while the agent worked, and
 * would mean storing a copy of the engagement record inside itself. Removing
 * stamped artifacts touches only the agent's own work.
 *
 * The honest cost: reordering, rotation and deletion changed the binder rather
 * than adding something removable, so they survive. They are reported instead
 * of being silently left behind.
 */
export function revertRun(
  session: Session,
  run: string
): { session: Session; removed: number; structural: JournalEntry[] } {
  const mine = <T extends Provenance>(xs: T[] | undefined): T[] => (xs ?? []).filter((x) => x.run === run)
  const removed =
    mine(session.marks).length +
    mine(session.tapes).length +
    mine(session.shapes).length +
    mine(session.links).length +
    mine(session.bookmarks).length
  const drop = <T extends Provenance>(xs: T[] | undefined): T[] | undefined =>
    xs ? xs.filter((x) => x.run !== run) : xs
  const structural = (session.journal ?? []).filter((e) => e.run === run && e.structural)

  let next: Session = {
    ...session,
    ...(session.marks ? { marks: drop(session.marks)! } : {}),
    ...(session.links ? { links: drop(session.links)! } : {}),
    ...(session.tapes ? { tapes: drop(session.tapes)! } : {}),
    ...(session.shapes ? { shapes: drop(session.shapes)! } : {}),
    ...(session.bookmarks ? { bookmarks: drop(session.bookmarks)! } : {})
  }
  // The revert is itself part of the record — including what it could not undo.
  const seq = next.seq + 1
  next = {
    ...next,
    seq,
    journal: [
      ...(next.journal ?? []),
      {
        id: `je_${seq}`,
        at: new Date().toISOString(),
        by: 'human',
        action: 'revert_run',
        what:
          `Reverted ${run}: removed ${removed} agent annotation(s)` +
          (structural.length
            ? `; ${structural.length} structural change(s) could not be undone`
            : '')
      }
    ]
  }
  return { session: next, removed, structural }
}

/** What an agent has touched in this binder — the reviewer's summary. */
export function agentWork(session: Session): {
  runs: string[]
  marks: number
  tapes: number
  shapes: number
  links: number
  bookmarks: number
} {
  const byAgent = <T extends Provenance>(xs: T[] | undefined): number =>
    (xs ?? []).filter((x) => x.by === 'agent').length
  return {
    runs: [...new Set((session.journal ?? []).map((e) => e.run).filter(Boolean) as string[])],
    marks: byAgent(session.marks),
    tapes: byAgent(session.tapes),
    shapes: byAgent(session.shapes),
    links: byAgent(session.links),
    bookmarks: byAgent(session.bookmarks)
  }
}

/**
 * Attribution to stamp on something being created right now.
 *
 * Empty when no run is active, so a person's work carries no extra fields and
 * a session written by hand is byte-identical to one from before attribution.
 */
export function stamp(session: Session): Provenance {
  return session.activeRun ? { by: 'agent', run: session.activeRun } : {}
}

export function addMark(
  session: Session,
  mark: Omit<Mark, 'id' | 'created' | 'author'> & { author?: string }
): { session: Session; id: string } {
  const seq = session.seq + 1
  const id = `mk_${seq}`
  const next: Mark = {
    ...mark,
    ...stamp(session),
    id,
    author: mark.author ?? session.reviewer ?? '',
    created: new Date().toISOString()
  }
  return { session: { ...session, seq, marks: [...(session.marks ?? []), next] }, id }
}

/**
 * Record a cross-page reference. Both ends are page ids, so the link is
 * correct after any reorder — see the note on `Link`.
 */
export function addLink(
  session: Session,
  link: Omit<Link, 'id' | 'created'>
): { session: Session; id: string } {
  const seq = session.seq + 1
  const id = `ln_${seq}`
  const next: Link = { ...link, ...stamp(session), id, created: new Date().toISOString() }
  return { session: { ...session, seq, links: [...(session.links ?? []), next] }, id }
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

// -------------------------------------------------------------- page status

export function statusDefs(session: Session): StatusDef[] {
  return session.statusDefs ?? DEFAULT_STATUS_DEFS
}

export function statusParts(session: Session): StatusParts {
  return { ...DEFAULT_STATUS_PARTS, ...(session.statusParts ?? {}) }
}

export function pageStatus(session: Session, pageId: string): PageStatus | null {
  return session.statuses?.[pageId] ?? null
}

export function statusOf(session: Session, pageId: string): StatusDef | null {
  const st = pageStatus(session, pageId)
  if (!st) return null
  return statusDefs(session).find((d) => d.id === st.status) ?? null
}

/** Apply a status to pages. Applying a second one REPLACES the first — a page
 *  is in one state, not several. */
export function setPageStatus(
  session: Session,
  pageIds: string[],
  statusId: string,
  by = ''
): Session {
  const at = new Date().toISOString()
  const statuses = { ...(session.statuses ?? {}) }
  for (const id of pageIds) statuses[id] = { status: statusId, ...(by ? { by } : {}), at }
  return { ...session, statuses }
}

export function clearPageStatus(session: Session, pageIds: string[]): Session {
  const statuses = { ...(session.statuses ?? {}) }
  for (const id of pageIds) delete statuses[id]
  return { ...session, statuses }
}

/** How many pages sit in each status, plus how many have none. */
export function statusCounts(session: Session): { byId: Record<string, number>; unset: number } {
  const byId: Record<string, number> = {}
  for (const d of statusDefs(session)) byId[d.id] = 0
  let unset = 0
  for (const p of session.pages) {
    const st = session.statuses?.[p.id]
    if (st && byId[st.status] !== undefined) byId[st.status]++
    else unset++
  }
  return { byId, unset }
}

/** The stamp's centre for a corner, in normalized display coordinates. */
export function statusStampAnchor(corner: StatusParts['corner']): { nx: number; ny: number } {
  const near = 0.14
  const far = 0.07
  return {
    nx: corner === 'tl' || corner === 'bl' ? near : 1 - near,
    ny: corner === 'tl' || corner === 'tr' ? far : 1 - far
  }
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
    // Same stamp as addMark/addLink. This was missing while shapes could only
    // come from the toolbar — invisible then, because a human drew every one.
    // The moment an agent can draw, its shapes would have been recorded as a
    // person's work and revertRun, which filters on `run`, would have left
    // them behind on a binder someone signs.
    ...stamp(session),
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
 * A tape's metrics at a given point size — the mirror of engine
 * appearance.tape_metrics. Both sides derive every dimension from the font, so
 * a resized tape cannot be one shape in the preview and another in the PDF.
 */
export function tapeMetrics(size?: number): { charW: number; lineH: number; pad: number } {
  const font = Math.max(TAPE_SIZE_MIN, Math.min(TAPE_SIZE_MAX, size ?? TAPE_FONT_SIZE))
  const k = font / TAPE_FONT_SIZE
  return { charW: font * 0.6, lineH: TAPE_LINE_HEIGHT * k, pad: TAPE_PAD * k }
}

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
/**
 * A money figure as it appears on a workpaper, in whole CENTS.
 *
 * Comparison is the whole job of a tie-out, so this is deliberately stricter
 * and broader than parseAmount — broader because a real workpaper writes
 * negatives as "(350.67)", which is the accounting convention and which
 * parseAmount reads as nothing at all; stricter because anything it cannot
 * read with certainty returns null rather than a guess. A figure guessed wrong
 * in a tie-out is worse than a figure not read: it agrees confidently.
 *
 * Cents, not floats: 0.1 + 0.2 is a rounding error a reviewer cannot see and
 * cannot forgive on a balance sheet.
 */
export interface MoneyRead {
  cents: number
  /** How it was read, when a reader might not agree — surfaced to the reviewer. */
  as?: string
}

export function parseMoney(raw: string): MoneyRead | null {
  let text = String(raw)
    .replace(/[\u00a0\u2007\u202f\s]/g, '')
    .replace(/[\u2212\u2013\u2014]/g, '-')
  if (!text) return null

  let negative = false
  let note: string | undefined
  // Accounting negatives: (350.67). Also seen as a trailing minus in ledger
  // exports, and as CR in some trial balances — the last is NOT assumed,
  // because whether a credit is negative depends on the schedule.
  if (/^\((.*)\)$/.test(text)) {
    negative = true
    note = 'read as a negative — parentheses'
    text = text.replace(/^\(|\)$/g, '')
  } else if (/-$/.test(text)) {
    negative = true
    note = 'read as a negative — trailing minus'
    text = text.slice(0, -1)
  }

  text = text.replace(/^[$£€]/, '').replace(/[$£€]$/, '')
  if (text.startsWith('-')) {
    negative = true
    text = text.slice(1)
  }
  // Thousands separators only in the grouping positions; a bare "1,2" is not a
  // number anyone wrote on purpose.
  if (text.includes(',')) {
    if (!/^\d{1,3}(,\d{3})*(\.\d+)?$/.test(text)) return null
    text = text.replace(/,/g, '')
  }
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(text)) return null

  const [whole, frac = ''] = text.split('.')
  if (frac.length > 2) {
    // More precision than money has. Rounding it silently would hide a real
    // difference, so say what was done.
    note = `${note ? `${note}; ` : ''}rounded from ${text} to 2 decimals`
  }
  // Integer arithmetic the whole way. Number('1.005') * 100 is 100.4999…, so
  // rounding the product gives 1.00 where a workpaper says 1.01 — a systematic
  // error at exactly the boundary where money rounds.
  const digits = frac.padEnd(3, '0')
  let cents = Number(whole || '0') * 100 + Number(digits.slice(0, 2))
  if (Number(digits[2]) >= 5) cents += 1
  if (!Number.isFinite(cents)) return null
  return { cents: negative ? -cents : cents, ...(note ? { as: note } : {}) }
}

/** Cents back to the way a workpaper writes it. */
export function formatCents(cents: number): string {
  return `${cents < 0 ? '(' : ''}${formatAmount(Math.abs(cents) / 100)}${cents < 0 ? ')' : ''}`
}

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
    ...stamp(session),
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

/**
 * One keystroke of the 10-key, as a pure transition. The UI and the on-screen
 * keypad both route through this shape, and it is what lets "5 × 5 =" be
 * verified without a DOM.
 *
 *   + and -  are POSTFIX (adding-machine): commit this figure with that sign.
 *   × and ÷  are INFIX (calculator): set the operator for the NEXT figure,
 *            committing anything already keyed as an addend first.
 *   = / Enter closes the calculation with the pending operator.
 */
export interface TapeKeyState {
  entries: TapeEntry[]
  buffer: string
  op: TapeOp
}

export function tapeKeyPress(state: TapeKeyState, key: string): TapeKeyState {
  const { entries, buffer, op } = state
  const commit = (withOp: TapeOp, nextOp: TapeOp): TapeKeyState => {
    const value = parseAmount(buffer)
    if (value === null) return { entries, buffer: '', op: nextOp }
    if (withOp === '÷' && value === 0) return state // refuse; never poison a total
    const flip = value < 0 && (withOp === '+' || withOp === '-')
    return {
      entries: [
        ...entries,
        {
          value: flip ? Math.abs(value) : value,
          op: flip ? (withOp === '+' ? '-' : '+') : withOp
        }
      ],
      buffer: '',
      op: nextOp
    }
  }

  if (/^[0-9]$/.test(key)) return { ...state, buffer: buffer === '0' ? key : buffer + key }
  if (key === '00' || key === '000') return { ...state, buffer: buffer ? buffer + key : buffer }
  if (key === '.' || key === ',') {
    return { ...state, buffer: buffer.includes('.') ? buffer : (buffer || '0') + '.' }
  }
  if (key === '±') {
    return { ...state, buffer: buffer.startsWith('-') ? buffer.slice(1) : `-${buffer}` }
  }
  if (key === '+') return commit('+', op)
  if (key === '-') return commit('-', op)
  if (key === '*' || key === '×') return buffer ? commit('+', '×') : { ...state, op: '×' }
  if (key === '/' || key === '÷') return buffer ? commit('+', '÷') : { ...state, op: '÷' }
  if (key === 'Enter' || key === '=') return commit(op, '+')
  if (key === 'C') return { entries, buffer: '', op: '+' }
  if (key === 'CE') return { ...state, buffer: '' }
  if (key === 'Backspace' || key === 'Delete') {
    if (buffer) return { ...state, buffer: buffer.slice(0, -1) }
    return { ...state, entries: entries.slice(0, -1) }
  }
  return state
}

export function removeTapes(session: Session, ids: string[]): Session {
  const set = new Set(ids)
  return { ...session, tapes: (session.tapes ?? []).filter((t) => !set.has(t.id)) }
}

export function tapesOnPage(session: Session, pageId: string | null): Tape[] {
  if (!pageId) return []
  return (session.tapes ?? []).filter((t) => t.page === pageId)
}

// ------------------------------------------------------------ tickmark legend

/**
 * A tickmark is only evidence if a reader knows what it MEANS.
 *
 * A binder full of unexplained letters is the classic peer-review finding: the
 * preparer knew that "GL" meant agreed to the general ledger, and nobody who
 * picks the file up in three years does. Every firm defines its own legend —
 * which is exactly why this is data on the session rather than a fixed table in
 * the code, and why the presets below are a starting point a firm edits, not a
 * standard we are asserting.
 *
 * Keyed by the mark's TOKEN (see `markToken`), so one entry covers every place
 * that mark is used.
 */
export type Legend = Record<string, string>

/**
 * The legend key for a mark. Lettered stamps key on their letters, so `GL` used
 * on forty pages is one legend row; the fixed kinds key on the kind name.
 *
 * Connectors are deliberately absent: `①` does not have a meaning to define,
 * it points at its twin. Giving them legend rows would fill the legend with one
 * row per number and bury the marks that do carry meaning.
 */
export function markToken(mark: Pick<Mark, 'kind' | 'text'>): string | null {
  if (mark.kind === 'conn') return null
  if (mark.kind === 'text') return normalizeStamp(mark.text ?? '') || null
  return mark.kind
}

/** How a token reads in the legend's left column. */
export function tokenGlyph(token: string): string {
  return token === 'tick' || token === 'cross' || token === 'note'
    ? MARK_GLYPH[token as MarkKind]
    : token
}

/**
 * The standard starting set. Names come from the vocabulary already in use on
 * paper — most of these ARE letters in practice, which is why they need no new
 * glyphs and can ship on the lettered-stamp path that is already verified.
 */
export const TICKMARK_PRESETS: ReadonlyArray<{ token: string; meaning: string }> = [
  { token: 'tick', meaning: 'Agrees to supporting documentation' },
  { token: 'cross', meaning: 'Does not agree — see note' },
  { token: 'GL', meaning: 'Agrees to general ledger' },
  { token: 'PY', meaning: 'Agrees to prior year' },
  { token: 'TB', meaning: 'Agrees to trial balance' },
  { token: 'F', meaning: 'Footed' },
  { token: 'CF', meaning: 'Cross-footed' },
  { token: 'RC', meaning: 'Recalculated' },
  { token: 'C', meaning: 'Confirmed' },
  { token: 'CE', meaning: 'Confirmed with exception' },
  { token: 'NR', meaning: 'No reply' },
  { token: 'IM', meaning: 'Immaterial — no adjustment proposed' },
  { token: 'UD', meaning: 'Unreconciled difference' }
]

/** Define or change what a tickmark means. A blank meaning removes the row. */
export function setLegend(session: Session, token: string, meaning: string): Session {
  const key = token.trim()
  if (!key) return session
  const text = sanitizeTitle(meaning).replace(/\s+/g, ' ').slice(0, 120).trim()
  const legend = { ...(session.legend ?? {}) }
  if (!text) delete legend[key]
  else legend[key] = text
  return { ...session, legend }
}

/**
 * The legend for THIS binder: every mark actually placed, in the order a reader
 * meets them, with its meaning if one is defined.
 *
 * Only marks in use. A legend listing a firm's whole palette tells a reader
 * that fourteen tickmarks were available, not what the six in this file mean —
 * and an unused row invites the question of where that mark is.
 */
export function legendEntries(
  session: Session
): Array<{ token: string; glyph: string; meaning: string; count: number }> {
  const order = session.pages.map((p) => p.id)
  const seen = new Map<string, number>()
  const rank = new Map<string, number>()
  for (const m of [...(session.marks ?? [])].sort(
    (a, b) => order.indexOf(a.page) - order.indexOf(b.page)
  )) {
    const token = markToken(m)
    if (!token) continue
    seen.set(token, (seen.get(token) ?? 0) + 1)
    if (!rank.has(token)) rank.set(token, rank.size)
  }
  return [...seen.entries()]
    .sort((a, b) => (rank.get(a[0]) ?? 0) - (rank.get(b[0]) ?? 0))
    .map(([token, count]) => ({
      token,
      glyph: tokenGlyph(token),
      meaning: session.legend?.[token] ?? '',
      count
    }))
}

/**
 * The legend as the markdown the document typesetter already takes, so a legend
 * page is a normal typeset page — reorderable, bookmarkable, visible in the app
 * — rather than something conjured during export. The export path is the
 * highest-risk code in the project and this feature has no business touching it.
 */
export function legendMarkdown(session: Session): string {
  const rows = legendEntries(session)
  const body = rows.length
    ? rows
        .map(
          (r) =>
            `| ${r.glyph.replace(/\|/g, '')} | ${(r.meaning || '_(not defined)_').replace(/\|/g, '')} | ${r.count} |`
        )
        .join('\n')
    : '| — | _No review marks placed yet._ | 0 |'
  return (
    `# Tickmark Legend\n\n` +
    `| Mark | Meaning | Times used |\n| --- | --- | --- |\n${body}\n\n` +
    `Prepared with LedgerPDF. Marks carry the reviewer's initials and the time ` +
    `they were placed; open the binder in LedgerPDF to see who placed each one.\n`
  )
}

// ---------------------------------------------------------------- connectors

/**
 * The clickable footprint of a mark, in normalized visual coordinates.
 *
 * Approximate on purpose: a mark's size is in POINTS and this rect is a
 * fraction of the page, so an exact footprint would need the page dimensions
 * that neither caller has to hand. Slightly generous is the right error — the
 * thing a reader clicks is the mark they are already looking at.
 */
export function markLinkRect(nx: number, ny: number): [number, number, number, number] {
  return [
    Math.max(0, nx - 0.02),
    Math.max(0, ny - 0.015),
    Math.min(1, nx + 0.02),
    Math.min(1, ny + 0.015)
  ]
}

/**
 * Connectors tie one figure to another — the number circled on the lead sheet
 * and the same number circled on the detail that supports it.
 *
 * The label sequence is 1..n then A..Z. Numbers first because that is what a
 * preparer reaches for; letters are there for a second, parallel run of
 * references on the same page without colliding with the numbers.
 */
export function connectorLabels(): string[] {
  return [
    ...Array.from({ length: 99 }, (_, i) => String(i + 1)),
    ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i))
  ]
}

/**
 * Place one end of a connector, and close the reference if this is the second
 * end of a pair.
 *
 * The pairing rule is deliberately simple and stated rather than inferred: a
 * label ties exactly TWO places together. Placing it a third time leaves an
 * unpaired mark and says so, instead of silently re-pointing an existing
 * reference at somewhere new — a workpaper reference that quietly changes what
 * it points at is worse than one that is obviously incomplete.
 *
 * Pairing writes `refTarget` on both ends (the printed "see p.N", resolved at
 * export so a reorder cannot make it lie) and a `Link` each way (the clickable
 * half). Both halves matter: paper and screen have to agree.
 */
export function placeConnector(
  session: Session,
  at: { page: string; nx: number; ny: number; size: number; label: string },
  author?: string
): { session: Session; id: string; paired: boolean; sameSide: boolean } {
  const label = at.label.trim()
  const existing = connectorsUsed(session).get(label) ?? []
  const { session: withMark, id } = addMark(session, {
    page: at.page,
    kind: 'conn',
    nx: at.nx,
    ny: at.ny,
    size: at.size,
    text: label,
    ...(author ? { author } : {})
  })
  // Only the FIRST placement is a partner. Two already means the pair is
  // closed; zero means this end is waiting for its twin.
  if (existing.length !== 1) {
    return { session: withMark, id, paired: false, sameSide: existing.length > 1 }
  }
  const twin = existing[0]
  // A pair on one page needs no page reference — "see p.4" printed on page 4
  // is noise — but it is still a legitimate way to tie two figures in one
  // schedule, so it is placed, just not linked.
  if (twin.page === at.page) return { session: withMark, id, paired: true, sameSide: true }

  let out: Session = {
    ...withMark,
    marks: (withMark.marks ?? []).map((m) =>
      m.id === id ? { ...m, refTarget: twin.page } : m.id === twin.id ? { ...m, refTarget: at.page } : m
    )
  }
  out = addLink(out, {
    page: at.page,
    target: twin.page,
    rect: markLinkRect(at.nx, at.ny),
    label: `Connector ${label}`
  }).session
  out = addLink(out, {
    page: twin.page,
    target: at.page,
    rect: markLinkRect(twin.nx, twin.ny),
    label: `Connector ${label}`
  }).session
  return { session: out, id, paired: true, sameSide: false }
}

/**
 * Point size for a connector's label so it stays inside its ring.
 *
 * Duplicated by `conn_font_size` in engine/appearance.py, and `verify:model`
 * compares the two directly — the same watch the image-layout duplication is
 * under. If they drift, a connector that reads "12" on screen exports with its
 * digits crossing the ring, and nothing else would catch it.
 */
/**
 * Ring stroke as a fraction of the connector's size. Mirrors
 * appearance.CONN_STROKE_RATIO — the ring is annotation content, so screen and
 * export must agree, the same rule the tape's card is under.
 */
export const CONN_STROKE_RATIO = 0.075

export function connectorFontSize(size: number, label: string): number {
  const n = Math.max(1, label.trim().length)
  return size * (n <= 1 ? 0.55 : n === 2 ? 0.42 : 0.3)
}

/** Every connector label already placed in this binder. */
export function connectorsUsed(session: Session): Map<string, Mark[]> {
  const used = new Map<string, Mark[]>()
  for (const m of session.marks ?? []) {
    if (m.kind !== 'conn') continue
    const label = (m.text ?? '').trim()
    if (!label) continue
    used.set(label, [...(used.get(label) ?? []), m])
  }
  return used
}

/**
 * The next label to hand out, in the chosen series.
 *
 * A label placed ONCE is still waiting for its other end, so it is not skipped
 * — the sequence advances past a label only when its pair is complete. That is
 * what makes "place ①, go to the detail page, place ① again" work without the
 * preparer having to remember which number they were on.
 */
export function nextConnectorLabel(session: Session, series: 'number' | 'letter'): string {
  const used = connectorsUsed(session)
  const pool = connectorLabels().filter((l) =>
    series === 'number' ? /^\d+$/.test(l) : /^[A-Z]$/.test(l)
  )
  const open = pool.find((l) => (used.get(l)?.length ?? 0) === 1)
  if (open) return open
  return pool.find((l) => !used.has(l)) ?? pool[pool.length - 1]
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

/**
 * Point a bookmark at a different page.
 *
 * A bookmark added on the wrong page previously had to be deleted and retyped,
 * and an imported one whose destination was wrong could not be fixed at all.
 * Imported bookmarks are re-targeted through an override rather than by
 * rewriting the source outline, so the original destination is never lost and
 * the change survives save/reopen exactly like a rename.
 */
export function assignBookmarkPage(session: Session, key: string, pageId: string): Session {
  if (!session.pages.some((p) => p.id === pageId)) return session

  if (key.startsWith(USER_BOOKMARK_PREFIX)) {
    const id = key.slice(USER_BOOKMARK_PREFIX.length)
    return {
      ...session,
      bookmarks: (session.bookmarks ?? []).map((b) => (b.id === id ? { ...b, page: pageId } : b))
    }
  }
  return { ...session, bookmarkPages: { ...(session.bookmarkPages ?? {}), [key]: pageId } }
}

/** Drop a re-target, sending an imported bookmark back to where it came from. */
export function clearBookmarkPage(session: Session, key: string): Session {
  if (!session.bookmarkPages?.[key]) return session
  const next = { ...session.bookmarkPages }
  delete next[key]
  return { ...session, bookmarkPages: next }
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
      bookmarks: [
        ...(session.bookmarks ?? []),
        { id, page: pageId, title, depth, ...stamp(session) }
      ]
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
  // Keep in step with main/index.ts SOURCE_EXTS. A workbook that kept its
  // ".xlsx" read as the odd one out in a bookmark list where every PDF and
  // image had already lost its extension.
  return name.replace(/\.(pdf|xlsx|xlsm|csv|md|markdown|docx|png|jpe?g|jpe|gif|bmp|tiff?|webp)$/i, '')
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
/**
 * The pages a bookmark owns: from its own page up to the page before the next
 * bookmark at the same or shallower depth.
 *
 * This is the span the "(N pages)" label already describes, so what a preparer
 * reads is exactly what moves. Children are inside it by construction, which is
 * why moving a section carries its nested bookmarks with it — their pages went
 * along.
 */
/**
 * Has the binder moved since its cover was written?
 *
 * The live inventory is always right because it reads page ids. A PRINTED
 * summary cannot be — it is ink — so the honest thing is to notice and say so
 * rather than let a reviewer follow "p.6" to the wrong page.
 */
export function coverIsStale(session: Session): boolean {
  if (!session.cover) return false
  return session.cover.pages !== session.pages.map((p) => p.id).join(',')
}

export function bookmarkSection(session: Session, key: string): string[] {
  const flat = flattenTree(buildBookmarks(session, { pageCounts: false }))
  const indexOf = new Map(session.pages.map((p, i) => [p.id, i]))
  const at = flat.findIndex((e) => e.key === key)
  if (at < 0) return []
  const start = indexOf.get(flat[at].page)
  if (start === undefined) return []

  let end = session.pages.length
  for (let i = at + 1; i < flat.length; i++) {
    if (flat[i].depth > flat[at].depth) continue
    const next = indexOf.get(flat[i].page)
    // A re-assigned bookmark can point backwards; only a page AFTER this one
    // can bound the section.
    if (next !== undefined && next > start) {
      end = next
      break
    }
  }
  return session.pages.slice(start, end).map((p) => p.id)
}

/**
 * Drag a bookmark, move its pages.
 *
 * Acrobat's bookmark drag reorders the outline and leaves the pages where they
 * were. In a workpaper a bookmark IS a tab divider, so moving one has to take
 * its section with it — otherwise the outline and the binder disagree, which is
 * worse than not being able to drag at all.
 *
 * `beforeKey` is the bookmark to land in front of; null puts the section last.
 */
export function moveBookmarkSection(
  session: Session,
  key: string,
  beforeKey: string | null
): Session {
  const ids = bookmarkSection(session, key)
  if (!ids.length) return session
  if (beforeKey === key) return session

  const indexOf = new Map(session.pages.map((p, i) => [p.id, i]))
  let target = session.pages.length
  if (beforeKey) {
    const flat = flattenTree(buildBookmarks(session, { pageCounts: false }))
    const dest = flat.find((e) => e.key === beforeKey)
    const at = dest ? indexOf.get(dest.page) : undefined
    if (at === undefined) return session
    // Dropping inside your own section is a no-op, not a scramble.
    if (ids.includes(session.pages[at].id)) return session
    target = at
  }
  return movePages(session, ids, target)
}

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
      // A re-target wins over the imported destination, provided its page is
      // still in the binder.
      const override = session.bookmarkPages?.[key]
      const target =
        override && session.pages.some((p) => p.id === override)
          ? override
          : n.destPage === null
            ? null
            : pageIdFor(sourceId, n.destPage)
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
      const override = session.bookmarkPages?.[key]
      const target =
        override && session.pages.some((p) => p.id === override) ? override : page
      return { key, title: titled(key, stripSourceExt(source.name)), page: target, children }
    })
  }

  const indexOf = new Map(session.pages.map((p, i) => [p.id, i]))
  tree = mergeUserBookmarks(tree, session, indexOf)

  // A status colours the bookmark of the page it is on, so the outline reads
  // as a coverage map in any viewer's bookmark panel — not just in this app.
  if (statusParts(session).bookmark && session.statuses) {
    const paint = (ns: BookmarkNode[]): BookmarkNode[] =>
      ns.map((n) => {
        const def = statusOf(session, n.page)
        return {
          ...n,
          ...(def ? { color: def.color, bold: true } : {}),
          children: paint(n.children)
        }
      })
    tree = paint(tree)
  }

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
  /**
   * Store the editable session inside the binder (issue #3), making the PDF the
   * document rather than a companion to a `.wptsession.json`.
   *
   * Deliberately NOT set for the copy that leaves the firm. That copy is
   * flattened, and the engine refuses to embed a session into a flattened
   * binder — flattened marks are painted into the page and cannot be lifted
   * back out, so an embedded session would promise an edit that cannot happen.
   */
  embedSession?: boolean
}

/**
 * A mark's note with its page reference resolved against the CURRENT order.
 *
 * `refTarget` holds a page id; the number a reader sees is computed at export.
 * Storing the number instead is the bug this exists to prevent — it is right
 * the moment it is written and wrong after the next reorder, while still
 * reading as authoritative on a document someone signs.
 */
export function refNote(session: Session, m: Mark): string | undefined {
  if (!m.refTarget) return m.note
  const idx = session.pages.findIndex((p) => p.id === m.refTarget)
  if (idx < 0) return m.note
  return `${m.note ? `${m.note} — ` : ''}see p.${idx + 1}`
}

export function toExportSpec(
  session: Session,
  output: string,
  opts: ExportOptions = {}
): ExportSpec {
  const { flatten = false, embedSession = false, ...bookmarkOpts } = opts
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
    // Both ends must still be in the binder: the engine resolves target_page
    // through final_index, so a link to a deleted page would throw rather than
    // degrade. Dropping it here is the difference between a missing
    // cross-reference and a failed export.
    ...(session.links?.length
      ? {
          links: session.links
            .filter(
              (l) =>
                session.pages.some((p) => p.id === l.page) &&
                session.pages.some((p) => p.id === l.target)
            )
            .map((l) => ({ page: l.page, target_page: l.target, rect_n: l.rect }))
        }
      : {}),
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
        // The printed reference is rendered HERE, from the target's position in
        // the binder being exported — so it is correct for this artifact rather
        // than for whatever the order was when the tie was made. A target that
        // no longer exists degrades to the note alone, never to a wrong number.
        ...(refNote(session, m) ? { note: refNote(session, m) } : {}),
        ...(m.created ? { created: m.created } : {}),
        // Attribution travels into the PDF: /WPT_Data keeps the raw values and
        // the visible author is qualified, so a reviewer opening the exported
        // binder in any viewer can tell agent work from a person's.
        ...(m.by ? { by: m.by } : {}),
        ...(m.run ? { run: m.run } : {})
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
          ...(x.created ? { created: x.created } : {}),
          ...(x.by ? { by: x.by } : {}),
          ...(x.run ? { run: x.run } : {})
        })),
      // Page numbers, from each page's FINAL position in the binder.
      ...(() => {
        const num = numbering(session)
        if (!num.enabled) return []
        const anchor = numberAnchor(num.corner)
        return session.pages.map((p, i) => ({
          kind: 'pagenumber',
          page: p.id,
          nx: anchor.nx,
          ny: anchor.ny,
          text: formatPageNumber(i, session.pages.length, num),
          size: num.size,
          corner: num.corner
        }))
      })(),
      // Page statuses become a stamp and a border. They are generated at
      // export from the status, not stored as shapes, so changing the legend
      // or the parts re-draws every page rather than leaving stale artwork.
      ...(() => {
        const parts = statusParts(session)
        const anchor = statusStampAnchor(parts.corner)
        return session.pages.flatMap((p) => {
          const st = session.statuses?.[p.id]
          const def = st ? statusDefs(session).find((d) => d.id === st.status) : null
          if (!st || !def) return []
          const out: Array<Record<string, unknown>> = []
          if (parts.stamp) {
            out.push({
              kind: 'statusstamp',
              page: p.id,
              nx: anchor.nx,
              ny: anchor.ny,
              color: def.color,
              text: st.by || session.reviewer || def.label,
              label: def.label,
              ...(st.at ? { at: st.at } : {}),
              ...(st.by ? { author: st.by } : {})
            })
          }
          if (parts.border) {
            out.push({
              kind: 'pageborder',
              page: p.id,
              color: def.color,
              width: parts.borderWidth,
              note: def.label
            })
          }
          return out
        })
      })(),
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
          // Alongside the other annotation kinds, which all carry `size`.
          ...(t.size ? { size: t.size } : {}),
          ...(t.author ? { author: t.author } : {}),
          ...(t.by ? { by: t.by } : {}),
          ...(t.run ? { run: t.run } : {})
        }))
    ],
    ...(flatten ? { flatten: true } : {}),
    ...(embedSession && !flatten ? { session } : {}),
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
      sources: s.sources.map((x) => ({
        ...x,
        kind:
          x.kind === 'image'
            ? 'image'
            : x.kind === 'sheet'
              ? 'sheet'
              : x.kind === 'document'
                ? 'document'
                : 'pdf'
      })),
      pages: s.pages.map((p) => ({ ...p, rotate: p.rotate ?? 0 })),
      seq,
      ...(s.titles && typeof s.titles === 'object' ? { titles: s.titles } : {}),
      ...(s.bookmarkPages && typeof s.bookmarkPages === 'object'
        ? {
            bookmarkPages: Object.fromEntries(
              Object.entries(s.bookmarkPages).filter(([, pid]) => pageIds.has(pid as string))
            )
          }
        : {}),
      ...(Array.isArray(s.bookmarks)
        ? { bookmarks: s.bookmarks.filter((b) => pageIds.has(b.page)) }
        : {}),
      ...(Array.isArray(s.marks)
        ? { marks: s.marks.filter((m) => pageIds.has(m.page)) }
        : {}),
      ...(Array.isArray(s.statusDefs) ? { statusDefs: s.statusDefs } : {}),
      ...(s.statuses && typeof s.statuses === 'object'
        ? {
            statuses: Object.fromEntries(
              Object.entries(s.statuses).filter(([pid]) => pageIds.has(pid))
            )
          }
        : {}),
      ...(s.numbering && typeof s.numbering === 'object'
        ? { numbering: { ...DEFAULT_NUMBERING, ...s.numbering } }
        : {}),
      ...(s.statusParts && typeof s.statusParts === 'object'
        ? { statusParts: { ...DEFAULT_STATUS_PARTS, ...s.statusParts } }
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
      ...(s.cover && typeof s.cover === 'object' && typeof s.cover.path === 'string'
        ? { cover: s.cover }
        : {}),
      // The audit trail survives reopen intact. `activeRun` deliberately does
      // NOT: a run belongs to the agent process that opened it, and reviving
      // one would silently stamp a person's later edits as the AI's work.
      ...(Array.isArray(s.journal)
        ? {
            journal: s.journal
              .filter(
                (e): e is JournalEntry =>
                  !!e && typeof e.id === 'string' && typeof e.what === 'string'
              )
              .map((e) => {
                const { artifact, ...entry } = e
                const validArtifact =
                  artifact?.kind === 'binder_export' &&
                  typeof artifact.path === 'string' &&
                  artifact.path.length > 0 &&
                  typeof artifact.sha256 === 'string' &&
                  /^[a-f0-9]{64}$/i.test(artifact.sha256)
                return validArtifact ? { ...entry, artifact } : entry
              })
          }
        : {}),
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
        : {}),
      // A legend is a plain string->string map. Anything else in the file is
      // dropped rather than trusted: it is read back into the UI and typeset
      // into a page, so a non-string value here would surface as "[object
      // Object]" on a printed workpaper.
      ...(s.legend && typeof s.legend === 'object' && !Array.isArray(s.legend)
        ? {
            legend: Object.fromEntries(
              Object.entries(s.legend as Record<string, unknown>)
                .filter(([k, v]) => typeof k === 'string' && typeof v === 'string' && !!k.trim())
                .map(([k, v]) => [k.trim(), (v as string).slice(0, 120)])
            )
          }
        : {})
    }
  }
}

// ------------------------------------------------------------------- helpers

export function sourceOf(session: Session, page: BinderPage): SourceDoc | undefined {
  return session.sources.find((s) => s.id === page.source)
}

/**
 * The binder page holding a given page of a given source, or undefined.
 *
 * This is how a link destination becomes somewhere to go. A /Link in a source
 * PDF points at a page of THAT document, which is not a binder page: the binder
 * reorders, drops and interleaves, so source page 3 may be binder page 11, may
 * appear twice, or may not be here at all. Resolving through the session is what
 * makes a tab reference land on the right sheet.
 *
 * Jumping to the raw index instead would land on whatever now occupies that
 * position — which is worse than refusing to move, because it looks like it
 * worked. The first match wins when a source page was imported twice; there is
 * no better answer, and the alternative (refusing) would break the common case
 * to be pedantic about a rare one.
 */
export function pageForSourceIndex(
  session: Session,
  sourceId: string,
  index: number
): BinderPage | undefined {
  return session.pages.find((p) => p.source === sourceId && p.index === index)
}

/** "TaxForm-A.pdf p.3" — provenance, shown on hover per DESIGN.md. */
export function pageProvenance(session: Session, page: BinderPage): string {
  const src = sourceOf(session, page)
  return `${src?.name ?? page.source} p.${page.index + 1}`
}
