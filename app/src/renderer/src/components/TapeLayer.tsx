import { useEffect, useRef, useState } from 'react'
import {
  TAPE_CHAR_W,
  TAPE_FONT_SIZE,
  TAPE_LINE_HEIGHT,
  TAPE_PAD,
  TAPE_TITLE_MAX_LEN,
  formatAmount,
  parseAmount,
  tapeTotal,
  type Tape
} from '../session'

/**
 * Calculator tapes, drawn on top of the page.
 *
 * Keyboard model is a 10-key adding machine, because that is the muscle memory
 * every preparer already has: digits key into the current line, Enter commits it
 * and the running total updates, `-` flips the sign, ⌫ takes back the last
 * keystroke (or the last committed line once the buffer is empty), Esc puts the
 * tape down.
 *
 * The card's geometry mirrors engine appearance.tape_* exactly, so the tape you
 * line up beside a number on screen is the tape that lands in the PDF.
 */

/** Committed lines plus whatever is mid-keying, aligned as one block. */
function displayLines(tape: Tape, buffer: string | null): {
  title: string | null
  amounts: string[]
  pending: string | null
  rule: string
  total: string
  width: number
} {
  const amounts = tape.entries.map(formatAmount)
  const total = formatAmount(tapeTotal(tape.entries))
  const title = tape.title?.trim() || null
  const width = Math.max(
    total.length,
    title?.length ?? 0,
    buffer?.length ?? 0,
    ...amounts.map((a) => a.length),
    8
  )
  return {
    title,
    amounts: amounts.map((a) => a.padStart(width)),
    pending: buffer === null ? null : buffer.padStart(width),
    rule: '-'.repeat(width),
    total: total.padStart(width),
    width
  }
}

export function TapeLayer({
  tapes,
  width,
  height,
  scale,
  activeId,
  onActivate,
  onCommit,
  onBackspace,
  onMove,
  onTitle,
  onDelete
}: {
  tapes: Tape[]
  width: number
  height: number
  /** Effective zoom: CSS pixels per PDF point. */
  scale: number
  activeId: string | null
  onActivate: (id: string | null) => void
  onCommit: (id: string, value: number) => void
  onBackspace: (id: string) => void
  onMove: (id: string, nx: number, ny: number) => void
  onTitle: (id: string, title: string) => void
  onDelete: (id: string) => void
}): React.JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const [buffer, setBuffer] = useState('')

  // A fresh tape starts with an empty buffer; so does switching tapes, so a
  // half-keyed number can never land on the wrong tape.
  useEffect(() => setBuffer(''), [activeId])

  // Keying should start the moment a tape is placed — no click to focus first.
  useEffect(() => {
    if (activeId) cardRef.current?.focus()
  }, [activeId])

  const toNorm = (clientX: number, clientY: number): { nx: number; ny: number } => {
    const r = box.current!.getBoundingClientRect()
    return {
      nx: Math.min(1, Math.max(0, (clientX - r.left) / r.width)),
      ny: Math.min(1, Math.max(0, (clientY - r.top) / r.height))
    }
  }

  /**
   * Pointer down could be a drag or a click-to-focus. Treat it as a drag only
   * once it actually moves, so tapping a tape to key into it never nudges it.
   */
  const startDrag = (e: React.PointerEvent, id: string): void => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return
    e.stopPropagation()
    e.preventDefault()
    const from = { x: e.clientX, y: e.clientY }
    let dragging = false
    const move = (ev: PointerEvent): void => {
      if (!dragging && Math.hypot(ev.clientX - from.x, ev.clientY - from.y) < 3) return
      dragging = true
      const { nx, ny } = toNorm(ev.clientX, ev.clientY)
      onMove(id, nx, ny)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (!dragging) onActivate(id)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const onKey = (e: React.KeyboardEvent, tape: Tape): void => {
    // The caption field is an ordinary text input — let it have its keys.
    if ((e.target as HTMLElement).tagName === 'INPUT') {
      if (e.key === 'Enter' || e.key === 'Escape') {
        e.stopPropagation()
        cardRef.current?.focus()
      }
      return
    }
    // Everything below belongs to the tape, not to the app's page shortcuts.
    e.stopPropagation()

    if (/^[0-9]$/.test(e.key) || e.key === '.') {
      e.preventDefault()
      // One decimal point per number, and no leading run of zeros.
      if (e.key === '.' && buffer.includes('.')) return
      return setBuffer((b) => (b === '0' && e.key !== '.' ? e.key : b + e.key))
    }
    if (e.key === '-' || e.key === '+') {
      e.preventDefault()
      return setBuffer((b) => (b.startsWith('-') ? b.slice(1) : `-${b}`))
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const value = parseAmount(buffer)
      if (value === null) return
      onCommit(tape.id, value)
      return setBuffer('')
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault()
      // Take back the keystroke first; only then the last committed line.
      if (buffer) return setBuffer((b) => b.slice(0, -1))
      return onBackspace(tape.id)
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      // An untouched tape shouldn't linger as an empty card on the workpaper.
      if (tape.entries.length === 0 && !buffer && !tape.title) return onDelete(tape.id)
      return onActivate(null)
    }
  }

  return (
    <div className="tapelayer" ref={box} style={{ width, height }}>
      {tapes.map((tape) => {
        const active = tape.id === activeId
        const view = displayLines(tape, active ? buffer : null)
        const fs = TAPE_FONT_SIZE * scale
        return (
          <div
            key={tape.id}
            ref={active ? cardRef : undefined}
            className={`tape${active ? ' is-active' : ''}`}
            tabIndex={0}
            role="group"
            aria-label={`Calculator tape, total ${formatAmount(tapeTotal(tape.entries))}`}
            style={{
              left: `${tape.nx * 100}%`,
              top: `${tape.ny * 100}%`,
              // Width from the same character-advance the engine uses, so the
              // card can't be one size here and another in the PDF.
              width: (view.width * TAPE_CHAR_W + 2 * TAPE_PAD) * scale,
              padding: TAPE_PAD * scale,
              fontSize: fs,
              lineHeight: `${TAPE_LINE_HEIGHT * scale}px`
            }}
            onPointerDown={(e) => startDrag(e, tape.id)}
            onKeyDown={(e) => onKey(e, tape)}
            onFocus={() => !active && onActivate(tape.id)}
          >
            {active ? (
              <input
                className="tape-title-input"
                value={tape.title ?? ''}
                maxLength={TAPE_TITLE_MAX_LEN}
                placeholder="caption…"
                style={{ fontSize: fs, height: TAPE_LINE_HEIGHT * scale }}
                onChange={(e) => onTitle(tape.id, e.target.value)}
              />
            ) : (
              view.title && <div className="tape-line tape-title">{view.title}</div>
            )}
            {view.amounts.map((a, i) => (
              <div className="tape-line" key={i}>
                {a}
              </div>
            ))}
            {view.pending !== null && (
              <div className="tape-line tape-pending">
                {view.pending}
                <span className="tape-caret" />
              </div>
            )}
            <div className="tape-line tape-rule">{view.rule}</div>
            <div className="tape-line tape-total">{view.total}</div>
            {active && (
              <button
                className="tape-close"
                title="Delete this tape"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => onDelete(tape.id)}
              >
                ×
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
