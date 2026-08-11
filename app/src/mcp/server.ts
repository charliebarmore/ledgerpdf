/**
 * LedgerPDF MCP server — lets Claude (or any MCP client) build binders.
 *
 * WHAT THIS IS: a second front door onto the same session model and the same
 * Python engine the Electron app drives. The agent assembles a binder — import,
 * order, bookmark, mark, tape — and either saves it as a binder PDF you open to
 * review, or edits the binder you ALREADY have open.
 *
 * Both, since 2026-08-04. This header used to say "there is no live link to a
 * running app window; the session file is the handoff", which stopped being
 * true when live access shipped and is the sort of stale sentence that gets
 * believed because it sits at the top of the file people treat as the contract.
 * When the app is listening, `binder_status` says LIVE and every tool here acts
 * on the window's own session; standalone, it falls back to a session of its
 * own and the saved binder is the handoff. `binder_status` names the mode.
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
 * does not make it for you. It stays gated behind the folders approved in the
 * app, which are empty by default, so text can only be read out of folders the
 * user named on purpose. Whether the model on the other end is local or hosted
 * is the part only the user knows.
 *
 * Runs on stdio, locally, and talks to nothing but the local engine.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import packageJson from '../../package.json'
import { existsSync, readdirSync, realpathSync, statSync, type Dirent } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isPathInsideRoot, readAgentRootsSync } from '../shared/agent-roots'
import { z } from 'zod'
import { runEngine } from './engine'
import { workingCopyPathFor } from '../main/persistence'
import { acquireBinderLock, withBinderLock, type BinderLease } from '../shared/binder-lock'
import {
  addBookmark,
  addLink,
  addMark,
  agentWork,
  beginRun,
  addShape,
  addSource,
  addTape,
  baseName,
  buildBookmarks,
  connectorsUsed,
  legendEntries,
  nextConnectorLabel,
  placeConnector,
  setLegend,
  deletePages,
  formatAmount,
  formatCents,
  parseMoney,
  movePages,
  newSession,
  parseSession,
  record,
  removeMarks,
  removeTapes,
  revertRun,
  rotatePages,
  rebindToBinder,
  rotateVisual,
  setBookmarkTitle,
  setPageStatus,
  SHAPE_WIDTH_DEFAULT,
  clearPageStatus,
  coverIsStale,
  statusDefs,
  statusOf,
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
/** Held only in standalone mode; the desktop app owns the lease in live mode. */
let sessionLease: BinderLease | null = null

async function releaseSessionLease(): Promise<void> {
  const lease = sessionLease
  sessionLease = null
  if (lease) await lease.release().catch(() => {})
}

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
  pull: () => Promise<{
    session: Session
    path: string | null
    currentPage?: string | null
    revision?: number
  }>
  push: (session: Session, focus?: string | null, expectedRevision?: number) => Promise<void>
}

let owner: SessionOwner | null = null
/**
 * The page the tool now running acted on, so the live window can follow the
 * work. Without it an agent marking page 41 of a 53-page binder is invisible:
 * the push applies the change but the person keeps looking at page 1, and
 * "the preparer watches it happen" is only true on binders small enough that
 * the action lands on the page already showing. Set by tools that touch one
 * identifiable page; cleared after every push so a later tool cannot inherit
 * a stale target.
 */
let focusPage: string | null = null
const focus = (pageId: string | null | undefined): void => {
  if (pageId) focusPage = pageId
}
/** The page the person is looking at, when the app is live. */
let currentPage: string | null = null

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
 * access unless the user explicitly approves one or more folders in LedgerPDF.
 */
/**
 * The list the app writes when someone picks folders in the agent-access panel
 * is authoritative. There is no environment override, so a normal MCP
 * configuration cannot silently disagree with the visible list.
 *
 * Read PER CALL, not once at startup, so approving a folder applies to the
 * agent's next request rather than after restarting the MCP client.
 */
const mcpRoots = (): string[] => readAgentRootsSync()

