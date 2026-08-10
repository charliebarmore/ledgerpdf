import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  marksOnPage,
  pageProvenance,
  pageSize,
  shapesOnPage,
  sourceOf,
  tapesOnPage,
  type BinderPage,
  type Session,
  type Shape,
  type TapeOp,
  type ToolKind
} from '../session'
import { renderInto } from '../pdf'
import { MarkLayer } from './MarkLayer'
import { TapeLayer } from './TapeLayer'
import { ShapeLayer } from './ShapeLayer'
import { LinkLayer } from './LinkLayer'

/**
 * The binder, as one continuously scrolling column of pages.
 *
 * Every page gets a slot laid out from its recorded size, but only pages near
 * the viewport actually render — a 62-page master file cannot hold 62 live
 * canvases, and a scroller that renders everything stalls the moment a real
 * file is opened. Slots keep their height whether or not their canvas exists,
 * so scrolling past unrendered pages never reflows the column under the cursor.
 *
 * Each page carries its OWN annotation layers, sized to its own canvas. That is
 * what preserves the invariant everything else depends on: coordinates are
 * normalized per page, so what you place is what exports.
 */

type Zoom = { mode: 'fitWidth' } | { mode: 'fitPage' } | { mode: 'scale'; factor: number }

const STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8]
const PAD = 40
/** Gap between pages, CSS pixels. */
const GAP = 16
/** How far beyond the viewport to keep canvases alive, in viewport heights. */
const OVERSCAN = 0.6

function stepFrom(current: number, dir: 1 | -1): number {
  if (dir > 0) return STEPS.find((s) => s > current + 0.001) ?? STEPS[STEPS.length - 1]
  return [...STEPS].reverse().find((s) => s < current - 0.001) ?? STEPS[0]
}

/** One page's canvas, mounted only while it is near the viewport. */
function PageCanvas({
  session,
  page,
  zoom,
  onError
}: {
  session: Session
  page: BinderPage
  zoom: number
  onError: (msg: string | null) => void
}): React.JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const src = sourceOf(session, page)
    if (!src || !canvas.current) return
    renderInto(
      canvas.current,
      src.id,
      src.path,
      page.index,
      page.rotate,
      { mode: 'scale', factor: zoom },
      src.kind
    )
      .then(() => onError(null))
      .catch((e) => onError(String(e?.message ?? e)))
  }, [page.id, page.rotate, zoom, session.sources])

  return <canvas ref={canvas} className="sheet" />
}

