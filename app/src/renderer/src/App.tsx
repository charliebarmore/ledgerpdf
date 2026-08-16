import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BookmarkPanel } from './components/BookmarkPanel'
import { ReviewCenter, type ReviewTab } from './components/ReviewCenter'
import { SendOutPreflight } from './components/SendOutPreflight'
import { MarkInspector } from './components/MarkInspector'
import { ShapeInspector } from './components/ShapeInspector'
import { Keypad } from './components/Keypad'
import { StatusMenu } from './components/StatusMenu'
import { ColorMenu } from './components/ColorMenu'
import { ExportMenu } from './components/ExportMenu'
import { LegendMenu } from './components/LegendMenu'
import { StampMenu } from './components/StampMenu'
import { ConnectorMenu } from './components/ConnectorMenu'
import { SaveMenu } from './components/SaveMenu'
import { AgentAccessPanel } from './components/AgentAccessPanel'
import { PageView } from './components/PageView'
import { ThumbnailRail } from './components/ThumbnailRail'
import { MARK_COLOR } from './components/MarkLayer'
import { forgetDoc } from './pdf'
import {
  MARK_SIZE_DEFAULT,
  addBookmark,
  addMark,
  endRun,
  beginRun,
  addSource,
  addShape,
  assignBookmarkPage,
  clearBookmarkPage,
  addStamp,
  addTape,
  agentCreatedItems,
  legendMarkdown,
  legendEntries,
  nextConnectorLabel,
  placeConnector,
  setLegend,
  baseName,
  formatAmount,
  tapeTotal,
  deletePages,
  movePages,
  newSession,
  nudgeBookmarkDepth,
  pageForSourceIndex,
  parseSession,
  parseAmount,
  rebindToBinder,
  tapeKeyPress,
  toTapeEntry,
  removeTapeEntry,
  updateTapeEntry,
  bookmarkSection,
  moveBookmarkSection,
  removeBookmark,
  removeMarks,
  clearPageStatus,
  isShapeKind,
  moveShape,
  removeShapes,
  removeStamp,
  record,
  removeTapes,
  revertRun,
  rotatePages,
  setBookmarkTitle,
  setPageStatus,
  statusCounts,
  statusDefs,
  statusOf,
  statusParts,
  numbering,
  toExportSpec,
  updateMark,
  updateShape,
  updateTape,
  isDragMeaningful,
  SHAPE_COLOR_NAMES,
  SHAPE_COLORS,
  SHAPE_WIDTH_DEFAULT,
  TAPE_SIZE_MAX,
  TAPE_SIZE_MIN,
  type Mark,
  type ProbeWire,
  type Shape,
  type ShapeColor,
  type StatusDef,
  type StatusParts,
  type TapeEntry,
  type TapeOp,
  type Session,
  type SourceDoc,
  type ToolKind
} from './session'
import { reviewSnapshot } from './review'
import {
  clampMarkSize,
  markSizePreferenceKey,
  preferredMarkSize,
  type MarkSizePreferences
} from './mark-preferences'

const MOD = window.wpt.platform === 'darwin' ? '⌘' : 'Ctrl'

/**
 * How a legend page is recognised on rebuild. Must match the name main writes
 * in `binder:writeLegendDoc` — the renderer never learns that folder's path, so
 * the file name is the only handle it has.
 */
const LEGEND_DOC_PREFIX = 'Tickmark Legend'

/**
 * Tokens the toolbar already carries as their own button. A preset for one of
 * these defines its meaning; it must not also be added to the stamp list.
 */
const FIXED_TOOL_TOKENS = new Set(['F'])

