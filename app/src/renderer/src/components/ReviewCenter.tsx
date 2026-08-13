import { SHAPE_COLORS } from '../session'
import type { ReviewSnapshot } from '../review'

export type ReviewTab = 'attention' | 'coverage' | 'ai'

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? '' : 's'}`
}

function shortTime(iso?: string): string {
  if (!iso) return ''
  const value = new Date(iso)
  return Number.isNaN(value.getTime()) ? '' : value.toLocaleString()
}

/**
 * The reviewer's front door into a finished binder.
 *
 * This is deliberately a drawer, not more ribbon. Review is a distinct pass
 * over the work: walk the exceptions, check coverage, inspect automation, then
 * return to the page. Everything displayed here is derived by review.ts, so it
 * cannot disagree with the MCP queue or the eventual send-out preflight.
 */
export function ReviewCenter({
  snapshot,
  tab,
  onTab,
  onJump,
  onResolve,
  onRevert,
  onClose
}: {
  snapshot: ReviewSnapshot
  tab: ReviewTab
  onTab: (tab: ReviewTab) => void
  onJump: (pageId: string) => void
  onResolve: (pageId: string, status: 'reviewed' | 'na') => void
  onRevert: (run: string) => void
  onClose: () => void
}): React.JSX.Element {
  const attentionChecks = snapshot.readiness.filter((finding) => finding.level === 'attention')
  const advisoryChecks = snapshot.readiness.filter((finding) => finding.level === 'advisory')
  const agentRuns = snapshot.runs.filter((run) => run.run !== 'you')

  return (
    <div className="review-backdrop" onMouseDown={onClose}>
      <aside
        className="review-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Review center"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="review-head">
          <div>
            <h2>Review center</h2>
            <p>
              {snapshot.active.length
                ? `${plural(snapshot.active.length, 'page')} ${snapshot.active.length === 1 ? 'needs' : 'need'} attention`
                : 'No open review items'}
            </p>
          </div>
          <button className="review-close" onClick={onClose} aria-label="Close review center">
            ×
          </button>
        </header>

        <div className="review-overview" aria-label="Binder review overview">
          <div><b>{snapshot.pageCount}</b><span>pages</span></div>
          <div className={snapshot.active.length ? 'has-attention' : ''}>
            <b>{snapshot.active.length}</b><span>open</span>
          </div>
          <div><b>{snapshot.resolved.length}</b><span>resolved</span></div>
          <div><b>{snapshot.statuses.unset}</b><span>not set</span></div>
        </div>

        <nav className="review-tabs" aria-label="Review center sections">
          <button className={tab === 'attention' ? 'is-current' : ''} onClick={() => onTab('attention')}>
            Needs attention{snapshot.active.length ? ` ${snapshot.active.length}` : ''}
          </button>
          <button className={tab === 'coverage' ? 'is-current' : ''} onClick={() => onTab('coverage')}>
            Coverage
          </button>
          <button className={tab === 'ai' ? 'is-current' : ''} onClick={() => onTab('ai')}>
            AI work{snapshot.agentCreatedItems ? ` ${snapshot.agentCreatedItems}` : ''}
          </button>
        </nav>

        <div className="review-body">
          {tab === 'attention' && (
            <>
              {attentionChecks.filter((finding) => finding.kind !== 'open-items').map((finding) => (
                <div className="review-alert" key={finding.kind}>
                  <b>Check:</b> {finding.message}
                </div>
              ))}
              {snapshot.connectorIssues.map((issue) => (
                <div className="review-connector" key={`${issue.label}:${issue.kind}`}>
                  <div>
                    <b>Connector {issue.label}</b>
                    <span>
                      {issue.kind === 'unpaired'
                        ? 'has only one end'
                        : issue.kind === 'too-many-ends'
                          ? 'is used more than twice'
                          : 'lost one or both page links'}
                    </span>
                  </div>
                  <div>
                    {issue.pageIds.map((pageId, index) => (
                      <button key={pageId} onClick={() => onJump(pageId)}>
                        p.{issue.pageNumbers[index] ?? '?'}
                      </button>
                    ))}
                  </div>
                </div>
              ))}

              {snapshot.active.length === 0 ? (
                <div className="review-empty">
                  <b>No open review items.</b>
                  <span>Coverage and send-out checks may still have advisories.</span>
                </div>
              ) : (
                <div className="review-items">
                  {snapshot.active.map((page) => {
                    const notes = page.findings.filter((finding) => finding.kind === 'note')
                    const crosses = page.findings.filter((finding) => finding.kind === 'cross')
                    return (
                      <article className="review-item" key={page.pageId}>
                        <div className="review-item-head">
                          <button className="review-page-link" onClick={() => onJump(page.pageId)}>
                            p.{page.pageNumber}
                          </button>
                          <span title={page.sourceName}>{page.sourceName}</span>
                          {page.status && (
                            <span className="review-status">
                              <i style={{ background: SHAPE_COLORS[page.status.color] }} />
                              {page.status.label}
                            </span>
                          )}
                        </div>
                        {crosses.length > 0 && (
                          <p className="review-crosses">{plural(crosses.length, 'cross')} on this page</p>
                        )}
                        {notes.map((note) => (
                          <div className="review-note" key={note.id}>
                            <p>{note.note?.trim() || 'Review note'}</p>
                            <span>
                              {note.author || 'No initials'}{note.by === 'agent' ? ' · AI' : ''}
                            </span>
                          </div>
                        ))}
                        {!page.findings.length && (
                          <p className="review-no-note">Flagged open without an explanatory note.</p>
                        )}
                        <div className="review-actions">
                          <button onClick={() => onJump(page.pageId)}>Go to page</button>
                          <button onClick={() => onResolve(page.pageId, 'reviewed')}>Reviewed</button>
                          <button onClick={() => onResolve(page.pageId, 'na')}>N/A</button>
                        </div>
                      </article>
                    )
                  })}
                </div>
              )}

              {snapshot.resolved.length > 0 && (
                <details className="review-resolved">
                  <summary>{plural(snapshot.resolved.length, 'resolved page')}</summary>
                  {snapshot.resolved.map((page) => (
                    <button key={page.pageId} onClick={() => onJump(page.pageId)}>
                      p.{page.pageNumber} · {page.sourceName} · {page.status?.label}
                    </button>
                  ))}
                </details>
              )}
            </>
          )}

          {tab === 'coverage' && (
            <>
              <section className="review-section">
                <h3>Source coverage</h3>
                {snapshot.sources.map((source) => (
                  <div className="review-source" key={source.sourceId}>
                    <div><b>{source.name}</b><span>{source.pageNumbers.length ? `p.${source.pageNumbers.join(', ')}` : 'No pages'}</span></div>
                    <span className={source.leftOut || source.extra ? 'is-warning' : ''}>
                      {source.includedPages} of {source.expectedPages}
                      {source.leftOut ? ` · ${source.leftOut} left out` : ''}
                      {source.extra ? ` · ${source.extra} extra` : ''}
                    </span>
                  </div>
                ))}
              </section>

              <section className="review-section">
                <h3>Page status</h3>
                <div className="review-status-list">
                  {snapshot.statusDefs.map((definition) => (
                    <div key={definition.id}>
                      <i style={{ background: SHAPE_COLORS[definition.color] }} />
                      <span>{definition.label}</span>
                      <b>{snapshot.statuses.byId[definition.id] ?? 0}</b>
                    </div>
                  ))}
                  <div><i /><span>Not set</span><b>{snapshot.statuses.unset}</b></div>
                </div>
              </section>

              <section className="review-section">
                <h3>Checks</h3>
                {snapshot.readiness.length === 0 ? (
                  <p className="review-good">No review checks are outstanding.</p>
                ) : (
                  [...attentionChecks, ...advisoryChecks].map((finding) => (
                    <div className={`review-check ${finding.level}`} key={finding.kind}>
                      <span>{finding.level === 'attention' ? 'Attention' : 'Advisory'}</span>
                      <p>{finding.message}</p>
                    </div>
                  ))
                )}
              </section>
            </>
          )}

          {tab === 'ai' && (
            <section className="review-section review-runs">
              <h3>{plural(snapshot.agentCreatedItems, 'AI-created item')} in this binder</h3>
              {agentRuns.length === 0 ? (
                <p className="review-good">No agent work recorded.</p>
              ) : (
                agentRuns.map((run) => (
                  <article className="review-run" key={run.run}>
                    <div className="review-run-head">
                      <div>
                        <b>AI run</b>
                        <span>{shortTime(run.lastAt)} · {plural(run.pageIds.length, 'page')}</span>
                      </div>
                      <button
                        disabled={run.remainingItems === 0}
                        onClick={() => onRevert(run.run)}
                        title={run.structural.length ? 'Page order, rotation and deletion cannot be undone here.' : ''}
                      >
                        {run.remainingItems ? `Undo ${run.remainingItems}` : 'Reverted'}
                      </button>
                    </div>
                    {run.entries.length ? run.entries.map((entry) => (
                      <p className="review-run-entry" key={entry.id}>
                        {entry.what}{entry.structural ? <em> · not undoable</em> : null}
                      </p>
                    )) : (
                      <p className="review-run-entry">No action log; surviving items can still be removed.</p>
                    )}
                  </article>
                ))
              )}
            </section>
          )}
        </div>
      </aside>
    </div>
  )
}