export function PageView({
  session,
  page,
  pageIndex,
  pageCount,
  onGoto,
  onCurrentPage,
  armed,
  selectedMarkId,
  onPlaceMark,
  onSelectMark,
  onMoveMark,
  activeTapeId,
  onActivateTape,
  tapeBuffer,
  tapeOp,
  onTapeKey,
  onMoveTape,
  onTitleTape,
  onDeleteTape,
  shapeColor,
  selectedShapeId,
  onDrawShape,
  onFollowLink,
  onSelectShape,
  onMoveShape,
  onResizeShape,
  onTextShape
}: {
  session: Session
  page: BinderPage | null
  pageIndex: number
  pageCount: number
  onGoto: (index: number) => void
  /** Reports the page the reader is actually looking at, as they scroll. */
  onCurrentPage: (id: string) => void
  armed: { kind: ToolKind; text?: string } | null
  selectedMarkId: string | null
  onPlaceMark: (pageId: string, nx: number, ny: number) => void
  onSelectMark: (id: string | null) => void
  onMoveMark: (id: string, nx: number, ny: number) => void
  activeTapeId: string | null
  onActivateTape: (id: string | null) => void
  tapeBuffer: string
  tapeOp: TapeOp
  onTapeKey: (key: string) => void
  onMoveTape: (id: string, nx: number, ny: number) => void
  onTitleTape: (id: string, title: string) => void
  onDeleteTape: (id: string) => void
  shapeColor: string
  selectedShapeId: string | null
  onDrawShape: (pageId: string, nx: number, ny: number, nx2: number, ny2: number) => void
  /** A link in a source page was clicked; the caller maps it to a binder page. */
  onFollowLink: (sourceId: string, toIndex: number) => void
  onSelectShape: (id: string | null) => void
  onMoveShape: (id: string, dx: number, dy: number) => void
  onResizeShape: (id: string, patch: Partial<Shape>) => void
  onTextShape: (id: string, text: string) => void
}): React.JSX.Element {
  const holder = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ w: 800, h: 900 })
  const [zoom, setZoom] = useState<Zoom>({ mode: 'fitWidth' })
  const [scrollTop, setScrollTop] = useState(0)
  /** Where a programmatic scroll is headed, so arrival can be detected. */
  const programmaticTarget = useRef<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Set while WE scroll, so the scroll handler doesn't fight the jump. */
  const programmatic = useRef(false)
  /** The one pending arrival fallback, so a stale one cannot clear a live jump. */
  const settleTimer = useRef(0)

  const pages = session.pages

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

  // Fit measures the CURRENT page. Mixed page sizes are normal in a binder, and
  // fitting to the widest would shrink every other page to suit one outlier.
  const fitRef = page ?? pages[0] ?? null
  const fitSize = fitRef ? pageSize(fitRef) : { w: 612, h: 792 }
  const effective =
    zoom.mode === 'scale'
      ? zoom.factor
      : zoom.mode === 'fitWidth'
        ? box.w / fitSize.w
        : Math.min(box.w / fitSize.w, box.h / fitSize.h)

  /** Slot offsets, so a page can be scrolled to without measuring the DOM. */
  let y = 0
  const tops: number[] = []
  const heights: number[] = []
  for (const p of pages) {
    const s = pageSize(p)
    const h = Math.ceil(s.h * effective)
    tops.push(y)
    heights.push(h)
    y += h + GAP
  }
  const totalHeight = Math.max(0, y - GAP)
  /**
   * `tops` is rebuilt every render, so its IDENTITY always changes and any
   * effect depending on it re-runs every render — which is not what "when the
   * geometry changes" means. The scroll effect below stacked a fresh 1200ms
   * fallback timer per render, and a timer armed by an earlier render fired
   * while a later jump was still travelling, cleared `programmatic`, and let
   * the scroll handler overwrite the page. Depend on the VALUE.
   */
  const topsKey = tops.join(',')

  const viewH = box.h + PAD
  const lo = scrollTop - viewH * OVERSCAN
  const hi = scrollTop + viewH * (1 + OVERSCAN)

  /** The page the reader is looking at: the last one starting above the fold. */
  const onScroll = useCallback(() => {
    const el = scroller.current
    if (!el) return
    setScrollTop(el.scrollTop)
    // A programmatic jump is over when the column has ARRIVED, not when a timer
    // says so. This used to clear after a flat 60ms, and a long jump — page 1 to
    // page 11 — does not always settle inside it: a late scroll event then ran
    // the handler below, recomputed the page from scroll position, and set
    // currentId back to where the reader had been. Intermittent by construction,
    // and it hit whichever navigation happened to be slowest.
    if (programmatic.current) {
      const target = programmaticTarget.current
      if (target === null || Math.abs(el.scrollTop - target) <= 2) {
        programmatic.current = false
        programmaticTarget.current = null
      }
      return
    }
    // A third down the viewport, not the very top: at a page boundary the page
    // filling most of the screen is the one you are reading, and a fixed 80px
    // offset kept naming the page that was mostly scrolled past.
    const probe = el.scrollTop + (el.clientHeight || 1) * 0.35
    let idx = 0
    for (let i = 0; i < tops.length; i++) {
      if (tops[i] <= probe) idx = i
      else break
    }
    const id = pages[idx]?.id
    if (id && id !== page?.id) onCurrentPage(id)
  }, [tops, pages, page?.id, onCurrentPage])

  /** Bring a page into view when NAVIGATION changed it, not scrolling. */
  // Depends on `tops`, not on pageIndex alone. The geometry is recomputed
  // whenever the page list or zoom changes — including when a live agent pushes
  // a session — and if pageIndex changed BEFORE the new geometry existed, this
  // effect read `undefined`, returned having scrolled nothing, and never ran
  // again. The column stayed at the top while currentId said page 6, and the
  // next scroll event duly "corrected" currentId back to page 1. That is what
  // made following an agent look intermittent: it was not the follow failing,
  // it was the scroll never happening and the page tracker overwriting it.
  useLayoutEffect(() => {
    const el = scroller.current
    const top = tops[pageIndex]
    if (!el || top === undefined) return
    // Already comfortably in view? Leave the reader where they are, or every
    // scroll would yank the column back to the page boundary.
    if (top >= el.scrollTop - 4 && top < el.scrollTop + viewH * 0.6) return
    programmatic.current = true
    programmaticTarget.current = top
    el.scrollTo({ top, behavior: 'auto' })
    // Fallback only. If the column was already at `top`, no scroll event fires
    // and the arrival check above never runs — without this, programmatic would
    // stay true and the reader's own scrolling would stop updating the page.
    // Replace any pending fallback rather than adding one: an older timer
    // clearing the flag mid-jump is precisely the bug `topsKey` also fixes.
    if (settleTimer.current) window.clearTimeout(settleTimer.current)
    settleTimer.current = window.setTimeout(() => {
      programmatic.current = false
      programmaticTarget.current = null
      settleTimer.current = 0
    }, 1200)
    // `topsKey` rather than `tops` on purpose — it is the same geometry by
    // value, and the array's identity changes every render. Keep it that way if
    // a dependency linter is ever added here.
  }, [pageIndex, topsKey])

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

  /** ⌘/Ctrl + wheel zooms; a plain wheel scrolls the binder, as it should. */
  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      setZoom({
        mode: 'scale',
        factor: Math.min(8, Math.max(0.1, effective * (e.deltaY < 0 ? 1.1 : 1 / 1.1)))
      })
    },
    [effective]
  )

  return (
    <div className="pageview" ref={holder} onWheel={onWheel}>
      {pages.length > 0 ? (
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
            <span className="pageview-caption" title={page ? pageProvenance(session, page) : ''}>
              {page ? pageProvenance(session, page) : ''}
              {page && page.rotate !== 0 && <span className="tag">rotated {page.rotate}°</span>}
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

          <div className="sheet-scroll" ref={scroller} onScroll={onScroll}>
            {error ? (
              <div className="error">{error}</div>
            ) : (
              <div className="sheet-column" style={{ height: totalHeight }}>
                {pages.map((p, i) => {
                  const top = tops[i]
                  const h = heights[i]
                  const near = top + h >= lo && top <= hi
                  const w = Math.ceil(pageSize(p).w * effective)
                  return (
                    <div
                      key={p.id}
                      className={`page-slot${page?.id === p.id ? ' is-current' : ''}`}
                      data-page-id={p.id}
                      style={{ top, height: h, width: w }}
                    >
                      {near ? (
                        <div className="sheet-stack">
                          <PageCanvas
                            session={session}
                            page={p}
                            zoom={effective}
                            onError={setError}
                          />
                          <MarkLayer
                            marks={marksOnPage(session, p.id)}
                            width={w}
                            height={h}
                            scale={effective}
                            armed={armed}
                            selectedId={selectedMarkId}
                            onPlace={(nx, ny) => onPlaceMark(p.id, nx, ny)}
                            onSelect={onSelectMark}
                            onMove={onMoveMark}
                          />
                          <ShapeLayer
                            shapes={shapesOnPage(session, p.id)}
                            width={w}
                            height={h}
                            scale={effective}
                            armed={armed}
                            color={shapeColor}
                            selectedId={selectedShapeId}
                            onDraw={(a, b, c, d) => onDrawShape(p.id, a, b, c, d)}
                            onSelect={onSelectShape}
                            onMove={onMoveShape}
                            onResize={onResizeShape}
                            onText={onTextShape}
                          />
                          <LinkLayer
                            session={session}
                            page={p}
                            width={w}
                            height={h}
                            armed={!!armed}
                            onFollow={onFollowLink}
                          />
                          <TapeLayer
                            tapes={tapesOnPage(session, p.id)}
                            width={w}
                            height={h}
                            scale={effective}
                            activeId={activeTapeId}
                            armed={armed}
                            buffer={tapeBuffer}
                            pendingOp={tapeOp}
                            onActivate={onActivateTape}
                            onKey={onTapeKey}
                            onMove={onMoveTape}
                            onTitle={onTitleTape}
                            onDelete={onDeleteTape}
                          />
                        </div>
                      ) : (
                        // A placeholder holds the slot's height, so scrolling
                        // past unrendered pages never reflows the column.
                        <div className="sheet sheet-pending" style={{ width: w, height: h }} />
                      )}
                      <span className="page-slot-num">{i + 1}</span>
                    </div>
                  )
                })}
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
