import { useEffect, useState } from 'react'
import {
  SHAPE_COLORS,
  SHAPE_COLOR_NAMES,
  SHAPE_WIDTH_MAX,
  SHAPE_WIDTH_MIN,
  type Shape
} from '../session'

const LABEL: Record<Shape['kind'], string> = {
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  line: 'Line',
  arrow: 'Arrow',
  highlight: 'Highlight',
  textbox: 'Text note'
}

/**
 * The selected drawn annotation, editable after the fact — same contract as the
 * mark inspector: everything that makes it a review record can be corrected
 * except when it was drawn.
 */
export function ShapeInspector({
  shape,
  onChange,
  onDelete
}: {
  shape: Shape
  onChange: (patch: Partial<Shape>) => void
  onDelete: () => void
}): React.JSX.Element {
  const [note, setNote] = useState(shape.note ?? '')
  useEffect(() => setNote(shape.note ?? ''), [shape.id])

  const stroked = shape.kind !== 'highlight'

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="panel-title">{LABEL[shape.kind]}</span>
        <button className="mi-delete" onClick={onDelete} title="Delete this shape  ⌫">
          Delete
        </button>
      </div>

      <div className="mi-fields">
        {shape.kind !== 'highlight' && (
          <label className="mi-row">
            <span>Color</span>
            <span className="swatches">
              {SHAPE_COLOR_NAMES.map((c) => (
                <button
                  key={c}
                  className={`swatch${shape.color === c ? ' on' : ''}`}
                  style={{ background: SHAPE_COLORS[c] }}
                  onClick={() => onChange({ color: c })}
                  title={c}
                />
              ))}
            </span>
          </label>
        )}

        {stroked && (
          <label className="mi-row">
            <span>Weight</span>
            <span className="mi-size">
              <button
                onClick={() => onChange({ width: shape.width - 0.5 })}
                disabled={shape.width <= SHAPE_WIDTH_MIN}
                title="Thinner"
              >
                −
              </button>
              <span className="mi-size-val">{shape.width.toFixed(1)}</span>
              <button
                onClick={() => onChange({ width: shape.width + 0.5 })}
                disabled={shape.width >= SHAPE_WIDTH_MAX}
                title="Thicker"
              >
                +
              </button>
            </span>
          </label>
        )}

        <label className="mi-row mi-row-note">
          <span>Note</span>
          <textarea
            value={note}
            rows={3}
            placeholder="Why this is here…"
            title="Shown as the annotation's comment in any PDF viewer. Command/Ctrl+Enter saves."
            onChange={(e) => setNote(e.target.value)}
            onBlur={() => note.trim() !== (shape.note ?? '') && onChange({ note: note.trim() })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                e.currentTarget.blur()
              }
              if (e.key === 'Escape') {
                setNote(shape.note ?? '')
                e.currentTarget.blur()
              }
            }}
          />
        </label>

        <div className="mi-row mi-meta">
          <span>Drawn</span>
          <span title={shape.created ?? ''}>
            {shape.created ? new Date(shape.created).toLocaleString() : '—'}
          </span>
        </div>
      </div>
    </div>
  )
}
