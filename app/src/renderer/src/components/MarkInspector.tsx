import { useEffect, useState } from 'react'
import { MARK_SIZE_MAX, MARK_SIZE_MIN, STAMP_MAX_LEN, type Mark } from '../session'
import { MARK_COLOR, MARK_GLYPH } from './MarkLayer'

/**
 * Everything about the selected mark, editable after the fact.
 *
 * A mark is a review record, so the fields that make it evidence — who placed
 * it, when, and what it means — have to be correctable without deleting and
 * re-placing it. The timestamp is deliberately NOT editable: it records when
 * the mark was placed, and a record you can backdate is not a record.
 *
 * Text fields commit on blur or Enter rather than per keystroke, so typing a
 * note leaves one undo entry instead of forty.
 */
export function MarkInspector({
  mark,
  onChange,
  onDelete
}: {
  mark: Mark
  onChange: (patch: Partial<Mark>) => void
  onDelete: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState({
    text: mark.text ?? '',
    author: mark.author ?? '',
    note: mark.note ?? ''
  })

  // Selecting a different mark replaces the draft — otherwise the previous
  // mark's half-typed note would leak onto this one.
  useEffect(() => {
    setDraft({ text: mark.text ?? '', author: mark.author ?? '', note: mark.note ?? '' })
  }, [mark.id])

  const commit = (field: 'text' | 'author' | 'note') => (): void => {
    const value = draft[field].trim()
    if (value === (mark[field] ?? '')) return
    // A lettered mark with no letters would export as "?" — keep the old text.
    if (field === 'text' && value === '') return setDraft((d) => ({ ...d, text: mark.text ?? '' }))
    onChange({ [field]: value })
  }

  const onKey = (field: 'text' | 'author' | 'note') => (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
    if (e.key === 'Escape') {
      setDraft((d) => ({ ...d, [field]: mark[field] ?? '' }))
      ;(e.target as HTMLInputElement).blur()
    }
  }

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
          {mark.kind === 'text' || mark.kind === 'conn' ? mark.text : MARK_GLYPH[mark.kind]}
        </span>
        <span className="mi-kind">
          {mark.kind === 'text'
            ? 'Lettered stamp'
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
              value={draft.text}
              maxLength={STAMP_MAX_LEN}
              onChange={(e) => setDraft((d) => ({ ...d, text: e.target.value }))}
              onBlur={commit('text')}
              onKeyDown={onKey('text')}
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
            value={draft.author}
            maxLength={4}
            placeholder="—"
            title="Who placed this mark"
            onChange={(e) => setDraft((d) => ({ ...d, author: e.target.value.toUpperCase() }))}
            onBlur={commit('author')}
            onKeyDown={onKey('author')}
          />
        </label>

        {mark.by === 'agent' ? (
          <div className="mi-row mi-agent" title={`Placed by an agent during ${mark.run ?? 'an AI run'}`}>
            <span>Placed by</span>
            <b>AI</b>
          </div>
        ) : null}

        <label className="mi-row">
          <span>Note</span>
          <input
            value={draft.note}
            placeholder="Agreed to source…"
            title="Shown as the annotation's comment in any PDF viewer"
            onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
            onBlur={commit('note')}
            onKeyDown={onKey('note')}
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
