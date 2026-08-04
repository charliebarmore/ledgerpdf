/**
 * Workpaper Binder MCP server — lets Claude (or any MCP client) build binders.
 *
 * WHAT THIS IS: a second front door onto the same session model and the same
 * Python engine the Electron app drives. The agent assembles a binder — import,
 * order, bookmark, mark, tape — saves the session, and you open that session in
 * the app to review it. There is no live link to a running app window; the
 * session file is the handoff.
 *
 * WHAT CROSSES THE BOUNDARY: file paths, file names, page counts, page order,
 * bookmark titles, mark/tape metadata — and, since binder_read_page and
 * binder_find, THE PAGE TEXT ITSELF.
 *
 * That last one is a deliberate escalation and worth stating plainly. Before
 * it, the worst case was that a model learned a client's name from a file name.
 * Now a model can be handed the figures off a return: wages, balances, and on a
 * 1040 the taxpayer's SSN. Pointing this at real client documents is an IRC
 * §7216 disclosure decision about *content*, not just metadata, and the tool
 * does not make it for you. It stays gated behind WPT_MCP_ROOTS, which is
 * empty by default, so text can only be read out of folders the user named on
 * purpose. Whether the model on the other end is local or hosted is the part
 * only the user knows.
 *
 * Runs on stdio, locally, and talks to nothing but the local engine.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { runEngine } from './engine'
import { atomicWriteJson, readSessionWithRecovery } from '../main/persistence'
import {
  addBookmark,
  addMark,
  agentWork,
  beginRun,
  addSource,
  addTape,
  baseName,
  buildBookmarks,
  deletePages,
  formatAmount,
  movePages,
  newSession,
  parseSession,
  record,
  removeMarks,
  removeTapes,
  revertRun,
  rotatePages,
  rotateVisual,
  setBookmarkTitle,
  tapeTotal,
  toTapeEntry,
  toExportSpec,
  toSaved,
  type BookmarkNode,
  type JournalEntry,
  type ProbeWire,
  type Session
} from '../renderer/src/session'

// ------------------------------------------------------------------- state

/** The working binder. One per server process, like one open document. */
let session: Session = newSession()
let sessionPath: string | null = null

/**
 * Where the binder actually lives.
 *
 * Standalone, this server IS the owner and both hooks are no-ops. Hosted
 * inside the running app, the owner is the renderer — it holds the undo stack,
 * the autosave timer and the window a person is looking at — so every tool call
 * refreshes from it first and publishes back after.
 *
 * Wrapping registration rather than threading a store through fifty call sites
 * keeps ONE definition of the tools. Two copies would drift, and a tool that
 * behaved differently depending on how it was reached is the kind of bug you
 * only find in front of a client.
 */
export interface SessionOwner {
  pull: () => Promise<{ session: Session; path: string | null }>
  push: (session: Session) => Promise<void>
}

let owner: SessionOwner | null = null

export function setSessionOwner(next: SessionOwner): void {
  owner = next
}

/**
 * Everything this server changes is agent work, so a run is opened on the
 * first mutation and every artifact created under it is stamped.
 *
 * Opened lazily rather than at connect: a server that only ever reads should
 * not leave a run in someone's engagement record.
 */
function mutating(action: string, what: string, structural = false): void {
  if (!session.activeRun) session = beginRun(session).session
  session = record(session, { action, what, structural })
}

const text = (s: string): { content: Array<{ type: 'text'; text: string }> } => ({
  content: [{ type: 'text', text: s }]
})
const fail = (
  s: string
): { content: Array<{ type: 'text'; text: string }>; isError: true } => ({
  content: [{ type: 'text', text: s }],
  isError: true
})

/** Keep in step with main/index.ts SOURCE_EXTS and engine images.IMAGE_SUFFIXES. */
const SOURCE_EXTS = [
  '.pdf',
  '.xlsx',
  '.xlsm',
  '.csv',
  '.md',
  '.markdown',
  '.docx',
  '.png',
  '.jpg',
  '.jpeg',
  '.jpe',
  '.gif',
  '.bmp',
  '.tif',
  '.tiff',
  '.webp'
]

/**
 * MCP is an agent boundary, not part of the local desktop app. It gets no file
 * access unless the user explicitly scopes one or more roots when registering
 * the server: WPT_MCP_ROOTS=/engagements/client-a (path-delimited).
 */
const MCP_ROOTS = (process.env.WPT_MCP_ROOTS ?? '')
  .split(path.delimiter)
  .map((root) => root.trim())
  .filter(Boolean)
  .map((root) => {
    const absolute = path.resolve(root)
    return existsSync(absolute) ? realpathSync(absolute) : absolute
  })

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function resolveAllowedPath(p: string, options: { mustExist: boolean; purpose: string }): string {
  if (MCP_ROOTS.length === 0) {
    throw new Error(
      `MCP file access is disabled; set WPT_MCP_ROOTS to an approved engagement folder before ${options.purpose}`
    )
  }
  const requested = path.resolve(p)
  let canonical: string
  if (options.mustExist) {
    if (!existsSync(requested)) throw new Error(`no such file: ${requested}`)
    canonical = realpathSync(requested)
  } else {
    const parent = path.dirname(requested)
    if (!existsSync(parent)) throw new Error(`destination folder does not exist: ${parent}`)
    canonical = path.join(realpathSync(parent), path.basename(requested))
  }
  if (!MCP_ROOTS.some((root) => inside(root, canonical))) {
    throw new Error(`${options.purpose} is outside WPT_MCP_ROOTS: ${canonical}`)
  }
  return canonical
}

