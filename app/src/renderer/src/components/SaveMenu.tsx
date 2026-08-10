import { useEffect, useRef, useState } from 'react'

/**
 * Save, and the other place a binder can go.
 *
 * These were two toolbar buttons — "Save" and "Save a copy to send out" — and
 * both starting with the same verb made them read as two flavours of one
 * action. They are not. Save updates THIS document. The send-out copy is a
 * different file, with the marks printed on permanently and the editable
 * session stripped out, which can never be reopened for editing.
 *
 * A SPLIT button rather than a menu you must open: clicking Save still saves,
 * because that happens once a minute and should cost nothing. The caret opens
 * the one other destination, which happens once an engagement.
 *
 * Deliberately NOT a "flatten" checkbox inside the save dialog, which is the
 * obvious alternative and the dangerous one. That would put the file picker and
 * the flatten toggle in the same place, so choosing the binder you have open
 * while the toggle is on would write a flattened file over your own working
 * copy and take the session with it. Two named commands cannot be got into by
 * accident; a mode can.
 */
export function SaveMenu({
  onSave,
  onSendOut,
  disabled,
  saveHint,
  sendHint
}: {
  onSave: () => void
  onSendOut: () => void
  disabled: boolean
  saveHint: string
  sendHint: string
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
    <span className="savemenu" ref={wrap}>
      <button className="primary sm-main" onClick={onSave} disabled={disabled} title={saveHint}>
        Save
      </button>
      <button
        className={`primary sm-caret${open ? ' on' : ''}`}
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-label="Other save destinations"
        aria-expanded={open}
        title="Other places this binder can go"
      >
        ▾
      </button>

      {open && (
        <div className="sm-menu">
          <button
            className="sm-item"
            onClick={() => {
              setOpen(false)
              onSendOut()
            }}
            title={sendHint}
          >
            <span className="sm-item-name">Save a copy to send out…</span>
            {/* The consequence, not a description. This is the one save in the
                app that cannot be undone by saving again. */}
            <span className="sm-item-why">
              Marks printed on permanently. Cannot be reopened for editing.
            </span>
          </button>
        </div>
      )}
    </span>
  )
}
