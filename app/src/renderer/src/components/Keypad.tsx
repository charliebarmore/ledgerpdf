import { useRef, useState } from 'react'
import { TAPE_OPS, formatAmount, tapeRunning, tapeTotal, type Tape, type TapeEntry, type TapeOp } from '../session'

/**
 * The 10-key panel: a keypad, the current figure, and the tape's lines as an
 * editable list.
 *
 * The keypad is a second way in, not the primary one — typing is faster than
 * clicking digits, and every button here routes through the same key handler
 * the keyboard does, so the two can't diverge.
 *
 * Chain semantics: every operator applies to the running total, like a physical
 * 10-key. The Result column shows that running value after each line, rounded
 * to cents at every step, so the printed figures always foot to the printed
 * total.
 */
export function Keypad({
  tape,
  buffer,
  pendingOp,
  onKey,
  onEditEntry,
  onRemoveEntry,
  onClose,
  onNewTape
}: {
  tape: Tape
  buffer: string
  pendingOp: TapeOp
  onKey: (key: string) => void
  onEditEntry: (index: number, patch: Partial<TapeEntry>) => void
  onRemoveEntry: (index: number) => void
  onClose: () => void
  onNewTape: () => void
}): React.JSX.Element {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const panel = useRef<HTMLDivElement>(null)

  const startDrag = (e: React.PointerEvent): void => {
    if ((e.target as HTMLElement).closest('button, input')) return
    e.preventDefault()
    const rect = panel.current!.getBoundingClientRect()
    const offX = e.clientX - rect.left
    const offY = e.clientY - rect.top
    const move = (ev: PointerEvent): void =>
      setPos({
        x: Math.max(0, Math.min(window.innerWidth - rect.width, ev.clientX - offX)),
        y: Math.max(0, Math.min(window.innerHeight - rect.height, ev.clientY - offY))
      })
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const section = tape.section ?? 1
  const running = tapeRunning(tape.entries)
  const key = (label: string, send: string, cls = ''): React.JSX.Element => (
    <button className={`kp-key ${cls}`} onClick={() => onKey(send)} title={label}>
      {label}
    </button>
  )

  return (
    <div
      ref={panel}
      className="keypad"
      style={pos ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' } : undefined}
      onPointerDown={startDrag}
    >
      <div className="kp-title">
        <span>10 Key</span>
        <button className="kp-close" onClick={onClose} title="Close (the tape stays)">
          ×
        </button>
      </div>

      {/* The tape's lines, editable: a mis-key in the middle shouldn't mean
          retyping the whole thing. */}
      <div className="kp-tape">
        <div className="kp-row kp-head">
          <span>Line</span>
          <span>Note</span>
          <span>Amount</span>
          <span>Op</span>
          <span className="kp-res">Result</span>
        </div>
        {tape.entries.map((e, i) => (
          <div className="kp-row" key={i}>
            <span className="kp-label">
              {section} - {i + 1}
            </span>
            <input
              className="kp-note"
              value={e.note ?? ''}
              placeholder="—"
              onChange={(ev) => onEditEntry(i, { note: ev.target.value })}
            />
            <span className="kp-amt">{formatAmount(e.value)}</span>
            <button
              className="kp-op"
              title="Cycle this line's operator: + − × ÷"
              onClick={() =>
                onEditEntry(i, {
                  op: TAPE_OPS[(TAPE_OPS.indexOf(e.op) + 1) % TAPE_OPS.length]
                })
              }
            >
              {e.op}
            </button>
            <span className="kp-res">{formatAmount(running[i])}</span>
            <button className="kp-del" title="Delete this line" onClick={() => onRemoveEntry(i)}>
              ×
            </button>
          </div>
        ))}
        <div className="kp-row kp-total">
          <span className="kp-label">{section} - T</span>
          <span className="kp-note-static">Total</span>
          <span className="kp-amt" />
          <span className="kp-op-static">*</span>
          <span className="kp-res kp-res-total">{formatAmount(tapeTotal(tape.entries))}</span>
        </div>
      </div>

      <div className="kp-display">
        <span className="kp-pending" title="Operator waiting for the next figure">
          {pendingOp === '+' ? '' : pendingOp}
        </span>
        <span>{buffer || '0'}</span>
      </div>

      <div className="kp-grid">
        {key('C', 'C')}
        {key('CE', 'CE')}
        {key('⌫', 'Backspace')}
        {key('÷', '/', 'kp-op-key')}

        {key('7', '7')}
        {key('8', '8')}
        {key('9', '9')}
        {key('×', '*', 'kp-op-key')}

        {key('4', '4')}
        {key('5', '5')}
        {key('6', '6')}
        {key('−', '-', 'kp-op-key')}

        {key('1', '1')}
        {key('2', '2')}
        {key('3', '3')}
        {key('+', '+', 'kp-op-key')}

        {key('0', '0')}
        {key('00', '00')}
        {key('.', '.')}
        {key('±', '±')}

        <button
          className="kp-key kp-enter"
          onClick={() => onKey('=')}
          title="Finish the calculation and add the line (Enter or =)"
        >
          =
        </button>
      </div>

      <div className="kp-foot">
        <button onClick={onNewTape} title="Place another tape on this page">
          New tape
        </button>
        <span className="kp-hint" title="Each operator applies to the running total, rounded to cents at every step — so the printed lines always foot to the printed total.">
          chain · rounds each step
        </span>
      </div>
    </div>
  )
}
