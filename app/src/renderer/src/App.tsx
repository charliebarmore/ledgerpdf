import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BookmarkPanel } from './components/BookmarkPanel'
import { PageView } from './components/PageView'
import { ThumbnailRail } from './components/ThumbnailRail'
import { forgetDoc } from './pdf'
import {
  addSource,
  baseName,
  deletePages,
  movePages,
  newSession,
  parseSession,
  rotatePages,
  toExportSpec,
  type ProbeWire,
  type Session
} from './session'

const MOD = window.wpt.platform === 'darwin' ? '⌘' : 'Ctrl'

export default function App(): React.JSX.Element {
  const [session, setSession] = useState<Session>(newSession)
  const [sessionPath, setSessionPath] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [status, setStatus] = useState('Add PDFs to start a binder.')
  const [busy, setBusy] = useState(false)
  const [pageCounts, setPageCounts] = useState(true)
  const [sideW, setSideW] = useState(300)
  const past = useRef<Session[]>([])
  const future = useRef<Session[]>([])

  const pages = session.pages
  const current = useMemo(
    () => pages.find((p) => p.id === currentId) ?? pages[0] ?? null,
    [pages, currentId]
  )

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

  // --------------------------------------------------------------- persistence

  /** Core export. Takes the session explicitly — never reads render-time state. */
  const exportSession = useCallback(async (target: Session, out: string, reveal = true) => {
    setBusy(true)
    setStatus('Exporting…')
    try {
      const res = await window.wpt.exportBinder(toExportSpec(target, out, { pageCounts }))
      if (res.ok) {
        const r = res.result as { pages: number; check_problems: string[] }
        const clean = r.check_problems.length === 0
        setStatus(
          `Exported ${r.pages} pages to ${baseName(out)}${clean ? ' · validation clean' : ` · ${r.check_problems.length} validation warning(s)`}`
        )
        if (reveal) await window.wpt.reveal(out)
      } else {
        setStatus(`Export failed — ${res.error}`)
      }
    } finally {
      setBusy(false)
    }
  }, [pageCounts])

  const exportBinder = useCallback(async () => {
    if (!pages.length) return setStatus('Nothing to export.')
    const suggested = `${(session.sources[0]?.name ?? 'binder').replace(/\.pdf$/i, '')}-binder.pdf`
    const out = await window.wpt.chooseBinderOutput(suggested)
    if (out) await exportSession(session, out)
  }, [session, pages, exportSession])

  const saveSession = useCallback(
    async (forceDialog = false) => {
      const target = await window.wpt.saveSession(session, forceDialog ? null : sessionPath)
      if (target) {
        setSessionPath(target)
        setStatus(`Session saved to ${baseName(target)}`)
      }
    },
    [session, sessionPath]
  )

  const openSession = useCallback(async () => {
    const res = await window.wpt.openSession()
    if (!res) return
    const parsed = parseSession(res.session)
    if ('error' in parsed) return setStatus(`Cannot open session — ${parsed.error}`)
    const paths = parsed.session.sources.map((s) => s.path)
    const okPaths = new Set(await window.wpt.registerFiles(paths))
    const missing = parsed.session.sources.filter((s) => !okPaths.has(s.path))
    for (const s of parsed.session.sources) forgetDoc(s.id)
    past.current = []
    future.current = []
    setSession(parsed.session)
    setSessionPath(res.path)
    setSelected(new Set())
    setCurrentId(parsed.session.pages[0]?.id ?? null)
    setStatus(
      missing.length
        ? `Opened, but ${missing.length} source file(s) could not be found: ${missing.map((s) => s.name).join(', ')}`
        : `Opened ${baseName(res.path)} — ${parsed.session.pages.length} pages.`
    )
  }, [])

  // Dev seam (WPT_DEV_OPEN / WPT_DEV_EXPORT): drive the whole Phase 1 flow —
  // import, then optionally a real export through IPC + engine — with no
  // dialogs, so it can be smoke-tested automatically. Handlers are read through
  // refs so this subscribes exactly once.
  const devRefs = useRef({ importPaths, exportSession })
  devRefs.current = { importPaths, exportSession }
  useEffect(() => {
    window.wpt.onDevOpen(async ({ paths, exportTo }) => {
      const imported = await devRefs.current.importPaths(paths)
      if (exportTo && imported) await devRefs.current.exportSession(imported, exportTo, false)
      window.wpt.devRendered()
    })
  }, [])

  // ------------------------------------------------------------------ keyboard

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
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
      if (mod && e.key.toLowerCase() === 'e') {
        e.preventDefault()
        void exportBinder()
        return
      }
      if (e.key === '[') return rotate(-90)
      if (e.key === ']') return rotate(90)
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault()
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
  }, [undo, redo, rotate, remove, step, nudge, saveSession, openSession, addViaDialog, exportBinder])

  /** Drag the divider to widen the bookmark panel — real titles are long. */
  const startResize = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = sideW
    const onMove = (ev: PointerEvent): void =>
      setSideW(Math.max(200, Math.min(720, startW + (startX - ev.clientX))))
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
      const files = [...e.dataTransfer.files].filter((f) => f.name.toLowerCase().endsWith('.pdf'))
      if (!files.length) return
      const paths = files.map((f) => window.wpt.pathForFile(f)).filter(Boolean)
      const allowed = await window.wpt.registerFiles(paths)
      await importPaths(allowed)
    },
    [importPaths]
  )

  const count = selected.size || (current ? 1 : 0)

  return (
    <div
      className="app"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault()
      }}
      onDrop={onDrop}
    >
      <header className="toolbar">
        <strong className="brand">Workpaper Binder</strong>
        <button onClick={addViaDialog} disabled={busy}>
          Add PDFs
        </button>
        <span className="sep" />
        <button onClick={() => rotate(-90)} disabled={!count} title="Rotate left  [">
          ⟲
        </button>
        <button onClick={() => rotate(90)} disabled={!count} title="Rotate right  ]">
          ⟳
        </button>
        <button onClick={() => nudge(-1)} disabled={!count} title={`Move up  ${MOD}↑`}>
          ↑
        </button>
        <button onClick={() => nudge(1)} disabled={!count} title={`Move down  ${MOD}↓`}>
          ↓
        </button>
        <button onClick={remove} disabled={!count} title="Delete (undoable)  ⌫">
          Delete
        </button>
        <span className="sep" />
        <button onClick={undo} title={`Undo  ${MOD}Z`}>
          Undo
        </button>
        <button onClick={redo} title={`Redo  ${MOD}⇧Z`}>
          Redo
        </button>
        <span className="spacer" />
        <button onClick={openSession} title={`Open session  ${MOD}O`}>
          Open
        </button>
        <button onClick={() => saveSession(false)} disabled={!pages.length} title={`Save session  ${MOD}S`}>
          Save
        </button>
        <button className="primary" onClick={() => void exportBinder()} disabled={busy || !pages.length}>
          Export binder
        </button>
      </header>

      <div className="body" style={{ ['--side-w' as string]: `${sideW}px` }}>
        {pages.length === 0 ? (
          <div className="dropzone">
            <div className="dropzone-inner">
              <p className="dz-title">Drop PDFs here</p>
              <p className="dz-sub">
                or <button className="link" onClick={addViaDialog}>choose files</button> · nothing
                leaves this machine
              </p>
            </div>
          </div>
        ) : (
          <>
            <ThumbnailRail
              session={session}
              selected={selected}
              currentId={current?.id ?? null}
              onSelect={select}
              onReorder={(ids, before) => apply(movePages(session, ids, before), 'Reordered.')}
            />
            <PageView session={session} page={current} />
            <div
              className="splitter"
              onPointerDown={startResize}
              title="Drag to resize"
              role="separator"
            />
            <aside className="side">
              <BookmarkPanel
                session={session}
                pageCounts={pageCounts}
                onTogglePageCounts={setPageCounts}
                onJump={(id) => {
                  setCurrentId(id)
                  setSelected(new Set([id]))
                }}
              />
              <div className="panel">
                <div className="panel-head">Binder</div>
                <dl className="stats">
                  <dt>Pages</dt>
                  <dd>{pages.length}</dd>
                  <dt>Sources</dt>
                  <dd>{session.sources.length}</dd>
                  <dt>Selected</dt>
                  <dd>{selected.size}</dd>
                </dl>
              </div>
            </aside>
          </>
        )}
      </div>

      <footer className="statusbar">
        <span className={busy ? 'working' : ''}>{busy ? 'Working…' : status}</span>
        <span className="muted">
          {sessionPath ? baseName(sessionPath) : 'unsaved session'} · drag to reorder · [ ] rotate ·
          ⌫ delete · {MOD}Z undo
        </span>
      </footer>
    </div>
  )
}
