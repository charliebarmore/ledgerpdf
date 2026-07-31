import { useCallback, useEffect, useRef, useState } from 'react'
import {
  HIGHLIGHT_FILL,
  SHAPE_COLORS,
  isShapeKind,
  resizeShape,
  type ShapeHandle,
  type Shape,
  type ShapeKind,
  type ToolKind
} from '../session'

/**
 * Drawn annotations — rectangles, ellipses, lines, arrows, highlights, notes.
 *
 * Drag-to-draw, so this owns the pointer while a shape tool is armed. SVG
 * rather than divs: a 1.5pt stroke and an ellipse are what SVG is for, and it
 * scales exactly with zoom instead of accumulating rounding.
 *
 * Geometry is normalized to the page AS DISPLAYED — the same convention marks
 * and tapes use, and exactly what the engine consumes, so what you draw is what
 * exports.
 */

/** Shift constrains: square, circle, or a 45° line — the Acrobat convention. */
function constrain(
  kind: ShapeKind,
  nx: number,
  ny: number,
  nx2: number,
  ny2: number,
  aspect: number
): { nx2: number; ny2: number } {
  const dx = nx2 - nx
  const dy = ny2 - ny
  if (kind === 'line' || kind === 'arrow') {
    // Snap to the nearest 45°, measured in on-screen space so it looks square.
    const ang = Math.atan2(dy * aspect, dx)
    const snapped = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4)
    const len = Math.hypot(dx, dy * aspect)
    return { nx2: nx + Math.cos(snapped) * len, ny2: ny + (Math.sin(snapped) * len) / aspect }
  }
  // Square/circle: equal on-screen extent, so equal in normalized terms only
  // after correcting for the page's aspect ratio.
  const size = Math.max(Math.abs(dx), Math.abs(dy) * aspect)
  return { nx2: nx + Math.sign(dx || 1) * size, ny2: ny + (Math.sign(dy || 1) * size) / aspect }
}

/**
 * An invisible, fat version of the shape purely to catch the pointer.
 *
 * SVG hit-testing follows what is painted: a `fill="none"` outline is only
 * clickable ON its stroke, so a 2pt arrow means hitting a 2px line exactly, and
 * the inside of a circle is not a target at all. This sits underneath and gives
 * every shape a real grab area.
 */
function HitArea({ shape, w, h, scale }: { shape: Shape; w: number; h: number; scale: number }) {
  const x1 = shape.nx * w
  const y1 = shape.ny * h
  const x2 = shape.nx2 * w
  const y2 = shape.ny2 * h
  const left = Math.min(x1, x2)
  const top = Math.min(y1, y2)
  const bw = Math.abs(x2 - x1)
  const bh = Math.abs(y2 - y1)
  const grab = Math.max(shape.width * scale * 3, 12)
  const common = {
    fill: 'transparent',
    stroke: 'transparent',
    strokeWidth: grab,
    // `all` so the transparent fill counts as a target too — clicking inside a
    // circled figure to select it is what every PDF tool does.
    pointerEvents: 'all' as const
  }
  if (shape.kind === 'line' || shape.kind === 'arrow') {
    return <line x1={x1} y1={y1} x2={x2} y2={y2} {...common} strokeLinecap="round" />
  }
  if (shape.kind === 'ellipse') {
    return <ellipse cx={left + bw / 2} cy={top + bh / 2} rx={bw / 2} ry={bh / 2} {...common} />
  }
  return <rect x={left} y={top} width={bw} height={bh} {...common} />
}

