import { useCallback, useEffect, useRef, useState } from 'react'
import {
  marksOnPage,
  pageProvenance,
  sourceOf,
  shapesOnPage,
  tapesOnPage,
  type BinderPage,
  type Session,
  type ToolKind
} from '../session'
import { renderInto, type Sizing } from '../pdf'
import { MarkLayer } from './MarkLayer'
import { TapeLayer } from './TapeLayer'
import { ShapeLayer } from './ShapeLayer'

/** Zoom state: a fit mode, or an absolute scale where 1 = 100%. */
type Zoom = { mode: 'fitWidth' } | { mode: 'fitPage' } | { mode: 'scale'; factor: number }

const STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8]
const PAD = 40

function stepFrom(current: number, dir: 1 | -1): number {
  if (dir > 0) return STEPS.find((s) => s > current + 0.001) ?? STEPS[STEPS.length - 1]
  return [...STEPS].reverse().find((s) => s < current - 0.001) ?? STEPS[0]
}

export function PageView({
  session,
  page,
  pageIndex,
  pageCount,
  onGoto,
  armed,
  selectedMarkId,
  onPlaceMark,
  onSelectMark,
  onMoveMark,
  activeTapeId,
  onActivateTape,
  onCommitTapeEntry,
  onBackspaceTape,
  onMoveTape,
  onTitleTape,
  onDeleteTape,
  shapeColor,
  selectedShapeId,
  onDrawShape,
  onSelectShape,
  onMoveShape,
  onTextShape
}: {
  session: Session
  page: BinderPage | null
  /** 0-based position of `page` in the binder, and the total, for navigation. */
  pageIndex: number
  pageCount: number
  onGoto: (index: number) => void
  armed: { kind: ToolKind; text?: string } | null
  selectedMarkId: string | null
  onPlaceMark: (nx: number, ny: number) => void
  onSelectMark: (id: string | null) => void
  onMoveMark: (id: string, nx: number, ny: number) => void
  activeTapeId: string | null
  onActivateTape: (id: string | null) => void
  onCommitTapeEntry: (id: string, value: number) => void
  onBackspaceTape: (id: string) => void
  onMoveTape: (id: string, nx: number, ny: number) => void
  onTitleTape: (id: string, title: string) => void
  onDeleteTape: (id: string) => void
  shapeColor: string
  selectedShapeId: string | null
  onDrawShape: (nx: number, ny: number, nx2: number, ny2: number) => void
  onSelectShape: (id: string | null) => void
  onMoveShape: (id: string, dx: number, dy: number) => void
  onTextShape: (id: string, text: string) => void
}): React.JSX.Element {
  const holder = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [box, setBox] = useState({ w: 800, h: 900 })
  const [zoom, setZoom] = useState<Zoom>({ mode: 'fitWidth' })
  const [effective, setEffective] = useState(1)
  const [canvasBox, setCanvasBox] = useState({ w: 0, h: 0 })
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const el = holder.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      setBox({
        w: Math.max(200, Math.floor(entry.contentRect.width - PAD)),
        h: Math.max(200, Math.floor(entry.contentRect.height - PAD))
      })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const src = page ? sourceOf(session, page) : undefined
    if (!page || !src || !canvas.current) return
    const sizing: Sizing =
      zoom.mode === 'scale'
        ? { mode: 'scale', factor: zoom.factor }
        : zoom.mode === 'fitWidth'
          ? { mode: 'fitWidth', boxW: box.w }
          : { mode: 'fitPage', boxW: box.w, boxH: box.h }
    setError(null)
    renderInto(canvas.current, src.id, src.path, page.index, page.rotate, sizing, src.kind)
      .then((zoom) => {
        setEffective(zoom)
        const el = canvas.current
        if (el) setCanvasBox({ w: el.clientWidth, h: el.clientHeight })
      })
      .catch((e) => setError(String(e?.message ?? e)))
  }, [page?.id, page?.rotate, box.w, box.h, zoom, session.sources])

  /** Zoom steps operate on whatever is currently on screen. */
  const nudgeZoom = useCallback(
    (dir: 1 | -1) => setZoom({ mode: 'scale', factor: stepFrom(effective, dir) }),
    [effective]
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.key === '=' || e.key === '+') {
        e.preventDefault()
        nudgeZoom(1)
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault()
        nudgeZoom(-1)
      } else if (e.key === '0') {
        e.preventDefault()
        setZoom({ mode: 'fitWidth' })
      } else if (e.key === '9') {
        e.preventDefault()
        setZoom({ mode: 'fitPage' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [nudgeZoom])

  /** Ctrl/⌘ + wheel = continuous zoom, like every other document viewer. */
  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      const next = Math.min(8, Math.max(0.1, effective * (e.deltaY < 0 ? 1.1 : 1 / 1.1)))
      setZoom({ mode: 'scale', factor: next })
    },
    [effective]
  )

  const isFit = zoom.mode !== 'scale'

  return (
    <div className="pageview" ref={holder} onWheel={onWheel}>
      {page ? (
        <>
          <div className="pageview-bar">
            <span className="pagenav">
              <button
                onClick={() => onGoto(pageIndex - 1)}
                disabled={pageIndex <= 0}
                title="Previous page  ↑"
              >
                ‹
              </button>
              <input
                className="pagenum"
                value={pageIndex + 1}
                onChange={(e) => {
                  const n = parseInt(e.target.value.replace(/\D/g, ''), 10)
                  if (!Number.isNaN(n)) onGoto(n - 1)
                }}
                title="Jump to binder page"
              />
              <span className="pagetotal">/ {pageCount}</span>
              <button
                onClick={() => onGoto(pageIndex + 1)}
                disabled={pageIndex >= pageCount - 1}
                title="Next page  ↓"
              >
                ›
              </button>
            </span>
            <span className="pageview-caption" title={pageProvenance(session, page)}>
              {pageProvenance(session, page)}
              {page.rotate !== 0 && <span className="tag">rotated {page.rotate}°</span>}
            </span>
            <span className="zoom">
              <button onClick={() => nudgeZoom(-1)} title="Zoom out  ⌘−">
                −
              </button>
              <span className="zoom-pct" title="Current zoom">
                {Math.round(effective * 100)}%
              </span>
              <button onClick={() => nudgeZoom(1)} title="Zoom in  ⌘+">
                +
              </button>
              <button
                className={zoom.mode === 'fitWidth' ? 'on' : ''}
                onClick={() => setZoom({ mode: 'fitWidth' })}
                title="Fit width  ⌘0"
              >
                Fit W
              </button>
              <button
                className={zoom.mode === 'fitPage' ? 'on' : ''}
                onClick={() => setZoom({ mode: 'fitPage' })}
                title="Fit page  ⌘9"
              >
                Fit P
              </button>
              <button
                className={zoom.mode === 'scale' && Math.abs(zoom.factor - 1) < 0.01 ? 'on' : ''}
                onClick={() => setZoom({ mode: 'scale', factor: 1 })}
                title="Actual size"
              >
                100%
              </button>
            </span>
          </div>
          <div className={`sheet-scroll${isFit ? '' : ' is-zoomed'}`}>
            {error ? (
              <div className="error">{error}</div>
            ) : (
              <div className="sheet-stack">
                <canvas ref={canvas} className="sheet" />
                <MarkLayer
                  marks={marksOnPage(session, page.id)}
                  width={canvasBox.w}
                  height={canvasBox.h}
                  scale={effective}
                  armed={armed}
                  selectedId={selectedMarkId}
                  onPlace={onPlaceMark}
                  onSelect={onSelectMark}
                  onMove={onMoveMark}
                />
                <ShapeLayer
                  shapes={shapesOnPage(session, page.id)}
                  width={canvasBox.w}
                  height={canvasBox.h}
                  scale={effective}
                  armed={armed}
                  color={shapeColor}
                  selectedId={selectedShapeId}
                  onDraw={onDrawShape}
                  onSelect={onSelectShape}
                  onMove={onMoveShape}
                  onText={onTextShape}
                />
                <TapeLayer
                  tapes={tapesOnPage(session, page.id)}
                  width={canvasBox.w}
                  height={canvasBox.h}
                  scale={effective}
                  activeId={activeTapeId}
                  onActivate={onActivateTape}
                  onCommit={onCommitTapeEntry}
                  onBackspace={onBackspaceTape}
                  onMove={onMoveTape}
                  onTitle={onTitleTape}
                  onDelete={onDeleteTape}
                />
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="pageview-empty">No page selected</div>
      )}
    </div>
  )
}
