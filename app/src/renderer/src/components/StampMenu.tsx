import { useEffect, useRef, useState } from 'react'
import { MARK_COLOR, STAMP_MAX_LEN, type Legend } from '../session'

/**
 * The firm's own tickmarks, grouped behind one control.
 *
 * They used to sit loose in the toolbar, one arm button and one × per stamp.
 * That was fine for the two or three a reviewer types by hand, and fell apart
 * the moment the legend's presets made eleven of them a single click away: the
 * ribbon filled edge to edge with "GL × TB × CF × F × C × CE ×" and the tools
 * that matter were pushed off the end.
 *
 * Two behaviours in one control, which is the point:
 *
 * - The BUTTON arms the stamp you used last. Marking a workpaper means the same
 *   stamp forty times, and putting a menu in front of the second one would be a
 *   tax on the common case.
 * - The CARET opens the list, where each stamp shows what it MEANS. The legend
 *   is what makes a tickmark evidence, so the meaning belongs where the stamp is
 *   chosen, not only in a panel someone has to know to open.
 *
 * Removal lives in the menu rather than the ribbon: dropping a stamp is a rare,
 * deliberate act, and an × sitting permanently beside a tool you click all day
 * is a misfire waiting to happen.
 */
export function StampMenu({
  stamps,
  legend,
  armedText,
  onArm,
  onAdd,
  onRemove
}: {
  stamps: string[]
  legend: Legend
  armedText: string | null
  onArm: (text: string) => void
  onAdd: (text: string) => void
  onRemove: (text: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  // The stamp the button arms. Remembered across openings so the button is a
  // repeat of what you are actually doing, not always the first in the list.
  const [last, setLast] = useState<string | null>(null)
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

  // A stamp armed from anywhere — a keyboard shortcut, the legend panel —
  // becomes the one the button repeats.
  useEffect(() => {
    if (armedText && stamps.includes(armedText)) setLast(armedText)
  }, [armedText, stamps])

  const primary = last && stamps.includes(last) ? last : (stamps[0] ?? null)
  const armedHere = !!armedText && armedText === primary

  const commit = (): void => {
    const text = draft.trim()
    setDraft('')
    if (text) onAdd(text)
  }

  return (
    <span className="stampmenu" ref={wrap}>
      <button
        className={`stamp-primary${armedHere ? ' on' : ''}`}
        disabled={!primary}
        style={primary ? { color: MARK_COLOR.text } : undefined}
        onClick={() => primary && onArm(primary)}
        title={
          primary
            ? `Place "${primary}"${legend[primary] ? ` — ${legend[primary]}` : ''}`
            : 'Your firm’s own tickmarks. Open the list to add one.'
        }
      >
        {primary ?? 'Stamps'}
      </button>
      <button
        className={`stamp-caret${open ? ' on' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title="Choose a stamp, add one, or see what each means"
      >
        ▾
      </button>

      {open && (
        <div className="menu stamp-panel">
          <div className="menu-title">Your stamps</div>
          {stamps.length === 0 ? (
            <p className="menu-note">
              None yet. Type letters below, or open Legend to add a standard set in one click.
            </p>
          ) : (
            <div className="stamp-rows">
              {stamps.map((s) => (
                <div key={s} className={`stamp-row${armedText === s ? ' on' : ''}`}>
                  <button
                    className="stamp-row-arm"
                    onClick={() => {
                      onArm(s)
                      setLast(s)
                      setOpen(false)
                    }}
                  >
                    <span className="stamp-row-letters" style={{ color: MARK_COLOR.text }}>
                      {s}
                    </span>
                    <span className="stamp-row-meaning">
                      {legend[s] || <em>no meaning recorded</em>}
                    </span>
                  </button>
                  <button
                    className="stamp-row-drop"
                    onClick={() => onRemove(s)}
                    title={`Remove "${s}" from the palette. Marks already placed stay exactly as they are.`}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="menu-title">Add one</div>
          <div className="stamp-add">
            <input
              value={draft}
              maxLength={STAMP_MAX_LEN}
              placeholder="TB"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit()
              }}
            />
            <button className="stamp-add-btn" disabled={!draft.trim()} onClick={commit}>
              Add
            </button>
          </div>
          <p className="menu-note">
            Give it a meaning in Legend — a tickmark nobody can read is not evidence.
          </p>
        </div>
      )}
    </span>
  )
}