function resolveSource(p: string): string {
  const abs = resolveAllowedPath(p, { mustExist: true, purpose: 'reading a source' })
  if (!SOURCE_EXTS.some((e) => abs.toLowerCase().endsWith(e))) {
    throw new Error(
      `not a supported source (PDF, spreadsheet, memo or image): ${abs}`
    )
  }
  return abs
}

/** Page ids are how every other tool refers to pages, so always show them. */
function pageTable(s: Session, limit = 300): string {
  const marks = new Map<string, number>()
  for (const m of s.marks ?? []) marks.set(m.page, (marks.get(m.page) ?? 0) + 1)
  const tapes = new Map<string, number>()
  for (const t of s.tapes ?? []) tapes.set(t.page, (tapes.get(t.page) ?? 0) + 1)

  const rows = s.pages.slice(0, limit).map((p, i) => {
    const src = s.sources.find((x) => x.id === p.source)
    return [
      String(i + 1),
      p.id,
      src?.name ?? p.source,
      `p.${p.index + 1}`,
      p.rotate ? `${p.rotate}°` : '',
      marks.get(p.id) ? `${marks.get(p.id)} mark(s)` : '',
      tapes.get(p.id) ? `${tapes.get(p.id)} tape(s)` : ''
    ]
      .filter(Boolean)
      .join('  ')
  })
  const more = s.pages.length > limit ? `\n… ${s.pages.length - limit} more pages` : ''
  return rows.join('\n') + more
}

function flatBookmarks(nodes: BookmarkNode[], depth = 0): string[] {
  return nodes.flatMap((n) => [
    `${'  '.repeat(depth)}${n.title}   [key ${n.key} → ${n.page}]`,
    ...flatBookmarks(n.children, depth + 1)
  ])
}

function summary(s: Session): string {
  const bits = [
    `${s.pages.length} page(s)`,
    `${s.sources.length} source(s)`,
    `${s.marks?.length ?? 0} mark(s)`,
    `${s.tapes?.length ?? 0} tape(s)`
  ]
  return `${bits.join(' · ')} · ${sessionPath ? `saved to ${baseName(sessionPath)}` : 'UNSAVED'}`
}

// ------------------------------------------------------------------- server

const server = new McpServer(
  { name: 'workpaper-binder', version: '0.1.0' },
  {
    instructions: [
      'Build tax workpaper binders: import PDFs, order pages, bookmark, place review',
      'marks and calculator tapes, then export a single PDF.',
      '',
      'Workflow: binder_add_pdfs → binder_status (get page ids) → arrange/mark →',
      'binder_save (hand off to the desktop app for review) and/or binder_export.',
      '',
      'Page ids (pg_*) are permanent and are how every tool refers to pages —',
      'they do not change when pages move, so read them once from binder_status.',
      'Mark and tape coordinates are normalized to the page AS DISPLAYED:',
      'nx 0→1 left to right, ny 0→1 TOP TO BOTTOM.',
      '',
      'This server reads document structure only — never page text. It cannot',
      'tell you what a page says or what numbers are on it.'
    ].join('\n')
  }
)

/** Register a tool, synchronizing with the owner around it when there is one. */
const registerTool: typeof server.registerTool = (name, config, handler) =>
  server.registerTool(name, config, (async (...args: unknown[]) => {
    if (owner) {
      const pulled = await owner.pull()
      session = pulled.session
      sessionPath = pulled.path
    }
    const before = session
    try {
      return await (handler as (...a: unknown[]) => unknown)(...args)
    } finally {
      // Push only on a real change, so a read-only tool never marks a person's
      // binder dirty or lands on their undo stack.
      if (owner && session !== before) await owner.push(session)
    }
  }) as never)


registerTool(
  'probe_pdf',
  {
    title: 'Probe a PDF',
    description:
      'Inspect a PDF or image without adding it to the binder: page count, page sizes, rotation, and its bookmark outline. An image reports the single Letter page it would become. Use to check a file before importing.',
    inputSchema: { path: z.string().describe('Path to a .pdf or an image (png, jpg, tif, ...)') }
  },
  async ({ path: p }) => {
    try {
      const res = await runEngine({ cmd: 'probe', path: resolveSource(p) })
      if (!res.ok) return fail(`probe failed: ${res.error}`)
      const probe = res.probe as ProbeWire
      const outline = probe.outline?.length
        ? `\noutline:\n${probe.outline.map((n) => `  ${n.title} → p.${(n.dest_page ?? 0) + 1}`).join('\n')}`
        : '\noutline: none'
      return text(`${baseName(probe.path)} — ${probe.n_pages} page(s)${outline}`)
    } catch (e) {
      return fail(String((e as Error).message))
    }
  }
)

