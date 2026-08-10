import { useCallback, useRef } from 'react'
import {
  CONN_STROKE_RATIO,
  MARK_COLOR,
  MARK_GLYPH,
  connectorFontSize,
  markCursor,
  type Mark,
  type ToolKind
} from '../session'

export { MARK_COLOR, MARK_GLYPH }

/**
 * Interactive overlay sitting exactly on top of the rendered page canvas.
 *
 * Coordinates here are normalized to the DISPLAYED page (nx left→right, ny
 * top→bottom), which is precisely what the engine's geometry module consumes —
 * so what you place is what gets written, on rotated and CropBox-cropped pages
 * alike, with no conversion in between.
 */

export function MarkLayer({
  marks,
  width,
  height,
  scale,
  armed,
  selectedId,
  onPlace,
  onSelect,
  onMove
}: {
  marks: Mark[]
  /** CSS size of the page canvas this overlays. */
  width: number
  height: number
  /** Effective zoom: CSS pixels per PDF point. Marks are sized in points. */
  scale: number
  /** The palette tool waiting to be placed, if any — a mark or a tape. */
  armed: { kind: ToolKind; text?: string } | null
  selectedId: string | null
  onPlace: (nx: number, ny: number) => void
  onSelect: (id: string | null) => void
  onMove: (id: string, nx: number, ny: number) => void
}): React.JSX.Element {
  const box = useRef<HTMLDivElement>(null)

  const toNorm = useCallback((clientX: number, clientY: number) => {
    const r = box.current!.getBoundingClientRect()
    return {
      nx: Math.min(1, Math.max(0, (clientX - r.left) / r.width)),
      ny: Math.min(1, Math.max(0, (clientY - r.top) / r.height))
    }
  }, [])

  const startDrag = useCallback(
    (e: React.PointerEvent, id: string) => {
      e.stopPropagation()
      e.preventDefault()
      onSelect(id)
      const move = (ev: PointerEvent): void => {
        const { nx, ny } = toNorm(ev.clientX, ev.clientY)
        onMove(id, nx, ny)
      }
      const up = (): void => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [onMove, onSelect, toNorm]
  )

  return (
    <div
      ref={box}
      className={`marklayer${armed ? ' is-armed' : ''}`}
      style={{
        width,
        height,
        // A stamp shows as its own glyph; drag tools keep the crosshair.
        cursor:
          armed && (armed.kind === 'tick' || armed.kind === 'cross' || armed.kind === 'text')
            ? markCursor(armed.kind, armed.text)
            : undefined
      }}
      onPointerDown={(e) => {
        if (!armed) return onSelect(null)
        const { nx, ny } = toNorm(e.clientX, e.clientY)
        onPlace(nx, ny)
      }}
    >
      {marks.map((m) => {
        // Mark sizes are PDF points; `scale` converts to CSS pixels, so a mark
        // occupies the same fraction of the page at any zoom — and the same
        // fraction of the sheet once exported.
        const px = m.size * scale
        return (
          <span
            key={m.id}
            // `is-agent` mirrors appearance._agent_outline in the engine. The
            // rule in appearance.py is that a mark looks the same on screen as
            // in the export, and attribution is part of how a mark looks now.
            className={`mark${m.by === 'agent' ? ' is-agent' : ''}${
              selectedId === m.id ? ' is-selected' : ''
            }${m.kind === 'conn' ? ' is-conn' : ''}`}
            style={{
              left: `${m.nx * 100}%`,
              top: `${m.ny * 100}%`,
              width: px,
              height: px,
              color: MARK_COLOR[m.kind],
              // The ring is drawn in CSS here and as a Bezier in the engine, so
              // its stroke has to be stated in both. `is-conn` in styles.css
              // carries the rest; only the width scales with the mark.
              ...(m.kind === 'conn'
                ? {
                    fontSize: connectorFontSize(px, m.text ?? ''),
                    borderWidth: Math.max(1, px * CONN_STROKE_RATIO)
                  }
                : { fontSize: m.kind === 'text' ? px * 0.62 : px })
            }}
            title={
              m.kind === 'conn'
                ? `Connector ${m.text}${m.refTarget ? ' · tied to another page' : ' · waiting for its other end'}${
                    m.author ? ` · ${m.author}` : ''
                  }`
                : `${m.kind === 'text' ? m.text : m.kind}${m.author ? ` · ${m.author}` : ''}${
                    m.created ? ` · ${new Date(m.created).toLocaleString()}` : ''
                  }`
            }
            onPointerDown={(e) => startDrag(e, m.id)}
          >
            {m.kind === 'text' || m.kind === 'conn' ? m.text : MARK_GLYPH[m.kind]}
          </span>
        )
      })}
    </div>
  )
}
