import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BookmarkPanel } from './components/BookmarkPanel'
import { MarkInspector } from './components/MarkInspector'
import { ShapeInspector } from './components/ShapeInspector'
import { Keypad } from './components/Keypad'
import { StatusMenu } from './components/StatusMenu'
import { ColorMenu } from './components/ColorMenu'
import { ExportMenu } from './components/ExportMenu'
import { PageView } from './components/PageView'
import { ThumbnailRail } from './components/ThumbnailRail'
import { MARK_COLOR } from './components/MarkLayer'
import { forgetDoc } from './pdf'
import {
  MARK_SIZE_DEFAULT,
  STAMP_MAX_LEN,
  addBookmark,
  addMark,
  addSource,
  addShape,
  assignBookmarkPage,
  clearBookmarkPage,
  addStamp,
  addTape,
  baseName,
  formatAmount,
  tapeTotal,
  deletePages,
  movePages,
  newSession,
  nudgeBookmarkDepth,
  parseSession,
  parseAmount,
  rebindToBinder,
  tapeKeyPress,
  toTapeEntry,
  removeTapeEntry,
  updateTapeEntry,
  removeBookmark,
  removeMarks,
  clearPageStatus,
  isShapeKind,
  moveShape,
  removeShapes,
  removeStamp,
  removeTapes,
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

const MOD = window.wpt.platform === 'darwin' ? '⌘' : 'Ctrl'

function sourceMatches(source: SourceDoc, probe: ProbeWire): boolean {
  if (source.nPages !== probe.n_pages) return false
  if (source.kind !== (probe.kind === 'image' ? 'image' : 'pdf')) return false
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
  const [selectedMarkId, setSelectedMarkId] = useState<string | null>(null)
  const [activeTapeId, setActiveTapeId] = useState<string | null>(null)
  const [tapeBuffer, setTapeBuffer] = useState('')
  const [tapeOp, setTapeOp] = useState<TapeOp>('+')
  const [keypadOpen, setKeypadOpen] = useState(true)
  const [markSize] = useState(MARK_SIZE_DEFAULT)
  const [stampDraft, setStampDraft] = useState('')
  const [addingStamp, setAddingStamp] = useState(false)
  const [shapeColor, setShapeColor] = useState<ShapeColor>('red')
  const [selectedShapeId, setSelectedShapeId] = useState<string | null>(null)
  const shapeArmed = !!armed && isShapeKind(armed.kind)
  const activeTape = useMemo(
    () => (session.tapes ?? []).find((t) => t.id === activeTapeId) ?? null,
    [session.tapes, activeTapeId]
  )
  const reviewerInitials = session.reviewer ?? ''
  const stamps = session.stamps ?? []
  const past = useRef<Session[]>([])
  const future = useRef<Session[]>([])
  const lastSaved = useRef(JSON.stringify(newSession()))
  const saving = useRef(false)

  const pages = session.pages
  const serializedSession = useMemo(() => JSON.stringify(session), [session])
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

  // ------------------------------------------------------------------ import

  const importPaths = useCallback(
    async (paths: string[]): Promise<Session | null> => {
      if (paths.length === 0) return null
      setBusy(true)
      try {
        let next = session
        const failed: string[] = []
        for (const p of paths) {
          const res = await window.wpt.probe(p)
          if (res.ok && res.probe) {
            next = addSource(next, res.probe as ProbeWire)
          } else {
            failed.push(`${baseName(p)}: ${res.error ?? 'unreadable'}`)
          }
        }
        if (next !== session) {
          apply(next, `Added ${paths.length - failed.length} file(s).`)
          setCurrentId((cur) => cur ?? next.pages[0]?.id ?? null)
        }
        if (failed.length) setStatus(`Could not add — ${failed.join('; ')}`)
        return next === session ? null : next
      } finally {
        setBusy(false)
      }
    },
    [session, apply]
  )

  const addViaDialog = useCallback(async () => {
    const paths = await window.wpt.openPdfs()
    await importPaths(paths)
  }, [importPaths])

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
    (pageId: string, nx: number, ny: number) => {
      if (!armed) return
      const target = pages.find((p) => p.id === pageId)
      if (!target) return
      if (armed.kind === 'tape') {
        const onPage = (session.tapes ?? []).filter((t) => t.page === pageId).length
        const { session: next, id } = addTape(session, {
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
      const { session: next, id } = addMark(session, {
        page: pageId,
        kind: armed.kind,
        nx,
        ny,
        size: markSize,
        ...(armed.text ? { text: armed.text } : {})
      })
      apply(next, `${armed.kind === 'text' ? armed.text : armed.kind} placed.`)
      setSelectedMarkId(id)
    },
    [pages, armed, session, markSize, apply]
  )

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

  /** Inspector edits — note, author, letters, size — on the selected mark. */
  const editMark = useCallback(
    (patch: Partial<Mark>) => {
      if (!selectedMarkId) return
      apply(updateMark(session, selectedMarkId, patch), 'Mark updated.')
    },
    [selectedMarkId, session, apply]
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
      apply(next, `${kind} drawn — drag it to move, corners to resize. ${KEY[kind]} to draw another.`)
      setSelectedShapeId(id)
      setSelectedMarkId(null)
      // Disarm after ONE shape, unlike the mark tools. A shape is drawn and
      // then adjusted; staying armed meant every click meant to grab it drew
      // another one on top instead.
      setArmed(null)
    },
    [pages, armed, session, shapeColor, apply]
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

  /** Save whatever is in the box as a reusable stamp, and arm it immediately. */
  const saveStamp = useCallback(() => {
    const next = addStamp(session, stampDraft)
    if (next === session) return setStampDraft('')
    const text = next.stamps![next.stamps!.length - 1]
    apply(next, `Stamp "${text}" saved.`)
    setArmed({ kind: 'text', text })
    setStampDraft('')
  }, [session, stampDraft, apply])

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
  const saveCopyToSendOut = useCallback(async () => {
    if (!pages.length) return setStatus('Nothing to send yet — add some pages.')
    const out = await window.wpt.chooseBinderOutput(`${binderStem} (copy to send).pdf`)
    if (!out) return
    if (binderPath && out === binderPath) {
      return setStatus(
        'That is the binder you are working in. Choose a different name — a flattened copy cannot be edited again.'
      )
    }
    await writeBinder(session, out, { flatten: true, reveal: true })
  }, [session, pages.length, binderPath, binderStem, writeBinder])

  /** Load a session into the editor, replacing whatever is open. */
  const adoptSession = useCallback(
    (next: Session, path: string | null, note: string, clean: boolean) => {
      for (const s of next.sources) forgetDoc(s.id)
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

  const openBinder = useCallback(async () => {
    if (dirty && !(await window.wpt.confirmDiscard())) return

    const res = await window.wpt.openBinder()
    if (!res) return

    if (res.kind === 'error') {
      return setStatus(`Cannot open ${baseName(res.path)} — ${res.error}`)
    }

    // An ordinary PDF with nothing of ours inside. Not a failure — it is how
    // every binder starts. Say so in words that suggest the next action.
    if (res.kind === 'plain') {
      return setStatus(
        `${baseName(res.path)} is a plain PDF with no saved marks. Use Add files to start a binder from it.`
      )
    }

    // ---- a saved binder
    if (res.kind === 'binder') {
      const parsed = parseSession(res.session)
      if ('error' in parsed) {
        return setStatus(`Cannot open ${baseName(res.path)} — ${parsed.error}`)
      }
      if (!res.payloadIntact) {
        return setStatus(
          `Cannot open ${baseName(res.path)} — the saved marks inside it are damaged.`
        )
      }
      const probed = await window.wpt.probe(res.workingPath)
      if (!probed.ok || !probed.probe) {
        return setStatus(`Cannot read ${baseName(res.path)} — ${probed.error ?? 'unreadable'}`)
      }
      const rebound = rebindToBinder(
        parsed.session,
        probed.probe as ProbeWire,
        res.workingPath,
        baseName(res.path)
      )
      if (rebound.error) {
        return setStatus(`Cannot open ${baseName(res.path)} — ${rebound.error}`)
      }

      // The pages moved since this session was written. The marks will load and
      // will look fine, and some of them will be in the wrong place. Say that
      // plainly rather than opening quietly.
      const moved = !res.geometryMatches
      const stale = res.pendingAutosave !== undefined

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
    adoptSession(
      openedSession,
      null,
      recovered
        ? `Recovered ${baseName(res.path)} from its previous complete save. This is the older two-file format — Save will convert it to a single binder.`
        : `Opened ${baseName(res.path)} — ${openedSession.pages.length} pages, source identity verified. This is the older two-file format — Save will convert it to a single binder.`,
      false
    )
  }, [dirty, adoptSession])

  // Dev seam (WPT_DEV_OPEN / WPT_DEV_EXPORT): drive the whole Phase 1 flow —
  // import, then optionally a real export through IPC + engine — with no
  // dialogs, so it can be smoke-tested automatically. Handlers are read through
  // refs so this subscribes exactly once.
  const devRefs = useRef({ importPaths, writeBinder })
  devRefs.current = { importPaths, writeBinder }
  useEffect(() => {
    window.wpt.onDevOpen(async ({ paths, exportTo, seedMarks }) => {
      let imported = await devRefs.current.importPaths(paths)
      if (imported && seedMarks) {
        // Exercise the same model the palette uses, so the smoke test covers
        // place -> render -> export without simulating pointer events.
        imported = { ...imported, reviewer: 'CJB' }
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
      window.wpt.devRendered({
        pages: imported?.pages.length ?? 0,
        sources: imported?.sources.length ?? 0,
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
    selectedShapeId
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
        <button onClick={addViaDialog} disabled={busy} title={`Add PDFs or images  ${MOD}I`}>
          Add
        </button>
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
          title={`Move the selected page(s) earlier in the binder  ${MOD}↑`}
        >
          Move ↑
        </button>
        <button
          className="move"
          onClick={() => nudge(1)}
          disabled={!count || maxSelectedIndex >= pages.length - 1}
          title={`Move the selected page(s) later in the binder  ${MOD}↓`}
        >
          Move ↓
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
          onReviewer={(v) => setSession((prev) => ({ ...prev, reviewer: v }))}
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
          <button
            className={armed?.kind === 'text' && armed.text === reviewerInitials ? 'on' : ''}
            style={{ color: MARK_COLOR.text }}
            onClick={() => setArmed({ kind: 'text', text: reviewerInitials })}
            disabled={!reviewerInitials}
            title={
              reviewerInitials
                ? `Stamp your initials (${reviewerInitials})`
                : 'Stamp your initials — set them in Status ▸ Options first'
            }
          >
            {reviewerInitials || '—'}
          </button>
          <button
            className={armed?.kind === 'tape' ? 'on' : ''}
            onClick={() => setArmed({ kind: 'tape' })}
            title="Calculator tape — click the page, then key numbers like a 10-key  (C)"
          >
            <span className="glyph-tape">Tape</span>
          </button>
          {/* The firm's own legend sits with the fixed palette — they are the
              same gesture: arm a stamp, click the page. */}
          {stamps.map((s) => (
            <span
              key={s}
              className={`stamp${armed?.kind === 'text' && armed.text === s ? ' on' : ''}`}
            >
              <button
                className="stamp-arm"
                onClick={() => setArmed({ kind: 'text', text: s })}
                title={`Place "${s}"`}
              >
                {s}
              </button>
              <button
                className="stamp-drop"
                onClick={() => dropStamp(s)}
                title={`Remove "${s}" from the palette (marks already placed stay)`}
              >
                ×
              </button>
            </span>
          ))}
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
          <span className="sep-thin" />
          {addingStamp ? (
            <input
              className="stamp-input"
              autoFocus
              value={stampDraft}
              maxLength={STAMP_MAX_LEN}
              placeholder="TB"
              onChange={(e) => setStampDraft(e.target.value)}
              onBlur={() => {
                saveStamp()
                setAddingStamp(false)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  saveStamp()
                  setAddingStamp(false)
                }
                if (e.key === 'Escape') {
                  setStampDraft('')
                  setAddingStamp(false)
                }
              }}
            />
          ) : (
            <button
              className="stamp-new-btn"
              onClick={() => setAddingStamp(true)}
              title="Add your own stamp — TB, PY, A/R…"
            >
              +
            </button>
          )}
        </span>
        <span className="sep" />
        <button onClick={undo} title={`Undo  ${MOD}Z`}>
          ↶
        </button>
        <button onClick={redo} title={`Redo  ${MOD}⇧Z`}>
          ↷
        </button>
        <span className="spacer" />
        <button onClick={openBinder} title={`Open a binder  ${MOD}O`}>
          Open
        </button>
        <ExportMenu
          numbering={numberCfg}
          onNumbering={(patch) =>
            apply({ ...session, numbering: { ...numberCfg, ...patch } }, 'Binder options updated.')
          }
          pageCount={pages.length}
        />
        <button
          onClick={() => void saveCopyToSendOut()}
          disabled={busy || !pages.length}
          title={`Save a copy for a client or a file room. Marks are printed on permanently and it cannot be reopened for editing.  ${MOD}E`}
        >
          Save a copy to send out
        </button>
        <button
          className="primary"
          onClick={() => void saveBinder(false)}
          disabled={busy || !pages.length}
          title={`Save this binder  ${MOD}S    (${MOD}⇧S to save it under a new name)`}
        >
          Save
        </button>
        </div>
      </header>

      <div className="body" style={{ ['--side-w' as string]: `${sideW}px` }}>
        {pages.length === 0 ? (
          <div className="dropzone">
            <div className="dropzone-inner">
              <p className="dz-title">Drop PDFs or images here</p>
              <p className="dz-sub">
                or <button className="link" onClick={addViaDialog}>choose files</button> · nothing
                leaves this machine
              </p>
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
              onCurrentPage={setCurrentId}
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
        </span>
        <span className="muted">
          {binderPath ? baseName(binderPath) : 'unsaved binder'}
          {dirty ? ' · unsaved changes' : binderPath ? ' · saved' : ''} · drag to reorder · [ ] rotate ·
          ⌫ delete · {MOD}Z undo
        </span>
      </footer>
    </div>
  )
}
