import type { ReviewSnapshot } from '../review'

/**
 * The deliberate boundary between a working binder and the permanent copy.
 *
 * This does not claim the accounting is correct. It names the mechanical and
 * review evidence LedgerPDF can actually prove, then leaves the professional
 * judgment with the person sending the file.
 */
export function SendOutPreflight({
  snapshot,
  confirmAnyway,
  onArmAnyway,
  onReview,
  onContinue,
  onClose
}: {
  snapshot: ReviewSnapshot
  confirmAnyway: boolean
  onArmAnyway: () => void
  onReview: () => void
  onContinue: () => void
  onClose: () => void
}): React.JSX.Element {
  const attention = snapshot.readiness.filter((finding) => finding.level === 'attention')
  const advisories = snapshot.readiness.filter((finding) => finding.level === 'advisory')
  const clear = attention.length === 0 && advisories.length === 0

  return (
    <div className="preflight-backdrop" onMouseDown={onClose}>
      <section
        className="preflight"
        role="dialog"
        aria-modal="true"
        aria-label="Send-out readiness"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="preflight-head">
          <div className={`preflight-signal${attention.length ? ' needs-attention' : ''}`}>
            {attention.length ? '!' : '✓'}
          </div>
          <div>
            <h2>{attention.length ? 'Review before sending' : 'Send-out readiness'}</h2>
            <p>
              {clear
                ? 'LedgerPDF found no open review or binder-structure checks.'
                : attention.length
                  ? 'This binder still has items that normally deserve a reviewer’s attention.'
                  : 'No open exceptions. Read the advisories before creating the copy.'}
            </p>
          </div>
        </header>

        <div className="preflight-body">
          <div className="preflight-fact">
            The copy will have marks printed on permanently and no editable LedgerPDF session.
            Your working binder is not changed.
          </div>

          {attention.length > 0 && (
            <section className="preflight-group">
              <h3>Needs attention</h3>
              {attention.map((finding) => (
                <div className="preflight-row attention" key={finding.kind}>
                  <span>!</span><p>{finding.message}</p>
                </div>
              ))}
            </section>
          )}

          {advisories.length > 0 && (
            <section className="preflight-group">
              <h3>Advisories</h3>
              {advisories.map((finding) => (
                <div className="preflight-row" key={finding.kind}>
                  <span>i</span><p>{finding.message}</p>
                </div>
              ))}
            </section>
          )}

          {clear && (
            <div className="preflight-clear">
              <b>No open items detected.</b>
              <span>This is a mechanical readiness check, not an audit conclusion.</span>
            </div>
          )}
        </div>

        <footer className="preflight-actions">
          <button onClick={onClose}>Cancel</button>
          {attention.length ? (
            <>
              <button onClick={onArmAnyway} className={confirmAnyway ? 'preflight-anyway armed' : 'preflight-anyway'}>
                {confirmAnyway ? 'Send anyway — choose file' : 'Send anyway…'}
              </button>
              <button className="primary" onClick={onReview}>Review items</button>
            </>
          ) : (
            <button className="primary" onClick={onContinue}>Continue to save</button>
          )}
        </footer>
        {confirmAnyway && (
          <p className="preflight-confirm">
            Click “Send anyway — choose file” again to accept the listed items.
          </p>
        )}
      </section>
    </div>
  )
}