function ShapeGraphic({
  shape,
  w,
  h,
  scale
}: {
  shape: Shape
  w: number
  h: number
  scale: number
}): React.JSX.Element {
  const x1 = shape.nx * w
  const y1 = shape.ny * h
  const x2 = shape.nx2 * w
  const y2 = shape.ny2 * h
  const left = Math.min(x1, x2)
  const top = Math.min(y1, y2)
  const bw = Math.abs(x2 - x1)
  const bh = Math.abs(y2 - y1)
  const stroke = SHAPE_COLORS[shape.color] ?? SHAPE_COLORS.red
  const sw = shape.width * scale

  switch (shape.kind) {
    case 'highlight':
      return <rect x={left} y={top} width={bw} height={bh} fill={HIGHLIGHT_FILL} />
    case 'rect':
      return (
        <rect x={left} y={top} width={bw} height={bh} fill="none" stroke={stroke} strokeWidth={sw} />
      )
    case 'ellipse':
      return (
        <ellipse
          cx={left + bw / 2}
          cy={top + bh / 2}
          rx={bw / 2}
          ry={bh / 2}
          fill="none"
          stroke={stroke}
          strokeWidth={sw}
        />
      )
    case 'textbox':
      return (
        <>
          <rect
            x={left}
            y={top}
            width={bw}
            height={bh}
            fill="#ffffff"
            stroke={stroke}
            strokeWidth={sw}
          />
          {/* Text itself is drawn by the HTML overlay so it wraps like the
              engine's does; SVG here is only the card. */}
        </>
      )
    default: {
      // line / arrow — drawn corner to corner in the direction dragged
      const head = Math.max(sw * 4, 6 * scale)
      const ang = Math.atan2(y2 - y1, x2 - x1)
      const spread = (24 * Math.PI) / 180
      const ax = x2 - head * Math.cos(ang - spread)
      const ay = y2 - head * Math.sin(ang - spread)
      const bx = x2 - head * Math.cos(ang + spread)
      const by = y2 - head * Math.sin(ang + spread)
      return (
        <>
          <line
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            stroke={stroke}
            strokeWidth={sw}
            strokeLinecap="round"
          />
          {shape.kind === 'arrow' && (
            <polygon points={`${x2},${y2} ${ax},${ay} ${bx},${by}`} fill={stroke} />
          )}
        </>
      )
    }
  }
}

type HandleKey = ShapeHandle

/** Where the grab handles sit, in CSS pixels. */
function handlesFor(
  s: Shape,
  w: number,
  h: number
): Array<{ key: HandleKey; x: number; y: number }> {
  if (s.kind === 'line' || s.kind === 'arrow') {
    return [
      { key: 'a', x: s.nx * w, y: s.ny * h },
      { key: 'b', x: s.nx2 * w, y: s.ny2 * h }
    ]
  }
  const x0 = Math.min(s.nx, s.nx2) * w
  const x1 = Math.max(s.nx, s.nx2) * w
  const y0 = Math.min(s.ny, s.ny2) * h
  const y1 = Math.max(s.ny, s.ny2) * h
  return [
    { key: 'nw', x: x0, y: y0 },
    { key: 'ne', x: x1, y: y0 },
    { key: 'se', x: x1, y: y1 },
    { key: 'sw', x: x0, y: y1 }
  ]
}