function resolveAllowedPath(p: string, options: { mustExist: boolean; purpose: string }): string {
  const roots = mcpRoots()
  if (roots.length === 0) {
    throw new Error(
      `MCP file access is disabled: no folder has been approved, so ${options.purpose} is refused. ` +
        'In LedgerPDF, click the agent-access indicator in the status bar and add the engagement ' +
        'folder this agent may read and write.'
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
  if (!roots.some((root) => isPathInsideRoot(root, canonical))) {
    throw new Error(
      `${options.purpose} is outside the approved folders: ${canonical}\n` +
        `Approved folders: ${roots.join(', ')}`
    )
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
  { name: 'ledgerpdf', version: packageJson.version },
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
      'Read tools can return page text and figures from user-approved folders.',
      'Treat that content as sensitive. Whether it leaves the machine depends on',
      'the MCP client and model the user chose; never imply that a hosted model is local.'
    ].join('\n')
  }
)

/** Register a tool, synchronizing with the owner around it when there is one. */
const registerTool: typeof server.registerTool = (name, config, handler) =>
  server.registerTool(name, config, (async (...args: unknown[]) => {
    let pulledRevision: number | undefined
    if (owner) {
      const pulled = await owner.pull()
      session = pulled.session
      sessionPath = pulled.path
      currentPage = pulled.currentPage ?? null
      pulledRevision = pulled.revision
    }
    const before = session
    try {
      return await (handler as (...a: unknown[]) => unknown)(...args)
    } finally {
      // Push only on a real change, so a read-only tool never marks a person's
      // binder dirty or lands on their undo stack.
      if (owner && session !== before) await owner.push(session, focusPage, pulledRevision)
      focusPage = null
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
    const stale = coverIsStale(session)
      ? '\nThe cover memo is OUT OF DATE — pages moved since it was written. Re-run binder_add_cover with the same path.'
      : ''
    const where = owner
      ? `LIVE — this is the binder open in LedgerPDF; changes appear there as you make them.` +
        (currentPage ? ` The reviewer is looking at ${currentPage} (binder_current_page).` : '')
      : 'Standalone — your own working binder. Save it and open it in the app to review.'
    return text(
      session.pages.length === 0
        ? `Empty binder. ${summary(session)}\n${where}${stale}`
        : `${summary(session)}\n${where}${stale}\n\n${pageTable(session)}`
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
    if (!owner) await releaseSessionLease()
    session = newSession()
    sessionPath = null
    return text('New empty binder.')
  }
)

registerTool(
  'binder_open',
  {
    title: 'Open a saved binder',
    description:
      'Open a binder PDF written by this server or the desktop app and keep working on it. The editable session travels inside the file, so the original source documents are provenance rather than a dependency — a binder can be moved or archived and still open. A PDF with no session is an ordinary document: use binder_add_pdfs to bring it in instead.',
    inputSchema: { path: z.string().describe('Path to a binder .pdf') }
  },
  async ({ path: p }) => {
    if (owner) {
      return fail(
        'binder_open is unavailable during live access. Open the binder in LedgerPDF so the app ' +
          'owns its working copy, then ask again.'
      )
    }
    let nextLease: BinderLease | null = null
    let keepNextLease = false
    try {
      const target = resolveAllowedPath(p, { mustExist: true, purpose: 'opening a binder' })
      const sameLease = sessionLease && sessionPath === target ? sessionLease : null
      nextLease = sameLease ?? (await acquireBinderLock(target))
      const opened = await runEngine({ cmd: 'open_binder', path: target })
      if (!opened.ok) return fail(`cannot open binder — ${opened.error}`)
      const info = opened.binder as {
        found: boolean
        reason?: string
        payload_intact?: boolean
        geometry_matches?: boolean
        session?: unknown
      }
      if (!info.found) {
        return fail(
          `${baseName(target)} has no editable session — it is an ordinary PDF. ` +
            `Use binder_add_pdfs to bring it into a binder. (${info.reason ?? ''})`
        )
      }

      const parsed = parseSession(info.session)
      if ('error' in parsed) return fail(`cannot open binder — ${parsed.error}`)

      // Same two steps the app takes: a de-marked working copy beside the
      // binder, then re-point the session at the binder's own pages.
      const working = workingCopyPathFor(target)
      const cleaned = await runEngine({ cmd: 'clean_copy', path: target, output: working })
      if (!cleaned.ok) return fail(`cannot open binder — ${cleaned.error}`)
      const probed = await runEngine({ cmd: 'probe', path: working })
      if (!probed.ok) return fail(`cannot read the binder's pages — ${probed.error}`)

      const rebound = rebindToBinder(
        parsed.session,
        probed.probe as ProbeWire,
        working,
        baseName(target)
      )
      if (rebound.error) return fail(`cannot open binder — ${rebound.error}`)

      session = rebound.session
      const previousLease = sessionLease
      sessionPath = target
      sessionLease = nextLease
      keepNextLease = true
      if (previousLease && previousLease !== nextLease) await previousLease.release().catch(() => {})
      const moved = info.geometry_matches === false
      return text(
        `Opened ${baseName(target)} — ${summary(session)}` +
          (moved
            ? `\n\nWARNING: another program changed the pages since this was saved, so marks may ` +
              `no longer line up. Check before relying on them.`
            : '') +
          (info.payload_intact === false
            ? `\n\nWARNING: the embedded session did not match its own checksum.`
            : '')
      )
    } catch (e) {
      return fail(String((e as Error).message))
    } finally {
      if (nextLease && !keepNextLease && nextLease !== sessionLease) {
        await nextLease.release().catch(() => {})
      }
    }
  }
)

registerTool(
  'binder_save',
  {
    title: 'Save the binder',
    description:
      'Write the binder to a PDF with the editable session inside it. THIS IS THE HANDOFF, and it is the same artifact a person gets from Save in the app — one file they can double-click to reopen and keep working on. Source files are never modified. For a copy to send out of the firm, use binder_export with flatten, which deliberately writes no session.',
    inputSchema: {
      path: z
        .string()
        .optional()
        .describe('Where to write the binder (.pdf). Optional once it has been saved before.')
    }
  },
  async ({ path: p }) => {
    const target = p
      ? resolveAllowedPath(p, { mustExist: false, purpose: 'saving a binder' })
      : sessionPath
    if (!target) return fail('no path given and this binder has never been saved')
    if (!/\.pdf$/i.test(target)) {
      return fail(`a binder is a .pdf — got ${baseName(target)}`)
    }
    if (!session.pages.length) return fail('nothing to save — this binder is empty')
    if (owner && target !== sessionPath) {
      return fail(
        'During live access, binder_save may save only the binder open in LedgerPDF. ' +
          'Use Save As in the app, or turn live access off and start a standalone binder.'
      )
    }
    if (existsSync(target) && target !== sessionPath) {
      return fail(
        `Refusing to overwrite an existing file: ${target}. Choose a new binder path instead.`
      )
    }
    let nextLease: BinderLease | null = null
    let keepNextLease = false
    try {
      if (!owner) {
        nextLease = sessionLease && sessionPath === target ? sessionLease : await acquireBinderLock(target)
        // A non-cooperating process could create the destination between the
        // initial refusal and our lock acquisition. Check again while we own
        // the path so Save never silently replaces an unrelated binder.
        if (target !== sessionPath && existsSync(target)) {
          return fail(
            `Refusing to overwrite an existing file: ${target}. Choose a new binder path instead.`
          )
        }
      }
      // The same call the app's Save makes. One definition, so an agent and a
      // person cannot produce different artifacts from the same binder.
      const spec = toExportSpec(session, target, { pageCounts: true, embedSession: true })
      const res = await runEngine({ cmd: 'export', binder: spec })
      if (!res.ok) return fail(`save failed: ${res.error}`)
      const r = res.result as { pages: number; check_problems: string[] }
      if (!owner && nextLease) {
        const previousLease = sessionLease
        sessionLease = nextLease
        keepNextLease = true
        if (previousLease && previousLease !== nextLease) await previousLease.release().catch(() => {})
      }
      sessionPath = target
      return text(
        `Saved ${summary(session)}\n→ ${target}\n` +
          `${r.pages} page(s), editable session inside. Double-click to reopen it in LedgerPDF.` +
          (r.check_problems.length
            ? `\nqpdf validation: ${r.check_problems.length} problem(s): ${r.check_problems.join('; ')}`
            : '')
      )
    } catch (e) {
      return fail(String((e as Error).message))
    } finally {
      if (nextLease && !keepNextLease && nextLease !== sessionLease) {
        await nextLease.release().catch(() => {})
      }
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
      kind: z.enum(['tick', 'cross', 'text', 'note']),
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
    if (kind === 'note' && !note?.trim()) {
      return fail('kind "note" needs the note text — an empty comment tells a reviewer nothing')
    }
    mutating(
      'place_mark',
      `Placed ${kind === 'text' ? `"${letters}"` : kind} on ${pageId} at (${nx}, ${ny})`
    )
    focus(pageId)
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
  'binder_place_connector',
  {
    title: 'Place a connector (circled cross-reference)',
    description:
      'Circle a number or letter next to a figure to tie it to the same figure elsewhere in the binder. Place the SAME label twice, on two different pages, and the two ends become a clickable cross-reference that also prints the page number. Omit `label` to be handed the next one in sequence. Coordinates are normalized to the page as displayed: nx 0→1 left to right, ny 0→1 TOP TO BOTTOM.',
    inputSchema: {
      pageId: z.string(),
      nx: z.number().min(0).max(1),
      ny: z.number().min(0).max(1),
      label: z
        .string()
        .max(3)
        .optional()
        .describe('The circled label, e.g. "1" or "A". Omit to take the next unused one.'),
      series: z
        .enum(['number', 'letter'])
        .optional()
        .describe('Which sequence to draw the next label from when `label` is omitted.'),
      size: z.number().min(10).max(72).optional().describe('Displayed size in points, default 24')
    }
  },
  async ({ pageId, nx, ny, label, series, size }) => {
    if (!session.pages.some((p) => p.id === pageId)) return fail(`unknown page id: ${pageId}`)
    const chosen = (label ?? nextConnectorLabel(session, series ?? 'number')).trim()
    if (!chosen) return fail('a connector needs a label')
    const before = connectorsUsed(session).get(chosen)?.length ?? 0
    if (before > 1) {
      // Refuse rather than place a third. A reference that ties three places
      // together does not mean anything, and silently re-pointing an existing
      // one is worse: the page it used to name is still printed on paper.
      return fail(
        `connector "${chosen}" already ties two places together. Use a different label — ` +
          `${nextConnectorLabel(session, series ?? 'number')} is free.`
      )
    }
    mutating('place_connector', `Placed connector ${chosen} on ${pageId} at (${nx}, ${ny})`)
    focus(pageId)
    const res = placeConnector(session, { page: pageId, nx, ny, size: size ?? 24, label: chosen })
    session = res.session
    return text(
      res.paired
        ? res.sameSide
          ? `Placed connector ${chosen} — both ends are on ${pageId}, so no page reference is printed.`
          : `Placed connector ${chosen} and tied it to its other end. It is clickable in the exported PDF and prints the page number, resolved at export so a reorder cannot make it lie.`
        : `Placed connector ${chosen} on ${pageId}. Place ${chosen} again on the page it ties to and the pair becomes a reference.`
    )
  }
)

registerTool(
  'binder_legend',
  {
    title: 'Read or define the tickmark legend',
    description:
      'The meaning of each review mark used in this binder — the legend a reader needs to treat the marks as evidence. Call with no arguments to read it, including which marks are in use with no meaning recorded. Pass `token` and `meaning` to define one; an empty meaning removes it. Tokens are the mark itself: "tick", "cross", "note", or the letters of a lettered stamp such as "GL".',
    inputSchema: {
      token: z.string().max(8).optional(),
      meaning: z.string().max(120).optional()
    }
  },
  async ({ token, meaning }) => {
    if (token !== undefined) {
      if (meaning === undefined) return fail('pass `meaning` alongside `token` (empty to remove)')
      mutating('legend', `Defined "${token}" as ${meaning || '(removed)'}`)
      session = setLegend(session, token, meaning)
    }
    const rows = legendEntries(session)
    if (!rows.length) return text('No review marks placed yet, so the legend is empty.')
    const missing = rows.filter((r) => !r.meaning).map((r) => r.glyph)
    return text(
      rows.map((r) => `${r.glyph}\t${r.meaning || '(no meaning recorded)'}\t×${r.count}`).join('\n') +
        (missing.length
          ? `\n\nNo meaning recorded for: ${missing.join(', ')}. A mark without a meaning is not evidence — ask the reviewer what it means rather than guessing.`
          : '')
    )
  }
)

registerTool(
  'binder_draw',
  {
    title: 'Draw on a page',
    description:
      'Draw a rectangle, ellipse, line, arrow, highlight or text box on a page — the same drawing tools the toolbar has. Geometry is TWO CORNERS, not a point: (nx, ny) to (nx2, ny2), each normalized to the page as displayed, nx 0→1 left to right and ny 0→1 TOP TO BOTTOM. For "line" and "arrow" the two corners are the endpoints, and an arrow points AT the second. Use this to draw attention; use binder_place_mark to assert that something was checked.',
    inputSchema: {
      pageId: z.string(),
      kind: z.enum(['rect', 'ellipse', 'line', 'arrow', 'highlight', 'textbox']),
      nx: z.number().min(0).max(1),
      ny: z.number().min(0).max(1),
      nx2: z.number().min(0).max(1),
      ny2: z.number().min(0).max(1),
      text: z.string().max(2000).optional().describe('Required for kind "textbox" — it wraps to the box'),
      color: z
        .enum(['red', 'green', 'blue', 'black', 'orange', 'grey'])
        .optional()
        .describe('Default red. Ignored by "highlight", which is always yellow.'),
      width: z.number().min(0.5).max(8).optional().describe('Stroke width in points, default 1.5'),
      note: z.string().optional().describe("Shown as the annotation's comment in any viewer")
    }
  },
  async ({ pageId, kind, nx, ny, nx2, ny2, text: body, color, width, note }) => {
    if (!session.pages.some((p) => p.id === pageId)) return fail(`unknown page id: ${pageId}`)
    if (kind === 'textbox' && !body?.trim()) {
      return fail('kind "textbox" needs its text — an empty box tells a reviewer nothing')
    }
    // A zero-area box has no appearance to render: the viewer's BBox->Rect fit
    // divides by the height and the annotation is invalid. Refused rather than
    // nudged to a minimum, because a shape the agent did not ask for is worse
    // than an error it can correct.
    if (kind !== 'line' && kind !== 'arrow' && (nx === nx2 || ny === ny2)) {
      return fail(
        `a ${kind} needs two DIFFERENT corners — got (${nx}, ${ny}) to (${nx2}, ${ny2}), which has no area`
      )
    }
    mutating('draw', `Drew ${kind} on ${pageId}`)
    focus(pageId)
    const res = addShape(session, {
      page: pageId,
      kind,
      nx,
      ny,
      nx2,
      ny2,
      color: color ?? 'red',
      width: width ?? SHAPE_WIDTH_DEFAULT,
      ...(body ? { text: body } : {}),
      ...(note ? { note } : {})
    })
    session = res.session
    return text(
      `Drew ${kind} on ${pageId} from (${nx}, ${ny}) to (${nx2}, ${ny2}). ` +
        `${session.shapes?.length} shape(s) total.`
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
    focus(pageId)
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
    if (existsSync(out)) {
      return fail(`Refusing to overwrite an existing export: ${out}. Choose a new path instead.`)
    }
    const spec = toExportSpec(session, out, {
      pageCounts: pageCounts ?? false,
      flatten: flatten ?? false
    })
    let res
    try {
      res = await withBinderLock(out, () => {
        // Recheck after acquiring the lease. This closes the race between the
        // first existence check and a separate process creating the file.
        if (existsSync(out)) {
          throw new Error(
            `Refusing to overwrite an existing export: ${out}. Choose a new path instead.`
          )
        }
        return runEngine({ cmd: 'export', binder: spec })
      })
    } catch (e) {
      return fail(String((e as Error).message))
    }
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
      `${work.shapes} shape(s), ${work.links} link(s), ${work.bookmarks} bookmark(s)`
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
  'binder_add_note',
  {
    title: 'Leave a review note on a page',
    description:
      "Attach a comment to a spot on a page — a question, something that does not tie, a follow-up. Exports as a PDF Text annotation, which is what Acrobat collects into its Comments pane, so a reviewer finds it where they already look and it survives to anyone who opens the binder. Use this rather than a tick with a note attached: a tick means AGREED, and putting one on something you are questioning tells a reviewer the opposite of what you mean.",
    inputSchema: {
      pageId: z.string(),
      note: z.string().min(1).describe('What you want the reviewer to read'),
      nx: z.number().min(0).max(1).describe('0 = left edge, 1 = right'),
      ny: z.number().min(0).max(1).describe('0 = top of page, 1 = bottom'),
      flag: z
        .boolean()
        .optional()
        .describe('Also mark the page as an open item, so it shows in binder_review_queue')
    }
  },
  async ({ pageId, note, nx, ny, flag }) => {
    if (!session.pages.some((p) => p.id === pageId)) return fail(`unknown page id: ${pageId}`)
    // min(1) lets "  " through, and a whitespace-only comment is an annotation
    // that wastes a reviewer's attention and says nothing.
    if (!note.trim()) {
      return fail('a note needs actual text — an empty comment tells a reviewer nothing')
    }
    mutating('add_note', `Noted on ${pageId}: ${note.trim().slice(0, 80)}`)
    focus(pageId)
    const res = addMark(session, { page: pageId, kind: 'note', nx, ny, size: 20, note: note.trim() })
    session = res.session
    if (flag) {
      session = setPageStatus(session, [pageId], 'open', session.reviewer ?? '')
    }
    return text(
      `Note left on ${pageId}${flag ? ' and flagged as an open item' : ''}.\n` +
        `${session.marks?.length} annotation(s) total.`
    )
  }
)

registerTool(
  'binder_set_status',
  {
    title: 'Set a page status',
    description:
      'Mark a page reviewed, an open item, or not applicable — the same statuses the app shows in the thumbnail rail and bookmark tree, so a flag an agent sets is visible to a person scrolling the binder. Pass null to clear.',
    inputSchema: {
      pageId: z.string(),
      status: z
        .string()
        .nullable()
        .describe('A status id from binder_review_queue (reviewed, open, na), or null to clear')
    }
  },
  async ({ pageId, status }) => {
    if (!session.pages.some((p) => p.id === pageId)) return fail(`unknown page id: ${pageId}`)
    const defs = statusDefs(session)
    if (status !== null && !defs.some((d) => d.id === status)) {
      return fail(`unknown status "${status}" — this binder has: ${defs.map((d) => d.id).join(', ')}`)
    }
    const label = status ? defs.find((d) => d.id === status)!.label : 'cleared'
    mutating('set_status', `Set ${pageId} to ${label}`, true)
    focus(pageId)
    session = status
      ? setPageStatus(session, [pageId], status, session.reviewer ?? '')
      : clearPageStatus(session, [pageId])
    return text(`${pageId}: ${label}.`)
  }
)

/**
 * The binder's own account of itself, in markdown.
 *
 * Every fact here is READ FROM THE BINDER, never supplied by the agent: what
 * was ingested, how it is organized, what was marked, what is outstanding, and
 * which runs did it. A reviewer who did not do the work should not have to take
 * the worker's word for what the work was — same reason a tape shows its
 * addends rather than just its total.
 */
function summaryMarkdown(narrative?: string, coverPages = 0): string {
  // Inserting the cover at the front shifts every page number in it. Numbers a
  // reviewer cannot trust are worse than no numbers, so they are computed
  // against the binder AS DELIVERED, cover included.
  const pageOf = new Map(session.pages.map((p, i) => [p.id, i + 1 + coverPages]))
  const marks = session.marks ?? []
  const tapes = session.tapes ?? []
  const byKind = (k: string): number => marks.filter((m) => m.kind === k).length
  const agentMade = marks.filter((m) => m.by === 'agent').length + tapes.filter((t) => t.by === 'agent').length

  const sources = session.sources.map((src) => {
    const pages = session.pages.filter((p) => p.source === src.id).length
    return `| ${src.name} | ${src.kind} | ${pages} |`
  })

  const outstanding: string[] = []
  session.pages.forEach((p, i) => {
    const st = statusOf(session, p.id)
    const notes = marks.filter((m) => m.page === p.id && m.kind === 'note')
    const crosses = marks.filter((m) => m.page === p.id && m.kind === 'cross')
    if (st?.id === 'reviewed' && !notes.length && !crosses.length) return
    if (!st && !notes.length && !crosses.length) return
    outstanding.push(
      `- **p.${i + 1 + coverPages}**${st ? ` — ${st.label}` : ''}` +
        (crosses.length ? ` · ${crosses.length} cross(es)` : '') +
        notes.map((n) => `\n  - ${n.note ?? ''}`).join('')
    )
  })

  const journal = session.journal ?? []
  const runs = [...new Set(journal.map((e) => e.run).filter(Boolean))] as string[]
  const runLines = runs.map((run) => {
    const entries = journal.filter((e) => e.run === run)
    const first = entries[0]?.at?.slice(0, 16).replace('T', ' ') ?? ''
    const last = entries[entries.length - 1]?.at?.slice(11, 16) ?? ''
    return (
      `**Run ${runs.indexOf(run) + 1}** — ${first}${last ? `–${last}` : ''}, ${entries.length} action(s)\n` +
      entries.map((e) => `- ${e.what}${e.structural ? ' *(not undoable)*' : ''}`).join('\n')
    )
  })

  const tapeLines = tapes.map(
    (t) =>
      `| p.${pageOf.get(t.page) ?? '?'} | ${t.title ?? '—'} | ${t.entries.length} | ${formatAmount(tapeTotal(t.entries))} |`
  )

  return [
    `# Binder summary`,
    ``,
    narrative?.trim() ? `${narrative.trim()}\n` : '',
    `## What is in this binder`,
    ``,
    `${session.pages.length} pages of support from ${session.sources.length} source(s)` +
      `${coverPages ? `, plus this ${coverPages}-page summary` : ''}.`,
    ``,
    `| Source | Kind | Pages |`,
    `| --- | --- | --- |`,
    ...sources,
    ``,
    `## Where each document ended up`,
    ``,
    `| Source | Pages in binder | At | Marked |`,
    `| --- | --- | --- | --- |`,
    ...session.sources.map((src) => {
      const pages = session.pages.filter((p) => p.source === src.id)
      const nums = pages.map((p) => (session.pages.findIndex((x) => x.id === p.id) + 1 + coverPages))
      const ids = new Set(pages.map((p) => p.id))
      const on = marks.filter((m) => ids.has(m.page))
      const dropped = src.nPages - pages.length
      const marked = [
        on.filter((m) => m.kind === 'tick').length ? `${on.filter((m) => m.kind === 'tick').length} tick` : '',
        on.filter((m) => m.kind === 'note').length ? `${on.filter((m) => m.kind === 'note').length} note` : '',
        tapes.filter((t) => ids.has(t.page)).length ? `${tapes.filter((t) => ids.has(t.page)).length} tape` : ''
      ].filter(Boolean).join(', ')
      return `| ${src.name} | ${pages.length} of ${src.nPages}${dropped > 0 ? ` (${dropped} left out)` : ''} | ${pageRanges(nums)} | ${marked || '—'} |`
    }),
    ``,
    `## How it is organized`,
    ``,
    ...flatBookmarks(buildBookmarks(session, { pageCounts: true })).map(
      (line) => `- ${line.replace(/\s+\[key .*$/, '')}`
    ),
    ``,
    `## What was marked`,
    ``,
    `- ${byKind('tick')} tick(s) — agreed`,
    `- ${byKind('cross')} cross(es) — does not agree`,
    `- ${byKind('text')} lettered stamp(s)`,
    `- ${byKind('note')} review note(s)`,
    `- ${tapes.length} calculator tape(s)`,
    ``,
    `**${agentMade} of these were placed by an agent.** Every one is attributed in`,
    `the exported PDF and can be removed with binder_revert_run.`,
    ``,
    ...(tapeLines.length
      ? [`| Page | Tape | Lines | Total |`, `| --- | --- | --- | --- |`, ...tapeLines, ``]
      : []),
    `## Still needs you`,
    ``,
    ...(outstanding.length ? outstanding : ['- Nothing outstanding.']),
    ``,
    `## What the agent did`,
    ``,
    ...(runLines.length ? runLines : ['No agent actions recorded.']),
    ``,
    `---`,
    ``,
    `Every figure above is read from the binder itself, not written by the agent.`
  ]
    // NOT filtered for empties: those blank lines are what separate markdown
    // blocks. Dropping them merged the tape table into the preceding bullet.
    // Runs of three or more collapse instead.
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
}

/** Contiguous binder-page runs, as "p.4-6" — how a person refers to a section. */
function pageRanges(numbers: number[]): string {
  if (!numbers.length) return '—'
  const sorted = [...numbers].sort((x, y) => x - y)
  const runs: Array<[number, number]> = [[sorted[0], sorted[0]]]
  for (const n of sorted.slice(1)) {
    const last = runs[runs.length - 1]
    if (n === last[1] + 1) last[1] = n
    else runs.push([n, n])
  }
  return runs.map(([a, b]) => (a === b ? `p.${a}` : `p.${a}-${b}`)).join(', ')
}

/** Human order: "9" before "10", and "1 - Income" before "2 - Deductions". */
const NATURAL = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

interface Found {
  path: string
  rel: string
  folder: string
}

/**
 * Everything in a folder this binder can hold, in the order a person would
 * file it.
 *
 * Skipping is reported with a reason, never silently: "I skipped 3 files" tells
 * a reviewer nothing, and a document missing from a binder because a tool
 * quietly ignored it is exactly the failure the inventory exists to catch.
 */
function scanFolder(root: string, maxDepth = 4, cap = 200): { found: Found[]; skipped: string[] } {
  const found: Found[] = []
  const skipped: string[] = []

  const walk = (dir: string, depth: number): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (e) {
      skipped.push(`${path.relative(root, dir) || '.'} — unreadable (${(e as Error).message})`)
      return
    }
    const sorted = [...entries].sort((x, y) => NATURAL.compare(x.name, y.name))
    for (const entry of sorted) {
      const full = path.join(dir, entry.name)
      const rel = path.relative(root, full)
      // Dotfiles are OS noise and stay silent. An Office lock file is NOT
      // noise: it means that workbook is open right now, so the copy on disk
      // may be missing unsaved changes — worth telling a preparer before they
      // build a binder out of it.
      if (entry.name.startsWith('.')) continue
      if (entry.name.startsWith('~$')) {
        skipped.push(
          `${rel} — lock file; "${entry.name.slice(2)}" is open in Excel and may have unsaved changes`
        )
        continue
      }
      if (entry.isDirectory()) {
        if (depth >= maxDepth) {
          skipped.push(`${rel}/ — deeper than ${maxDepth} folders`)
          continue
        }
        walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      if (!SOURCE_EXTS.some((e) => entry.name.toLowerCase().endsWith(e))) {
        skipped.push(`${rel} — not a PDF, spreadsheet, memo or image`)
        continue
      }
      try {
        if (statSync(full).size === 0) {
          skipped.push(`${rel} — empty file`)
          continue
        }
      } catch {
        skipped.push(`${rel} — unreadable`)
        continue
      }
      if (found.length >= cap) {
        skipped.push(`${rel} — over the ${cap}-file limit for one folder`)
        continue
      }
      found.push({ path: full, rel, folder: path.dirname(rel) === '.' ? '' : path.dirname(rel) })
    }
  }

  walk(root, 0)
  return { found, skipped }
}

/** Read a list of figures, refusing the whole set if any one is not money. */
function readAmounts(raw: string[]): { cents: number[]; notes: string[] } | string {
  const cents: number[] = []
  const notes: string[] = []
  for (const value of raw) {
    const read = parseMoney(value)
    if (!read) {
      return `"${value}" is not a figure I can read. Give me the amount as it appears on the page.`
    }
    cents.push(read.cents)
    if (read.as) notes.push(`${value}: ${read.as}`)
  }
  return { cents, notes }
}

registerTool(
  'binder_tie',
  {
    title: 'Tie one figure to another',
    description:
      "Check that a figure on one page equals a figure on another, and record the result IN THE BINDER: ticks and a cross-reference on both when they agree, notes carrying the difference and an open-item flag on both when they do not. The comparison is exact integer cents — never do this arithmetic yourself. Give the amounts exactly as they appear on the page; (350.67) is read as a negative.",
    inputSchema: {
      label: z.string().describe('What is being tied, e.g. "Wages — 1040 line 1 to W-2 box 1"'),
      a: z.object({
        pageId: z.string(),
        amount: z.string().describe('As it appears on the page'),
        nx: z.number().min(0).max(1),
        ny: z.number().min(0).max(1),
        what: z.string().optional().describe('What this figure is, for the cross-reference')
      }),
      b: z.object({
        pageId: z.string(),
        amount: z.string(),
        nx: z.number().min(0).max(1),
        ny: z.number().min(0).max(1),
        what: z.string().optional()
      }),
      toleranceCents: z
        .number()
        .min(0)
        .optional()
        .describe('Difference to accept, in cents. Default 0 — exact. Materiality is your call, not mine.')
    }
  },
  async ({ label, a, b, toleranceCents }) => {
    for (const side of [a, b]) {
      if (!session.pages.some((p) => p.id === side.pageId)) {
        return fail(`unknown page id: ${side.pageId}`)
      }
    }
    const read = readAmounts([a.amount, b.amount])
    if (typeof read === 'string') return fail(read)
    const [ca, cb] = read.cents
    const diff = ca - cb
    const agrees = Math.abs(diff) <= (toleranceCents ?? 0)

    const pageNo = (id: string): number => session.pages.findIndex((p) => p.id === id) + 1
    // The reference names WHAT it ties to, not WHERE. The page number is not
    // written here at all: `refTarget` carries the target's page id and the
    // number is rendered at export against the order the binder actually
    // ships in. This used to interpolate pageNo() straight into the string,
    // which was correct the moment it was written and wrong after the next
    // reorder — pointing a reviewer confidently at the wrong page, on a
    // document they sign.
    const refA = `${label} — ties${b.what ? ` to ${b.what}` : ''}`
    const refB = `${label} — ties${a.what ? ` to ${a.what}` : ''}`

    focus(a.pageId)
    mutating(
      'tie',
      `${agrees ? 'Tied' : 'DID NOT tie'} ${label}: ${formatCents(ca)} vs ${formatCents(cb)}` +
        (agrees ? '' : ` (difference ${formatCents(diff)})`)
    )

    // A clickable link each way, alongside the printed reference. The rect is
    // the tick's own footprint in visual coords, so the thing a reader clicks
    // is the mark they are already looking at.
    const linkRect = (nx: number, ny: number): [number, number, number, number] => [
      Math.max(0, nx - 0.02),
      Math.max(0, ny - 0.015),
      Math.min(1, nx + 0.02),
      Math.min(1, ny + 0.015)
    ]
    const crossLink = (): void => {
      session = addLink(session, {
        page: a.pageId, target: b.pageId, rect: linkRect(a.nx, a.ny), label
      }).session
      session = addLink(session, {
        page: b.pageId, target: a.pageId, rect: linkRect(b.nx, b.ny), label
      }).session
    }

    if (agrees) {
      session = addMark(session, {
        page: a.pageId, kind: 'tick', nx: a.nx, ny: a.ny, size: 20, note: refA, refTarget: b.pageId
      }).session
      session = addMark(session, {
        page: b.pageId, kind: 'tick', nx: b.nx, ny: b.ny, size: 20, note: refB, refTarget: a.pageId
      }).session
      crossLink()
    } else {
      // Same rule for the failure note: state the amounts, which do not move,
      // and let the page reference resolve at export. Each side points at the
      // other rather than both notes naming both positions.
      const detailFor = (mine: number, theirs: number): string =>
        `${label} — DOES NOT TIE. This page shows ${formatCents(mine)}, ` +
        `the other shows ${formatCents(theirs)}. Difference ${formatCents(diff)}.`
      session = addMark(session, {
        page: a.pageId, kind: 'note', nx: a.nx, ny: a.ny, size: 20,
        note: detailFor(ca, cb), refTarget: b.pageId
      }).session
      session = addMark(session, {
        page: b.pageId, kind: 'note', nx: b.nx, ny: b.ny, size: 20,
        note: detailFor(cb, ca), refTarget: a.pageId
      }).session
      crossLink()
      session = setPageStatus(session, [a.pageId, b.pageId], 'open', session.reviewer ?? '')
    }

    return text(
      `${agrees ? 'TIES' : 'DOES NOT TIE'} — ${label}\n` +
        `  p.${pageNo(a.pageId)}: ${formatCents(ca)}\n` +
        `  p.${pageNo(b.pageId)}: ${formatCents(cb)}\n` +
        (agrees
          ? `  Ticked both, cross-referenced and linked both ways.`
          : `  Difference ${formatCents(diff)}. Noted on both pages and flagged as open items.`) +
        (read.notes.length ? `\n  ${read.notes.join('; ')}` : '')
    )
  }
)

registerTool(
  'binder_foot',
  {
    title: 'Foot a column and check its total',
    description:
      "Add a column of figures and check it against the stated total. The tape it leaves on the page IS the evidence — it shows every addend, so a reviewer can see what was added rather than take your word for the sum. Arithmetic is exact integer cents; never do it yourself. Ticks the total when it foots, notes and flags the page when it does not.",
    inputSchema: {
      pageId: z.string(),
      label: z.string().describe('What is being footed, e.g. "Total expenses"'),
      amounts: z.array(z.string()).min(2).describe('The column, as the figures appear'),
      expectedTotal: z.string().describe('The stated total on the page'),
      nx: z.number().min(0).max(1).describe('Where to leave the tape'),
      ny: z.number().min(0).max(1),
      toleranceCents: z.number().min(0).optional()
    }
  },
  async ({ pageId, label, amounts, expectedTotal, nx, ny, toleranceCents }) => {
    if (!session.pages.some((p) => p.id === pageId)) return fail(`unknown page id: ${pageId}`)
    const read = readAmounts([...amounts, expectedTotal])
    if (typeof read === 'string') return fail(read)
    const stated = read.cents[read.cents.length - 1]
    const parts = read.cents.slice(0, -1)
    const sum = parts.reduce((t, c) => t + c, 0)
    const diff = sum - stated
    const foots = Math.abs(diff) <= (toleranceCents ?? 0)

    focus(pageId)
    mutating(
      'foot',
      `${foots ? 'Footed' : 'DID NOT foot'} ${label}: ${parts.length} line(s) = ${formatCents(sum)}` +
        (foots ? '' : ` against ${formatCents(stated)} stated (difference ${formatCents(diff)})`)
    )

    // The tape is the evidence: it shows the addends, so the conclusion is
    // checkable rather than asserted.
    session = addTape(session, {
      page: pageId,
      nx,
      ny,
      entries: parts.map((c) => toTapeEntry(c / 100)),
      title: label.slice(0, 28)
    }).session

    if (foots) {
      session = addMark(session, {
        page: pageId, kind: 'text', nx, ny: Math.max(0, ny - 0.04), size: 20, text: 'F',
        note: `${label} — footed to ${formatCents(sum)}`
      }).session
    } else {
      session = addMark(session, {
        page: pageId, kind: 'note', nx, ny: Math.max(0, ny - 0.04), size: 20,
        note:
          `${label} — DOES NOT FOOT. The ${parts.length} lines add to ${formatCents(sum)}, ` +
          `the page states ${formatCents(stated)}. Difference ${formatCents(diff)}.`
      }).session
      session = setPageStatus(session, [pageId], 'open', session.reviewer ?? '')
    }

    return text(
      `${foots ? 'FOOTS' : 'DOES NOT FOOT'} — ${label}\n` +
        `  ${parts.length} line(s) add to ${formatCents(sum)}\n` +
        `  the page states ${formatCents(stated)}\n` +
        (foots
          ? `  Tape left on the page as the working, stamped F.`
          : `  Difference ${formatCents(diff)}. Tape left showing the addends; noted and flagged.`) +
        (read.notes.length ? `\n  ${read.notes.join('; ')}` : '')
    )
  }
)

registerTool(
  'binder_add_folder',
  {
    title: 'Build a binder from a folder',
    description:
      "Import everything in a folder that a binder can hold — PDFs, spreadsheets, memos, scans — in the order a person would file them: subfolders in turn, and \"9\" before \"10\" rather than after. Reports what it took AND what it skipped with the reason for each, because a document missing because a tool quietly ignored it is the worst outcome. Subfolders are reported so you can bookmark by section afterwards.",
    inputSchema: {
      path: z.string().describe('The engagement folder'),
      recurse: z.boolean().optional().describe('Include subfolders (default true)'),
      dryRun: z
        .boolean()
        .optional()
        .describe('List what would be imported without changing the binder')
    }
  },
  async ({ path: folder, recurse, dryRun }) => {
    try {
      const root = resolveAllowedPath(folder, { mustExist: true, purpose: 'reading a folder' })
      if (!statSync(root).isDirectory()) return fail(`not a folder: ${root}`)
      const { found, skipped } = scanFolder(root, recurse === false ? 0 : 4)
      if (!found.length) {
        return text(
          `Nothing in ${baseName(root)} that a binder can hold.` +
            (skipped.length ? `\n\nSkipped:\n${skipped.map((x) => `  ${x}`).join('\n')}` : '')
        )
      }

      const plan = found.map((f) => `  ${f.rel}`).join('\n')
      if (dryRun) {
        return text(
          `${found.length} file(s) would be imported from ${baseName(root)}, in this order:\n${plan}` +
            (skipped.length ? `\n\nSkipped:\n${skipped.map((x) => `  ${x}`).join('\n')}` : '')
        )
      }

      mutating('add_folder', `Imported ${found.length} file(s) from ${baseName(root)}`, true)
      const failed: string[] = []
      let added = 0
      for (const f of found) {
        const probe = await runEngine({ cmd: 'probe', path: f.path })
        if (!probe.ok) {
          failed.push(`${f.rel} — ${String(probe.error).slice(0, 120)}`)
          continue
        }
        session = addSource(session, probe.probe as ProbeWire)
        added += 1
      }

      const folders = [...new Set(found.map((f) => f.folder).filter(Boolean))]
      return text(
        `Imported ${added} of ${found.length} file(s) from ${baseName(root)}.\n\n` +
          `${summary(session)}\n` +
          (folders.length
            ? `\nSubfolders, in order — bookmark by section if you want that structure:\n` +
              folders.map((d) => `  ${d}/`).join('\n') +
              '\n'
            : '') +
          (failed.length ? `\nCould not read:\n${failed.map((x) => `  ${x}`).join('\n')}\n` : '') +
          (skipped.length ? `\nSkipped:\n${skipped.map((x) => `  ${x}`).join('\n')}\n` : '') +
          `\nbinder_inventory will show where each one ended up.`
      )
    } catch (e) {
      return fail(String((e as Error).message))
    }
  }
)

registerTool(
  'binder_inventory',
  {
    title: 'What happened to every document',
    description:
      "One row per source file: what it was, how many of its pages made it in, where they sit in the binder RIGHT NOW, and what is marked on them. Answers 'I pointed you at a folder — what did you do with it all?'. Computed from the binder every time it is called, so it is never out of date: pages are tracked by permanent id, not page number, and a run that reads p.4-6 today will read p.9-11 after you reorder.",
    inputSchema: {}
  },
  async () => {
    if (!session.sources.length) return text('This binder is empty.')
    const numberOf = new Map(session.pages.map((p, i) => [p.id, i + 1]))
    const marks = session.marks ?? []
    const tapes = session.tapes ?? []

    const rows = session.sources.map((src) => {
      const pages = session.pages.filter((p) => p.source === src.id)
      const numbers = pages.map((p) => numberOf.get(p.id) ?? 0)
      const ids = new Set(pages.map((p) => p.id))
      const on = marks.filter((m) => ids.has(m.page))
      const count = (k: string): number => on.filter((m) => m.kind === k).length
      const flagged = pages.filter((p) => statusOf(session, p.id)?.id === 'open').length
      const notes = count('note')
      const bits = [
        count('tick') ? `${count('tick')} tick` : '',
        count('cross') ? `${count('cross')} cross` : '',
        notes ? `${notes} note` : '',
        tapes.filter((t) => ids.has(t.page)).length
          ? `${tapes.filter((t) => ids.has(t.page)).length} tape`
          : '',
        flagged ? `${flagged} flagged` : ''
      ].filter(Boolean)
      // A source whose pages were partly deleted is the thing a reviewer most
      // needs to notice: "you pointed me at this and I left some of it out."
      const dropped = src.nPages - pages.length
      return (
        `${src.name}\n` +
        `    ${src.kind} · ${pages.length} of ${src.nPages} page(s) in the binder` +
        `${dropped > 0 ? `  ⚠ ${dropped} NOT included` : ''}\n` +
        `    at ${pageRanges(numbers)}${bits.length ? `  ·  ${bits.join(', ')}` : ''}`
      )
    })

    const orphaned = session.pages.filter((p) => !session.sources.some((x) => x.id === p.source))
    return text(
      `${session.sources.length} source(s) → ${session.pages.length} page(s)\n\n` +
        rows.join('\n\n') +
        (orphaned.length ? `\n\n⚠ ${orphaned.length} page(s) reference a missing source.` : '') +
        `\n\nPositions are read from the binder now — reorder the pages and they move with them.`
    )
  }
)

registerTool(
  'binder_summary',
  {
    title: "The binder's account of itself",
    description:
      "A brief for whoever reviews this binder without having done the work: what was ingested, how it is organized, what was marked and by whom, what is still outstanding, and every agent action in order. All of it is READ FROM THE BINDER — pass a narrative to explain your reasoning on top, but the facts are not yours to state. Use binder_add_cover to put it in the binder as page 1.",
    inputSchema: {
      narrative: z
        .string()
        .optional()
        .describe('Your account of what you did and why — the context a reviewer does not have')
    }
  },
  async ({ narrative }) => text(summaryMarkdown(narrative))
)

registerTool(
  'binder_add_cover',
  {
    title: 'Put the summary in the binder as page 1',
    description:
      "Write the binder's summary to a real markdown file and insert it as the first page, typeset. A reviewer who did not do the work then meets the context before the evidence, in the binder itself rather than in a chat window they will not have later. Re-running replaces the previous cover rather than stacking another one.",
    inputSchema: {
      path: z
        .string()
        .describe('Where to write the memo (.md). It becomes a real source file the binder points at.'),
      narrative: z
        .string()
        .optional()
        .describe('Your account of what you did and why — the facts are generated, this is the reasoning')
    }
  },
  async ({ path: out, narrative }) => {
    let coverLease: BinderLease | null = null
    try {
      const target = resolveAllowedPath(out, { mustExist: false, purpose: 'writing the cover memo' })
      coverLease = await acquireBinderLock(target)
      // Refreshing after a reorder should not need the reasoning retyped.
      const story = narrative ?? (session.cover?.path === target ? session.cover.narrative : undefined)
      if (!/\.(md|markdown)$/i.test(target)) return fail('the cover must be a .md file')
      if (!session.pages.length) return fail('nothing to summarize — this binder is empty')
      if (existsSync(target) && session.cover?.path !== target) {
        return fail(
          `Refusing to overwrite an existing memo: ${target}. Choose a new path instead.`
        )
      }

      // Replace rather than stack: a binder with three covers has none.
      const existing = session.sources.find((x) => path.resolve(x.path) === target)
      if (existing) {
        const ids = session.pages.filter((p) => p.source === existing.id).map((p) => p.id)
        if (ids.length) {
          mutating('replace_cover', `Replaced the cover memo (${ids.length} page(s))`, true)
          session = deletePages(session, ids)
        }
      }

      // Two passes: the first learns how long the cover is, the second numbers
      // the pages knowing that. A third would only matter if adding the offset
      // changed the page count again, which the loop catches.
      let probe = await runEngine({ cmd: 'probe', path: target })
      let coverPages = 0
      for (let pass = 0; pass < 3; pass++) {
        await writeFile(target, `${summaryMarkdown(story, coverPages)}\n`, 'utf8')
        probe = await runEngine({ cmd: 'probe', path: target })
        if (!probe.ok) return fail(`could not typeset the cover: ${String(probe.error)}`)
        const made = (probe.probe as ProbeWire).n_pages
        if (made === coverPages) break
        coverPages = made
      }

      mutating('add_cover', `Added a cover memo summarizing the binder`, true)
      session = addSource(session, probe.probe as ProbeWire)
      const added = session.pages.filter((p) => {
        const src = session.sources.find((x) => x.id === p.source)
        return src ? path.resolve(src.path) === target : false
      })
      session = movePages(
        session,
        added.map((p) => p.id),
        0
      )
      // The agent just replaced page 1; following it there is the point of a
      // cover — the binder introducing itself is the thing worth watching.
      focus(added[0]?.id)
      session = {
        ...session,
        cover: {
          path: target,
          ...(story?.trim() ? { narrative: story.trim() } : {}),
          pages: session.pages.map((p) => p.id).join(',')
        }
      }
      return text(
        `Cover memo written to ${baseName(target)} and placed as page 1 ` +
          `(${added.length} page(s)).\n\n${summary(session)}`
      )
    } catch (e) {
      return fail(String((e as Error).message))
    } finally {
      await coverLease?.release().catch(() => {})
    }
  }
)

registerTool(
  'binder_current_page',
  {
    title: 'What the person is looking at',
    description:
      'The page open in the binder window right now, with everything on it — marks, notes, its status and bookmark. Use this to answer "why did you flag this one?" without making the reviewer read a page id off the screen. Only meaningful with live agent access on; standalone there is no window to look at.',
    inputSchema: {}
  },
  async () => {
    if (!owner) {
      return text(
        'Standalone — there is no open window. Turn on live agent access in the app to see what the reviewer is looking at.'
      )
    }
    if (!currentPage) return text('The binder window has no page open.')
    const at = session.pages.findIndex((p) => p.id === currentPage)
    if (at < 0) return text(`The window is showing ${currentPage}, which is no longer in the binder.`)
    const page = session.pages[at]
    const src = session.sources.find((x) => x.id === page.source)
    const st = statusOf(session, page.id)
    const marks = (session.marks ?? []).filter((m) => m.page === page.id)
    const tapes = (session.tapes ?? []).filter((t) => t.page === page.id)
    const bookmark = flatBookmarks(buildBookmarks(session)).find((line) => line.includes(page.id))
    const lines = [
      `Binder page ${at + 1} of ${session.pages.length} — ${page.id}`,
      `source: ${src?.name ?? page.source} p.${page.index + 1}${page.rotate ? ` · rotated ${page.rotate}°` : ''}`,
      st ? `status: ${st.label}` : '',
      bookmark ? `bookmark: ${bookmark.trim()}` : '',
      marks.length
        ? `marks:\n${marks
            .map(
              (m) =>
                `  ${m.kind}${m.text ? ` "${m.text}"` : ''} at (${m.nx}, ${m.ny})` +
                `${m.by === 'agent' ? '  (AI)' : ''}${m.note ? `\n    ${m.note}` : ''}`
            )
            .join('\n')}`
        : 'marks: none',
      tapes.length ? `tapes: ${tapes.length}` : ''
    ].filter(Boolean)
    return text(lines.join('\n'))
  }
)

registerTool(
  'binder_review_queue',
  {
    title: 'What still needs a human',
    description:
      "Everything in this binder waiting on a person, in binder order: pages flagged as open items, pages carrying notes, and crosses. Use it to hand work back — an agent's findings are only useful if a reviewer can walk them.",
    inputSchema: {}
  },
  async () => {
    const defs = statusDefs(session)
    const rows: string[] = []
    session.pages.forEach((p, i) => {
      const st = statusOf(session, p.id)
      const notes = (session.marks ?? []).filter((m) => m.page === p.id && m.kind === 'note')
      const crosses = (session.marks ?? []).filter((m) => m.page === p.id && m.kind === 'cross')
      if (!st && !notes.length && !crosses.length) return
      // "Reviewed" is not waiting on anyone; it is shown only when the page
      // also carries something unresolved.
      if (st?.id === 'reviewed' && !notes.length && !crosses.length) return
      const bits = [
        `p.${i + 1}  ${p.id}`,
        st ? `[${st.label}]` : '',
        crosses.length ? `${crosses.length} cross(es)` : '',
        ...notes.map((n) => `\n      note: ${n.note ?? ''}${n.by === 'agent' ? '  (AI)' : ''}`)
      ].filter(Boolean)
      rows.push(bits.join('  '))
    })
    const legend = `statuses in this binder: ${defs.map((d) => `${d.id} (${d.label})`).join(', ')}`
    return text(
      rows.length
        ? `${rows.length} page(s) need attention:\n\n${rows.join('\n')}\n\n${legend}`
        : `Nothing flagged. ${legend}`
    )
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
  // Attach to a running LedgerPDF if one is offering live access, so an
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
  process.stderr.write(`ledgerpdf MCP server failed: ${String(e)}\n`)
  process.exit(1)
})
