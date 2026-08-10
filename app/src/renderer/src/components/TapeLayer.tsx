import { useEffect, useRef } from 'react'
import {
  TAPE_CHAR_W,
  TAPE_FONT_SIZE,
  tapeMetrics,
  TAPE_LINE_HEIGHT,
  TAPE_PAD,
  TAPE_TITLE_MAX_LEN,
  formatAmount,
  parseAmount,
  tapeLines,
  tapeTotal,
  type Tape,
  type TapeOp
} from '../session'

/**
 * Calculator tapes, drawn on top of the page.
 *
 * The card is built from the model's `tapeLines()` — the same strings the
 * engine draws in Courier — so the preview and the exported PDF cannot drift.
 *
 * Keying is a 10-key adding machine, the muscle memory every preparer already
 * has: digits key into the current line, `+`/Enter commits it as an addition,
 * `-` commits it as a subtraction, ⌫ takes back the keystroke and then the last
 * line, Esc puts the tape down.
 */
export function TapeLayer({
  tapes,
  width,
  height,
  scale,
  activeId,
  armed,
  buffer,
  pendingOp,
  onActivate,
  onKey,
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
  /** Any armed tool: while one is armed, tapes let the pointer through. */
  armed: unknown
  /** What is mid-keying. Owned by App so the keypad and the card agree. */
  buffer: string
  pendingOp: TapeOp
  onActivate: (id: string | null) => void
  onKey: (key: string) => void
  onMove: (id: string, nx: number, ny: number) => void
  onTitle: (id: string, title: string) => void
  onDelete: (id: string) => void
}): React.JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)

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

  return (
    <div className="tapelayer" ref={box} style={{ width, height }}>
      {tapes.map((tape) => {
        const active = tape.id === activeId
        const hasTitle = !!tape.title?.trim()
        const rows = tapeLines(tape)
        // The line being keyed, rendered in the same columns as a committed one.
        // Only while something is actually being keyed — an empty buffer must
        // not add a phantom 0.00 line to the card.
        const pending = active && buffer
          ? tapeLines({
              ...tape,
              title: undefined,
              entries: [...tape.entries, { value: parseAmount(buffer) ?? 0, op: pendingOp }]
            })[tape.entries.length + 1]
          : null
        const cols = Math.max(...rows.map((r) => r.length), pending?.length ?? 0, 8)
        // Per-tape size, defaulting to the constant. Metrics come from the
        // shared helper so the card here matches the one the engine draws.
        const m = tapeMetrics(tape.size)
        const fs = (tape.size ?? TAPE_FONT_SIZE) * scale
        const all = hasTitle ? rows.slice(1) : rows
        // The line being keyed belongs above the total, where it will land.
        const body = all.slice(0, -1)
        const totalRow = all[all.length - 1]

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
              // Width from the same character advance the engine uses, so the
              // card can't be one size here and another in the PDF.
              width: (cols * m.charW + 2 * m.pad) * scale,
              padding: m.pad * scale,
              fontSize: fs,
              lineHeight: `${m.lineH * scale}px`,
              pointerEvents: armed ? 'none' : 'auto'
            }}
            onPointerDown={(e) => startDrag(e, tape.id)}
            onKeyDown={(e) => {
              if ((e.target as HTMLElement).tagName === 'INPUT') {
                if (e.key === 'Enter' || e.key === 'Escape') {
                  e.stopPropagation()
                  cardRef.current?.focus()
                }
                return
              }
              // The tape owns the keyboard while it is active.
              e.stopPropagation()
              e.preventDefault()
              onKey(e.key)
            }}
            onFocus={() => !active && onActivate(tape.id)}
          >
            {active ? (
              <>
                <input
                  className="tape-title-input"
                  value={tape.title ?? ''}
                  maxLength={TAPE_TITLE_MAX_LEN}
                  placeholder="caption…"
                  style={{ fontSize: fs, height: TAPE_LINE_HEIGHT * scale }}
                  onChange={(e) => onTitle(tape.id, e.target.value)}
                />
                {/* `maxLength` alone stops accepting keystrokes and says
                    nothing, so a caption typed past the cap is silently
                    shortened: "Peña & Fuentes — §1031 exchange" was stored as
                    "…§1031 excha" with no indication. On a workpaper the
                    caption is what a reviewer reads to know what was footed,
                    and one that quietly means something narrower than what the
                    preparer wrote is the same class of defect as a mark with
                    no author. The cap stays — it is what keeps the drawn card
                    from growing off the page — but it announces itself. */}
                {(tape.title ?? '').length >= TAPE_TITLE_MAX_LEN && (
                  <div className="tape-title-full" role="status">
                    caption full · {TAPE_TITLE_MAX_LEN} characters
                  </div>
                )}
              </>
            ) : (
              hasTitle && <div className="tape-line tape-title">{tape.title}</div>
            )}
            {body.map((r, i) => (
              <div key={i} className="tape-line">
                {r}
              </div>
            ))}
            {pending && (
              <div className="tape-line tape-pending">
                {pending}
                <span className="tape-caret" />
              </div>
            )}
            <div className="tape-line tape-total">{totalRow}</div>
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
