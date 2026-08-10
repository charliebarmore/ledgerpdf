import { useEffect, useRef, useState } from 'react'
import {
  SHAPE_COLORS,
  SHAPE_COLOR_NAMES,
  type ShapeColor,
  type StatusDef,
  type StatusParts
} from '../session'

/**
 * The status control: a toolbar button that opens the legend.
 *
 * It lives in the toolbar rather than the side pane because applying a status
 * is an ACTION on the current selection, like rotating or deleting — the side
 * pane is for navigation and for inspecting what is already there.
 *
 * A status is applied to the selected pages (or the current one) and replaces
 * any status already there — a page is in one state, not several. The counts
 * turn the panel into a progress readout: on a 62-page binder, "38 Reviewed,
 * 18 not set" is the answer to the only question that matters mid-review.
 */
export function StatusMenu({
  defs,
  counts,
  parts,
  currentStatusId,
  targetCount,
  onApply,
  onClear,
  onAddDef,
  onEditDef,
  onRemoveDef,
  onParts,
  reviewer,
  onReviewer
}: {
  defs: StatusDef[]
  counts: { byId: Record<string, number>; unset: number }
  parts: StatusParts
  /** The status of the page under the cursor, so the panel shows where you are. */
  currentStatusId: string | null
  /** How many pages the next click would affect. */
  targetCount: number
  onApply: (statusId: string) => void
  onClear: () => void
  onAddDef: (label: string) => void
  onEditDef: (id: string, patch: Partial<StatusDef>) => void
  onRemoveDef: (id: string) => void
  onParts: (patch: Partial<StatusParts>) => void
  reviewer: string
  onReviewer: (initials: string) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [showParts, setShowParts] = useState(false)
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)

  // Close on an outside click or Escape. Bound only while open, so the menu
  // costs nothing when it isn't showing.
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

  const currentDef = defs.find((d) => d.id === currentStatusId) ?? null

  return (
    <span className="statusmenu" ref={wrap}>
      <button
        className={open ? 'on' : ''}
        onClick={() => setOpen((v) => !v)}
        title="Mark the selected page(s) reviewed, open, or anything else in your legend"
      >
        <span
          className="st-dot"
          style={{ background: currentDef ? SHAPE_COLORS[currentDef.color] : 'transparent' }}
        />
        Status
      </button>

      {open && (
        <div className="st-menu">
          <div className="st-menu-head">
            <span>{targetCount ? `Apply to ${targetCount} page(s)` : 'Select a page first'}</span>
            <button
              className="bm-add"
              onClick={() => setShowParts((v) => !v)}
              title="What a status draws"
            >
              {showParts ? 'Done' : 'Options'}
            </button>
          </div>

      <div className="st-list">
        {defs.map((d) => (
          <div key={d.id} className={`st-row${currentStatusId === d.id ? ' is-current' : ''}`}>
            <button
              className="st-swatch"
              style={{ background: SHAPE_COLORS[d.color] }}
              title="Change color"
              onClick={() => {
                const i = SHAPE_COLOR_NAMES.indexOf(d.color)
                onEditDef(d.id, {
                  color: SHAPE_COLOR_NAMES[(i + 1) % SHAPE_COLOR_NAMES.length] as ShapeColor
                })
              }}
            />
            {editing === d.id ? (
              <input
                className="st-label-input"
                autoFocus
                defaultValue={d.label}
                onBlur={(e) => {
                  onEditDef(d.id, { label: e.target.value.trim() || d.label })
                  setEditing(null)
                }}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur()
                }}
              />
            ) : (
              <button
                className="st-label"
                disabled={targetCount === 0}
                onClick={() => {
                  onApply(d.id)
                  setOpen(false)
                }}
                onDoubleClick={() => setEditing(d.id)}
                title={
                  targetCount === 0
                    ? 'Select a page first'
                    : `Mark ${targetCount} page(s) "${d.label}" — double-click to rename`
                }
              >
                {d.label}
              </button>
            )}
            <span className="st-count" title="Pages with this status">
              {counts.byId[d.id] ?? 0}
            </span>
            <button
              className="st-drop"
              title={`Remove "${d.label}" from the legend`}
              onClick={() => onRemoveDef(d.id)}
            >
              ×
            </button>
          </div>
        ))}

        <div className="st-row st-unset">
          <span className="st-swatch st-swatch-none" />
          <button
            className="st-label"
            disabled={targetCount === 0}
            onClick={() => {
              onClear()
              setOpen(false)
            }}
          >
            Not set
          </button>
          <span className="st-count">{counts.unset}</span>
          <span className="st-drop" />
        </div>
      </div>

      <div className="st-new">
        <input
          className="st-label-input"
          value={draft}
          placeholder="Add a status…"
          maxLength={24}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter' && draft.trim()) {
              onAddDef(draft.trim())
              setDraft('')
            }
          }}
        />
        <button
          disabled={!draft.trim()}
          onClick={() => {
            onAddDef(draft.trim())
            setDraft('')
          }}
        >
          +
        </button>
      </div>

      {showParts && (
        <div className="st-parts">
          <label className="mi-row">
            <span>Initials</span>
            <input
              className="rev-input"
              value={reviewer}
              maxLength={4}
              placeholder="—"
              onChange={(e) => onReviewer(e.target.value.toUpperCase().slice(0, 4))}
              onKeyDown={(e) => e.stopPropagation()}
            />
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={parts.stamp}
              onChange={(e) => onParts({ stamp: e.target.checked })}
            />
            Stamp (initials + date)
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={parts.border}
              onChange={(e) => onParts({ border: e.target.checked })}
            />
            Page border
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={parts.bookmark}
              onChange={(e) => onParts({ bookmark: e.target.checked })}
            />
            Color the bookmark
          </label>
          <label className="mi-row">
            <span>Corner</span>
            <select
              value={parts.corner}
              onChange={(e) => onParts({ corner: e.target.value as StatusParts['corner'] })}
            >
              <option value="tl">Top left</option>
              <option value="tr">Top right</option>
              <option value="bl">Bottom left</option>
              <option value="br">Bottom right</option>
            </select>
          </label>
          <label className="mi-row">
            <span>Width</span>
            <span className="mi-size">
              <button
                onClick={() => onParts({ borderWidth: Math.max(1, parts.borderWidth - 1) })}
                disabled={parts.borderWidth <= 1}
              >
                −
              </button>
              <span className="mi-size-val">{parts.borderWidth}</span>
              <button
                onClick={() => onParts({ borderWidth: Math.min(12, parts.borderWidth + 1) })}
                disabled={parts.borderWidth >= 12}
              >
                +
              </button>
            </span>
          </label>
          <p className="st-note">
            The stamp carries your initials and the time you applied it. The same initials
            author every mark, tape and shape you place.
          </p>
          </div>
        )}
        </div>
      )}
    </span>
  )
}
