import { useEffect, useRef, useState } from 'react'
import { SHAPE_COLORS, SHAPE_COLOR_NAMES, type ShapeColor } from '../session'

/**
 * The colour for new shapes, as one button rather than six.
 *
 * Colour is a SETTING, not a tool: it is chosen occasionally and then left
 * alone, so it does not deserve permanent width next to the tools you reach for
 * constantly. Six inline swatches cost ~88px, which was the whole reason the
 * toolbar could not hold one row.
 */
export function ColorMenu({
  color,
  onPick,
  appliesToSelection
}: {
  color: ShapeColor
  onPick: (c: ShapeColor) => void
  /** True when a shape is selected, so the button can say it will recolor it. */
  appliesToSelection: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent): void => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', esc, true)
    return () => {
      document.removeEventListener('pointerdown', away)
      document.removeEventListener('keydown', esc, true)
    }
  }, [open])

  return (
    <span className="colormenu" ref={wrap}>
      <button
        className={`color-btn${open ? ' on' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title={
          appliesToSelection
            ? `Color: ${color} — pick another to recolor the selected shape`
            : `Color for new shapes: ${color}`
        }
      >
        <span className="color-chip" style={{ background: SHAPE_COLORS[color] }} />
        <span className="color-caret">▾</span>
      </button>
      {open && (
        <div className="color-pop">
          {SHAPE_COLOR_NAMES.map((c) => (
            <button
              key={c}
              className={`swatch${color === c ? ' on' : ''}`}
              style={{ background: SHAPE_COLORS[c] }}
              title={c}
              onClick={() => {
                onPick(c as ShapeColor)
                setOpen(false)
              }}
            />
          ))}
        </div>
      )}
    </span>
  )
}
