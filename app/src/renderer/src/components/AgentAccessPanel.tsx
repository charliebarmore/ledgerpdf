import { useEffect, useState } from 'react'

/**
 * Everything about agent access, in one place.
 *
 * It lives behind the status-bar indicator rather than in the export Options
 * menu, because it is one concept and the two halves are not separable: whether
 * an agent may connect, and what it may then read. Splitting them would put the
 * consequential half — the folders — somewhere nobody looks, and that half is
 * the one with IRC §7216 attached.
 *
 * Approving a folder is a DIALOG owned by the main process, and this component
 * cannot pass it a path. That is deliberate: a renderer that could name a folder
 * could widen what an agent reads without the person choosing it.
 */
export function AgentAccessPanel({
  liveOn,
  onToggleLive,
  onClose
}: {
  liveOn: boolean
  onToggleLive: () => void
  onClose: () => void
}): React.JSX.Element {
  const [roots, setRoots] = useState<string[]>([])
  const [connect, setConnect] = useState<{ command: string; needsElectronRunAsNode: boolean } | null>(
    null
  )
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.wpt.agentRoots().then(setRoots)
    void window.wpt.agentConnectCommand().then(setConnect)
  }, [])

  const add = async (): Promise<void> => {
    setBusy(true)
    try {
      setRoots(await window.wpt.addAgentRoot())
    } finally {
      setBusy(false)
    }
  }

  const remove = async (root: string): Promise<void> => {
    setBusy(true)
    try {
      setRoots(await window.wpt.removeAgentRoot(root))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="initials-backdrop" onMouseDown={onClose}>
      <div
        className="agent-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Agent access"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <p className="ap-title">Agent access</p>

        <section className="ap-section">
          <div className="ap-row">
            <span className="ap-label">
              {liveOn ? 'Working in this binder now' : 'Not connected to this binder'}
            </span>
            <button className={liveOn ? 'ap-toggle is-on' : 'ap-toggle'} onClick={onToggleLive}>
              {liveOn ? 'Stop' : 'Let an agent in'}
            </button>
          </div>
          <p className="ap-why">
            With this on, an agent you have connected can read and change the binder you have open,
            and you watch it happen. Everything it does is attributed to the AI and can be undone.
            Off by default, and off again every time the app starts.
          </p>
        </section>

        <section className="ap-section">
          <p className="ap-label">Folders an agent may read</p>
          {roots.length === 0 ? (
            <p className="ap-empty">
              None. An agent can work on the binder you have open, but it cannot open a document
              from disk until you approve the folder it lives in.
            </p>
          ) : (
            <ul className="ap-roots">
              {roots.map((root) => (
                <li key={root}>
                  <span className="ap-path" title={root}>
                    {root}
                  </span>
                  <button
                    className="ap-remove"
                    disabled={busy}
                    onClick={() => void remove(root)}
                    title={`Withdraw access to ${root}`}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button className="ap-add" disabled={busy} onClick={() => void add()}>
            Approve a folder…
          </button>
          {/* THREE FACTS AND A POINTER, deliberately not an essay.
              What a reader needs in order to decide is: what becomes readable,
              that it includes SSNs, and that where it goes depends on the agent
              rather than on this app. Those are facts about the software, which
              is the only thing this app is entitled to assert.
              An earlier draft said "that is an IRC §7216 decision" — a legal
              characterisation stated as fact, by a tool that is nobody's counsel.
              It is now a signpost, and the analysis lives in DATA-FLOW.md, which
              frames each regime as a question rather than answering it.
              Kept short because this is read MID-WORK: long compliance text gets
              skipped, and text that trains people to dismiss the box is worse
              than no text at all. The SSN sentence stays verbatim — it is the one
              that actually informs. */}
          <p className="ap-why">
            An agent you connect can read every document in an approved folder, including the text
            on the page — which on a 1040 includes the taxpayer's SSN. Where that text then goes
            depends on the agent, not on LedgerPDF: a locally-run model keeps it on this machine, a
            hosted one does not. Whether to send client return information to a third party is
            yours to decide — in the US, IRC §7216 and your firm's WISP are where that starts.
            Changes here apply to the agent's next request.
          </p>
        </section>

        {connect && (
          <section className="ap-section">
            <p className="ap-label">Connect an agent</p>
            {/* "then restart it" was ambiguous — the thing to restart is the
                agent, not LedgerPDF, and a reader who restarts the wrong one
                concludes the command did not work. */}
            <p className="ap-why">
              Run this once in a terminal to register LedgerPDF with{' '}
              <strong>Claude Code</strong>, then quit and reopen Claude Code so it picks the
              server up. LedgerPDF does not need restarting. Approving folders above does not
              require this — it is how the agent finds LedgerPDF in the first place.
            </p>
            <code className="ap-command">{connect.command}</code>
            <div className="ap-row">
              <button
                className="ap-add"
                onClick={() => {
                  void navigator.clipboard.writeText(connect.command)
                  setCopied(true)
                  window.setTimeout(() => setCopied(false), 1600)
                }}
              >
                {copied ? 'Copied' : 'Copy command'}
              </button>
            </div>
          </section>
        )}

        <div className="ap-foot">
          <button className="ap-done" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