registerTool(
  'binder_status',
  {
    title: 'Binder status',
    description:
      'The current binder: totals plus every page with its permanent page id, source file, source page number, rotation, and how many marks/tapes it carries.',
    inputSchema: {}
  },
  async () => {
    // Which binder this is must never be left to inference: editing a private
    // copy while believing you are editing the open window is the whole failure
    // this feature exists to remove.
    const where = owner
      ? 'LIVE — this is the binder open in Workpaper Binder; changes appear there as you make them.'
      : 'Standalone — your own working binder. Save it and open it in the app to review.'
    return text(
      session.pages.length === 0
        ? `Empty binder. ${summary(session)}\n${where}`
        : `${summary(session)}\n${where}\n\n${pageTable(session)}`
    )
  }
)

registerTool(
  'binder_new',
  {
    title: 'Start a new binder',
    description: 'Discard the working binder and start empty. Unsaved changes are lost.',
    inputSchema: {}
  },
  async () => {
    session = newSession()
    sessionPath = null
    return text('New empty binder.')
  }
)

registerTool(
  'binder_open',
  {
    title: 'Open a saved session',
    description:
      'Load a .wptsession.json written by this server or the desktop app. Source PDFs must still be where the session recorded them.',
    inputSchema: { path: z.string().describe('Path to a .wptsession.json') }
  },
  async ({ path: p }) => {
    try {
      const abs = resolveAllowedPath(p, { mustExist: true, purpose: 'opening a session' })
      const read = await readSessionWithRecovery(abs)
      if (read.session === undefined) return fail(`cannot open session — ${read.error}`)
      let parsed = parseSession(read.session)
      let recovered = !!read.recoveredFrom
      if ('error' in parsed && read.recoverySession !== undefined) {
        const fallback = parseSession(read.recoverySession)
        if (!('error' in fallback)) {
          parsed = fallback
          recovered = true
        }
      }
      if ('error' in parsed) return fail(`cannot open session — ${parsed.error}`)
      session = parsed.session
      for (const source of session.sources) {
        resolveAllowedPath(source.path, { mustExist: true, purpose: 'opening a session source' })
      }
      sessionPath = recovered ? null : abs
      const missing = session.sources.filter((s) => !existsSync(s.path))
      return text(
        `Opened ${baseName(abs)} — ${summary(session)}` +
          (recovered ? '\nWARNING: recovered the previous complete generation; save to a new path.' : '') +
          (missing.length
            ? `\nWARNING: ${missing.length} source file(s) missing: ${missing.map((s) => s.path).join(', ')}`
            : '')
      )
    } catch (e) {
      return fail(String((e as Error).message))
    }
  }
)

registerTool(
  'binder_save',
  {
    title: 'Save the session',
    description:
      'Write the working binder to a .wptsession.json. THIS IS THE HANDOFF: open that file in the desktop app to review and finish the binder. Source PDFs are never modified.',
    inputSchema: {
      path: z
        .string()
        .optional()
        .describe('Where to write it. Optional once the session has been saved before.')
    }
  },
  async ({ path: p }) => {
    const target = p
      ? resolveAllowedPath(p, { mustExist: false, purpose: 'saving a session' })
      : sessionPath
    if (!target) return fail('no path given and this session has never been saved')
    try {
      await atomicWriteJson(target, toSaved(session))
      sessionPath = target
      return text(`Saved ${summary(session)}\n→ ${target}\nOpen it in Workpaper Binder to review.`)
    } catch (e) {
      return fail(String((e as Error).message))
    }
  }
)

registerTool(
  'binder_add_pdfs',
  {
    title: 'Add PDFs, spreadsheets, documents or images to the binder',
    description:
      'Probe each file and append its pages to the end of the binder, in the order given. PDFs contribute all their pages; an image (png, jpg, tif, ...) contributes one Letter page, auto-oriented, with the picture centred. The same file may be added twice; each import is a distinct source.',
    inputSchema: { paths: z.array(z.string()).min(1).describe('Paths to .pdf or image files') }
  },
  async ({ paths }) => {
    const failed: string[] = []
    let next = session
    for (const p of paths) {
      try {
        const res = await runEngine({ cmd: 'probe', path: resolveSource(p) })
        if (res.ok) next = addSource(next, res.probe as ProbeWire)
        else failed.push(`${baseName(p)}: ${res.error}`)
      } catch (e) {
        failed.push(`${baseName(p)}: ${(e as Error).message}`)
      }
    }
    session = next
    mutating('add_sources', `Imported ${paths.length} file(s): ${paths.map((x) => baseName(x)).join(', ')}`, true)
    const added = paths.length - failed.length
    return text(
      `Added ${added} file(s). ${summary(session)}` +
        (failed.length ? `\nFailed: ${failed.join('; ')}` : '') +
        (added ? `\n\n${pageTable(session)}` : '')
    )
  }
)

