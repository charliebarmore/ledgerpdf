import { useEffect, useRef, useState } from 'react'
import { TICKMARK_PRESETS, tokenGlyph, type Session, legendEntries } from '../session'

/**
 * What the tickmarks in this binder MEAN.
 *
 * A binder full of unexplained letters is the classic peer-review finding: the
 * preparer knew that "GL" meant agreed to the general ledger, and whoever picks
 * the file up in three years does not. So the legend is not decoration — it is
 * the part that makes the marks evidence.
 *
 * Two deliberate choices:
 *
 * - It lists only marks ACTUALLY USED. A legend showing a firm's whole palette
 *   tells a reader that fourteen tickmarks were available, not what the six in
 *   front of them mean, and every unused row invites "where is that one?"
 * - The presets are a starting point a firm edits, not a standard being
 *   asserted. Legends are firm-defined; ours would be a house style at best.
 */
export function LegendMenu({
  session,
  onMeaning,
  onAddStamp,
  onAddPage,
  busy
}: {
  session: Session
  onMeaning: (token: string, meaning: string) => void
  onAddStamp: (token: string, meaning: string) => void
  onAddPage: () => void
  busy: boolean
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

  const inUse = legendEntries(session)
  const undefinedCount = inUse.filter((r) => !r.meaning).length
  const palette = new Set(session.stamps ?? [])
  // Offer only what is not already available and not already explained:
  // - in the palette, or a fixed toolbar tool (tick, cross, note, F)
  // - or already carrying a meaning, which is all a fixed tool needs from here
  const spare = TICKMARK_PRESETS.filter(
    (p) =>
      !palette.has(p.token) &&
      !['tick', 'cross', 'note'].includes(p.token) &&
      !session.legend?.[p.token]
  )

  return (
    <span className="legendmenu" ref={wrap}>
      <button
        className={open ? 'on' : ''}
        onClick={() => setOpen((v) => !v)}
        title="What each tickmark in this binder means — and add the legend to the binder as a page"
      >
        {/* The dot is the only thing in this menu a reviewer needs to see from
            the outside: marks are in use with no meaning recorded. */}
        Legend{undefinedCount ? ' •' : ''}
      </button>

      {open && (
        <div className="menu legend-panel">
          <div className="menu-title">Tickmarks in this binder</div>
          {inUse.length === 0 ? (
            <p className="menu-note">
              No review marks placed yet. Once you mark up a page, every mark you used shows up here
              to be given a meaning.
            </p>
          ) : (
            <div className="legend-rows">
              {inUse.map((r) => (
                <label key={r.token} className="legend-row">
                  <span className="legend-glyph">{r.glyph}</span>
                  <input
                    value={r.meaning}
                    placeholder="What does this mark mean?"
                    maxLength={120}
                    onChange={(e) => onMeaning(r.token, e.target.value)}
                  />
                  <span className="legend-count" title="How many times this mark is used">
                    ×{r.count}
                  </span>
                </label>
              ))}
            </div>
          )}

          {spare.length > 0 && (
            <>
              <div className="menu-title">Add to your palette</div>
              <p className="menu-note">
                A starting set, not a standard — every firm defines its own. Click one to add it to
                your stamps with its meaning already filled in, then edit the wording to match your
                firm.
              </p>
              <div className="legend-presets">
                {spare.map((p) => (
                  <button
                    key={p.token}
                    className="legend-preset"
                    onClick={() => onAddStamp(p.token, p.meaning)}
                    title={p.meaning}
                  >
                    <span className="legend-glyph">{tokenGlyph(p.token)}</span>
                    <span className="legend-preset-name">{p.meaning}</span>
                  </button>
                ))}
              </div>
            </>
          )}

          <div className="menu-title">In the binder</div>
          <p className="menu-note">
            Adds the legend as a real page at the front of the binder — a normal page you can move,
            rename or delete. Run it again after marking up more and it replaces the old one.
          </p>
          <button className="legend-addpage" disabled={busy || !inUse.length} onClick={onAddPage}>
            Add legend page
          </button>
        </div>
      )}
    </span>
  )
}
