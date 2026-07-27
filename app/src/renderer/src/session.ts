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

export interface SourceDoc {
  id: string
  path: string
  name: string
  nPages: number
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

export interface Session {
  formatVersion: number
  sources: SourceDoc[]
  /** Final binder order. */
  pages: BinderPage[]
  /** Monotonic id counter — keeps ids unique and stable across save/reopen. */
  seq: number
}

export interface BookmarkNode {
  title: string
  page: string
  children: BookmarkNode[]
}

export interface ExportSpec {
  sources: Record<string, string>
  pages: Array<{ id: string; source: string; index: number; rotate: number }>
  bookmarks: BookmarkNode[]
  output: string
}

/** Shape returned by the engine's `probe` command (snake_case wire format). */
export interface ProbeWire {
  path: string
  n_pages: number
  pages: Array<{ index: number; rotate: number; mediabox: number[]; cropbox: number[] | null }>
  outline: Array<{ title: string; dest_page: number | null; children: unknown[] }>
}

// --------------------------------------------------------------- construction

export function newSession(): Session {
  return { formatVersion: SESSION_FORMAT_VERSION, sources: [], pages: [], seq: 0 }
}

function normalizeOutline(nodes: ProbeWire['outline']): OutlineNode[] {
  return (nodes ?? []).map((n) => ({
    title: String(n.title ?? 'Untitled'),
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
  return { ...session, pages, sources: session.sources.filter((s) => used.has(s.id)) }
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

const PAGE_COUNT_SUFFIX = /\s*\(\s*\d+\s*(?:page|pages|p)\s*\)\s*$/i

/** Drop a hand-typed "(2 pages)" so a generated count can't double up. */
function stripPageCount(title: string): string {
  return title.replace(PAGE_COUNT_SUFFIX, '').trim()
}

function stripPdfExt(name: string): string {
  return name.replace(/\.pdf$/i, '')
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

  const mapNodes = (sourceId: string, nodes: OutlineNode[]): BookmarkNode[] =>
    nodes.flatMap((n) => {
      const children = mapNodes(sourceId, n.children)
      const target = n.destPage === null ? null : pageIdFor(sourceId, n.destPage)
      if (!target) return children
      return [{ title: n.title, page: target, children }]
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
    tree = perSource.map(({ source, page, children }) => ({
      title: stripPdfExt(source.name),
      page,
      children
    }))
  }

  if (!pageCounts) return tree
  const indexOf = new Map(session.pages.map((p, i) => [p.id, i]))
  return applyPageCounts(tree, indexOf, session.pages.length)
}

// --------------------------------------------------------------------- export

export function toExportSpec(
  session: Session,
  output: string,
  bookmarkOpts: BookmarkOptions = {}
): ExportSpec {
  const used = new Set(session.pages.map((p) => p.source))
  const sources: Record<string, string> = {}
  for (const s of session.sources) {
    if (used.has(s.id)) sources[s.id] = s.path
  }
  return {
    sources,
    pages: session.pages.map((p) => ({
      id: p.id,
      source: p.source,
      index: p.index,
      rotate: p.rotate
    })),
    bookmarks: buildBookmarks(session, bookmarkOpts),
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
  const seq = typeof s.seq === 'number' ? s.seq : s.pages.length + s.sources.length
  return {
    session: {
      formatVersion: SESSION_FORMAT_VERSION,
      sources: s.sources,
      pages: s.pages.map((p) => ({ ...p, rotate: p.rotate ?? 0 })),
      seq
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