/** "2h ago", "yesterday" — how long since, not a timestamp to decode. */
function whenShort(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days}d ago`
  return new Date(then).toLocaleDateString()
}

function sourceMatches(source: SourceDoc, probe: ProbeWire): boolean {
  if (source.nPages !== probe.n_pages) return false
  const probed =
    probe.kind === 'image'
      ? 'image'
      : probe.kind === 'sheet'
        ? 'sheet'
        : probe.kind === 'document'
          ? 'document'
          : 'pdf'
  if (source.kind !== probed) return false
  if (!source.fingerprint) return true // Legacy session: establish identity on this open.
  return source.fingerprint.sha256 === probe.fingerprint?.sha256
}

export default function App(): React.JSX.Element {
  const [session, setSession] = useState<Session>(newSession)
  /** The binder PDF being edited. The document itself, not a companion file. */
  const [binderPath, setBinderPath] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [status, setStatus] = useState('Add PDFs or images to start a binder.')
  const [busy, setBusy] = useState(false)
  const [pageCounts, setPageCounts] = useState(true)
  const [sideW, setSideW] = useState(300)
  const [autoEditKey, setAutoEditKey] = useState<string | null>(null)
  const [armed, setArmed] = useState<{ kind: ToolKind; text?: string } | null>(null)
  /**
   * Keep the armed tool armed after each use, instead of disarming.
   *
   * The two tool families want OPPOSITE defaults, which is why this is two
   * pieces of state and not one:
   *
   * - Marks (tick, cross, lettered stamps) stay armed. Ticking down a column is
   *   the whole job; disarming after each one would be unusable.
   * - Shapes disarm after one. A drawn shape is usually adjusted next, and
   *   staying armed made every click meant to GRAB it draw another on top.
   *
   * One button showing only the shape half was the bug: turning "Keep tool" off
   * with the ✗ tool armed did nothing visible, because marks never consulted it.
   * The button now reads and writes whichever family is armed, so it always
   * describes the tool in your hand. The tape is exempt either way — it is a
   * mode you key into, not a stamp you repeat (see the note where it disarms).
   */
  const [keepMark, setKeepMark] = useState(true)
  const [keepDraw, setKeepDraw] = useState(false)
  /**
   * Which family the armed tool belongs to. The Keep tool button reads and
   * writes this one, so what it shows is always about the tool in your hand.
   * Null means nothing is armed, or the tape is — neither can be kept.
   */
  const lockFamily: 'mark' | 'draw' | null = !armed
    ? null
    : isShapeKind(armed.kind)
      ? 'draw'
      : armed.kind === 'tape'
        ? null
        : 'mark'
  const toolLock = lockFamily === 'draw' ? keepDraw : lockFamily === 'mark' ? keepMark : false
  const toggleToolLock = (): void => {
    if (lockFamily === 'draw') setKeepDraw((v) => !v)
    else if (lockFamily === 'mark') setKeepMark((v) => !v)
  }
  /**
   * The dev seam sets the lock BEFORE arming a tool, so it cannot go through
   * the armed family. It sets both, and asserts on both — driving the real
   * state rather than the value the button happens to be showing.
   */
  const setBothLocks = (v: boolean): void => {
    setKeepDraw(v)
    setKeepMark(v)
  }
  const [agentPanelOpen, setAgentPanelOpen] = useState(false)
  const [selectedMarkId, setSelectedMarkId] = useState<string | null>(null)
  const [activeTapeId, setActiveTapeId] = useState<string | null>(null)
  const [tapeBuffer, setTapeBuffer] = useState('')
  const [tapeOp, setTapeOp] = useState<TapeOp>('+')
  const [keypadOpen, setKeypadOpen] = useState(true)
  const [markSizes, setMarkSizes] = useState<MarkSizePreferences>({})
  const [shapeColor, setShapeColor] = useState<ShapeColor>('red')
  const [selectedShapeId, setSelectedShapeId] = useState<string | null>(null)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [reviewTab, setReviewTab] = useState<ReviewTab>('attention')
  const [sendPreflightOpen, setSendPreflightOpen] = useState(false)
  const [sendAnywayArmed, setSendAnywayArmed] = useState(false)
  const [liveOn, setLiveOn] = useState(false)
  /**
   * The initials question, open.
   *
   * `mark` is the mark that triggered it, held so it can land attributed the
   * moment the answer arrives — or null when the question was asked on its own,
   * by clicking the initials button in the palette before any mark exists.
   */
  const [initialsPrompt, setInitialsPrompt] = useState<{
    mark: { pageId: string; nx: number; ny: number } | null
  } | null>(null)
  const [initialsDraft, setInitialsDraft] = useState('')
  /**
   * The preparer's initials as stored for this MACHINE, not this binder.
   *
   * The session keeps its own copy so attribution travels inside the file, but
   * the person does not change between binders. Without this, every new binder
   * re-asked and the palette's initials button went back to a dead dash.
   */
  const [preparerInitials, setPreparerInitials] = useState('')
  const initialsInput = useRef<HTMLInputElement | null>(null)
  const [recents, setRecents] = useState<
    Array<{ path: string; name: string; at: string; pages?: number; present?: boolean }>
  >([])
  const shapeArmed = !!armed && isShapeKind(armed.kind)
  const activeTape = useMemo(
    () => (session.tapes ?? []).find((t) => t.id === activeTapeId) ?? null,
    [session.tapes, activeTapeId]
  )
  // The binder's own attribution wins; the machine's stored initials are the
  // default a fresh session starts from. Falling back here is what keeps the
  // palette's initials button live on a new binder instead of a dead dash.
  const reviewerInitials = (session.reviewer ?? '').trim() || preparerInitials
  const stamps = session.stamps ?? []
  const past = useRef<Session[]>([])
  const future = useRef<Session[]>([])
  const lastSaved = useRef(JSON.stringify(newSession()))
  const saving = useRef(false)

  const pages = session.pages
  /** Annotations an agent placed, so the status bar can say so on open. */
  const aiCount = agentCreatedItems(session)
  const review = useMemo(() => reviewSnapshot(session), [session])
  const serializedSession = useMemo(() => JSON.stringify(session), [session])
  /** Monotonic guard against a stale agent replacing newer user/agent work. */
  const liveRevision = useRef(0)
  /**
   * Identity of the binder in this window, separate from its path. Two fresh
   * binders can both be unsaved, and Save As changes a path without changing
   * the document. A live MCP process uses this boundary to start a new run
   * when the person actually replaces the binder.
   */
  const liveDocumentId = useRef(crypto.randomUUID())
  const liveRevisionSession = useRef(serializedSession)
  if (liveRevisionSession.current !== serializedSession) {
    liveRevisionSession.current = serializedSession
    liveRevision.current += 1
  }
  const dirty = serializedSession !== lastSaved.current
  const current = useMemo(
    () => pages.find((p) => p.id === currentId) ?? pages[0] ?? null,
    [pages, currentId]
  )

  /** The binder's own name, so sessions and exports sit together in a folder. */
  const binderStem = useMemo(
    () => (session.sources[0]?.name ?? 'binder').replace(/\.[^.]+$/, ''),
    [session.sources]
  )


  // The main process owns the native close prompt. Keep it informed without
  // exposing any session contents beyond the renderer/main boundary.
  useEffect(() => {
    window.wpt.setDirty(dirty)
  }, [dirty])

  /** Every mutation goes through here so undo/redo is never bypassed. */
  const apply = useCallback((next: Session, note?: string) => {
    setSession((prev) => {
      past.current = [...past.current.slice(-49), prev]
      future.current = []
      return next
    })
    if (note) setStatus(note)
  }, [])

  /**
   * Like `apply`, but the mutation runs against the session React holds at
   * commit time instead of this render's closure.
   *
   * Any path that AWAITS between reading `session` and applying is a lost-
   * update window: an agent push landing during the await was silently
   * replaced by a next-state computed from the pre-push world — the agent was
   * told ok, its marks and journal entries vanished, and only ⌘Z knew.
   * The agent side has a revision guard for the mirror-image race; this is
   * the same care in the other direction. Synchronous click handlers can keep
   * using `apply` — React flushes discrete events before a push can land.
   */
  const applyWith = useCallback((mutate: (prev: Session) => Session, note?: string) => {
    setSession((prev) => {
      const next = mutate(prev)
      if (next === prev) return prev
      past.current = [...past.current.slice(-49), prev]
      future.current = []
      return next
    })
    if (note) setStatus(note)
  }, [])

  const undo = useCallback(() => {
    const prev = past.current.pop()
    if (!prev) return setStatus('Nothing to undo.')
    setSession((cur) => {
      future.current = [...future.current, cur]
      return prev
    })
    setStatus('Undo.')
  }, [])

  const redo = useCallback(() => {
    const next = future.current.pop()
    if (!next) return setStatus('Nothing to redo.')
    setSession((cur) => {
      past.current = [...past.current, cur]
      return next
    })
    setStatus('Redo.')
  }, [])

  /**
   * Undo an agent run from the UI. Goes through `apply` like every other
   * mutation, so the revert itself is on the undo stack — a reviewer who
   * removes the AI's work and changes their mind is not stranded.
   */
  const revertAgentRun = useCallback(
    (run: string) => {
      const res = revertRun(session, run)
      const note =
        `Removed ${res.removed} annotation(s) the AI added.` +
        (res.structural.length
          ? ` ${res.structural.length} change(s) to page order or rotation could not be undone.`
          : '')
      apply(res.session, note)
    },
    [session, apply]
  )

  /**
   * Live agent access. An agent asks for the binder and hands changes back;
   * both go through the same state a person's clicks do.
   *
   * Read through a ref so this subscribes once — resubscribing on every session
   * change would drop requests already in flight.
   */
  const openRef = useRef<(target?: string) => Promise<void>>(async () => {})
  const liveRefs = useRef({
    session,
    binderPath,
    apply,
    currentId,
    revision: liveRevision.current,
    documentId: liveDocumentId.current
  })
  liveRefs.current = {
    session,
    binderPath,
    apply,
    currentId,
    revision: liveRevision.current,
    documentId: liveDocumentId.current
  }
  /**
   * When the person last touched the app, for follow-the-agent. A live agent's
   * change carries the page it acted on, and the view follows it there — that
   * is what "watch it work" means on a 53-page binder where the action is
   * otherwise off-screen. But the view is the REVIEWER's: any input (click,
   * scroll, keys) suppresses following long enough that the page can never be
   * yanked out from under someone mid-read. Idle again = watching again.
   */
  const FOLLOW_IDLE_MS = 8000
  const lastUserInput = useRef(0)
  /**
   * The page a follow JUMPED to, until the column gets there.
   *
   * `currentId` has two writers — navigation, and the scroll tracker reporting
   * what the reader is looking at — and they fought. Every fix in PageView so
   * far has been a different way of stopping the tracker from firing during a
   * programmatic scroll, and each one closed a real hole while leaving the
   * shape of the bug intact: a scroll event that slips through outranks the
   * navigation that caused it, and the view snaps back.
   *
   * So state the precedence instead of policing the timing. While a follow is
   * in flight, a scroll-derived page that DISAGREES with it is the tracker
   * reading a column mid-move, and is ignored. Two things clear the pin, and
   * both mean the disagreement is genuine: arriving, and the reader touching
   * the app — the same signal that suppresses following in the first place.
   */
  const navIntent = useRef<string | null>(null)
  useEffect(() => {
    const bump = (): void => {
      lastUserInput.current = Date.now()
    }
    for (const ev of ['pointerdown', 'keydown', 'wheel'] as const) {
      document.addEventListener(ev, bump, true)
    }
    return () => {
      for (const ev of ['pointerdown', 'keydown', 'wheel'] as const) {
        document.removeEventListener(ev, bump, true)
      }
    }
  }, [])
  useEffect(() => {
    // Refreshed whenever the binder is put down, so the list is current the
    // moment it is visible again.
    void window.wpt.recentBinders().then(setRecents)
    void window.wpt.preparerInitials().then(setPreparerInitials)
    void window.wpt.markSizes().then(setMarkSizes)
    // Opened from Finder while already running: pushed to this listener.
    window.wpt.onOpenPath((target) => void openRef.current(target))
    // Opened from Finder on a COLD start: the path was waiting before this
    // listener existed, so PULL it now rather than hoping a push arrived after
    // we subscribed. This is the fix for a double-click showing the file picker.
    void window.wpt.consumePendingOpen().then((target) => {
      if (target) void openRef.current(target)
    })
    const applyLiveState = (state: { on: boolean; socketPath?: string }): void => {
      setLiveOn(state.on)
      if (import.meta.env.DEV) console.info(`[live-indicator] ${state.on ? 'on' : 'off'}`)
    }
    // Subscribe first, then pull. The event covers future transitions and the
    // pull covers broadcasts sent before this renderer existed — especially a
    // new macOS window after ⌘W while the live socket stayed open.
    window.wpt.onLiveState(applyLiveState)
    void window.wpt.getLive().then(applyLiveState)
    window.wpt.onLiveRequest((req) => {
      if (req.kind === 'pull') {
        window.wpt.liveReply(req.id, {
          session: liveRefs.current.session,
          path: liveRefs.current.binderPath,
          documentId: liveRefs.current.documentId,
          // What the person is actually looking at, so "why did you flag this
          // one?" resolves without them reading a page id off the screen.
          currentPage: liveRefs.current.currentId,
          revision: liveRefs.current.revision
        })
        return
      }
      if (
        typeof req.expectedRevision !== 'number' ||
        req.expectedRevision !== liveRefs.current.revision
      ) {
        window.wpt.liveReply(req.id, {
          ok: false,
          error:
            typeof req.expectedRevision !== 'number'
              ? 'This agent connection is outdated. Restart the agent, then retry.'
              : 'The binder changed after the agent read it. Its stale change was refused; retry against the current binder.'
        })
        return
      }
      // `apply`, not setSession: an agent's change lands on the undo stack and
      // autosaves exactly like a click, so a person can take it back with the
      // undo they already know and never sees a change they cannot reverse.
      // endRun strips any run id the server let through: if activeRun survives
      // into this session, stamp() marks the person's own work as the
      // agent's, and reverting the run deletes it.
      const pushed = endRun(req.payload as Session)
      // Close the race before React renders the pushed state. A second agent
      // holding the same prior revision must fail even if its IPC event arrives
      // in this narrow gap.
      liveRevision.current += 1
      liveRefs.current.revision = liveRevision.current
      liveRefs.current.apply(pushed, 'The agent changed this binder.')
      // A pin outlives its page if the agent's NEXT change deletes it. Only
      // arrival or real input clears one, and arrival is impossible once the
      // page is gone — so a pin on a deleted page would mute the scroll
      // tracker for the rest of the session, with nothing on screen to explain
      // why the page number stopped moving.
      if (navIntent.current && !pushed.pages.some((p) => p.id === navIntent.current)) {
        navIntent.current = null
      }
      if (
        req.focus &&
        pushed.pages.some((p) => p.id === req.focus) &&
        Date.now() - lastUserInput.current > FOLLOW_IDLE_MS
      ) {
        if (import.meta.env.DEV) console.info(`[live-follow] following ${req.focus}`)
        navIntent.current = req.focus
        setCurrentId(req.focus)
      } else if (req.focus) {
        if (import.meta.env.DEV) {
          console.info(
            `[live-follow] suppressed ${req.focus}; present=${pushed.pages.some((p) => p.id === req.focus)} idleMs=${Date.now() - lastUserInput.current}`
          )
        }
      }
      window.wpt.liveReply(req.id, { ok: true })
    })
    // Register the request listener first. Main queues any request that arrived
    // during mount and sends it only after this signal.
    window.wpt.liveReady()
  }, [])

  /**
   * Follow a link the source PDF already carried.
   *
   * A link's destination is a page in its SOURCE document, which is not a binder
   * page — the binder reorders, drops and interleaves. So the destination is
   * resolved through the session: find the page carrying that source at that
   * index. Jumping to the raw index would land on whatever now sits there, which
   * is worse than not moving, because it looks like it worked.
   *
   * A target that is not in this binder (the page was deleted, or never
   * imported) says so instead of moving. Silence would read as a broken link.
   */
  const followLink = useCallback(
    (sourceId: string, toIndex: number) => {
      const target = pageForSourceIndex(session, sourceId, toIndex)
      if (!target) {
        const name = session.sources.find((s) => s.id === sourceId)?.name ?? 'that document'
        setStatus(
          `That link points at page ${toIndex + 1} of ${name}, which is not in this binder.`
        )
        return
      }
      setCurrentId(target.id)
      setSelectedMarkId(null)
      setSelectedShapeId(null)
      setStatus(`Followed a link to binder page ${session.pages.indexOf(target) + 1}.`)
    },
    [session]
  )

  /**
   * The scroll tracker's report, weighed against a follow still in flight.
   * See `navIntent`. Everything else that moves the view is a user action, so
   * `lastUserInput` was just bumped and the pin — if any — clears here at once.
   */
  const onScrolledToPage = useCallback((id: string) => {
    const pinned = navIntent.current
    if (pinned && id !== pinned && Date.now() - lastUserInput.current > FOLLOW_IDLE_MS) return
    navIntent.current = null
    setCurrentId(id)
  }, [])

  // ------------------------------------------------------------------ import

  const importPaths = useCallback(
    async (paths: string[]): Promise<Session | null> => {
      if (paths.length === 0) return null
      setBusy(true)
      try {
        const probes: ProbeWire[] = []
        const failed: string[] = []
        // What the engine had to guess or truncate. A file that imported but
        // not exactly as written is not a failure and must not be reported as
        // one — but it cannot pass in silence either, which is what happened
        // until now: the engine filled this in and nothing read it.
        const caveats: string[] = []
        for (const p of paths) {
          const res = await window.wpt.probe(p)
          if (res.ok && res.probe) {
            const probe = res.probe as ProbeWire
            probes.push(probe)
            for (const w of probe.sheet?.warnings ?? []) caveats.push(w)
          } else {
            failed.push(`${baseName(p)}: ${res.error ?? 'unreadable'}`)
          }
        }
        let preview: Session | null = null
        if (probes.length) {
          // The probes above took real time — an agent may have pushed while
          // the engine read the files. Fold the imports into whatever session
          // is CURRENT, never the one this closure was rendered with.
          applyWith((prev) => probes.reduce(addSource, prev), `Added ${probes.length} file(s).`)
          // The closure-based preview serves only the return value and the
          // first-page fallback; the committed state above is the truth.
          preview = probes.reduce(addSource, session)
          setCurrentId((cur) => cur ?? preview!.pages[0]?.id ?? null)
        }
        // Failures first: not adding a file at all is the bigger news.
        if (failed.length) setStatus(`Could not add — ${failed.join('; ')}`)
        else if (caveats.length) setStatus(caveats.join(' · '))
        return preview
      } finally {
        setBusy(false)
      }
    },
    [session, applyWith]
  )

  const addViaDialog = useCallback(async () => {
    const paths = await window.wpt.openPdfs()
    await importPaths(paths)
  }, [importPaths])

  /**
   * The tickmark legend, as a real page at the front of the binder.
   *
   * Deliberately a normal typeset page rather than something conjured during
   * export: the export path is the highest-risk code in the project, and a
   * legend has no business touching it. As a page it is also visible, movable
   * and deletable — a reviewer who wants it at the back can drag it there.
   *
   * Rebuilding replaces the previous one instead of stacking a second, and the
   * whole thing lands as ONE undo step.
   */
  const addLegendPage = useCallback(async () => {
    setBusy(true)
    try {
      const target = await window.wpt.writeLegendDoc(legendMarkdown(session))
      const res = await window.wpt.probe(target)
      if (!res.ok || !res.probe) {
        return setStatus(`Could not build the legend page — ${res.error ?? 'unreadable'}`)
      }
      // Ours by name, and it only ever lives in a folder we write. A file the
      // user named this themselves would be replaced too, which is why the
      // message says what happened rather than doing it silently.
      //
      // Computed inside applyWith against the CURRENT session: writing and
      // probing the legend doc took real time, and folding the page in from
      // this render's closure would silently drop anything an agent pushed
      // meanwhile. The status text reads from the closure — worst case it
      // says "added" for a rebuild, never wrong state.
      const rebuilt = session.sources.some((s) => baseName(s.path).startsWith(LEGEND_DOC_PREFIX))
      applyWith(
        (prev) => {
          const stale = new Set(
            prev.sources.filter((s) => baseName(s.path).startsWith(LEGEND_DOC_PREFIX)).map((s) => s.id)
          )
          const stalePages = prev.pages.filter((p) => stale.has(p.source)).map((p) => p.id)
          let next = stalePages.length ? deletePages(prev, stalePages) : prev
          const before = next.pages.length
          next = addSource(next, res.probe as ProbeWire)
          const added = next.pages.slice(before).map((p) => p.id)
          if (added.length) next = movePages(next, added, 0)
          return next
        },
        rebuilt
          ? `Legend page rebuilt at the front — ${legendEntries(session).length} tickmark(s).`
          : `Legend page added at the front — ${legendEntries(session).length} tickmark(s). Drag it anywhere you like.`
      )
      setCurrentId(null)
    } finally {
      setBusy(false)
    }
  }, [session, applyWith])

  // ------------------------------------------------------------- page actions

  const targetIds = useCallback((): string[] => {
    if (selected.size > 0) return pages.filter((p) => selected.has(p.id)).map((p) => p.id)
    return current ? [current.id] : []
  }, [selected, pages, current])

  const rotate = useCallback(
    (delta: number) => {
      const ids = targetIds()
      if (!ids.length) return
      apply(rotatePages(session, ids, delta), `Rotated ${ids.length} page(s).`)
    },
    [targetIds, session, apply]
  )

  const remove = useCallback(() => {
    const ids = targetIds()
    if (!ids.length) return
    const next = deletePages(session, ids)
    // Keep a sensible cursor: the page that took the first deleted slot.
    const firstIdx = pages.findIndex((p) => p.id === ids[0])
    apply(next, `Deleted ${ids.length} page(s). ${MOD}Z to undo.`)
    setSelected(new Set())
    setActiveTapeId(null)
    setCurrentId(next.pages[Math.min(firstIdx, next.pages.length - 1)]?.id ?? null)
    for (const s of session.sources) {
      if (!next.sources.some((n) => n.id === s.id)) forgetDoc(s.id)
    }
  }, [targetIds, session, pages, apply])

  const nudge = useCallback(
    (dir: -1 | 1) => {
      const ids = targetIds()
      if (!ids.length) return
      const idxs = ids.map((id) => pages.findIndex((p) => p.id === id))
      const before = dir < 0 ? Math.min(...idxs) - 1 : Math.max(...idxs) + 2
      if (before < 0 || before > pages.length) return
      apply(movePages(session, ids, before), 'Moved.')
    },
    [targetIds, pages, session, apply]
  )

  const select = useCallback(
    (id: string, mode: 'single' | 'toggle' | 'range') => {
      setCurrentId(id)
      setSelected((prev) => {
        if (mode === 'toggle') {
          const next = new Set(prev)
          next.has(id) ? next.delete(id) : next.add(id)
          return next
        }
        if (mode === 'range' && currentId) {
          const a = pages.findIndex((p) => p.id === currentId)
          const b = pages.findIndex((p) => p.id === id)
          if (a >= 0 && b >= 0) {
            const [lo, hi] = a < b ? [a, b] : [b, a]
            return new Set(pages.slice(lo, hi + 1).map((p) => p.id))
          }
        }
        return new Set([id])
      })
    },
    [currentId, pages]
  )

  const currentIndex = useMemo(
    () => pages.findIndex((p) => p.id === current?.id),
    [pages, current]
  )

  /** Navigate to a binder position (clamped). Distinct from moving a page. */
  const goto = useCallback(
    (index: number) => {
      if (!pages.length) return
      const target = pages[Math.min(pages.length - 1, Math.max(0, index))]
      if (!target) return
      setCurrentId(target.id)
      setSelected(new Set([target.id]))
      setSelectedMarkId(null)
      setSelectedShapeId(null)
      setActiveTapeId(null)
    },
    [pages]
  )

  const step = useCallback(
    (dir: -1 | 1) => {
      if (!pages.length) return
      const i = Math.max(0, pages.findIndex((p) => p.id === current?.id))
      const next = pages[Math.min(pages.length - 1, Math.max(0, i + dir))]
      if (next) {
        setCurrentId(next.id)
        setSelected(new Set([next.id]))
      }
    },
    [pages, current]
  )

  /** Add a bookmark on the current page and drop straight into renaming it. */
  const addBookmarkHere = useCallback(() => {
    if (!current) return
    const { session: next, key } = addBookmark(session, current.id)
    apply(next, 'Bookmark added — type a name.')
    setAutoEditKey(key)
  }, [current, session, apply])

  // -------------------------------------------------------------------- marks

  const placeTool = useCallback(
    (pageId: string, nx: number, ny: number, base?: Session) => {
      if (!armed) return
      // The initials question is open and owns the screen. Without this guard a
      // click that lands on the page BEHIND it silently re-registers the pending
      // mark at the new spot: the preparer clicked beside a figure, the prompt
      // appeared, a stray click moved the mark into white space, and the tick
      // came to rest somewhere they never pointed at. A tick in the wrong place
      // is worse than the blank author this prompt exists to prevent — it looks
      // like a figure was verified when it was not. The backdrop stops the click
      // reaching here at all; this is the second lock on the same door.
      //
      // `base` is the tell. Only commitInitials passes it, and that call IS the
      // answer being applied — it must go through even though the prompt has not
      // finished closing. React has not re-rendered yet when it lands, so
      // `initialsPrompt` is still set in this closure; without the `!base` the
      // guard would swallow the one placement it exists to protect.
      if (!base && initialsPrompt) return
      const target = pages.find((p) => p.id === pageId)
      if (!target) return
      // A mark is evidence that SOMEONE checked something. Recorded with a
      // blank author it is evidence of nothing, and until now that happened
      // silently: only the initials-stamp button was gated, so a fresh install
      // could mark up a whole binder and every tick exported with no author —
      // which is what the first Windows install test hit. Ask once, at the only
      // moment the answer matters, rather than refusing the tool or writing a
      // blank. `base` lets the answer be applied and the mark placed in one go.
      const base0 = base ?? session
      // Seed from the machine's stored initials before asking. The question is
      // worth asking once per person, not once per binder.
      const who = (base0.reviewer ?? '').trim() || preparerInitials
      if (!who) {
        setInitialsDraft('')
        setInitialsPrompt({ mark: { pageId, nx, ny } })
        return
      }
      // Write the answer into the SAME session the mark is added to, so the mark
      // that seeded it is not the one mark recording a blank author.
      const from = (base0.reviewer ?? '').trim() === who ? base0 : { ...base0, reviewer: who }
      if (armed.kind === 'tape') {
        const onPage = (from.tapes ?? []).filter((t) => t.page === pageId).length
        const { session: next, id } = addTape(from, {
          page: pageId,
          nx,
          ny,
          entries: [],
          section: onPage + 1
        })
        setKeypadOpen(true)
        setTapeBuffer('')
        apply(next, 'Tape placed — key a number, Enter after each. Esc when done.')
        setActiveTapeId(id)
        setSelectedMarkId(null)
        // A tape is a mode you enter and key into, not a stamp you repeat —
        // staying armed would drop a second empty tape on the next click.
        setArmed(null)
        return
      }
      // Shapes are dragged out, not clicked into place — drawShape handles them.
      if (isShapeKind(armed.kind)) return
      if (armed.kind === 'conn') {
        const label = (armed.text ?? '').trim() || '1'
        const size = preferredMarkSize(markSizes, armed)
        const res = placeConnector(from, { page: pageId, nx, ny, size, label }, who)
        apply(
          res.session,
          res.paired
            ? res.sameSide
              ? `${label} placed — both ends are on this page, so there is no page reference to print.`
              : `${label} tied to its other end. It is clickable in the exported PDF, and prints the page number.`
            : `${label} placed — put ${label} on the page it ties to and they become a reference.`
        )
        setSelectedMarkId(res.id)
        // Advance only when the tool is being kept; otherwise the next arming
        // recomputes it anyway. Read from the NEW session, or the label just
        // placed would be handed out twice.
        if (!keepMark) setArmed(null)
        else
          setArmed({
            kind: 'conn',
            text: nextConnectorLabel(res.session, /^\d+$/.test(label) ? 'number' : 'letter')
          })
        return
      }
      const { session: next, id } = addMark(from, {
        page: pageId,
        kind: armed.kind,
        nx,
        ny,
        size: preferredMarkSize(markSizes, armed),
        ...(armed.text ? { text: armed.text } : {})
      })
      // `|| armed.kind` because a lettered mark with no letters is possible —
      // the status line read "undefined placed" in a screenshot, which is the
      // kind of thing that only ever shows up by looking at the window.
      const placedName = (armed.kind === 'text' ? armed.text : '') || armed.kind
      apply(
        next,
        keepMark
          ? `${placedName} placed — tool kept, click to place another. Esc to stop.`
          : `${placedName} placed.`
      )
      setSelectedMarkId(id)
      // Marks stay armed by default — ticking down a column is the job. Keep
      // tool off is the reviewer asking for one and done.
      if (!keepMark) setArmed(null)
    },
    [pages, armed, session, markSizes, apply, initialsPrompt, preparerInitials, keepMark]
  )

  /**
   * Record the preparer's initials everywhere they need to be, in one place.
   *
   * Two homes, on purpose. The session copy is attribution and has to travel
   * inside the binder. The stored copy is the default the NEXT binder starts
   * from, so the question is asked once on a machine rather than once per file.
   */
  const rememberInitials = useCallback((value: string): string => {
    const initials = value.trim().toUpperCase().slice(0, 4)
    setPreparerInitials(initials)
    // Fire-and-forget: failing to persist a preference must never block a mark.
    // The worst case is being asked again on the next binder.
    void window.wpt.setPreparerInitials(initials).then(setPreparerInitials)
    setSession((prev) => ({ ...prev, reviewer: initials }))
    return initials
  }, [])

  /**
   * Answer the initials question, and land the mark that asked it if there was
   * one — the question can also be asked on its own, from the palette button.
   *
   * The reviewer is passed into placeTool on the SAME session the mark is added
   * to, rather than set and left for the next render: `setSession` above does
   * not take effect until React re-renders, so the mark that triggered the
   * prompt would otherwise be the one mark still recording a blank author.
   */
  const commitInitials = useCallback(() => {
    const pending = initialsPrompt
    if (!pending) return
    const value = rememberInitials(initialsDraft)
    if (!value) return
    setInitialsPrompt(null)
    if (pending.mark) {
      placeTool(pending.mark.pageId, pending.mark.nx, pending.mark.ny, {
        ...session,
        reviewer: value
      })
    }
  }, [initialsDraft, initialsPrompt, placeTool, session, rememberInitials])

  /**
   * Close the question without answering it. Says so in the status bar: the
   * click that opened this was an attempt to place a mark, and a tool that
   * quietly does nothing reads as broken.
   */
  /**
   * Put the caret in the initials field when the question opens.
   *
   * `autoFocus` alone does not survive here: the click that opens the question
   * is a click on the page, and the page view takes focus back for its own
   * keyboard handling after React has mounted the dialog. The visible symptom
   * was that typing "ABC" went to the global shortcuts instead of the field —
   * "C" armed the calculator tape — and the preparer was left staring at an
   * empty box that had apparently ignored them. Focusing in an effect runs
   * after that, and it is the modal's job to own the keyboard anyway.
   */
  useEffect(() => {
    if (!initialsPrompt) return
    const put = (): void => {
      const el = initialsInput.current
      if (!el) return
      el.focus()
      el.select()
    }
    put()
    // Again on the next frame: the page view can take focus back after this
    // effect has run, and losing that race leaves the caret nowhere.
    const frame = requestAnimationFrame(put)
    return () => cancelAnimationFrame(frame)
  }, [initialsPrompt])

  const cancelInitials = useCallback(() => {
    const asking = initialsPrompt
    setInitialsPrompt(null)
    if (asking?.mark) setStatus('Mark not placed — it needs initials to be evidence of anything.')
  }, [initialsPrompt])

  const moveMark = useCallback(
    (id: string, nx: number, ny: number) => {
      // Dragging fires continuously; collapse the whole gesture into the undo
      // entry created when it started rather than one per pointer event.
      setSession((prev) => updateMark(prev, id, { nx, ny }))
    },
    []
  )

  const resizeMark = useCallback(
    (delta: number) => {
      if (!selectedMarkId) return
      const cur = (session.marks ?? []).find((m) => m.id === selectedMarkId)
      if (!cur) return
      apply(updateMark(session, selectedMarkId, { size: cur.size + delta }), 'Mark resized.')
    },
    [selectedMarkId, session, apply]
  )

  const deleteMark = useCallback(() => {
    if (!selectedMarkId) return
    apply(removeMarks(session, [selectedMarkId]), `Mark deleted. ${MOD}Z to undo.`)
    setSelectedMarkId(null)
  }, [selectedMarkId, session, apply])

  const selectedMark = useMemo<Mark | null>(
    () => (session.marks ?? []).find((m) => m.id === selectedMarkId) ?? null,
    [session.marks, selectedMarkId]
  )

  const rememberMarkSize = useCallback((mark: Pick<Mark, 'kind' | 'text'>, value: number) => {
    const key = markSizePreferenceKey(mark)
    if (!key) return
    const size = clampMarkSize(value)
    setMarkSizes((current) => ({ ...current, [key]: size }))
    // A preference write must not block editing. Main serializes preference
    // updates so a near-simultaneous initials write cannot overwrite this one.
    void window.wpt.setMarkSize(key, size).then((stored) => {
      if (stored) setMarkSizes((current) => ({ ...current, [stored.key]: stored.size }))
    })
  }, [])

  /** Inspector edits — note, author, letters, size — on the selected mark. */
  const editMark = useCallback(
    (patch: Partial<Mark>) => {
      if (!selectedMarkId) return
      const mark = (session.marks ?? []).find((candidate) => candidate.id === selectedMarkId)
      if (!mark) return
      const next = updateMark(session, selectedMarkId, patch)
      if (typeof patch.size === 'number') {
        const updated = (next.marks ?? []).find((candidate) => candidate.id === selectedMarkId)
        if (updated) rememberMarkSize(mark, updated.size)
      }
      apply(next, 'Mark updated.')
    },
    [selectedMarkId, session, apply, rememberMarkSize]
  )

  // ---------------------------------------------------------- calculator tape

  /**
   * One key router for the tape, used by BOTH the keyboard and the on-screen
   * keypad — so a button and a keystroke can never drift apart.
   *
   * The transition itself lives in the model (`tapeKeyPress`) so it is verified
   * headlessly; this only owns what needs React: the buffer, the undo entry,
   * and the status line.
   */
  const tapeKey = useCallback(
    (key: string) => {
      const id = activeTapeId
      if (!id) return
      const tape = (session.tapes ?? []).find((t) => t.id === id)
      if (!tape) return

      if (key === 'Escape') {
        // An untouched tape shouldn't linger as an empty card on the workpaper.
        if (tape.entries.length === 0 && !tapeBuffer && !tape.title) {
          apply(removeTapes(session, [id]), 'Tape discarded.')
        }
        setTapeBuffer('')
        setTapeOp('+')
        setActiveTapeId(null)
        return
      }

      const before = { entries: tape.entries, buffer: tapeBuffer, op: tapeOp }
      const after = tapeKeyPress(before, key)
      if (after === before) {
        // The one refusal worth explaining rather than ignoring.
        if ((key === '=' || key === 'Enter') && tapeOp === '÷' && parseAmount(tapeBuffer) === 0) {
          setStatus('Cannot divide by zero.')
        }
        return
      }

      setTapeBuffer(after.buffer)
      setTapeOp(after.op)
      if (after.entries !== before.entries) {
        const total = formatAmount(tapeTotal(after.entries))
        const note =
          after.entries.length < before.entries.length
            ? `Line removed — total ${total}`
            : `${after.entries[after.entries.length - 1].op} ${formatAmount(
                after.entries[after.entries.length - 1].value
              )} — total ${total}`
        apply(updateTape(session, id, { entries: after.entries }), note)
      }
    },
    [activeTapeId, tapeBuffer, tapeOp, session, apply]
  )

  const editTapeEntry = useCallback(
    (index: number, patch: Partial<TapeEntry>) => {
      if (!activeTapeId) return
      apply(updateTapeEntry(session, activeTapeId, index, patch), 'Tape line updated.')
    },
    [activeTapeId, session, apply]
  )

  const removeTapeLine = useCallback(
    (index: number) => {
      if (!activeTapeId) return
      apply(removeTapeEntry(session, activeTapeId, index), 'Tape line removed.')
    },
    [activeTapeId, session, apply]
  )

  // Dragging and captioning fire continuously; fold each gesture into the undo
  // entry that opened it rather than one per pointer event or keystroke.
  const moveTape = useCallback((id: string, nx: number, ny: number) => {
    setSession((prev) => updateTape(prev, id, { nx, ny }))
  }, [])

  const titleTape = useCallback((id: string, title: string) => {
    setSession((prev) => updateTape(prev, id, { title }))
  }, [])

  const deleteTape = useCallback(
    (id: string) => {
      apply(removeTapes(session, [id]), `Tape deleted. ${MOD}Z to undo.`)
      setActiveTapeId(null)
      setTapeBuffer('')
    },
    [session, apply]
  )

  /** Clicking a tape puts you back in it — and brings the keypad back with it.
   *  Without this, closing the keypad left every tape a dead card. */
  const activateTape = useCallback((id: string | null) => {
    setActiveTapeId(id)
    if (id) {
      setKeypadOpen(true)
      setTapeBuffer('')
      setSelectedMarkId(null)
      setSelectedShapeId(null)
    }
  }, [])

  // -------------------------------------------------------------------- shapes

  /** Commit a drag as a shape. A stray click is not a shape. */
  const drawShape = useCallback(
    (pageId: string, nx: number, ny: number, nx2: number, ny2: number) => {
      if (!armed || !isShapeKind(armed.kind)) return
      if (!pages.some((p) => p.id === pageId)) return
      let [x2, y2] = [nx2, ny2]
      if (!isDragMeaningful(nx, ny, x2, y2)) {
        // A text note is PLACED, not sized — a plain click should give a box
        // to type in. Every other shape genuinely needs a drag.
        if (armed.kind !== 'textbox') return
        x2 = Math.min(1, nx + 0.3)
        y2 = Math.min(1, ny + 0.07)
      }
      const { session: next, id } = addShape(session, {
        page: pageId,
        kind: armed.kind,
        nx,
        ny,
        nx2: x2,
        ny2: y2,
        color: shapeColor,
        width: SHAPE_WIDTH_DEFAULT,
        ...(armed.kind === 'textbox' ? { text: '' } : {})
      })
      const kind = armed.kind
      const KEY: Record<string, string> = {
        rect: 'R',
        ellipse: 'O',
        line: 'L',
        arrow: 'A',
        highlight: 'H',
        textbox: 'N'
      }
      apply(
        next,
        toolLock
          ? `${kind} drawn — tool locked, drag out another. Esc or Keep tool to stop.`
          : `${kind} drawn — drag it to move, corners to resize. ${KEY[kind]} to draw another.`
      )
      // Don't select the shape we just drew while the tool is locked. Selecting
      // it puts resize handles under the cursor, and the very next drag is meant
      // to be a NEW shape — so the handles would silently resize the last one
      // instead of drawing.
      setSelectedShapeId(toolLock ? null : id)
      setSelectedMarkId(null)
      // Disarm after ONE shape, unlike the mark tools. A shape is drawn and
      // then adjusted; staying armed meant every click meant to grab it drew
      // another one on top instead. `toolLock` is the reviewer opting out of
      // that, for a run of boxes or circles down a page.
      if (!toolLock) setArmed(null)
    },
    [pages, armed, session, shapeColor, apply, toolLock]
  )

  const selectedShape = useMemo<Shape | null>(
    () => (session.shapes ?? []).find((x) => x.id === selectedShapeId) ?? null,
    [session.shapes, selectedShapeId]
  )

  const editShape = useCallback(
    (patch: Partial<Shape>) => {
      if (!selectedShapeId) return
      apply(updateShape(session, selectedShapeId, patch), 'Shape updated.')
    },
    [selectedShapeId, session, apply]
  )

  // Dragging fires continuously; fold the gesture into one undo entry.
  const nudgeShape = useCallback((id: string, dx: number, dy: number) => {
    setSession((prev) => moveShape(prev, id, dx, dy))
  }, [])

  const deleteShape = useCallback(() => {
    if (!selectedShapeId) return
    apply(removeShapes(session, [selectedShapeId]), `Shape deleted. ${MOD}Z to undo.`)
    setSelectedShapeId(null)
  }, [selectedShapeId, session, apply])

  // -------------------------------------------------------------- page status

  const defs = useMemo(() => statusDefs(session), [session.statusDefs])
  const parts = useMemo(() => statusParts(session), [session.statusParts])
  const numberCfg = useMemo(() => numbering(session), [session.numbering])
  const counts = useMemo(() => statusCounts(session), [session.statuses, session.pages, session.statusDefs])
  const currentStatus = current ? statusOf(session, current.id) : null

  const applyStatus = useCallback(
    (statusId: string) => {
      const ids = targetIds()
      if (!ids.length) return
      const def = defs.find((d) => d.id === statusId)
      apply(
        setPageStatus(session, ids, statusId, session.reviewer ?? ''),
        `${ids.length} page(s) marked "${def?.label ?? statusId}".`
      )
    },
    [targetIds, session, apply, defs]
  )

  const clearStatus = useCallback(() => {
    const ids = targetIds()
    if (!ids.length) return
    apply(clearPageStatus(session, ids), `Status cleared on ${ids.length} page(s).`)
  }, [targetIds, session, apply])

  const addStatusDef = useCallback(
    (label: string) => {
      const id = `st_${session.seq + 1}`
      const used = new Set(defs.map((d) => d.color))
      const color =
        (SHAPE_COLOR_NAMES.find((c) => !used.has(c)) as StatusDef['color']) ?? 'blue'
      apply(
        { ...session, seq: session.seq + 1, statusDefs: [...defs, { id, label, color }] },
        `Status "${label}" added to the legend.`
      )
    },
    [session, defs, apply]
  )

  const editStatusDef = useCallback(
    (id: string, patch: Partial<StatusDef>) => {
      apply(
        { ...session, statusDefs: defs.map((d) => (d.id === id ? { ...d, ...patch } : d)) },
        'Legend updated.'
      )
    },
    [session, defs, apply]
  )

  const removeStatusDef = useCallback(
    (id: string) => {
      // Pages holding a status that no longer exists would render nothing and
      // silently lose their marking, so clear them with it.
      const held = Object.entries(session.statuses ?? {})
        .filter(([, v]) => v.status === id)
        .map(([k]) => k)
      const next = clearPageStatus(
        { ...session, statusDefs: defs.filter((d) => d.id !== id) },
        held
      )
      apply(next, held.length ? `Status removed — cleared from ${held.length} page(s).` : 'Status removed.')
    },
    [session, defs, apply]
  )

  const setParts = useCallback(
    (patch: Partial<StatusParts>) => {
      apply({ ...session, statusParts: { ...parts, ...patch } }, 'Status options updated.')
    },
    [session, parts, apply]
  )

  // ----------------------------------------------------------- custom stamps

  /** Save letters as a reusable stamp, and arm it immediately. */
  const addStampNamed = useCallback(
    (raw: string) => {
      const next = addStamp(session, raw)
      if (next === session) return
      const text = next.stamps![next.stamps!.length - 1]
      apply(next, `Stamp "${text}" saved. Give it a meaning in Legend.`)
      setArmed({ kind: 'text', text })
    },
    [session, apply]
  )

  const dropStamp = useCallback(
    (text: string) => {
      apply(removeStamp(session, text), `Stamp "${text}" removed from the palette.`)
      setArmed((cur) => (cur?.kind === 'text' && cur.text === text ? null : cur))
    },
    [session, apply]
  )

  // --------------------------------------------------------------- persistence

  /**
   * Autosave, to the invisible sibling — never to the binder.
   *
   * Writing the binder means rebuilding the whole PDF, which is not something
   * to do on a timer. Edits land in a small JSON file beside it and are only
   * folded into the binder when the user saves; the sibling is deleted on a
   * clean close, so its presence at open time means the app did not close
   * cleanly. This is the invisible scratch file, not a second document.
   */
  useEffect(() => {
    if (!binderPath || !dirty) return
    const timer = window.setTimeout(() => {
      void window.wpt.autosaveBinder(binderPath, session).catch(() => {
        // An autosave that cannot be written must not interrupt editing. The
        // binder on disk is still whatever was last saved.
      })
    }, 1500)
    return () => window.clearTimeout(timer)
  }, [session, binderPath, dirty])

  /**
   * Core write. Takes the session explicitly — never reads render-time state.
   *
   * `flatten` and `embedSession` are opposites, and that is the whole model:
   * a working save carries the editable session and marks you can still move,
   * the copy that leaves the firm carries neither.
   */
  const writeBinder = useCallback(
    async (
      target: Session,
      out: string,
      opts: { flatten?: boolean; reveal?: boolean } = {}
    ) => {
      const { flatten = false, reveal = false } = opts
      setBusy(true)
      setStatus(flatten ? 'Preparing copy…' : 'Saving…')
      try {
        const res = await window.wpt.exportBinder(
          toExportSpec(target, out, { pageCounts, flatten, embedSession: !flatten })
        )
        if (res.ok) {
          const r = res.result as {
            pages: number
            marks: number
            check_problems: string[]
            session_bytes?: number
          }
          const clean = r.check_problems.length === 0
          setStatus(
            flatten
              ? `Copy for sending saved to ${baseName(out)} — ${r.pages} pages, ${r.marks} mark(s) printed on permanently`
              : `Saved ${baseName(out)} — ${r.pages} pages${
                  clean ? '' : ` · ${r.check_problems.length} validation warning(s)`
                }`
          )
          if (reveal) await window.wpt.reveal(out)
        } else {
          setStatus(`${flatten ? 'Copy' : 'Save'} failed — ${res.error}`)
        }
        return res
      } finally {
        setBusy(false)
      }
    },
    [pageCounts]
  )

  /** Save the binder. One file, one action. */
  const saveBinder = useCallback(
    async (forceDialog = false) => {
      if (!pages.length) return setStatus('Nothing to save yet — add some pages.')
      if (saving.current) return
      saving.current = true
      try {
        let out = forceDialog ? null : binderPath
        if (!out) {
          out = await window.wpt.chooseBinderOutput(`${binderStem}.pdf`)
          if (!out) return
        }
        const res = await writeBinder(session, out)
        if (!res.ok) return
        // Only now is the file on disk the thing on screen.
        lastSaved.current = JSON.stringify(session)
        if (binderPath && binderPath !== out) await window.wpt.releaseBinder(binderPath)
        setBinderPath(out)
      } finally {
        saving.current = false
      }
    },
    [session, pages.length, binderPath, binderStem, writeBinder]
  )

  /**
   * The copy that leaves the firm: marks printed permanently onto the page,
   * no editable session inside. Deliberately a separate destination — it must
   * never overwrite the working binder.
   */
  const writeCopyToSendOut = useCallback(async () => {
    if (!pages.length) return setStatus('Nothing to send yet — add some pages.')
    const out = await window.wpt.chooseBinderOutput(`${binderStem} (copy to send).pdf`)
    if (!out) return
    // A refusal, not a warning. Writing a flattened copy over the binder you
    // have open destroys the editable session inside it — the marks stop being
    // marks and become ink, and there is no saving again to undo it. That is
    // the only irreversible thing this app can do to a file, so it is the one
    // place a message you can click past is not enough.
    if (binderPath && out === binderPath) {
      return setStatus(
        'Refused — that is the binder you are working in. A flattened copy cannot be edited again, ' +
          'and writing it here would take the editable session with it. Choose a different name.'
      )
    }
    await writeBinder(session, out, { flatten: true, reveal: true })
  }, [session, pages.length, binderPath, binderStem, writeBinder])

  /** Show what the binder itself can prove before making the permanent copy. */
  const saveCopyToSendOut = useCallback(() => {
    if (!pages.length) return setStatus('Nothing to send yet — add some pages.')
    setSendAnywayArmed(false)
    setSendPreflightOpen(true)
  }, [pages.length])

  /** Load a session into the editor, replacing whatever is open. */
  const adoptSession = useCallback(
    (next: Session, path: string | null, note: string, clean: boolean) => {
      for (const s of next.sources) forgetDoc(s.id)
      liveDocumentId.current = crypto.randomUUID()
      liveRefs.current.documentId = liveDocumentId.current
      past.current = []
      future.current = []
      lastSaved.current = clean ? JSON.stringify(next) : `${JSON.stringify(next)} `
      setSession(next)
      setBinderPath(path)
      setSelected(new Set())
      setCurrentId(next.pages[0]?.id ?? null)
      setStatus(note)
    },
    []
  )

  /**
   * `fromDevSeam` skips the unsaved-changes question, and ONLY the dev seam may.
   *
   * The guard used to be `!devPath`, on the reasoning that a path could only
   * come from a scripted run. That stopped being true the moment Finder's
   * double-click started working: opening a second binder from the Finder would
   * have replaced an edited one with no question asked, which is silent data
   * loss on a workpaper. A path from the OS is a person choosing a file, and a
   * person gets asked.
   */
  const openBinder = useCallback(async (target?: string, fromDevSeam = false) => {
    if (!fromDevSeam && dirty && !(await window.wpt.confirmDiscard())) return

    const previousBinder = binderPath
    const releasePrevious = async (next: string | null): Promise<void> => {
      if (previousBinder && previousBinder !== next) await window.wpt.releaseBinder(previousBinder)
    }
    const releaseFailedNext = async (next: string): Promise<void> => {
      if (previousBinder !== next) await window.wpt.releaseBinder(next)
    }

    const res = await window.wpt.openBinder(target)
    if (!res) return

    if (res.kind === 'error') {
      return setStatus(`Cannot open ${baseName(res.path)} — ${res.error}`)
    }

    // An ordinary PDF with nothing of ours inside. When someone tells the OS or
    // the Open button to open a PDF in LedgerPDF, they want to SEE it — so start
    // a binder from it and show it, rather than an empty screen and a status line
    // that says "use Add files". That message read as "open is broken": it sent
    // a maintainer hunting a bug that was not there, because the plain original and
    // the -LedgerPDF binder look alike in Finder and only the latter carries a
    // session. Importing is exactly what the comment in openBinderAt already
    // intended ("hand it back for import, not an error"); it just was not done.
    if (res.kind === 'plain') {
      const probed = await window.wpt.probe(res.path)
      if (!probed.ok || !probed.probe) {
        return setStatus(`Cannot open ${baseName(res.path)} — ${probed.error ?? 'unreadable'}`)
      }
      // A fresh binder, not appended to whatever was open: "Open" replaces, and
      // the unsaved-changes guard at the top of this function already protected
      // anything the person had not saved.
      const fresh = addSource(newSession(), probed.probe as ProbeWire)
      await releasePrevious(null)
      adoptSession(
        fresh,
        null,
        res.flattened
          ? `Opened flattened copy as a new binder — its existing marks are permanent ink and cannot be clicked. New marks you add will be editable.`
          : `Opened ${baseName(res.path)} — a new binder from this PDF. Add more, mark it up, then Save.`,
        true
      )
      return
    }

    // ---- a saved binder
    if (res.kind === 'binder') {
      const parsed = parseSession(res.session)
      if ('error' in parsed) {
        await releaseFailedNext(res.path)
        return setStatus(`Cannot open ${baseName(res.path)} — ${parsed.error}`)
      }
      if (!res.payloadIntact) {
        await releaseFailedNext(res.path)
        return setStatus(
          `Cannot open ${baseName(res.path)} — the saved marks inside it are damaged.`
        )
      }
      const probed = await window.wpt.probe(res.workingPath)
      if (!probed.ok || !probed.probe) {
        await releaseFailedNext(res.path)
        return setStatus(`Cannot read ${baseName(res.path)} — ${probed.error ?? 'unreadable'}`)
      }
      const rebound = rebindToBinder(
        parsed.session,
        probed.probe as ProbeWire,
        res.workingPath,
        baseName(res.path)
      )
      if (rebound.error) {
        await releaseFailedNext(res.path)
        return setStatus(`Cannot open ${baseName(res.path)} — ${rebound.error}`)
      }

      // The pages moved since this session was written. The marks will load and
      // will look fine, and some of them will be in the wrong place. Say that
      // plainly rather than opening quietly.
      const moved = !res.geometryMatches
      const stale = res.pendingAutosave !== undefined

      await releasePrevious(res.path)
      adoptSession(
        rebound.session,
        res.path,
        moved
          ? `Opened ${baseName(res.path)} — WARNING: another program changed the pages since this was saved, so marks may no longer line up. Check before relying on them.`
          : stale
            ? `Opened ${baseName(res.path)} — it was last closed without saving; unsaved edits from that session were not applied.`
            : `Opened ${baseName(res.path)} — ${rebound.session.pages.length} pages.`,
        !moved
      )
      return
    }

    // ---- the older two-file format, opened once so it can be converted
    if (res.session === undefined) {
      return setStatus(`Cannot open session — ${res.error ?? 'unreadable file'}`)
    }
    let parsed = parseSession(res.session)
    let recovered = !!res.recoveredFrom
    if ('error' in parsed && res.recoverySession !== undefined) {
      const fallback = parseSession(res.recoverySession)
      if (!('error' in fallback)) {
        parsed = fallback
        recovered = true
      }
    }
    if ('error' in parsed) return setStatus(`Cannot open session — ${parsed.error}`)
    const resolvedSources: SourceDoc[] = []

    for (const source of parsed.session.sources) {
      let candidate: string | null = source.path
      let probe: ProbeWire | null = null

      if (candidate) {
        const checked = await window.wpt.probe(candidate)
        if (checked.ok && checked.probe) {
          probe = checked.probe as ProbeWire
        }
      }

      if (!candidate || !probe || !sourceMatches(source, probe)) {
        const replacement = await window.wpt.relinkSource(source.name)
        if (!replacement) {
          return setStatus(
            `Open cancelled — locate the original ${source.name} to preserve mark/page integrity.`
          )
        }
        const checked = await window.wpt.probe(replacement)
        if (!checked.ok || !checked.probe) {
          return setStatus(`Cannot use ${baseName(replacement)} — ${checked.error ?? 'unreadable'}`)
        }
        candidate = replacement
        probe = checked.probe as ProbeWire
        if (!sourceMatches(source, probe)) {
          return setStatus(
            `Cannot use ${baseName(replacement)} — it is not the same source that was originally reviewed.`
          )
        }
      }

      resolvedSources.push({
        ...source,
        path: candidate,
        ...(probe.fingerprint ? { fingerprint: probe.fingerprint } : {})
      })
    }

    const openedSession = { ...parsed.session, sources: resolvedSources }
    // Converting: the old file stays exactly where it is and is never written
    // to again. There is no binder yet, so the next Save asks where to put one.
    await releasePrevious(null)
    adoptSession(
      openedSession,
      null,
      recovered
        ? `Recovered ${baseName(res.path)} from its previous complete save. This is the older two-file format — Save will convert it to a single binder.`
        : `Opened ${baseName(res.path)} — ${openedSession.pages.length} pages, source identity verified. This is the older two-file format — Save will convert it to a single binder.`,
      false
    )
  }, [dirty, binderPath, adoptSession])
  openRef.current = openBinder

  // Dev seam (WPT_DEV_OPEN / WPT_DEV_EXPORT): drive the whole Phase 1 flow —
  // import, then optionally a real export through IPC + engine — with no
  // dialogs, so it can be smoke-tested automatically. Handlers are read through
  // refs so this subscribes exactly once.
  const setLegendMeaning = useCallback(
    (token: string, meaning: string) => apply(setLegend(session, token, meaning), 'Legend updated.'),
    [session, apply]
  )
  const devRefs = useRef({ importPaths, writeBinder, openBinderAt: openBinder, setLegendMeaning })
  devRefs.current = { importPaths, writeBinder, openBinderAt: openBinder, setLegendMeaning }
  /**
   * The placement path, held by ref so a scripted dev run always calls the
   * CURRENT closures. placeTool and commitInitials capture session state; a
   * script that grabbed them once would replay against a stale binder and
   * assert nothing useful.
   */
  const devPlay = useRef({
    placeTool,
    commitInitials,
    setArmed,
    setInitialsDraft,
    session,
    initialsPrompt,
    initialsDraft,
    armed,
    drawShape,
    setToolLock: setBothLocks,
    keepDraw,
    keepMark,
    setAgentPanelOpen,
    agentPanelOpen
  })
  devPlay.current = {
    placeTool,
    commitInitials,
    setArmed,
    setInitialsDraft,
    session,
    initialsPrompt,
    initialsDraft,
    armed,
    drawShape,
    setToolLock: setBothLocks,
    keepDraw,
    keepMark,
    setAgentPanelOpen,
    agentPanelOpen
  }
  useEffect(() => {
    window.wpt.onDevOpen(async ({ paths, exportTo, seedMarks, preflight, reopen, place, openRecent }) => {
      let imported = await devRefs.current.importPaths(paths)
      // A scripted run through the REAL placement path. `seedMarks` above calls
      // addMark directly, which is exactly why placeTool went uncovered and
      // collected three defects in two days. Steps are replayed one render
      // apart, because placeTool and commitInitials are useCallbacks over
      // state: fired in a single tick they would all see the session as it was
      // before the first of them, and the test would pass while proving nothing.
      if (imported && place) {
        const pageId = imported.pages[0].id
        // Wait for OBSERVED state, never for a duration. placeTool's guard reads
        // `initialsPrompt` from its closure, and that closure is only replaced
        // on render — so a fixed delay makes this a race, and the first version
        // of this runner duly lost it about half the time. A flaky test is worse
        // than none: it fails on correct code often enough that people learn to
        // re-run it, which is how a real failure gets waved through.
        const until = async (what: string, ok: () => boolean): Promise<void> => {
          for (let i = 0; i < 200; i++) {
            if (ok()) return
            await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 5)))
          }
          throw new Error(`dev place script: timed out waiting for ${what}`)
        }
        // importPaths resolves after scheduling the session update. Wait until
        // the scripted view has rendered that session before a DOM-only step
        // (such as opening Legend) can hand the old empty session back to export.
        await until(
          'the scripted view to see the imported pages',
          () => devPlay.current.session.pages.length >= (imported?.pages.length ?? 0)
        )
        let currentStep = ''
        try {
        for (const raw of place.split(';').map((x) => x.trim()).filter(Boolean)) {
          currentStep = raw
          const answer = raw.match(/^answer:(.*)$/i)
          if (answer) {
            const value = answer[1].trim().toUpperCase().slice(0, 4)
            devPlay.current.setInitialsDraft(value)
            // commitInitials reads the draft from ITS closure, so the wait is
            // for that closure to exist — not merely for setState to be called.
            await until(
              'the answer to reach the field',
              () => devPlay.current.initialsDraft === value
            )
            devPlay.current.commitInitials()
            await until('the question to close', () => !devPlay.current.initialsPrompt)
            continue
          }
          // lock:on / lock:off — the Keep tool toggle, driven for real rather
          // than asserted from the outside.
          const lock = raw.match(/^lock:(on|off)$/i)
          if (lock) {
            const want = lock[1].toLowerCase() === 'on'
            devPlay.current.setToolLock(want)
            await until(
              `the tool lock to read ${want}`,
              () => devPlay.current.keepDraw === want && devPlay.current.keepMark === want
            )
            continue
          }
          // menu:legend — open the legend panel by clicking its REAL button,
          // rather than lifting its open state into App just to be testable.
          // The panel owns that state the same way every other menu here does.
          if (/^menu:legend$/i.test(raw)) {
            const btn = document.querySelector<HTMLButtonElement>('.legendmenu > button')
            if (!btn) throw new Error('dev place script: no legend button in the toolbar')
            btn.click()
            await until('the legend panel to open', () => !!document.querySelector('.legend-panel'))
            continue
          }
          // legend:<token>=<meaning> — define a meaning, then build the page by
          // clicking the real button. Driving the button rather than calling
          // addLegendPage keeps the check on the path a person uses.
          const legendDef = raw.match(/^legend:([^=]+)=(.*)$/i)
          if (legendDef) {
            devRefs.current.setLegendMeaning(legendDef[1].trim(), legendDef[2].trim())
            await until(
              `the legend to record ${legendDef[1]}`,
              () => !!devPlay.current.session.legend?.[legendDef[1].trim()]
            )
            continue
          }
          if (/^legend:addpage$/i.test(raw)) {
            const btn = document.querySelector<HTMLButtonElement>('.legend-addpage')
            if (!btn) throw new Error('dev place script: the legend panel is not open')
            if (btn.disabled) throw new Error('dev place script: Add legend page is disabled')
            const before = devPlay.current.session.pages.length
            btn.click()
            await until(
              'the legend page to land at the front',
              () => devPlay.current.session.pages.length > before
            )
            continue
          }
          // preset:<n> — click the first n rows of the legend's preset list, the
          // way a firm adopting the standard set does. This is what filled the
          // ribbon edge to edge before the stamps were grouped, so it is the
          // gesture the density check has to reproduce.
          // `preset:all` takes up every one offered, which is what "a firm
          // adopting the standard set" means and does not go stale when the set
          // changes. A fixed count broke the moment seeded marks put one of the
          // presets in the palette already, and failed as a toolbar-wrap.
          const preset = raw.match(/^preset:(\d+|all)$/i)
          if (preset) {
            const want = preset[1].toLowerCase() === 'all' ? Infinity : Number(preset[1])
            for (let i = 0; i < want; i++) {
              const btn = document.querySelector<HTMLButtonElement>('.legend-preset')
              if (!btn) {
                if (want === Infinity) break
                throw new Error(`dev place script: only ${i} preset(s) available`)
              }
              // Wait on the LIST shrinking, not on the stamp count. A preset
              // whose token already has its own toolbar button (F) records a
              // meaning without adding a second copy of itself, so counting
              // stamps hangs on exactly the case worth covering.
              const before = document.querySelectorAll('.legend-preset').length
              btn.click()
              await until(
                `preset ${i + 1} to be taken up`,
                () => document.querySelectorAll('.legend-preset').length < before
              )
            }
            continue
          }
          // onerow — verify BOTH supported toolbar layouts. At the 1440px
          // design window it must be one row with enough spare width for small
          // font/rendering differences. At the 1100px minimum window it may
          // wrap, but only to two complete, unclipped rows. This is measured at
          // fixed content widths because hosted runners clamp BrowserWindow to
          // their virtual display.
          if (/^onerow$/i.test(raw)) {
            const row = document.querySelector<HTMLElement>('.toolbar-row')
            if (!row) throw new Error('dev place script: no toolbar row')
            await document.fonts.ready
            const priorWidth = row.style.width
            const priorAlignSelf = row.style.alignSelf
            row.style.alignSelf = 'flex-start'
            const DESIGN_WIDTH = 1400
            const COMPACT_WIDTH = 1060
            const MIN_DESIGN_SLACK = 32
            const settleAt = async (width: number): Promise<void> => {
              row.style.width = `${width}px`
              await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
            }
            // Compare centres, not offsetTop. The row is align-items:center, so
            // its short dividers have a different top on the SAME line.
            const lineCount = (): number => {
              const centres = ([...row.children] as HTMLElement[])
                .map((kid) => kid.offsetTop + kid.offsetHeight / 2)
                .sort((a, b) => a - b)
              const lines: number[] = []
              for (const centre of centres) {
                if (!lines.some((line) => Math.abs(line - centre) <= 4)) lines.push(centre)
              }
              return lines.length
            }
            try {
              await settleAt(DESIGN_WIDTH)
              if (lineCount() !== 1) {
                throw new Error(
                  'dev place script: the toolbar wrapped at the 1440px design window. ' +
                    'Something added to the ribbon needs a menu instead.'
                )
              }

              // Find the smallest integer width that still holds one row. The
              // difference is real headroom, rather than a binary pass with an
              // unknown one-pixel margin.
              let low = 1
              let high = DESIGN_WIDTH
              while (low < high) {
                const mid = Math.floor((low + high) / 2)
                await settleAt(mid)
                if (lineCount() === 1) high = mid
                else low = mid + 1
              }
              const designSlack = DESIGN_WIDTH - low
              if (designSlack < MIN_DESIGN_SLACK) {
                throw new Error(
                  `dev place script: the toolbar has only ${designSlack}px spare at the ` +
                    `${DESIGN_WIDTH}px design width; require ${MIN_DESIGN_SLACK}px.`
                )
              }

              await settleAt(COMPACT_WIDTH)
              const compactLines = lineCount()
              const bounds = row.getBoundingClientRect()
              const clipped = ([...row.children] as HTMLElement[]).filter((kid) => {
                const rect = kid.getBoundingClientRect()
                return rect.left < bounds.left - 1 || rect.right > bounds.right + 1
              })
              if (compactLines > 2 || clipped.length) {
                throw new Error(
                  `dev place script: the toolbar needs ${compactLines} rows at the ` +
                    `${COMPACT_WIDTH}px minimum-window width` +
                    (clipped.length
                      ? ` and clips "${clipped[0]?.textContent?.trim().slice(0, 24)}".`
                      : '; only two rows are supported.')
                )
              }
              console.log(
                `[dev] toolbar contract: ${designSlack}px design slack; ` +
                  `${compactLines} compact row(s); no clipped controls`
              )
            } finally {
              row.style.width = priorWidth
              row.style.alignSelf = priorAlignSelf
            }
            continue
          }
          // panel:agent — open the agent-access panel, so its copy can be read
          // in a screenshot during review rather than only by running the app.
          if (/^panel:agent$/i.test(raw)) {
            devPlay.current.setAgentPanelOpen(true)
            await until('the agent panel to open', () => devPlay.current.agentPanelOpen)
            continue
          }
          // stamp:<letters> — arm a real lettered stamp. Keeping the text in
          // the tool identity is what lets the size preference distinguish F
          // from GL, so a generic arm:text step cannot cover this path.
          const stamp = raw.match(/^stamp:(.*)$/i)
          if (stamp) {
            const text = stamp[1].trim()
            if (!text) throw new Error('dev place script: stamp needs letters')
            devPlay.current.setArmed({ kind: 'text', text })
            await until(
              `the ${text} stamp to arm`,
              () =>
                devPlay.current.armed?.kind === 'text' &&
                devPlay.current.armed.text === text
            )
            continue
          }
          // size:<points> — drive the selected mark's REAL inspector buttons.
          // This is deliberately DOM-facing: calling updateMark here would
          // prove the model and skip the inspector -> preference -> next
          // placement wiring that a preparer actually uses.
          const preferredSize = raw.match(/^size:(\d+)$/i)
          if (preferredSize) {
            const want = Number(preferredSize[1])
            const value = (): number =>
              Number(document.querySelector<HTMLElement>('.mi-size-val')?.textContent ?? NaN)
            for (let i = 0; i < 20 && value() !== want; i++) {
              const buttons = document.querySelectorAll<HTMLButtonElement>('.mi-size button')
              const button = want < value() ? buttons[0] : buttons[1]
              if (!button || button.disabled) {
                throw new Error(`dev place script: cannot resize selected mark to ${want}pt`)
              }
              const before = value()
              button.click()
              await until(
                `the selected mark size to change from ${before}`,
                () => value() !== before
              )
            }
            if (value() !== want) {
              throw new Error(
                `dev place script: selected mark reached ${value()}pt, expected ${want}pt`
              )
            }
            continue
          }
          // arm:<kind> — select a tool without using it. Explicit, so a drag can
          // demand the tool already be armed and thereby TEST the lock.
          const arm = raw.match(/^arm:([a-z]+)$/i)
          if (arm) {
            const kind = arm[1] as ToolKind
            devPlay.current.setArmed({ kind })
            await until(`the ${kind} tool to arm`, () => devPlay.current.armed?.kind === kind)
            continue
          }
          // armed:<kind> / armed:none — assert what is in hand. This is how the
          // RELEASE half of Keep tool gets tested: with the lock off, a mark
          // must leave the tool unarmed, and nothing about the placed mark
          // itself shows that. Throws, so a wrong answer fails the run.
          const wantArmed = raw.match(/^armed:([a-z]+|none)$/i)
          if (wantArmed) {
            const want = wantArmed[1].toLowerCase()
            const now = devPlay.current.armed?.kind ?? 'none'
            if (now !== want) {
              throw new Error(
                `dev place script: expected the armed tool to be ${want}, but it is ${now}. ` +
                  `With Keep tool off a mark must release the tool; with it on the tool must hold.`
              )
            }
            continue
          }
          // keep:<kind>@x,y — place a MARK without arming first, mirroring the
          // drag steps below. The plain kind@x,y form re-arms every time, which
          // makes it useless for testing whether the tool stayed armed.
          const kept = raw.match(/^keep:([a-z]+)@([\d.]+),([\d.]+)$/i)
          if (kept) {
            const kind = kept[1] as ToolKind
            if (devPlay.current.armed?.kind !== kind) {
              throw new Error(
                `dev place script: ${kind} is not armed. Keep tool should have held it from the ` +
                  `previous step. Armed now: ${devPlay.current.armed?.kind ?? 'nothing'}`
              )
            }
            const before = (devPlay.current.session.marks ?? []).length
            devPlay.current.placeTool(pageId, Number(kept[2]), Number(kept[3]))
            await until(
              'the mark to land or the question to open',
              () =>
                (devPlay.current.session.marks ?? []).length > before ||
                !!devPlay.current.initialsPrompt
            )
            continue
          }
          // A SHAPE is dragged, so it needs two corners: rect@0.1,0.1>0.3,0.2.
          // Written before the mark pattern below, because that one would match
          // the first half of this and silently place a mark instead.
          const drag = raw.match(/^([a-z]+)@([\d.]+),([\d.]+)>([\d.]+),([\d.]+)$/i)
          if (drag) {
            const kind = drag[1] as ToolKind
            const before = (devPlay.current.session.shapes ?? []).length
            // NEVER arm here. Arming is an explicit `arm:<kind>` step, because a
            // runner that quietly re-armed would draw all three shapes whether or
            // not the lock held — the check would pass against a completely
            // broken lock. The first version of this did exactly that. Requiring
            // the tool to be armed ALREADY is what gives the check teeth: with
            // the lock off, the second drag throws here and the run fails.
            if (devPlay.current.armed?.kind !== kind) {
              throw new Error(
                `dev place script: ${kind} is not armed. The previous step should have left it ` +
                  `armed (tool lock), or the script needs an explicit arm:${kind}. ` +
                  `Armed now: ${devPlay.current.armed?.kind ?? 'nothing'}`
              )
            }
            devPlay.current.drawShape(
              pageId,
              Number(drag[2]),
              Number(drag[3]),
              Number(drag[4]),
              Number(drag[5])
            )
            await until(
              `the ${kind} to land`,
              () => (devPlay.current.session.shapes ?? []).length > before
            )
            continue
          }
          const m = raw.match(/^([a-z]+)@([\d.]+),([\d.]+)$/i)
          if (!m) continue
          const kind = m[1] as ToolKind
          const before = (devPlay.current.session.marks ?? []).length
          devPlay.current.setArmed({ kind })
          await until(`the ${kind} tool to arm`, () => devPlay.current.armed?.kind === kind)
          devPlay.current.placeTool(pageId, Number(m[2]), Number(m[3]))
          // Either the mark lands, or the question opens. Both are settled
          // states; waiting for "one of them" is what makes this deterministic.
          await until(
            'the mark to land or the question to open',
            () =>
              (devPlay.current.session.marks ?? []).length > before ||
              !!devPlay.current.initialsPrompt
          )
        }
        } catch (error) {
          console.error(
            `[dev-script] step "${currentStep}" failed: ${(error as Error)?.message ?? String(error)}`
          )
          throw error
        }
        // Hand the scripted session back to the rest of this flow, which still
        // owns exporting and the snapshot.
        imported = devPlay.current.session
      }
      if (imported && seedMarks) {
        // Exercise the same model the palette uses, so the smoke test covers
        // place -> render -> export without simulating pointer events.
        // A neutral placeholder, not anyone's real initials. This is shipped
        // source: a maintainer's initials sitting in it read as the app being
        // personalised to them, and this value ends up as the author on every
        // mark the smoke test exports.
        imported = { ...imported, reviewer: 'RV' }
        imported = addMark(imported, {
          page: imported.pages[0].id,
          kind: 'tick',
          nx: 0.72,
          ny: 0.3,
          size: 24
        }).session
        const lettered = addMark(imported, {
          page: imported.pages[0].id,
          kind: 'text',
          nx: 0.4,
          ny: 0.45,
          size: 24,
          text: 'F'
        })
        imported = lettered.session
        // A custom stamp, on its own page so the page-0 color checks stay
        // unambiguous — covers the firm-legend path end to end.
        imported = addStamp(imported, 'TB')
        imported = addMark(imported, {
          page: imported.pages[1].id,
          kind: 'text',
          nx: 0.55,
          ny: 0.25,
          size: 24,
          text: 'TB'
        }).session
        // One finding placed as an agent would place it, so the smoke covers the
        // attribution path end to end: stamped in the model, shown in the UI,
        // and exported as "(AI)" rather than under the reviewer's initials.
        // It is a note rather than another agreed tick so the window snapshot
        // also exercises the Review Center's real exception path and wrapping.
        {
          const run = beginRun(imported)
          // Journal it as the MCP server does, so the smoke exercises the
          // stamp AND the action log rather than only the stamp.
          const logged = record(run.session, {
            action: 'place_mark',
            what: 'Flagged the wages figure for reviewer follow-up on page 2'
          })
          const agent = addMark(logged, {
            page: imported.pages[1].id,
            kind: 'note',
            nx: 0.28,
            ny: 0.62,
            size: 24,
            note: 'Confirm the wages figure agrees to the final W-2 summary before sign-off.'
          })
          imported = endRun(agent.session)
        }
        // A tape with lines already on it, so the smoke test exercises the
        // grid and the export rather than an empty card.
        const tape = addTape(imported, {
          page: imported.pages[0].id,
          nx: 0.68,
          ny: 0.55,
          entries: [1200, 340, -50].map(toTapeEntry),
          title: 'Repairs'
        })
        imported = tape.session
        setSession(imported)
        // Leave the lettered mark selected so the window snapshot captures the
        // inspector rather than an empty side panel.
        setSelectedMarkId(lettered.id)
      }
      // An export that fails sets a status and returns; it never throws. Carry
      // the reason out rather than leaving the smoke to infer it from a
      // missing file.
      let exported: string | undefined
      if (exportTo && imported) {
        const res = await devRefs.current.writeBinder(imported, exportTo)
        exported = res?.ok ? 'ok' : `failed: ${res?.error ?? 'no result'}`
      }
      // Report what loaded, not merely that we got here — an import that threw
      // lands on this line too, with `imported` still undefined.
      if (seedMarks) {
        if (preflight) setSendPreflightOpen(true)
        else {
          setReviewTab('attention')
          setReviewOpen(true)
        }
      }
      // Dev seam: reopen what was just written. The single-file reopen path is
      // the primary flow now and had no headless coverage, which is how a
      // refused readSource reached a person before a check did.
      if (reopen) {
        await devRefs.current.openBinderAt(reopen, true)
      }
      // Packaged seam: click the top of "Pick up where you left off". Goes
      // through the SAME openBinder the row does, so what is covered is the
      // path a person takes, not a private shortcut beside it.
      if (openRecent) {
        const list = await window.wpt.recentBinders()
        const first = list.find((r) => r.present !== false)
        if (!first) {
          window.wpt.devRendered({ pages: 0, sources: 0, exported: 'no recent binder to open' })
          return
        }
        await devRefs.current.openBinderAt(first.path, true)
        // Wait for OBSERVED state, never assume the render happened. openBinder
        // resolves when the session has been SET, not when React has re-rendered
        // — so reading the page count on the next line reports zero on a binder
        // that opened perfectly. That is what this reported the first time, and
        // the window screenshot beside it clearly said "Opened … — 3 pages".
        for (let i = 0; i < 200 && devPlay.current.session.pages.length === 0; i++) {
          await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 5)))
        }
      }
      window.wpt.devRendered({
        pages: openRecent
          ? (devPlay.current.session.pages.length ?? 0)
          : (imported?.pages.length ?? 0),
        sources: openRecent
          ? (devPlay.current.session.sources.length ?? 0)
          : (imported?.sources.length ?? 0),
        exported
      })
    })
  }, [])

  // ------------------------------------------------------------------ keyboard

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // While the cursor is in a text field, the field owns the keyboard.
      // Without this, typing reviewer initials armed the F stamp on "F" and
      // — much worse — deleted a binder page on Backspace. The bookmark rename
      // input guards itself with stopPropagation; this covers every field.
      const el = e.target as HTMLElement | null
      if (el && (el.isContentEditable || /^(input|textarea|select)$/i.test(el.tagName))) return

      // A modal owns the keyboard for as long as it is up, whatever happens to
      // have focus. The field guard above is not enough on its own: the click
      // that opens the initials question is a click on the page, and if the page
      // wins focus back the keystrokes arrive here with the body as their
      // target. Typing "ABC" then armed the calculator tape on "C" instead of
      // answering the question — and a stray letter that silently rearms a tool
      // while a dialog is open is how a preparer ends up placing the wrong mark.
      if (initialsPrompt) return

      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        return e.shiftKey ? redo() : undo()
      }
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void saveBinder(e.shiftKey)
        return
      }
      if (mod && e.key.toLowerCase() === 'o') {
        e.preventDefault()
        void openBinder()
        return
      }
      if (mod && e.key.toLowerCase() === 'i') {
        e.preventDefault()
        void addViaDialog()
        return
      }
      if (mod && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        addBookmarkHere()
        return
      }
      if (mod && e.key.toLowerCase() === 'e') {
        e.preventDefault()
        void saveCopyToSendOut()
        return
      }
      // A live tape owns the keyboard — digits, operators, Enter, ⌫, Esc —
      // routed here at the WINDOW rather than on the tape card, because the
      // moment you touch a keypad button focus leaves the card and typing
      // would otherwise go dead. That is exactly the bug this fixes.
      if (activeTapeId && !mod) {
        e.preventDefault()
        return tapeKey(e.key)
      }

      // Mark tools. Plain keys, so they stay out of the way of the browser's
      // and OS's modifier shortcuts.
      if (!mod && !e.repeat) {
        if (e.key === 'Escape') {
          if (sendPreflightOpen) {
            setSendPreflightOpen(false)
            setSendAnywayArmed(false)
            return
          }
          if (reviewOpen) {
            setReviewOpen(false)
            return
          }
          setArmed(null)
          setSelectedMarkId(null)
          setSelectedShapeId(null)
          setActiveTapeId(null)
          return
        }
        if (e.key === 'v' || e.key === 'V') {
          setArmed(null)
          return
        }
        if (e.key === 't' || e.key === 'T') return setArmed({ kind: 'tick' })
        if (e.key === 'x' || e.key === 'X') return setArmed({ kind: 'cross' })
        if (e.key === 'f' || e.key === 'F') return setArmed({ kind: 'text', text: 'F' })
        if (e.key === 'c' || e.key === 'C') return setArmed({ kind: 'tape' })
        if (e.key === 'r' || e.key === 'R') return setArmed({ kind: 'rect' })
        if (e.key === 'o' || e.key === 'O') return setArmed({ kind: 'ellipse' })
        if (e.key === 'l' || e.key === 'L') return setArmed({ kind: 'line' })
        if (e.key === 'a' || e.key === 'A') return setArmed({ kind: 'arrow' })
        if (e.key === 'h' || e.key === 'H') return setArmed({ kind: 'highlight' })
        if (e.key === 'n' || e.key === 'N') return setArmed({ kind: 'textbox' })
        if (e.key === '+' || e.key === '=') return resizeMark(4)
        if (e.key === '_' || e.key === '-') return resizeMark(-4)
      }
      if (e.key === '[') return rotate(-90)
      if (e.key === ']') return rotate(90)
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault()
        // The most specific selection wins; fall through to pages.
        if (selectedMarkId) return deleteMark()
        if (selectedShapeId) return deleteShape()
        return remove()
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        e.preventDefault()
        return mod ? nudge(1) : step(1)
      }
      if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        e.preventDefault()
        return mod ? nudge(-1) : step(-1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    undo,
    redo,
    rotate,
    remove,
    step,
    nudge,
    saveBinder,
    openBinder,
    addViaDialog,
    saveCopyToSendOut,
    addBookmarkHere,
    resizeMark,
    deleteMark,
    activeTapeId,
    tapeKey,
    deleteShape,
    selectedMarkId,
    selectedShapeId,
    initialsPrompt,
    reviewOpen,
    sendPreflightOpen
  ])

  /** Drag the divider to widen the bookmark panel — real titles are long.
   *  The panel is on the LEFT, so dragging right widens it. */
  const startResize = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = sideW
    const onMove = (ev: PointerEvent): void =>
      setSideW(Math.max(200, Math.min(720, startW + (ev.clientX - startX))))
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [sideW])

  // ---------------------------------------------------------------- drag-drop

  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault()
      // Hand everything to the main process — it owns the list of what may
      // enter a binder and returns only what it authorized.
      const files = [...e.dataTransfer.files]
      if (!files.length) return
      const allowed = await window.wpt.registerDroppedFiles(files)
      if (!allowed.length) return setStatus('Nothing added — drop PDFs or images.')
      await importPaths(allowed)
    },
    [importPaths]
  )

  const count = selected.size || (current ? 1 : 0)
  // Boundaries for the move buttons, so they disable instead of silently
  // no-opping at the ends of the binder.
  const activeIdxs = (selected.size ? [...selected] : current ? [current.id] : []).map((id) =>
    pages.findIndex((p) => p.id === id)
  )
  const minSelectedIndex = activeIdxs.length ? Math.min(...activeIdxs) : -1
  const maxSelectedIndex = activeIdxs.length ? Math.max(...activeIdxs) : -1

  return (
    <div
      className="app"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault()
      }}
      onDrop={onDrop}
    >
      <header className="toolbar">
        <div className="toolbar-row">
        {/* Options leads the row. It sat at the far right beside Save because
            page numbering is a decision about the OUTPUT — but that put a
            settings menu inside the run of file verbs, where the eye is looking
            for Save. Settings belong at the edge, before the work. */}
        <ExportMenu
          numbering={numberCfg}
          onNumbering={(patch) =>
            apply({ ...session, numbering: { ...numberCfg, ...patch } }, 'Binder options updated.')
          }
          pageCount={pages.length}
        />
        <LegendMenu
          session={session}
          busy={busy}
          onMeaning={(token, meaning) =>
            apply(setLegend(session, token, meaning), 'Legend updated.')
          }
          onAddStamp={(token, meaning) =>
            // A token the toolbar already has a dedicated button for needs its
            // MEANING, not a second copy of itself in the stamp list. Adding it
            // would give a reviewer two Fs that behave identically.
            apply(
              FIXED_TOOL_TOKENS.has(token)
                ? setLegend(session, token, meaning)
                : setLegend(addStamp(session, token), token, meaning),
              FIXED_TOOL_TOKENS.has(token)
                ? `${token} already has a button — recorded what it means: ${meaning}`
                : `"${token}" added to your stamps — ${meaning}`
            )
          }
          onAddPage={() => void addLegendPage()}
        />
        <span className="sep" />
        <button onClick={() => rotate(-90)} disabled={!count} title="Rotate left  [">
          ⟲
        </button>
        <button onClick={() => rotate(90)} disabled={!count} title="Rotate right  ]">
          ⟳
        </button>
        <button
          className="move"
          onClick={() => nudge(-1)}
          disabled={!count || minSelectedIndex <= 0}
          aria-label="Move selected pages earlier"
          title={`Move the selected page(s) earlier in the binder  ${MOD}↑`}
        >
          ↑
        </button>
        <button
          className="move"
          onClick={() => nudge(1)}
          disabled={!count || maxSelectedIndex >= pages.length - 1}
          aria-label="Move selected pages later"
          title={`Move the selected page(s) later in the binder  ${MOD}↓`}
        >
          ↓
        </button>
        <button onClick={remove} disabled={!count} title="Delete (undoable)  ⌫">
          Delete
        </button>
        <StatusMenu
          defs={defs}
          counts={counts}
          parts={parts}
          currentStatusId={currentStatus?.id ?? null}
          targetCount={count}
          onApply={applyStatus}
          onClear={clearStatus}
          onAddDef={addStatusDef}
          onEditDef={editStatusDef}
          onRemoveDef={removeStatusDef}
          onParts={setParts}
          reviewer={reviewerInitials}
          onReviewer={rememberInitials}
        />
        <span className="sep" />
        <span className="palette" title="Review marks — click a tool, then click the page">
          <button
            className={!armed ? 'on' : ''}
            onClick={() => setArmed(null)}
            title="Select — click a mark or shape to move it  (V or Esc)"
          >
            ↖
          </button>
          <button
            className={armed?.kind === 'tick' ? 'on' : ''}
            style={{ color: MARK_COLOR.tick }}
            onClick={() => setArmed({ kind: 'tick' })}
            title="Tick — agreed  (T). Click the page to place."
          >
            ✓
          </button>
          <button
            className={armed?.kind === 'cross' ? 'on' : ''}
            style={{ color: MARK_COLOR.cross }}
            onClick={() => setArmed({ kind: 'cross' })}
            title="Cross — does not agree  (X). Click the page to place."
          >
            ✕
          </button>
          <button
            className={armed?.kind === 'text' && armed.text === 'F' ? 'on' : ''}
            style={{ color: MARK_COLOR.text }}
            onClick={() => setArmed({ kind: 'text', text: 'F' })}
            title="F — footed  (F). Click the page to place."
          >
            F
          </button>
          {/* Not disabled when there are no initials yet. A greyed-out control
              carrying a bare dash is unreadable — it looks like a divider or a
              rendering fault, not a setting, and clicking it to find out taught
              nothing because nothing happened. It now asks the question it is
              waiting on. */}
          <button
            className={armed?.kind === 'text' && armed.text === reviewerInitials ? 'on' : ''}
            style={{ color: MARK_COLOR.text }}
            onClick={() => {
              if (reviewerInitials) return setArmed({ kind: 'text', text: reviewerInitials })
              setInitialsDraft('')
              setInitialsPrompt({ mark: null })
            }}
            title={
              reviewerInitials
                ? `Stamp your initials (${reviewerInitials})`
                : 'Stamp your initials — click to set them'
            }
          >
            {reviewerInitials || '··'}
          </button>
          <button
            className={armed?.kind === 'date' ? 'on' : ''}
            style={{ color: MARK_COLOR.date }}
            onClick={() => setArmed({ kind: 'date' })}
            title="Date stamp — uses today's local calendar date. Click the page to place."
          >
            Date
          </button>
          <button
            className={armed?.kind === 'tape' ? 'on' : ''}
            onClick={() => setArmed({ kind: 'tape' })}
            title="Calculator tape — click the page, then key numbers like a 10-key  (C)"
          >
            <span className="glyph-tape">Tape</span>
          </button>
          {/* Connectors and stamps are each ONE control. Loose in the ribbon
              they filled it edge to edge — see each component's header. */}
          <ConnectorMenu
            session={session}
            armedLabel={armed?.kind === 'conn' ? (armed.text ?? null) : null}
            onArm={(label) => setArmed({ kind: 'conn', text: label })}
          />
          {/* The firm's own tickmarks, behind ONE control. Loose in the ribbon
              they filled it edge to edge the moment the legend's presets made
              eleven of them a click away — see StampMenu's header. */}
          <StampMenu
            stamps={stamps}
            legend={session.legend ?? {}}
            armedText={armed?.kind === 'text' ? (armed.text ?? null) : null}
            onArm={(text) => setArmed({ kind: 'text', text })}
            onAdd={addStampNamed}
            onRemove={dropStamp}
          />
          <span className="sep-thin" />
          {(
            [
              ['rect', '▭', 'Rectangle', 'R'],
              ['ellipse', '◯', 'Ellipse — circle a figure', 'O'],
              ['line', '╱', 'Line', 'L'],
              ['arrow', '➔', 'Arrow', 'A'],
              ['highlight', '▬', 'Highlighter', 'H'],
              ['textbox', 'T', 'Text note', 'N']
            ] as const
          ).map(([kind, glyph, label, key]) => (
            <button
              key={kind}
              className={armed?.kind === kind ? 'on' : ''}
              style={{ color: kind === 'highlight' ? '#c9a800' : SHAPE_COLORS[shapeColor] }}
              onClick={() => setArmed({ kind })}
              title={`${label} — drag to draw  (${key})${
                kind === 'rect' || kind === 'ellipse' ? '. Hold ⇧ for a square/circle.' : ''
              }`}
            >
              {kind === 'textbox' ? <span className="glyph-note">{glyph}</span> : glyph}
            </button>
          ))}
          <ColorMenu
            color={shapeColor}
            appliesToSelection={!!selectedShapeId}
            onPick={(c) => {
              setShapeColor(c)
              if (selectedShapeId) editShape({ color: c })
            }}
          />
          {/* Named, not drawn. A padlock glyph here would be one more icon to
              ask about, and this one needs no explaining if it says what it is. */}
          <button
            className={`toollock${toolLock ? ' on' : ''}`}
            aria-pressed={toolLock}
            disabled={!lockFamily}
            onClick={toggleToolLock}
            title={
              !lockFamily
                ? armed
                  ? 'Keep tool — the tape is always one at a time, so there is nothing to keep.'
                  : 'Keep tool — pick a mark or a drawing tool first, then this keeps it selected between uses.'
                : toolLock
                  ? `Keep tool: ON — the ${lockFamily === 'draw' ? 'drawing tool stays selected, so you can box or circle' : 'mark stays selected, so you can tick or stamp'} several in a row. Click to turn off, or press Esc to drop the tool.`
                  : `Keep tool: OFF — the ${lockFamily === 'draw' ? 'drawing tool deselects after one shape, so the next click selects what you drew' : 'mark deselects after one, so the next click selects what you placed'}. Turn on to ${lockFamily === 'draw' ? 'draw' : 'place'} several in a row.`
            }
          >
            Keep tool
          </button>
        </span>
        <span className="sep" />
        <button onClick={undo} title={`Undo  ${MOD}Z`}>
          ↶
        </button>
        <button onClick={redo} title={`Redo  ${MOD}⇧Z`}>
          ↷
        </button>
        <span className="spacer" />
        {/* Add sits with Open and Save: they are the file verbs, and it was
            stranded at the far left away from the two it belongs with. */}
        <button
          onClick={addViaDialog}
          disabled={busy}
          title={`Add PDFs, spreadsheets, memos or images  ${MOD}I`}
        >
          Add
        </button>
        <button onClick={() => void openBinder()} title={`Open a binder  ${MOD}O`}>
          Open
        </button>
        {/* One Save in the row. The send-out copy used to sit beside it as a
            second button, and both starting with "Save" made them read as two
            flavours of one action when they are two destinations — the second
            produces a file with the marks printed on permanently and the
            editable session removed. It is on the caret now: clicking Save
            still saves, because that happens once a minute and should cost
            nothing, and the other destination happens once an engagement. */}
        <SaveMenu
          onSave={() => void saveBinder(false)}
          onSendOut={() => void saveCopyToSendOut()}
          disabled={busy || !pages.length}
          saveHint={`Save this binder  ${MOD}S    (${MOD}⇧S to save it under a new name)`}
          sendHint={`Save a copy for a client or a file room. Marks are printed on permanently and it cannot be reopened for editing.  ${MOD}E`}
        />
        </div>
      </header>

      <div className="body" style={{ ['--side-w' as string]: `${sideW}px` }}>
        {pages.length === 0 ? (
          <div className="dropzone">
            <div className="dropzone-inner">
              <p className="dz-title">Drop PDFs, spreadsheets, memos or images here</p>
              <p className="dz-sub">
                or <button className="link" onClick={addViaDialog}>choose files</button> · nothing
                leaves this machine
              </p>
              {recents.length > 0 && (
                <div className="recents">
                  <div className="recents-head">
                    <span>Pick up where you left off</span>
                    <button
                      className="link"
                      title="Forget this list. It holds engagement file paths, which carry client names."
                      onClick={async () => {
                        await window.wpt.clearRecentBinders()
                        setRecents([])
                      }}
                    >
                      Clear
                    </button>
                  </div>
                  {recents.map((r) => (
                    <button
                      key={r.path}
                      className={r.present === false ? 'recent is-missing' : 'recent'}
                      // A binder that moved is still worth showing — a file
                      // that vanished off a shared drive is something to
                      // notice, not something to quietly forget.
                      disabled={r.present === false}
                      title={r.present === false ? `${r.path} — no longer there` : r.path}
                      onClick={() => void openBinder(r.path)}
                    >
                      <span className="recent-name">{r.name}</span>
                      <span className="recent-when">
                        {r.present === false ? 'missing' : whenShort(r.at)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : (
          <>
            <aside className="side">
              <BookmarkPanel
                session={session}
                pageCounts={pageCounts}
                onTogglePageCounts={setPageCounts}
                onRename={(key, title) =>
                  apply(
                    setBookmarkTitle(session, key, title),
                    title ? 'Bookmark renamed.' : 'Bookmark title reverted.'
                  )
                }
                onAdd={addBookmarkHere}
                onRemove={(key) => apply(removeBookmark(session, key), 'Bookmark removed.')}
                currentPageId={current?.id ?? null}
                onAssign={(key, pageId) =>
                  apply(
                    assignBookmarkPage(session, key, pageId),
                    `Bookmark moved to page ${pages.findIndex((p) => p.id === pageId) + 1}.`
                  )
                }
                onClearAssign={(key) =>
                  apply(clearBookmarkPage(session, key), 'Bookmark sent back to its imported page.')
                }
                onIndent={(key, delta) =>
                  apply(nudgeBookmarkDepth(session, key, delta), 'Bookmark nesting changed.')
                }
                onMoveSection={(key, beforeKey) => {
                  const moving = bookmarkSection(session, key).length
                  const next = moveBookmarkSection(session, key, beforeKey)
                  if (next === session) return setStatus('Nothing to move there.')
                  apply(next, `Moved ${moving} page${moving === 1 ? '' : 's'} with the bookmark.`)
                }}
                canAdd={!!current}
                autoEditKey={autoEditKey}
                onAutoEditDone={() => setAutoEditKey(null)}
                onJump={(id) => {
                  setCurrentId(id)
                  setSelected(new Set([id]))
                }}
              />
              {selectedMark && (
                <MarkInspector mark={selectedMark} onChange={editMark} onDelete={deleteMark} />
              )}
              {selectedShape && (
                <ShapeInspector shape={selectedShape} onChange={editShape} onDelete={deleteShape} />
              )}
            </aside>
            <div
              className="splitter"
              onPointerDown={startResize}
              title="Drag to resize"
              role="separator"
            />
            <PageView
              session={session}
              page={current}
              pageIndex={currentIndex}
              pageCount={pages.length}
              onGoto={goto}
              armed={armed}
              selectedMarkId={selectedMarkId}
              onCurrentPage={onScrolledToPage}
              onPlaceMark={placeTool}
              onSelectMark={setSelectedMarkId}
              onMoveMark={moveMark}
              activeTapeId={activeTapeId}
              onActivateTape={activateTape}
              tapeBuffer={tapeBuffer}
              tapeOp={tapeOp}
              onTapeKey={tapeKey}
              onMoveTape={moveTape}
              onTitleTape={titleTape}
              onDeleteTape={deleteTape}
              shapeColor={shapeColor}
              selectedShapeId={selectedShapeId}
              onDrawShape={drawShape}
              onFollowLink={followLink}
              onSelectShape={setSelectedShapeId}
              onMoveShape={nudgeShape}
              onResizeShape={(id, patch) => setSession((prev) => updateShape(prev, id, patch))}
              onTextShape={(id, text) => setSession((prev) => updateShape(prev, id, { text }))}
            />
            <ThumbnailRail
              session={session}
              selected={selected}
              currentId={current?.id ?? null}
              onSelect={select}
              onReorder={(ids, before) => apply(movePages(session, ids, before), 'Reordered.')}
            />
          </>
        )}
      </div>

      {reviewOpen && (
        <ReviewCenter
          snapshot={review}
          tab={reviewTab}
          onTab={setReviewTab}
          onClose={() => setReviewOpen(false)}
          onJump={(pageId) => {
            setCurrentId(pageId)
            setSelected(new Set([pageId]))
            setReviewOpen(false)
          }}
          onResolve={(pageId, nextStatus) => {
            const label = defs.find((definition) => definition.id === nextStatus)?.label ?? nextStatus
            apply(
              setPageStatus(session, [pageId], nextStatus, reviewerInitials),
              `Page ${pages.findIndex((page) => page.id === pageId) + 1} marked "${label}".`
            )
          }}
          onRevert={revertAgentRun}
        />
      )}

      {sendPreflightOpen && (
        <SendOutPreflight
          snapshot={review}
          confirmAnyway={sendAnywayArmed}
          onArmAnyway={() => {
            if (!sendAnywayArmed) return setSendAnywayArmed(true)
            setSendPreflightOpen(false)
            setSendAnywayArmed(false)
            void writeCopyToSendOut()
          }}
          onReview={() => {
            setSendPreflightOpen(false)
            setSendAnywayArmed(false)
            setReviewTab('attention')
            setReviewOpen(true)
          }}
          onContinue={() => {
            setSendPreflightOpen(false)
            void writeCopyToSendOut()
          }}
          onClose={() => {
            setSendPreflightOpen(false)
            setSendAnywayArmed(false)
          }}
        />
      )}

      {/* The backdrop is not decoration. Without it the page stays live behind
          the question, and a click meant for the dialog lands on the binder and
          moves the very mark being asked about. It swallows the click instead,
          and closes on a click outside the way a dialog is expected to. */}
      {initialsPrompt && (
        <div className="initials-backdrop" onMouseDown={cancelInitials}>
          <div
            className="initials-ask"
            role="dialog"
            aria-modal="true"
            aria-label="Set your initials"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <p className="ia-q">Your initials?</p>
            <p className="ia-why">
              Marks record who made them — a tick with no author is not evidence of anything.
              They are remembered for the next binder too.
            </p>
            <div className="ia-row">
              <input
                className="ia-input"
                ref={initialsInput}
                autoFocus
                value={initialsDraft}
                maxLength={4}
                placeholder="e.g. ABC"
                onChange={(e) => setInitialsDraft(e.target.value.toUpperCase().slice(0, 4))}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter') commitInitials()
                  if (e.key === 'Escape') cancelInitials()
                }}
              />
              <button className="ia-go" onClick={commitInitials} disabled={!initialsDraft.trim()}>
                {initialsPrompt.mark ? 'Place mark' : 'Save'}
              </button>
              <button className="ia-cancel" onClick={cancelInitials}>
                Cancel
              </button>
            </div>
            <p className="ia-later">Change them later in Status ▸ Options.</p>
          </div>
        </div>
      )}

      {agentPanelOpen && (
        <AgentAccessPanel
          liveOn={liveOn}
          onToggleLive={async () => {
            const res = await window.wpt.setLive(!liveOn)
            setStatus(
              res.on
                ? 'Live access to this binder ON — an agent can now read and change it.'
                : 'Live access to this binder off.'
            )
          }}
          onClose={() => setAgentPanelOpen(false)}
        />
      )}

      {activeTape && keypadOpen && (
        <Keypad
          tape={activeTape}
          buffer={tapeBuffer}
          pendingOp={tapeOp}
          onKey={tapeKey}
          onEditEntry={editTapeEntry}
          onRemoveEntry={removeTapeLine}
          onClose={() => {
            setKeypadOpen(false)
            setActiveTapeId(null)
            setTapeBuffer('')
          }}
          onSize={(size) =>
            apply(
              updateTape(session, activeTape.id, {
                size: Math.max(TAPE_SIZE_MIN, Math.min(TAPE_SIZE_MAX, size))
              }),
              `Tape size ${size}.`
            )
          }
          onNewTape={() => setArmed({ kind: 'tape' })}
        />
      )}

      <footer className="statusbar">
        <span className={busy ? 'working' : ''}>{busy ? 'Working…' : status}</span>
        {/* Counts are readouts, not controls — the status bar is where a reader
            looks for them, and it keeps the side pane to bookmarks. */}
        <span className="counts">
          <b>{pages.length}</b> page{pages.length === 1 ? '' : 's'} ·{' '}
          <b>{session.sources.length}</b> source{session.sources.length === 1 ? '' : 's'} ·{' '}
          <b>{selected.size}</b> selected
          {session.marks?.length ? (
            <>
              {' '}· <b>{session.marks.length}</b> mark{session.marks.length === 1 ? '' : 's'}
            </>
          ) : null}
          {session.tapes?.length ? (
            <>
              {' '}· <b>{session.tapes.length}</b> tape{session.tapes.length === 1 ? '' : 's'}
            </>
          ) : null}
          {session.shapes?.length ? (
            <>
              {' '}· <b>{session.shapes.length}</b> shape{session.shapes.length === 1 ? '' : 's'}
            </>
          ) : null}
          {pages.length ? (
            <>
              {' '}·{' '}
              <button
                className={`review-count link${review.active.length ? ' has-open' : ''}`}
                onClick={() => {
                  setReviewTab('attention')
                  setReviewOpen(true)
                }}
                title="Open the Review Center: exceptions, coverage, and agent work"
              >
                Review · {review.active.length} open
              </button>
            </>
          ) : null}
          {/* Opening a binder an agent worked on should say so without being
              asked. A reviewer signing this file needs to know before they
              scroll, not after. */}
          {aiCount ? (
            <>
              {' '}·{' '}
              <button
                className="ai-count link"
                onClick={() => {
                  setReviewTab('ai')
                  setReviewOpen(true)
                }}
                title={`${aiCount} AI-created page item${aiCount === 1 ? '' : 's'}: marks, tapes and shapes. Click to see logged actions or undo a run.`}
              >
                {aiCount} AI-created item{aiCount === 1 ? '' : 's'}
              </button>
            </>
          ) : null}
        </span>
        <button
          className={liveOn ? 'live-toggle is-on' : 'live-toggle'}
          onClick={async () => {
            const res = await window.wpt.setLive(!liveOn)
            setStatus(
              res.on
                ? 'Live access to this binder ON — an agent can now read and change it.'
                : 'Live access to this binder off.'
            )
          }}
          title={
            liveOn
              ? 'An agent can read and change this open binder right now. Click to stop.'
              : 'Let an agent work on the binder currently on screen. Off by default.'
          }
        >
          {liveOn ? 'Open binder access: ON' : 'Open binder access: off'}
        </button>
        {/* Beside the toggle rather than replacing it. One click to let an agent
            in stays right; what an agent may READ is a separate, longer-lived
            decision and needs somewhere to live. */}
        <button
          className="live-settings"
          onClick={() => setAgentPanelOpen(true)}
          title="Approve folders an agent may read, and how to connect one"
        >
          Agent access…
        </button>
        <span className="muted">
          {binderPath ? baseName(binderPath) : 'unsaved binder'}
          {dirty ? ' · unsaved changes' : binderPath ? ' · saved' : ''} · drag to reorder · [ ] rotate ·
          ⌫ delete · {MOD}Z undo
        </span>
      </footer>
    </div>
  )
}
