import { useInspectorField } from './useInspectorField'
import {
  MARK_SIZE_MAX,
  MARK_SIZE_MIN,
  STAMP_MAX_LEN,
  dateMarkText,
  type Mark
} from '../session'
import { MARK_COLOR, MARK_GLYPH } from './MarkLayer'

/**
 * Everything about the selected mark, editable after the fact.
 *
 * A mark is a review record, so the fields that make it evidence — who placed
 * it, when, and what it means — have to be correctable without deleting and
 * re-placing it. The timestamp is deliberately NOT editable: it records when
 * the mark was placed, and a record you can backdate is not a record.
 *
 * Text fields update the session while typing. One focus gesture is one undo
 * entry, so changing selection cannot discard a note still in the panel.
 */
export function MarkInspector({
  mark,
  onChange,
  onDelete
}: {
  mark: Mark
  onChange: (patch: Partial<Mark>, group?: symbol, cancel?: boolean) => void
  onDelete: () => void
}): React.JSX.Element {
  const text = useInspectorField(
    mark.text ?? '',
    (value, group, cancel) => onChange({ text: value }, group, cancel),
    false
  )
  const author = useInspectorField(
    mark.author ?? '',
    (value, group, cancel) => onChange({ author: value }, group, cancel)
  )
  const note = useInspectorField(
    mark.note ?? '',
    (value, group, cancel) => onChange({ note: value }, group, cancel)
  )

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="panel-title">Mark</span>
        <button className="mi-delete" onClick={onDelete} title="Delete this mark  ⌫">
          Delete
        </button>
      </div>

      <div className="mi-id">
        <span className="mi-glyph" style={{ color: MARK_COLOR[mark.kind] }}>
          {mark.kind === 'text' || mark.kind === 'conn'
            ? mark.text
            : mark.kind === 'date'
              ? dateMarkText(mark)
              : MARK_GLYPH[mark.kind]}
        </span>
        <span className="mi-kind">
          {mark.kind === 'text'
            ? 'Lettered stamp'
            : mark.kind === 'date'
              ? 'Date stamp'
            : mark.kind === 'conn'
              ? // Say which half of the reference this is. An unpaired connector
                // looks identical to a paired one on the page, and the whole
                // point of the mark is the thing it points at.
                mark.refTarget
                ? 'Connector — tied to another page'
                : 'Connector — waiting for its other end'
              : mark.kind}
        </span>
      </div>

      <div className="mi-fields">
        {mark.kind === 'text' && (
          <label className="mi-row">
            <span>Letters</span>
            <input
              data-inspector-id={mark.id}
              data-inspector-field="letters"
              {...text}
              maxLength={STAMP_MAX_LEN}
            />
          </label>
        )}

        <label className="mi-row">
          <span>Size</span>
          <span className="mi-size">
            <button
              onClick={() => onChange({ size: mark.size - 4 })}
              disabled={mark.size <= MARK_SIZE_MIN}
              title="Smaller  −"
            >
              −
            </button>
            <span className="mi-size-val">{Math.round(mark.size)}</span>
            <button
              onClick={() => onChange({ size: mark.size + 4 })}
              disabled={mark.size >= MARK_SIZE_MAX}
              title="Larger  +"
            >
              +
            </button>
          </span>
        </label>

        <label className="mi-row">
          <span>Author</span>
          <input
            data-inspector-id={mark.id}
            data-inspector-field="author"
            {...author}
            maxLength={4}
            placeholder="—"
            title="Who placed this mark"
            onChange={(e) => {
              e.target.value = e.target.value.toUpperCase()
              author.onChange(e)
            }}
          />
        </label>

        {mark.by === 'agent' ? (
          <div className="mi-row mi-agent" title={`Placed by an agent during ${mark.run ?? 'an AI run'}`}>
            <span>Placed by</span>
            <b>AI</b>
          </div>
        ) : null}

        <label className="mi-row mi-row-note">
          <span>Note</span>
          <textarea
            data-inspector-id={mark.id}
            {...note}
            rows={3}
            placeholder="Agreed to source…"
            title="Comment shown in PDF viewers. Escape cancels the current edit."
          />
        </label>

        <div className="mi-row mi-meta">
          <span>Placed</span>
          <span title={mark.created ?? ''}>
            {mark.created ? new Date(mark.created).toLocaleString() : '—'}
          </span>
        </div>
      </div>
    </div>
  )
}