export function ShapeLayer({
  shapes,
  width,
  height,
  scale,
  armed,
  color,
  selectedId,
  onDraw,
  onSelect,
  onMove,
  onResize,
  onText
}: {
  shapes: Shape[]
  width: number
  height: number
  /** Effective zoom: CSS pixels per PDF point. */
  scale: number
  armed: { kind: ToolKind; text?: string } | null
  color: string
  selectedId: string | null
  onDraw: (nx: number, ny: number, nx2: number, ny2: number) => void
  onSelect: (id: string | null) => void
  onMove: (id: string, dx: number, dy: number) => void
  onResize: (id: string, patch: Partial<Shape>) => void
  onText: (id: string, text: string) => void
}): React.JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState<{ nx: number; ny: number; nx2: number; ny2: number } | null>(
    null
  )
  const drawing = armed && isShapeKind(armed.kind) ? (armed.kind as ShapeKind) : null

  const toNorm = useCallback((clientX: number, clientY: number) => {
    const r = box.current!.getBoundingClientRect()
    return {
      nx: Math.min(1, Math.max(0, (clientX - r.left) / r.width)),
      ny: Math.min(1, Math.max(0, (clientY - r.top) / r.height))
    }
  }, [])

  /** Draw a new shape. */
  const startDraw = useCallback(
    (e: React.PointerEvent) => {
      if (!drawing) return
      e.preventDefault()
      const start = toNorm(e.clientX, e.clientY)
      const aspect = width / Math.max(height, 1)
      setDraft({ nx: start.nx, ny: start.ny, nx2: start.nx, ny2: start.ny })

      const move = (ev: PointerEvent): void => {
        const p = toNorm(ev.clientX, ev.clientY)
        const end = ev.shiftKey
          ? constrain(drawing, start.nx, start.ny, p.nx, p.ny, aspect)
          : { nx2: p.nx, ny2: p.ny }
        setDraft({ nx: start.nx, ny: start.ny, ...end })
      }
      const up = (ev: PointerEvent): void => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        const p = toNorm(ev.clientX, ev.clientY)
        const end = ev.shiftKey
          ? constrain(drawing, start.nx, start.ny, p.nx, p.ny, aspect)
          : { nx2: p.nx, ny2: p.ny }
        setDraft(null)
        onDraw(start.nx, start.ny, end.nx2, end.ny2)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [drawing, toNorm, onDraw, width, height]
  )

  /** Move an existing shape. */
  const startMove = useCallback(
    (e: React.PointerEvent, id: string) => {
      if (drawing) return
      e.stopPropagation()
      e.preventDefault()
      onSelect(id)
      let last = toNorm(e.clientX, e.clientY)
      const move = (ev: PointerEvent): void => {
        const p = toNorm(ev.clientX, ev.clientY)
        onMove(id, p.nx - last.nx, p.ny - last.ny)
        last = p
      }
      const up = (): void => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [drawing, toNorm, onMove, onSelect]
  )

  const selectedShape = shapes.find((s) => s.id === selectedId) ?? null

  const startResize = useCallback(
    (e: React.PointerEvent, shape: Shape, key: HandleKey) => {
      e.stopPropagation()
      e.preventDefault()
      const move = (ev: PointerEvent): void => {
        const p = toNorm(ev.clientX, ev.clientY)
        onResize(shape.id, resizeShape(shape, key, p.nx, p.ny))
      }
      const up = (): void => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [toNorm, onResize]
  )

  const editing = shapes.find((s) => s.id === selectedId && s.kind === 'textbox')
  const noteRef = useRef<HTMLTextAreaElement>(null)

  // A NEW note is useless until the caret is in it, and the single-key tool
  // shortcuts would otherwise eat every letter typed. Only empty ones grab
  // focus, so selecting an existing note to move it doesn't steal the caret.
  useEffect(() => {
    if (editing && !editing.text) noteRef.current?.focus()
  }, [editing?.id])

  return (
    <div
      ref={box}
      className={`shapelayer${drawing ? ' is-armed' : ''}`}
      style={{ width, height }}
      onPointerDown={(e) => {
        if (drawing) return startDraw(e)
        if (e.target === box.current) onSelect(null)
      }}
    >
      <svg width={width} height={height} className="shapesvg">
        {shapes.map((s) => (
          <g
            key={s.id}
            className={`shape${selectedId === s.id ? ' is-selected' : ''}`}
            // With any tool armed, shapes must not intercept — otherwise a tick
            // aimed inside a circled figure would select the circle instead.
            style={{ pointerEvents: armed ? 'none' : 'auto' }}
            onPointerDown={(e) => startMove(e, s.id)}
          >
            <HitArea shape={s} w={width} h={height} scale={scale} />
            <ShapeGraphic shape={s} w={width} h={height} scale={scale} />
          </g>
        ))}
        {/* Resize handles on the selected shape. Endpoints for a line or
            arrow (direction matters — the head is the second point); corners
            for everything else. */}
        {!armed &&
          selectedShape &&
          handlesFor(selectedShape, width, height).map((hd) => (
            <rect
              key={hd.key}
              className="shape-handle"
              x={hd.x - 5}
              y={hd.y - 5}
              width={10}
              height={10}
              onPointerDown={(e) => startResize(e, selectedShape, hd.key)}
            />
          ))}
        {draft && drawing && (
          <g className="shape-draft">
            <ShapeGraphic
              shape={{
                id: 'draft',
                page: '',
                kind: drawing,
                ...draft,
                color: color as Shape['color'],
                width: 1.5
              }}
              w={width}
              h={height}
              scale={scale}
            />
          </g>
        )}
      </svg>

      {/* Text boxes get a real textarea so wrapping and editing behave like
          text, not like a canvas. */}
      {shapes
        .filter((s) => s.kind === 'textbox')
        .map((s) => {
          const left = Math.min(s.nx, s.nx2) * width
          const top = Math.min(s.ny, s.ny2) * height
          const w = Math.abs(s.nx2 - s.nx) * width
          const h = Math.abs(s.ny2 - s.ny) * height
          return (
            <textarea
              key={`t-${s.id}`}
              ref={selectedId === s.id ? noteRef : undefined}
              className={`shape-text${selectedId === s.id ? ' is-editing' : ''}`}
              value={s.text ?? ''}
              placeholder={selectedId === s.id ? 'Type a note…' : ''}
              spellCheck={false}
              style={{
                left,
                top,
                width: w,
                height: h,
                fontSize: 11 * scale,
                lineHeight: `${13 * scale}px`,
                padding: 4 * scale,
                color: SHAPE_COLORS[s.color] ?? SHAPE_COLORS.red,
                // Only the SELECTED note takes the pointer. Unselected, the
                // shape's hit area underneath handles click-to-select and
                // drag-to-move; a textarea on top would swallow both.
                pointerEvents: !drawing && selectedId === s.id ? 'auto' : 'none'
              }}
              onFocus={() => onSelect(s.id)}
              onChange={(e) => onText(s.id, e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
            />
          )
        })}
    </div>
  )
}
