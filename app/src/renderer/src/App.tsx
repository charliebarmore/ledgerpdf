import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BookmarkPanel } from './components/BookmarkPanel'
import { MarkInspector } from './components/MarkInspector'
import { ShapeInspector } from './components/ShapeInspector'
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
  popTapeEntry,
  pushTapeEntry,
  removeBookmark,
  removeMarks,
  isShapeKind,
  moveShape,
  removeShapes,
  removeStamp,
  removeTapes,
  rotatePages,
  setBookmarkTitle,
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
  const [sessionPath, setSessionPath] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [status, setStatus] = useState('Add PDFs or images to start a binder.')
  const [busy, setBusy] = useState(false)
  const [pageCounts, setPageCounts] = useState(true)
  const [flatten, setFlatten] = useState(false)
  const [sideW, setSideW] = useState(300)
  const [autoEditKey, setAutoEditKey] = useState<string | null>(null)
  const [armed, setArmed] = useState<{ kind: ToolKind; text?: string } | null>(null)
  const [selectedMarkId, setSelectedMarkId] = useState<string | null>(null)
  const [activeTapeId, setActiveTapeId] = useState<string | null>(null)
  const [markSize] = useState(MARK_SIZE_DEFAULT)
  const [stampDraft, setStampDraft] = useState('')
  const [addingStamp, setAddingStamp] = useState(false)
  const [shapeColor, setShapeColor] = useState<ShapeColor>('red')
  const [selectedShapeId, setSelectedShapeId] = useState<string | null>(null)
  const shapeArmed = !!armed && isShapeKind(armed.kind)
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
    (nx: number, ny: number) => {
      if (!current || !armed) return
      if (armed.kind === 'tape') {
        const { session: next, id } = addTape(session, { page: current.id, nx, ny, entries: [] })
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
        page: current.id,
        kind: armed.kind,
        nx,
        ny,
        size: markSize,
        ...(armed.text ? { text: armed.text } : {})
      })
      apply(next, `${armed.kind === 'text' ? armed.text : armed.kind} placed.`)
      setSelectedMarkId(id)
    },
    [current, armed, session, markSize, apply]
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

  /** Enter commits a line. Each committed line is one undo step. */
  const commitTapeEntry = useCallback(
    (id: string, value: number) => {
      const next = pushTapeEntry(session, id, value)
      const tape = next.tapes?.find((t) => t.id === id)
      apply(
        next,
        `${formatAmount(value)} — total ${formatAmount(tapeTotal(tape?.entries ?? []))}`
      )
    },
    [session, apply]
  )

  const backspaceTape = useCallback(
    (id: string) => {
      const next = popTapeEntry(session, id)
      if (next === session) return
      const tape = next.tapes?.find((t) => t.id === id)
      apply(next, `Line removed — total ${formatAmount(tapeTotal(tape?.entries ?? []))}`)
    },
    [session, apply]
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
    },
    [session, apply]
  )

  // -------------------------------------------------------------------- shapes

  /** Commit a drag as a shape. A stray click is not a shape. */
  const drawShape = useCallback(
    (nx: number, ny: number, nx2: number, ny2: number) => {
      if (!current || !armed || !isShapeKind(armed.kind)) return
      if (!isDragMeaningful(nx, ny, nx2, ny2)) return
      const { session: next, id } = addShape(session, {
        page: current.id,
        kind: armed.kind,
        nx,
        ny,
        nx2,
        ny2,
        color: shapeColor,
        width: SHAPE_WIDTH_DEFAULT,
        ...(armed.kind === 'textbox' ? { text: '' } : {})
      })
      apply(next, `${armed.kind} drawn.`)
      setSelectedShapeId(id)
      setSelectedMarkId(null)
      // A text box is useless empty, so drop straight into typing it.
      if (armed.kind === 'textbox') setArmed(null)
    },
    [current, armed, session, shapeColor, apply]
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

  const persistSession = useCallback(
    async (
      value: Session,
      existingPath: string | null,
      mode: 'manual' | 'auto',
      suggested?: string
    ) => {
      if (saving.current) return null
      saving.current = true
      try {
        const target = await window.wpt.saveSession(value, existingPath, suggested)
        if (!target) return null
        lastSaved.current = JSON.stringify(value)
        setSessionPath(target)
        setStatus(
          mode === 'auto'
            ? `Autosaved ${baseName(target)}`
            : `Session saved to ${baseName(target)}`
        )
        return target
      } catch (error) {
        setStatus(`${mode === 'auto' ? 'Autosave' : 'Save'} failed — ${String((error as Error).message ?? error)}`)
        return null
      } finally {
        saving.current = false
      }
    },
    []
  )

  // Once the user chooses where the engagement lives, every subsequent edit
  // is saved after a short quiet period. The write is atomic in the main
  // process and retains the previous complete generation beside the session.
  useEffect(() => {
    if (!sessionPath || !dirty) return
    const timer = window.setTimeout(() => {
      void persistSession(session, sessionPath, 'auto')
    }, 1500)
    return () => window.clearTimeout(timer)
  }, [session, sessionPath, dirty, persistSession])

  /** Core export. Takes the session explicitly — never reads render-time state. */
  const exportSession = useCallback(async (target: Session, out: string, reveal = true) => {
    setBusy(true)
    setStatus('Exporting…')
    try {
      const res = await window.wpt.exportBinder(toExportSpec(target, out, { pageCounts, flatten }))
      if (res.ok) {
        const r = res.result as { pages: number; marks: number; check_problems: string[] }
        const clean = r.check_problems.length === 0
        setStatus(
          `Exported ${r.pages} pages to ${baseName(out)}${
            flatten && r.marks ? ` · ${r.marks} mark(s) flattened` : ''
          }${clean ? ' · validation clean' : ` · ${r.check_problems.length} validation warning(s)`}`
        )
        if (reveal) await window.wpt.reveal(out)
      } else {
        setStatus(`Export failed — ${res.error}`)
      }
    } finally {
      setBusy(false)
    }
  }, [pageCounts, flatten])

  const exportBinder = useCallback(async () => {
    if (!pages.length) return setStatus('Nothing to export.')
    const suggested = flatten
      ? `${binderStem}-binder-flat.pdf`
      : `${binderStem}-binder.pdf`
    const out = await window.wpt.chooseBinderOutput(suggested)
    if (out) await exportSession(session, out)
  }, [session, pages, exportSession, flatten, binderStem])

  const saveSession = useCallback(
    async (forceDialog = false) => {
      await persistSession(
        session,
        forceDialog ? null : sessionPath,
        'manual',
        `${binderStem}.wptsession.json`
      )
    },
    [session, sessionPath, persistSession, binderStem]
  )

  const openSession = useCallback(async () => {
    if (dirty) {
      if (sessionPath) {
        const saved = await persistSession(session, sessionPath, 'auto')
        if (!saved) return
      } else if (!(await window.wpt.confirmDiscard())) {
        return
      }
    }
    const res = await window.wpt.openSession()
    if (!res) return
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
    const originalSerialized = JSON.stringify(parsed.session)
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
    for (const s of parsed.session.sources) forgetDoc(s.id)
    past.current = []
    future.current = []
    // A relink or first fingerprinting of a legacy session is a real change and
    // will autosave. Recovered data remains clean until the explicit Save As.
    lastSaved.current = recovered ? JSON.stringify(openedSession) : originalSerialized
    setSession(openedSession)
    // Never overwrite an unreadable primary with recovered data implicitly.
    // Save As makes the recovery decision explicit and preserves both files.
    setSessionPath(recovered ? null : res.path)
    setSelected(new Set())
    setCurrentId(openedSession.pages[0]?.id ?? null)
    setStatus(
      recovered
        ? `Recovered ${baseName(res.path)} from its previous complete save — use Save to choose a safe destination.`
        : `Opened ${baseName(res.path)} — ${openedSession.pages.length} pages; source identity verified.`
    )
  }, [dirty, sessionPath, session, persistSession])

  // Dev seam (WPT_DEV_OPEN / WPT_DEV_EXPORT): drive the whole Phase 1 flow —
  // import, then optionally a real export through IPC + engine — with no
  // dialogs, so it can be smoke-tested automatically. Handlers are read through
  // refs so this subscribes exactly once.
  const devRefs = useRef({ importPaths, exportSession })
  devRefs.current = { importPaths, exportSession }
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
        // A tape, keyed the way the 10-key does it: place, then push entries.
        const tape = addTape(imported, {
          page: imported.pages[0].id,
          nx: 0.68,
          ny: 0.55,
          entries: [],
          title: 'Repairs'
        })
        imported = tape.session
        for (const v of [1200, 340, -50]) imported = pushTapeEntry(imported, tape.id, v)
        setSession(imported)
        // Leave the lettered mark selected so the window snapshot captures the
        // inspector rather than an empty side panel.
        setSelectedMarkId(lettered.id)
      }
      if (exportTo && imported) await devRefs.current.exportSession(imported, exportTo, false)
      window.wpt.devRendered()
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
        void saveSession(e.shiftKey)
        return
      }
      if (mod && e.key.toLowerCase() === 'o') {
        e.preventDefault()
        void openSession()
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
        void exportBinder()
        return
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
    saveSession,
    openSession,
    addViaDialog,
    exportBinder,
    addBookmarkHere,
    resizeMark,
    deleteMark,
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
            title={reviewerInitials ? `Stamp your initials (${reviewerInitials})` : 'Stamp your initials — type them in the Initials box first'}
          >
            {reviewerInitials || '—'}
          </button>
          <button
            className={armed?.kind === 'tape' ? 'on' : ''}
            onClick={() => setArmed({ kind: 'tape' })}
            title="Calculator tape — click the page, then key numbers like a 10-key  (C)"
          >
            <span className="glyph-tape">123</span>
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
          {/* Swatches only when they apply — a colour picker with nothing to
              colour is just five more buttons competing for the row. */}
          {(shapeArmed || selectedShapeId) && (
          <span className="swatches" title="Color for new shapes">
            {SHAPE_COLOR_NAMES.map((c) => (
              <button
                key={c}
                className={`swatch${shapeColor === c ? ' on' : ''}`}
                style={{ background: SHAPE_COLORS[c] }}
                onClick={() => {
                  setShapeColor(c)
                  if (selectedShapeId) editShape({ color: c })
                }}
                title={`${c}${selectedShapeId ? ' — also recolors the selected shape' : ''}`}
              />
            ))}
          </span>
          )}
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
        <label className="rev" title="Stamped as the author of every mark you place">
          <span className="rev-label">Initials</span>
          <input
            className="rev-input"
            value={reviewerInitials}
            maxLength={4}
            placeholder="—"
            onChange={(e) =>
              setSession((prev) => ({ ...prev, reviewer: e.target.value.toUpperCase().slice(0, 4) }))
            }
          />
        </label>
        <span className="sep" />
        <button onClick={undo} title={`Undo  ${MOD}Z`}>
          ↶
        </button>
        <button onClick={redo} title={`Redo  ${MOD}⇧Z`}>
          ↷
        </button>
        <span className="spacer" />
        <button onClick={openSession} title={`Open a saved .wptsession.json  ${MOD}O`}>
          Open
        </button>
        <button
          onClick={() => saveSession(false)}
          disabled={!pages.length}
          title={`Save the editable session (.wptsession.json) — your work in progress, sources untouched  ${MOD}S`}
        >
          Save session
        </button>
        {/* An export option belongs beside the export button, not in a panel. */}
        <label
          className="toggle flatten"
          title="Burn marks and tapes into the page for a binder that leaves the building — nothing a viewer can drag or delete. One-way: a flattened PDF can't be re-edited, so keep the session file as your master."
        >
          <input type="checkbox" checked={flatten} onChange={(e) => setFlatten(e.target.checked)} />
          Flatten
        </label>
        <button className="primary" onClick={() => void exportBinder()} disabled={busy || !pages.length}>
          Export PDF
        </button>
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
              onPlaceMark={placeTool}
              onSelectMark={setSelectedMarkId}
              onMoveMark={moveMark}
              activeTapeId={activeTapeId}
              onActivateTape={setActiveTapeId}
              onCommitTapeEntry={commitTapeEntry}
              onBackspaceTape={backspaceTape}
              onMoveTape={moveTape}
              onTitleTape={titleTape}
              onDeleteTape={deleteTape}
              shapeColor={shapeColor}
              selectedShapeId={selectedShapeId}
              onDrawShape={drawShape}
              onSelectShape={setSelectedShapeId}
              onMoveShape={nudgeShape}
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
          {sessionPath ? baseName(sessionPath) : 'unsaved session'}
          {dirty ? ' · unsaved changes' : sessionPath ? ' · autosaved' : ''} · drag to reorder · [ ] rotate ·
          ⌫ delete · {MOD}Z undo
        </span>
      </footer>
    </div>
  )
}
