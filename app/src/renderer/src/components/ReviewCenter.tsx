import { useEffect, useRef } from 'react'
import { SHAPE_COLORS } from '../session'
import type { ReviewSnapshot } from '../review'

export type ReviewTab = 'attention' | 'coverage' | 'ai' | 'handoff'

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
  onResolveHandoff,
  onClose
}: {
  snapshot: ReviewSnapshot
  tab: ReviewTab
  onTab: (tab: ReviewTab) => void
  onJump: (pageId: string) => void
  onResolve: (pageId: string, status: 'reviewed' | 'na') => void
  onRevert: (run: string) => void
  onResolveHandoff: (id: string) => void
  onClose: () => void
}): React.JSX.Element {
  const attentionChecks = snapshot.readiness.filter((finding) => finding.level === 'attention')
  const advisoryChecks = snapshot.readiness.filter((finding) => finding.level === 'advisory')
  const agentRuns = snapshot.runs.filter((run) => run.run !== 'you')
  const drawer = useRef<HTMLElement>(null)

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    drawer.current?.querySelector<HTMLButtonElement>('.review-close')?.focus()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [])

  return (
    <div className="review-backdrop" onMouseDown={onClose}>
      <aside
        ref={drawer}
        className="review-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Review center"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return
          const controls = [...event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), summary, [tabindex="0"]'
          )]
          const first = controls[0]
          const last = controls[controls.length - 1]
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last?.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first?.focus()
          }
        }}
      >
        <header className="review-head">
          <div>
            <h2>Review center</h2>
            <p>
              {snapshot.active.length
                ? `${plural(snapshot.active.length, 'page')} ${snapshot.active.length === 1 ? 'needs' : 'need'} attention`
                : snapshot.handoffPending.length ? 'Compilation needs review' : 'No flagged findings'}
              {' · '}{plural(snapshot.statuses.unset, 'page')} without review status
            </p>
          </div>
          <button className="review-close" onClick={onClose} aria-label="Close review center">
            ×
          </button>
        </header>

        <div className="review-overview" aria-label="Binder review overview">
          <div><b>{snapshot.pageCount}</b><span>pages</span></div>
          <div className={snapshot.active.length || snapshot.handoffPending.length ? 'has-attention' : ''}>
            <b>{snapshot.active.length + snapshot.handoffPending.length}</b><span>open items</span>
          </div>
          <div><b>{snapshot.resolved.length + Object.keys(snapshot.handoff?.resolutions ?? {}).length}</b><span>resolved</span></div>
          <div><b>{snapshot.statuses.unset}</b><span>without status</span></div>
        </div>

        <nav className="review-tabs" aria-label="Review center sections">
          <button className={tab === 'attention' ? 'is-current' : ''} onClick={() => onTab('attention')}>
            Needs attention{snapshot.active.length + snapshot.handoffPending.length ? ` ${snapshot.active.length + snapshot.handoffPending.length}` : ''}
          </button>
          <button className={tab === 'coverage' ? 'is-current' : ''} onClick={() => onTab('coverage')}>
            Coverage
          </button>
          <button className={tab === 'ai' ? 'is-current' : ''} onClick={() => onTab('ai')}>
            AI work{snapshot.agentCreatedItems ? ` ${snapshot.agentCreatedItems}` : ''}
          </button>
          {snapshot.handoff && (
            <button className={tab === 'handoff' ? 'is-current' : ''} onClick={() => onTab('handoff')}>Compilation</button>
          )}
        </nav>

        <div className="review-body">
          {tab === 'attention' && (
            <>
              {attentionChecks.filter((finding) => finding.kind !== 'open-items' && finding.kind !== 'compilation-handoff').map((finding) => (
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

              {snapshot.handoffPending.map((item) => (
                <article className="review-item handoff-item" key={item.id}>
                  <b>{item.label}</b>
                  <p>{item.detail}</p>
                  <div className="review-actions">
                    {[...new Set(item.pageIds)].filter((id) => snapshot.pageNumbers[id]).map((id) => (
                      <button key={id} onClick={() => onJump(id)}>Evidence p.{snapshot.pageNumbers[id]}</button>
                    ))}
                    <button onClick={() => onResolveHandoff(item.id)}>Resolve item</button>
                  </div>
                </article>
              ))}

              {snapshot.active.length === 0 && snapshot.handoffPending.length === 0 ? (
                <div className="review-empty">
                  <b>No flagged findings.</b>
                  <span>
                    {snapshot.statuses.unset
                      ? `${plural(snapshot.statuses.unset, 'page')} still ${snapshot.statuses.unset === 1 ? 'has' : 'have'} no review status.`
                      : 'Page statuses and agent work are recorded separately.'}
                    {' '}Open Coverage to see page statuses and remaining checks.
                  </span>
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
                              {page.status.label}{page.statusRecord?.agent ? ' · AI' : ''}
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
                          <p className="review-no-note">
                            {page.statusRecord?.agent &&
                            (page.status?.id === 'reviewed' || page.status?.id === 'na')
                              ? 'AI set this status. A human reviewer must confirm it.'
                              : 'Flagged open without an explanatory note.'}
                          </p>
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

          {tab === 'handoff' && snapshot.handoff && (
            <section className="review-section">
              <h3>Compilation record</h3>
              <p>Agent preparation snapshot · {shortTime(snapshot.handoff.recordedAt)}. Outcomes are agent-reported; inspect the evidence. Human review is separate.</p>
              <h3>{snapshot.handoff.inputs.length} input dispositions</h3>
              {snapshot.handoff.inputs.map((input) => (
                <div className="review-item handoff-item" key={input.path}>
                  <b>{input.path.split(/[\\/]/).pop()} · {input.disposition}</b>
                  <p>{input.reason}</p>
                  <details><summary>Source identity</summary><code className="handoff-hash">SHA-256 {input.sha256}</code></details>
                </div>
              ))}
              <h3>{snapshot.handoff.checks.length} recorded checks</h3>
              {snapshot.handoff.checks.map((check, i) => (
                <div className="review-item handoff-item" key={i}>
                  <b>{check.label} · {check.outcome}</b>
                  <p>{check.detail}</p>
                  {check.evidence.map((e, j) => (
                    <div key={j}>
                      {snapshot.pageNumbers[e.pageId]
                        ? <button onClick={() => onJump(e.pageId)}>p.{snapshot.pageNumbers[e.pageId]} · {e.sourceName} (source p.{e.sourcePage})</button>
                        : <b>Evidence page removed · {e.sourceName}</b>}
                      <p>{e.quote}{e.sheet ? ` · ${e.sheet}` : ''}{e.cells ? `!${e.cells}` : ''}</p>
                    </div>
                  ))}
                </div>
              ))}
              <p>{Object.keys(snapshot.handoff.resolutions).length} compilation item(s) resolved by a human. The original record is retained.</p>
            </section>
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
                      <b>{(snapshot.statuses.byId[definition.id] ?? 0) - (snapshot.agentStatuses[definition.id] ?? 0)}</b>
                    </div>
                  ))}
                  {snapshot.statusDefs.filter((definition) => snapshot.agentStatuses[definition.id]).map((definition) => (
                    <div key={`agent-${definition.id}`}>
                      <i style={{ background: SHAPE_COLORS[definition.color] }} />
                      <span>{definition.label} · AI proposed</span>
                      <b>{snapshot.agentStatuses[definition.id]}</b>
                    </div>
                  ))}
                  <div><i /><span>Without review status</span><b>{snapshot.statuses.unset}</b></div>
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
                        title={
                          run.remainingItems
                            ? run.structural.length
                              ? 'Structural and page-status changes cannot be undone here.'
                              : ''
                            : run.structural.length
                              ? 'This run has only changes that cannot be undone here.'
                              : 'No removable items from this run remain.'
                        }
                      >
                        {run.remainingItems ? `Undo ${run.remainingItems}` : 'Nothing to undo'}
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