registerTool(
  'binder_move_pages',
  {
    title: 'Reorder pages',
    description:
      'Move pages so they sit immediately before the given 0-based binder position (use the page count to move to the end). Moved pages keep their relative order. Bookmarks, marks and tapes travel with their pages.',
    inputSchema: {
      pageIds: z.array(z.string()).min(1).describe('Permanent page ids (pg_*)'),
      beforeIndex: z.number().int().min(0).describe('0-based position to insert before')
    }
  },
  async ({ pageIds, beforeIndex }) => {
    const known = new Set(session.pages.map((p) => p.id))
    const unknown = pageIds.filter((id) => !known.has(id))
    if (unknown.length) return fail(`unknown page id(s): ${unknown.join(', ')}`)
    session = movePages(session, pageIds, beforeIndex)
    mutating('move_pages', `Moved ${pageIds.length} page(s) to position ${beforeIndex + 1}`, true)
    return text(`Moved ${pageIds.length} page(s).\n\n${pageTable(session)}`)
  }
)

registerTool(
  'binder_rotate_pages',
  {
    title: 'Rotate pages',
    description:
      'Rotate pages by a multiple of 90°. This is a delta on top of the page\'s own rotation and accumulates.',
    inputSchema: {
      pageIds: z.array(z.string()).min(1),
      degrees: z.number().int().describe('90, 180, 270, or -90')
    }
  },
  async ({ pageIds, degrees }) => {
    if (degrees % 90 !== 0) return fail('degrees must be a multiple of 90')
    session = rotatePages(session, pageIds, degrees)
    mutating('rotate_pages', `Rotated ${pageIds.length} page(s) by ${degrees}°`, true)
    return text(`Rotated ${pageIds.length} page(s) by ${degrees}°.`)
  }
)

registerTool(
  'binder_delete_pages',
  {
    title: 'Delete pages',
    description:
      'Remove pages from the binder. Marks, tapes and bookmarks anchored to them go too. Source files are untouched.',
    inputSchema: { pageIds: z.array(z.string()).min(1) }
  },
  async ({ pageIds }) => {
    const before = session.pages.length
    // Deletion is the one destructive structural act. Name the pages in the
    // record, because reverting the run cannot restore them.
    mutating('delete_pages', `Deleted ${pageIds.length} page(s): ${pageIds.join(', ')}`, true)
    session = deletePages(session, pageIds)
    return text(`Deleted ${before - session.pages.length} page(s). ${summary(session)}`)
  }
)

registerTool(
  'binder_bookmarks',
  {
    title: 'Show the bookmark tree',
    description:
      'The bookmark tree exactly as it will be written on export — one per source file with imported outlines nested beneath, retargeted to final positions. Each row shows the key used to rename it.',
    inputSchema: {
      pageCounts: z.boolean().optional().describe('Append "(N pages)" to leaf bookmarks')
    }
  },
  async ({ pageCounts }) => {
    const tree = buildBookmarks(session, { pageCounts: pageCounts ?? false })
    return text(tree.length ? flatBookmarks(tree).join('\n') : 'No bookmarks.')
  }
)

registerTool(
  'binder_add_bookmark',
  {
    title: 'Add a bookmark',
    description:
      'Add your own bookmark on a page. It is anchored to the page id, so it moves with the page.',
    inputSchema: {
      pageId: z.string(),
      title: z.string(),
      depth: z.number().int().min(0).max(5).optional().describe('Nesting level, 0 = top')
    }
  },
  async ({ pageId, title, depth }) => {
    if (!session.pages.some((p) => p.id === pageId)) return fail(`unknown page id: ${pageId}`)
    mutating('add_bookmark', `Bookmarked ${pageId} as "${title}"`)
    const res = addBookmark(session, pageId, title, depth ?? 0)
    session = res.session
    return text(`Added bookmark "${title}" on ${pageId} (key ${res.key}).`)
  }
)

registerTool(
  'binder_rename_bookmark',
  {
    title: 'Rename a bookmark',
    description:
      'Rename any bookmark by its key (from binder_bookmarks). An empty title reverts an imported bookmark to its original.',
    inputSchema: { key: z.string(), title: z.string() }
  },
  async ({ key, title }) => {
    session = setBookmarkTitle(session, key, title)
    mutating('rename_bookmark', `Renamed bookmark ${key} to "${title}"`, true)
    return text(`Renamed ${key}${title ? ` to "${title}"` : ' back to its imported title'}.`)
  }
)

registerTool(
  'binder_set_reviewer',
  {
    title: 'Set reviewer initials',
    description: 'Initials stamped as the author of marks and tapes placed from here on.',
    inputSchema: { initials: z.string().max(4) }
  },
  async ({ initials }) => {
    session = { ...session, reviewer: initials.toUpperCase().slice(0, 4) }
    mutating('set_reviewer', `Set reviewer initials to ${initials.toUpperCase().slice(0, 4)}`, true)
    return text(`Reviewer set to ${session.reviewer}.`)
  }
)

