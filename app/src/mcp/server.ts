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
 * bookmark titles, and mark/tape metadata. Page *text* is never read or
 * returned — the engine probes structure, not content — so this server cannot
 * put the numbers off a return into a model's context. Bookmark titles and file
 * names routinely carry client names, so what does cross is still client-
 * identifying: running this against real client files is a §7216 disclosure
 * decision, and the tool does not make it for you.
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
  addSource,
  addTape,
  baseName,
  buildBookmarks,
  deletePages,
  formatAmount,
  movePages,
  newSession,
  parseSession,
  removeMarks,
  removeTapes,
  rotatePages,
  setBookmarkTitle,
  tapeTotal,
  toTapeEntry,
  toExportSpec,
  type BookmarkNode,
  type ProbeWire,
  type Session
} from '../renderer/src/session'

// ------------------------------------------------------------------- state

/** The working binder. One per server process, like one open document. */
let session: Session = newSession()
let sessionPath: string | null = null

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
    throw new Error(`not a PDF or supported image: ${abs}`)
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

server.registerTool(
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

server.registerTool(
  'binder_status',
  {
    title: 'Binder status',
    description:
      'The current binder: totals plus every page with its permanent page id, source file, source page number, rotation, and how many marks/tapes it carries.',
    inputSchema: {}
  },
  async () =>
    text(
      session.pages.length === 0
        ? `Empty binder. ${summary(session)}`
        : `${summary(session)}\n\n${pageTable(session)}`
    )
)

server.registerTool(
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

server.registerTool(
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

server.registerTool(
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
      await atomicWriteJson(target, session)
      sessionPath = target
      return text(`Saved ${summary(session)}\n→ ${target}\nOpen it in Workpaper Binder to review.`)
    } catch (e) {
      return fail(String((e as Error).message))
    }
  }
)

server.registerTool(
  'binder_add_pdfs',
  {
    title: 'Add PDFs or images to the binder',
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
    const added = paths.length - failed.length
    return text(
      `Added ${added} file(s). ${summary(session)}` +
        (failed.length ? `\nFailed: ${failed.join('; ')}` : '') +
        (added ? `\n\n${pageTable(session)}` : '')
    )
  }
)

server.registerTool(
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
    return text(`Moved ${pageIds.length} page(s).\n\n${pageTable(session)}`)
  }
)

server.registerTool(
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
    return text(`Rotated ${pageIds.length} page(s) by ${degrees}°.`)
  }
)

server.registerTool(
  'binder_delete_pages',
  {
    title: 'Delete pages',
    description:
      'Remove pages from the binder. Marks, tapes and bookmarks anchored to them go too. Source files are untouched.',
    inputSchema: { pageIds: z.array(z.string()).min(1) }
  },
  async ({ pageIds }) => {
    const before = session.pages.length
    session = deletePages(session, pageIds)
    return text(`Deleted ${before - session.pages.length} page(s). ${summary(session)}`)
  }
)

server.registerTool(
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

server.registerTool(
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
    const res = addBookmark(session, pageId, title, depth ?? 0)
    session = res.session
    return text(`Added bookmark "${title}" on ${pageId} (key ${res.key}).`)
  }
)

server.registerTool(
  'binder_rename_bookmark',
  {
    title: 'Rename a bookmark',
    description:
      'Rename any bookmark by its key (from binder_bookmarks). An empty title reverts an imported bookmark to its original.',
    inputSchema: { key: z.string(), title: z.string() }
  },
  async ({ key, title }) => {
    session = setBookmarkTitle(session, key, title)
    return text(`Renamed ${key}${title ? ` to "${title}"` : ' back to its imported title'}.`)
  }
)

server.registerTool(
  'binder_set_reviewer',
  {
    title: 'Set reviewer initials',
    description: 'Initials stamped as the author of marks and tapes placed from here on.',
    inputSchema: { initials: z.string().max(4) }
  },
  async ({ initials }) => {
    session = { ...session, reviewer: initials.toUpperCase().slice(0, 4) }
    return text(`Reviewer set to ${session.reviewer}.`)
  }
)

server.registerTool(
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

server.registerTool(
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

server.registerTool(
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
    session = removeTapes(removeMarks(session, markIds), markIds)
    const after = (session.marks?.length ?? 0) + (session.tapes?.length ?? 0)
    if (after === before) return fail(`no marks or tapes matched: ${markIds.join(', ')}`)
    return text(`Removed ${before - after} annotation(s). ${summary(session)}`)
  }
)

server.registerTool(
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
    const res = addTape(session, { page: pageId, nx, ny, entries: lines, ...(title ? { title } : {}) })
    session = res.session
    return text(
      `Tape on ${pageId}: ${lines.length} line(s), total ${formatAmount(tapeTotal(lines))}.`
    )
  }
)

server.registerTool(
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

// --------------------------------------------------------------------- boot

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport())
}

main().catch((e) => {
  // stdout is the MCP protocol channel — diagnostics go to stderr, never there.
  process.stderr.write(`workpaper-binder MCP server failed: ${String(e)}\n`)
  process.exit(1)
})
