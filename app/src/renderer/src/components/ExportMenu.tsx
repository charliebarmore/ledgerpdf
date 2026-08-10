import { useEffect, useRef, useState } from 'react'
import { formatPageNumber, type Numbering } from '../session'

/**
 * What the saved binder carries, beyond the pages themselves.
 *
 * Page numbering belongs here rather than as a loose toolbar control: it is a
 * decision about the OUTPUT, applied when the binder is written.
 *
 * Flattening used to live here as a checkbox. It moved out to its own action
 * ("Save a copy to send out") when the binder became the document: flattening
 * is permanent and produces a file that can never be reopened for editing, so
 * it is a different destination rather than a setting on this one.
 */
export function ExportMenu({
  numbering,
  onNumbering,
  pageCount
}: {
  numbering: Numbering
  onNumbering: (patch: Partial<Numbering>) => void
  pageCount: number
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

  // Show the real first and last, so the settings are checkable before export.
  const first = formatPageNumber(0, Math.max(pageCount, 1), numbering)
  const last = formatPageNumber(Math.max(pageCount - 1, 0), Math.max(pageCount, 1), numbering)

  return (
    <span className="exportmenu" ref={wrap}>
      <button
        className={open ? 'on' : ''}
        onClick={() => setOpen((v) => !v)}
        title="What the saved binder includes"
      >
        Options{numbering.enabled ? ' •' : ''}
      </button>

      {open && (
        <div className="ex-menu">
          <label className="toggle">
            <input
              type="checkbox"
              checked={numbering.enabled}
              onChange={(e) => onNumbering({ enabled: e.target.checked })}
            />
            Page numbers
          </label>

          {numbering.enabled && (
            <>
              <label className="mi-row">
                <span>Style</span>
                <select
                  value={numbering.style}
                  onChange={(e) => onNumbering({ style: e.target.value as Numbering['style'] })}
                >
                  <option value="number">1, 2, 3…</option>
                  <option value="pageOfTotal">Page 1 of {Math.max(pageCount, 1)}</option>
                  <option value="bates">Bates — {numbering.prefix}0001</option>
                </select>
              </label>
              {numbering.style === 'bates' && (
                <>
                  <label className="mi-row">
                    <span>Prefix</span>
                    <input
                      value={numbering.prefix}
                      maxLength={12}
                      onChange={(e) => onNumbering({ prefix: e.target.value })}
                      onKeyDown={(e) => e.stopPropagation()}
                    />
                  </label>
                  <label className="mi-row">
                    <span>Digits</span>
                    <span className="mi-size">
                      <button
                        onClick={() => onNumbering({ digits: Math.max(1, numbering.digits - 1) })}
                        disabled={numbering.digits <= 1}
                      >
                        −
                      </button>
                      <span className="mi-size-val">{numbering.digits}</span>
                      <button
                        onClick={() => onNumbering({ digits: Math.min(9, numbering.digits + 1) })}
                        disabled={numbering.digits >= 9}
                      >
                        +
                      </button>
                    </span>
                  </label>
                </>
              )}
              <label className="mi-row">
                <span>Start at</span>
                <input
                  className="ex-num"
                  value={numbering.start}
                  onChange={(e) => {
                    const n = parseInt(e.target.value.replace(/\D/g, ''), 10)
                    onNumbering({ start: Number.isNaN(n) ? 1 : n })
                  }}
                  onKeyDown={(e) => e.stopPropagation()}
                />
              </label>
              <label className="mi-row">
                <span>Corner</span>
                <select
                  value={numbering.corner}
                  onChange={(e) => onNumbering({ corner: e.target.value as Numbering['corner'] })}
                >
                  <option value="bl">Bottom left</option>
                  <option value="br">Bottom right</option>
                  <option value="tl">Top left</option>
                  <option value="tr">Top right</option>
                </select>
              </label>
              <label className="mi-row">
                <span>Size</span>
                <span className="mi-size">
                  <button
                    onClick={() => onNumbering({ size: Math.max(6, numbering.size - 1) })}
                    disabled={numbering.size <= 6}
                  >
                    −
                  </button>
                  <span className="mi-size-val">{numbering.size}</span>
                  <button
                    onClick={() => onNumbering({ size: Math.min(18, numbering.size + 1) })}
                    disabled={numbering.size >= 18}
                  >
                    +
                  </button>
                </span>
              </label>
              {/* Numbers follow binder ORDER, so showing the real ends is the
                  only way to check the settings before committing to an export. */}
              <p className="st-note">
                First page prints <b>{first}</b>, last prints <b>{last}</b>. Numbers follow
                binder order and are renumbered every export, so reordering pages can never
                leave them wrong.
              </p>
            </>
          )}
        </div>
      )}
    </span>
  )
}