registerTool(
  'binder_place_mark',
  {
    title: 'Place a review mark',
    description:
      'Put a tick (agreed), cross (does not agree), or short lettered stamp on a page. Coordinates are normalized to the page as displayed: nx 0→1 left to right, ny 0→1 TOP TO BOTTOM.',
    inputSchema: {
      pageId: z.string(),
      kind: z.enum(['tick', 'cross', 'text']),
      nx: z.number().min(0).max(1),
      ny: z.number().min(0).max(1),
      text: z.string().max(8).optional().describe('Required for kind "text" — e.g. F, TB, PY'),
      size: z.number().min(10).max(72).optional().describe('Displayed size in points, default 24'),
      note: z.string().optional().describe("Shown as the annotation's comment in any viewer")
    }
  },
  async ({ pageId, kind, nx, ny, text: letters, size, note }) => {
    if (!session.pages.some((p) => p.id === pageId)) return fail(`unknown page id: ${pageId}`)
    if (kind === 'text' && !letters?.trim()) return fail('kind "text" needs the text to stamp')
    mutating(
      'place_mark',
      `Placed ${kind === 'text' ? `"${letters}"` : kind} on ${pageId} at (${nx}, ${ny})`
    )
    const res = addMark(session, {
      page: pageId,
      kind,
      nx,
      ny,
      size: size ?? 24,
      ...(letters ? { text: letters } : {}),
      ...(note ? { note } : {})
    })
    session = res.session
    return text(
      `Placed ${kind === 'text' ? `"${letters}"` : kind} on ${pageId} at (${nx}, ${ny}). ${session.marks?.length} mark(s) total.`
    )
  }
)

registerTool(
  'binder_annotations',
  {
    title: 'List marks and tapes',
    description:
      'Every review mark and calculator tape in the binder with its id, page, kind, position, author and note. This is where the ids for binder_remove_marks come from.',
    inputSchema: {
      pageId: z.string().optional().describe('Limit to one page; omit for the whole binder')
    }
  },
  async ({ pageId }) => {
    const order = new Map(session.pages.map((p, i) => [p.id, i + 1]))
    const marks = (session.marks ?? []).filter((m) => !pageId || m.page === pageId)
    const tapes = (session.tapes ?? []).filter((t) => !pageId || t.page === pageId)
    if (!marks.length && !tapes.length) return text('No marks or tapes.')
    const rows = [
      ...marks.map(
        (m) =>
          `${m.id}  p${order.get(m.page) ?? '?'} ${m.page}  ${m.kind === 'text' ? `"${m.text}"` : m.kind}` +
          `  (${m.nx.toFixed(3)}, ${m.ny.toFixed(3)})  ${m.size}pt` +
          `${m.author ? `  ${m.author}` : ''}${m.note ? `  — ${m.note}` : ''}`
      ),
      ...tapes.map(
        (t) =>
          `${t.id}  p${order.get(t.page) ?? '?'} ${t.page}  tape` +
          `  (${t.nx.toFixed(3)}, ${t.ny.toFixed(3)})  ${t.entries.length} line(s)` +
          `  total ${formatAmount(tapeTotal(t.entries))}${t.title ? `  — ${t.title}` : ''}`
      )
    ]
    return text(rows.join('\n'))
  }
)

registerTool(
  'binder_remove_marks',
  {
    title: 'Remove marks or tapes',
    description:
      'Delete review marks (mk_*) and/or calculator tapes (tp_*) by id. Get the ids from binder_annotations. Removing a mark never touches the page it sat on.',
    inputSchema: {
      markIds: z.array(z.string()).min(1).describe('Mark ids (mk_*) and/or tape ids (tp_*)')
    }
  },
  async ({ markIds }) => {
    const before = (session.marks?.length ?? 0) + (session.tapes?.length ?? 0)
    mutating('remove_annotations', `Removed ${markIds.length} annotation(s): ${markIds.join(', ')}`, true)
    session = removeTapes(removeMarks(session, markIds), markIds)
    const after = (session.marks?.length ?? 0) + (session.tapes?.length ?? 0)
    if (after === before) return fail(`no marks or tapes matched: ${markIds.join(', ')}`)
    return text(`Removed ${before - after} annotation(s). ${summary(session)}`)
  }
)

registerTool(
  'binder_add_tape',
  {
    title: 'Add a calculator tape',
    description:
      'Lay a calculator tape on a page: the addends and their total, shown as an adding-machine tape. Amounts are summed in whole cents. The entries are stored structurally, so the total always carries its addends.',
    inputSchema: {
      pageId: z.string(),
      nx: z.number().min(0).max(1),
      ny: z.number().min(0).max(1).describe('0 = top of page, 1 = bottom'),
      entries: z
        .array(z.union([z.number(), z.object({ value: z.number(), op: z.enum(['+', '-']).optional(), note: z.string().optional() })]))
        .min(1)
        .describe('Lines in order. A bare number is an addition; a negative one subtracts. Or {value, op, note}.'),
      title: z.string().max(28).optional().describe('Caption, e.g. "Repairs & maintenance"')
    }
  },
  async ({ pageId, nx, ny, entries, title }) => {
    if (!session.pages.some((p) => p.id === pageId)) return fail(`unknown page id: ${pageId}`)
    const lines = entries.map((e) => toTapeEntry(e as never))
    mutating(
      'add_tape',
      `Tape on ${pageId}${title ? ` ("${title}")` : ''}: ${lines.length} line(s), total ${formatAmount(tapeTotal(lines))}`
    )
    const res = addTape(session, { page: pageId, nx, ny, entries: lines, ...(title ? { title } : {}) })
    session = res.session
    return text(
      `Tape on ${pageId}: ${lines.length} line(s), total ${formatAmount(tapeTotal(lines))}.`
    )
  }
)

