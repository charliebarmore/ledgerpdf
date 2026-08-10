import { useEffect, useRef, useState } from 'react'
import { MARK_COLOR, connectorsUsed, nextConnectorLabel, type Session } from '../session'

/**
 * Connectors — the circled reference that ties a figure to the same figure
 * elsewhere in the binder.
 *
 * One split control rather than two buttons, for the same reason the stamps are
 * grouped: the ribbon is finite. The button arms the next label in the series
 * you are using, which is the whole gesture most of the time; the caret is for
 * switching series and for picking up a label that is still waiting for its
 * other end.
 *
 * That list of open ends is the part worth having. A connector placed once is a
 * promise that has not been kept yet, and until now the only way to find it was
 * to remember. It is also the honest answer to "which number was I on?".
 */
export function ConnectorMenu({
  session,
  armedLabel,
  onArm
}: {
  session: Session
  armedLabel: string | null
  onArm: (label: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [series, setSeries] = useState<'number' | 'letter'>('number')
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

  const next = nextConnectorLabel(session, series)
  // Shows what is ARMED when a connector is in hand, so the label about to land
  // is the one on the button — auto-advance is unusable otherwise.
  const shown = armedLabel ?? next
  const used = connectorsUsed(session)
  const openEnds = [...used.entries()]
    .filter(([, marks]) => marks.length === 1)
    .map(([label]) => label)

  return (
    <span className="connmenu" ref={wrap}>
      <button
        className={`conn-primary${armedLabel ? ' on' : ''}`}
        style={{ color: MARK_COLOR.conn }}
        onClick={() => onArm(next)}
        title={`Connector ${shown} — click the figure, then click the matching figure on the page it ties to. The pair becomes a clickable reference that prints the page number.`}
      >
        <span className="conn-ring">{shown}</span>
      </button>
      <button
        className={`conn-caret${open ? ' on' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title="Numbers or letters, and any reference still waiting for its other end"
      >
        ▾
      </button>

      {open && (
        <div className="menu conn-panel">
          <div className="menu-title">Series</div>
          <div className="conn-series">
            {(['number', 'letter'] as const).map((s) => (
              <button
                key={s}
                className={series === s ? 'on' : ''}
                onClick={() => {
                  setSeries(s)
                  onArm(nextConnectorLabel(session, s))
                  setOpen(false)
                }}
              >
                <span className="conn-ring" style={{ color: MARK_COLOR.conn }}>
                  {nextConnectorLabel(session, s)}
                </span>
                <span>{s === 'number' ? 'Numbers' : 'Letters'}</span>
              </button>
            ))}
          </div>
          <p className="menu-note">
            A second series so a parallel run of references on one page does not collide with the
            first.
          </p>

          <div className="menu-title">Waiting for their other end</div>
          {openEnds.length === 0 ? (
            <p className="menu-note">
              None — every connector in this binder is tied to its pair.
            </p>
          ) : (
            <>
              <p className="menu-note">
                Placed once. Pick one up to put its other end on the page it ties to.
              </p>
              <div className="conn-open">
                {openEnds.map((label) => (
                  <button
                    key={label}
                    onClick={() => {
                      onArm(label)
                      setOpen(false)
                    }}
                  >
                    <span className="conn-ring" style={{ color: MARK_COLOR.conn }}>
                      {label}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </span>
  )
}
