import type { JournalEntry, Session } from '../session'

/**
 * What an agent did to this binder, and the way to take it back out.
 *
 * A workpaper is evidence. Before anyone signs one, they should be able to see
 * every automated change in order and in plain language — which is why this
 * reads as a list of sentences rather than a diff.
 *
 * Entries are grouped by run because that is the unit a reviewer thinks in
 * ("undo what the AI just did"), and it is the only unit revert operates on.
 */

function when(iso: string): string {
  // Local time, no date: the journal is read in the same sitting it was made.
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

export function HistoryPanel({
  session,
  onRevert,
  onClose
}: {
  session: Session
  onRevert: (run: string) => void
  onClose: () => void
}): React.JSX.Element {
  const journal = session.journal ?? []

  /** Whether anything from this run is still in the binder to remove. */
  const remaining = (run: string): number =>
    (session.marks ?? []).filter((m) => m.run === run).length +
    (session.tapes ?? []).filter((t) => t.run === run).length +
    (session.shapes ?? []).filter((s) => s.run === run).length +
    (session.bookmarks ?? []).filter((b) => b.run === run).length

  // Runs come from the journal AND from what is actually stamped in the binder.
  // Stamping and journaling are separate steps, so a run can leave annotations
  // behind without an action log — a session from an older build, or a tool
  // that stamps but does not record. Listing only journalled runs would let the
  // status bar say "1 by AI" while this panel said nothing was automated, which
  // is precisely the contradiction a reviewer must never be shown.
  const runs: Array<{ run: string; entries: JournalEntry[] }> = []
  const seen = (key: string): { run: string; entries: JournalEntry[] } => {
    const found = runs.find((r) => r.run === key)
    if (found) return found
    const made = { run: key, entries: [] as JournalEntry[] }
    runs.push(made)
    return made
  }
  for (const e of journal) seen(e.run ?? 'you').entries.push(e)
  for (const stamped of [
    ...(session.marks ?? []),
    ...(session.tapes ?? []),
    ...(session.shapes ?? []),
    ...(session.bookmarks ?? [])
  ]) {
    if (stamped.run) seen(stamped.run)
  }
  // Newest run first — the one a reviewer is most likely to be judging.
  runs.reverse()
  const unlogged = runs.filter((r) => r.run !== 'you' && r.entries.length === 0).length

  return (
    <div className="panel">
      <div className="panel-head">
        <span>AI history</span>
        <button className="bm-add" onClick={onClose} title="Hide this panel">
          Close
        </button>
      </div>

      {runs.length === 0 ? (
        <p className="panel-empty">Nothing automated in this binder.</p>
      ) : (
        <div className="hist-list">
          {unlogged > 0 && (
            <p className="panel-empty hist-note">
              {unlogged === 1 ? 'One run has' : `${unlogged} runs have`} no action log — written
              before this binder recorded them, or by a tool that does not. What they added can
              still be removed.
            </p>
          )}
          {runs.map(({ run, entries }) => {
            const left = run === 'you' ? 0 : remaining(run)
            return (
              <div className="hist-run" key={run}>
                <div className="hist-run-head">
                  <span>
                    {run === 'you'
                      ? 'Your changes'
                      : entries.length
                        ? `AI run · ${entries.length} change(s)`
                        : `AI run · ${left} annotation(s), not logged`}
                  </span>
                  {run !== 'you' && (
                    <button
                      className="bm-add"
                      disabled={left === 0}
                      onClick={() => onRevert(run)}
                      title={
                        left === 0
                          ? 'Nothing from this run is left to remove'
                          : `Remove the ${left} annotation(s) this run added. Page order, rotation and deletions are not undone.`
                      }
                    >
                      {left === 0 ? 'Reverted' : `Undo ${left}`}
                    </button>
                  )}
                </div>
                {entries.map((e) => (
                  <div className="hist-row" key={e.id}>
                    <span className="hist-when">{when(e.at)}</span>
                    <span className="hist-what">
                      {e.what}
                      {/* Named, not hidden: revert cannot take these back, and a
                          reviewer should learn that here rather than after. */}
                      {e.structural && (
                        <em className="hist-structural" title="Reverting the run cannot undo this">
                          {' '}
                          · not undoable
                        </em>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