registerTool(
  'binder_export',
  {
    title: 'Export the binder to PDF',
    description:
      'Write the binder to a single PDF: pages in order, bookmarks retargeted, marks and tapes applied. Source files are opened read-only and never modified. Returns qpdf validation results.',
    inputSchema: {
      output: z.string().describe('Path for the exported .pdf'),
      pageCounts: z.boolean().optional().describe('Append "(N pages)" to leaf bookmarks'),
      flatten: z
        .boolean()
        .optional()
        .describe(
          'Burn marks and tapes into the page content instead of attaching them as annotations. One-way: a flattened PDF cannot be re-edited. For copies that leave the firm.'
        )
    }
  },
  async ({ output, pageCounts, flatten }) => {
    if (session.pages.length === 0) return fail('nothing to export — the binder is empty')
    const out = resolveAllowedPath(output, { mustExist: false, purpose: 'exporting a binder' })
    const spec = toExportSpec(session, out, {
      pageCounts: pageCounts ?? false,
      flatten: flatten ?? false
    })
    const res = await runEngine({ cmd: 'export', binder: spec })
    if (!res.ok) return fail(`export failed: ${res.error}`)
    const r = res.result as { pages: number; marks: number; check_problems: string[] }
    return text(
      `Exported ${r.pages} page(s) and ${r.marks} annotation(s)${flatten ? ' (flattened)' : ''} → ${out}\n` +
        (r.check_problems.length
          ? `qpdf validation: ${r.check_problems.length} problem(s): ${r.check_problems.join('; ')}`
          : 'qpdf validation: clean')
    )
  }
)

// ------------------------------------------------------- audit and revert

function journalLines(entries: JournalEntry[]): string {
  return entries
    .map(
      (e) =>
        `${e.at.slice(0, 19).replace('T', ' ')}  ${e.by === 'agent' ? 'AI ' : 'you'}  ` +
        `${e.what}${e.structural ? '   [structural — revert cannot undo this]' : ''}` +
        `${e.run ? `   (${e.run})` : ''}`
    )
    .join('\n')
}

registerTool(
  'binder_history',
  {
    title: 'What has been done to this binder',
    description:
      'The record of every change an agent has made to this binder, in order, with what can and cannot be undone. A workpaper is evidence — use this to show a reviewer exactly what was automated.',
    inputSchema: {
      run: z.string().optional().describe('Restrict to one run id')
    }
  },
  async ({ run }) => {
    const all = session.journal ?? []
    const entries = run ? all.filter((e) => e.run === run) : all
    const work = agentWork(session)
    const head =
      `${entries.length} recorded change(s)` +
      (work.runs.length ? ` across ${work.runs.length} run(s): ${work.runs.join(', ')}` : '') +
      `\nStill present from agent work: ${work.marks} mark(s), ${work.tapes} tape(s), ` +
      `${work.shapes} shape(s), ${work.bookmarks} bookmark(s)`
    return text(entries.length ? `${head}\n\n${journalLines(entries)}` : `${head}\n\nNothing recorded.`)
  }
)

registerTool(
  'binder_revert_run',
  {
    title: 'Undo an agent run',
    description:
      "Remove everything an agent run added — its marks, tapes, shapes and bookmarks. Deliberately does NOT roll the binder back to a snapshot, so anything a person did alongside the agent is untouched. Page order, rotation and deletions are NOT undone; the result says exactly which ones survived.",
    inputSchema: { run: z.string().describe('Run id, from binder_history') }
  },
  async ({ run }) => {
    const known = new Set((session.journal ?? []).map((e) => e.run).filter(Boolean))
    if (!known.has(run)) return fail(`unknown run: ${run} — see binder_history`)
    const res = revertRun(session, run)
    session = res.session
    const tail = res.structural.length
      ? `\n\n${res.structural.length} change(s) could NOT be undone, because they altered the binder rather than adding something removable:\n` +
        res.structural.map((e) => `  ${e.what}`).join('\n')
      : ''
    return text(`Reverted ${run}: removed ${res.removed} agent annotation(s).${tail}\n\n${summary(session)}`)
  }
)

// ------------------------------------------------------------------- text

interface Word {
  t: string
  nx: number
  ny: number
  box: [number, number, number, number]
  /** Present only for OCR: 0-100. A guess, and labelled as one. */
  conf?: number
}

/**
 * A binder page's text, in the binder's own display space.
 *
 * Two corrections happen here and both matter. The engine is asked for the
 * SOURCE page index (a binder page can be any page of any file, in any order),
 * and every coordinate is then turned by the user's rotation delta so a word's
 * position means the same thing a mark's position does.
 */
