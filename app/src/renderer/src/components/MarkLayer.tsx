import { useCallback, useRef } from 'react'
import type { Mark, MarkKind, ToolKind } from '../session'

/**
 * Interactive overlay sitting exactly on top of the rendered page canvas.
 *
 * Coordinates here are normalized to the DISPLAYED page (nx left→right, ny
 * top→bottom), which is precisely what the engine's geometry module consumes —
 * so what you place is what gets written, on rotated and CropBox-cropped pages
 * alike, with no conversion in between.
 */

export const MARK_GLYPH: Record<MarkKind, string> = {
  tick: '✓',
  cross: '✕',
  text: ''
}

/** Must match engine MARK_COLORS — these are content, not theme. */
export const MARK_COLOR: Record<MarkKind, string> = {
  tick: 'rgb(33,140,33)',
  cross: 'rgb(184,38,38)',
  text: 'rgb(26,84,153)'
}

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
      style={{ width, height }}
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
            className={`mark${selectedId === m.id ? ' is-selected' : ''}`}
            style={{
              left: `${m.nx * 100}%`,
              top: `${m.ny * 100}%`,
              width: px,
              height: px,
              color: MARK_COLOR[m.kind],
              fontSize: m.kind === 'text' ? px * 0.62 : px
            }}
            title={`${m.kind === 'text' ? m.text : m.kind}${m.author ? ` · ${m.author}` : ''}${
              m.created ? ` · ${new Date(m.created).toLocaleString()}` : ''
            }`}
            onPointerDown={(e) => startDrag(e, m.id)}
          >
            {m.kind === 'text' ? m.text : MARK_GLYPH[m.kind]}
          </span>
        )
      })}
    </div>
  )
}