async function pageText(
  page: { id: string; source: string; index: number; rotate: number },
  useOcr = false
): Promise<{
  text: string
  words: Word[]
  hasText: boolean
  source: string
  engine?: string
  error?: string
}> {
  const src = session.sources.find((s) => s.id === page.source)
  if (!src) throw new Error(`page ${page.id} has no source in this session`)
  // Images are scans by definition — no text layer, and the engine's PDF
  // reader would simply fail to open one.
  // A spreadsheet's cells are really drawn into its pages, so its text is
  // exact — only a picture genuinely has nothing to read.
  const readable = ['.pdf', '.xlsx', '.xlsm', '.csv', '.md', '.markdown', '.docx']
  if (!readable.some((e) => src.path.toLowerCase().endsWith(e))) {
    return { text: '', words: [], hasText: false, source: 'none' }
  }
  const res = await runEngine({
    cmd: 'text',
    path: src.path,
    pages: [page.index],
    ...(useOcr ? { ocr: true } : {})
  })
  if (!res.ok) throw new Error(String(res.error))
  const wire = (
    res.text as {
      pages: Array<{
        text: string
        has_text: boolean
        source?: string
        words?: Word[]
        ocr_error?: string
        ocr_engine?: string
        ocr_confidence?: number
      }>
    }
  ).pages[0]
  if (!wire) return { text: '', words: [], hasText: false, source: 'none' }
  const turn = (w: Word): Word => {
    if (!page.rotate) return w
    const c = rotateVisual(w.nx, w.ny, page.rotate)
    const [x0, y0, x1, y1] = w.box
    const corners = [
      rotateVisual(x0, y0, page.rotate),
      rotateVisual(x1, y0, page.rotate),
      rotateVisual(x1, y1, page.rotate),
      rotateVisual(x0, y1, page.rotate)
    ]
    const xs = corners.map((p) => p.nx)
    const ys = corners.map((p) => p.ny)
    return {
      t: w.t,
      nx: Number(c.nx.toFixed(5)),
      ny: Number(c.ny.toFixed(5)),
      box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map((v) =>
        Number(v.toFixed(5))
      ) as [number, number, number, number]
    }
  }
  return {
    text: wire.text ?? '',
    words: (wire.words ?? []).map(turn),
    hasText: wire.has_text === true,
    source: wire.source ?? 'none',
    ...(wire.ocr_engine ? { engine: wire.ocr_engine } : {}),
    ...(wire.ocr_error ? { error: wire.ocr_error } : {})
  }
}

registerTool(
  'binder_read_page',
  {
    title: 'Read a page',
    description:
      'The text of a binder page, laid out in lines. Use this to find out what a page actually says — which figures are on it, what schedule it is — before bookmarking, naming, or marking it. A scan or photo has no text layer: pass ocr:true to have it read by OCR, which returns a MACHINE READING with confidence, not the document\'s own text.',
    inputSchema: {
      pageId: z.string(),
      ocr: z
        .boolean()
        .optional()
        .describe('Read a scanned page with OCR. Slower, and the result is a guess — check confidence before relying on a figure.')
    }
  },
  async ({ pageId, ocr }) => {
    const page = session.pages.find((p) => p.id === pageId)
    if (!page) return fail(`unknown page id: ${pageId}`)
    try {
      const got = await pageText(page, ocr === true)
      if (!got.hasText) {
        return text(
          `${pageId} has no text layer — it is a scan or a photo.` +
            (got.error
              ? ` OCR is unavailable: ${got.error}`
              : ocr
                ? ' OCR found nothing readable on it.'
                : ' Call again with ocr:true to have it read by OCR.')
        )
      }
      const provenance =
        got.source === 'ocr'
          ? `\n\n(Read by OCR${got.engine ? ` — ${got.engine}` : ''} — a machine reading of a picture, not the document\'s own text. Check a figure against the page before relying on it.)`
          : ''
      return text(`${pageId}:\n${got.text}${provenance}`)
    } catch (e) {
      return fail(String((e as Error).message))
    }
  }
)

registerTool(
  'binder_read_cells',
  {
    title: 'Read a spreadsheet as data',
    description:
      "A spreadsheet page's actual CELLS, by column, rather than the flattened line the page renders to. Use this for anything that depends on which column a figure sits in — reconciling, footing, comparing periods. On a trial balance the rendered page cannot tell you whether 7,412.68 is a beginning or an ending balance; this can. Blank cells are shown as empty between delimiters, because \"this column is blank for this account\" is a fact a reconciliation needs.",
    inputSchema: {
      pageId: z.string().describe('Any page from the spreadsheet you want to read'),
      sheet: z.string().optional().describe('Restrict to one worksheet by name'),
      maxRows: z.number().min(1).max(2000).optional()
    }
  },
  async ({ pageId, sheet, maxRows }) => {
    const page = session.pages.find((p) => p.id === pageId)
    if (!page) return fail(`unknown page id: ${pageId}`)
    const src = session.sources.find((x) => x.id === page.source)
    if (!src) return fail(`page ${pageId} has no source in this session`)
    if (!/\.(xlsx|xlsm|csv)$/i.test(src.path)) {
      return fail(`${pageId} is not a spreadsheet — use binder_read_page for ${baseName(src.path)}`)
    }
    const res = await runEngine({ cmd: 'cells', path: src.path })
    if (!res.ok) return fail(`could not read cells: ${String(res.error)}`)
    const data = res.cells as {
      sheets: Array<{
        name: string
        header_row: number | null
        headers: string[]
        rows: Array<{ row: number; cells: Record<string, string> }>
        truncated?: boolean
      }>
      warnings?: string[]
    }
    const wanted = sheet
      ? data.sheets.filter((s) => s.name.toLowerCase() === sheet.toLowerCase())
      : data.sheets
    if (!wanted.length) {
      return fail(`no sheet named "${sheet}" — found: ${data.sheets.map((s) => s.name).join(', ')}`)
    }
    const cap = maxRows ?? 400
    const out = wanted.map((s) => {
      const rows = s.rows.slice(0, cap)
      const lines = [
        `## ${s.name}   (header on row ${s.header_row ?? '?'})`,
        `row | ${s.headers.join(' | ')}`,
        ...rows.map((r) => `${r.row} | ${s.headers.map((h) => r.cells[h] ?? '').join(' | ')}`)
      ]
      if (s.rows.length > rows.length) lines.push(`… ${s.rows.length - rows.length} more rows`)
      return lines.join('\n')
    })
    const warn = data.warnings?.length ? `\n\n${data.warnings.join('\n')}` : ''
    return text(`${baseName(src.path)}\n\n${out.join('\n\n')}${warn}`)
  }
)

registerTool(
  'binder_find',
  {
    title: 'Find text in the binder',
    description:
      'Search the binder for a figure or phrase and get back each hit WITH the coordinates to mark it. Pass a hit straight to binder_place_mark: use "beside" to put the mark just right of the figure the way a preparer would, or "nx/ny" to centre it on top. Searches every page unless pageId is given. Case-insensitive substring match.',
    inputSchema: {
      query: z.string().min(1).describe('e.g. "84,200.00" or "Taxable interest"'),
      pageId: z.string().optional().describe('Restrict to one page'),
      limit: z.number().min(1).max(200).optional().describe('Max hits, default 50'),
      ocr: z
        .boolean()
        .optional()
        .describe('Also search scanned pages by reading them with OCR. Much slower, and those hits are a machine reading — each carries its confidence.')
    }
  },
  async ({ query, pageId, limit, ocr }) => {
    const pages = pageId ? session.pages.filter((p) => p.id === pageId) : session.pages
    if (pageId && pages.length === 0) return fail(`unknown page id: ${pageId}`)
    const cap = limit ?? 50
    const needle = query.toLowerCase()
    const hits: string[] = []
    const skipped: string[] = []
    try {
      for (const page of pages) {
        if (hits.length >= cap) break
        const got = await pageText(page, ocr === true)
        if (!got.hasText) {
          skipped.push(page.id)
          continue
        }
        for (const w of got.words) {
          if (!w.t.toLowerCase().includes(needle)) continue
          // An OCR hit is a guess. It is never presented like an exact reading:
          // a figure read at 61% and one read at 97% are different claims, and
          // the preparer signing the file is entitled to know which this is.
          const read =
            got.source === 'ocr' ? `  OCR ${w.conf !== undefined ? `${w.conf}%` : ''}` : ''
          // A tick centred on a figure covers its digits — no preparer ticks
          // through a number. Offer the position just past the word's right
          // edge as well, clamped to the page.
          const beside = Math.min(0.995, w.box[2] + (w.box[3] - w.box[1]) * 0.35)
          hits.push(
            `${w.t}   [page ${page.id}  nx ${w.nx}  ny ${w.ny}  beside nx ${Number(beside.toFixed(5))}]${read}`
          )
          if (hits.length >= cap) break
        }
      }
    } catch (e) {
      return fail(String((e as Error).message))
    }
    const note = skipped.length
      ? `\n\n${skipped.length} page(s) have no text layer and were not searched (scans/photos): ` +
        `${skipped.slice(0, 10).join(', ')}${skipped.length > 10 ? ' …' : ''}` +
        (ocr ? '' : '\nCall again with ocr:true to read them.')
      : ''
    return text(
      hits.length
        ? `${hits.length} hit(s) for "${query}":\n${hits.join('\n')}${note}`
        : `No hits for "${query}".${note}`
    )
  }
)

// --------------------------------------------------------------------- boot

async function main(): Promise<void> {
  // Attach to a running Workpaper Binder if one is offering live access, so an
  // agent and the person at the keyboard work on the SAME binder. Falls back to
  // this process owning its own binder — the behaviour before live access
  // existed — when the app is shut or has it turned off.
  const { attachToRunningApp } = await import('./live-client')
  const live = await attachToRunningApp()
  if (live) setSessionOwner(live)
  await server.connect(new StdioServerTransport())
}

main().catch((e) => {
  // stdout is the MCP protocol channel — diagnostics go to stderr, never there.
  process.stderr.write(`workpaper-binder MCP server failed: ${String(e)}\n`)
  process.exit(1)
})
