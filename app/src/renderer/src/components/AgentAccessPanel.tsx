import { useEffect, useState } from 'react'

/**
 * Everything about agent access, in one place.
 *
 * It lives behind the status-bar indicator rather than in the export Options
 * menu, because it is one concept and the two halves are not separable: live
 * access to the binder on screen, and what a standalone agent may do in approved
 * folders. Splitting them would put the
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
  const [connect, setConnect] = useState<{
    command: string
    needsElectronRunAsNode: boolean
    unstableReason?: string
  } | null>(null)
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
              {liveOn ? 'Live access to this binder is on' : 'Live access to this binder is off'}
            </span>
            <button className={liveOn ? 'ap-toggle is-on' : 'ap-toggle'} onClick={onToggleLive}>
              {liveOn ? 'Stop' : 'Let an agent in'}
            </button>
          </div>
          <p className="ap-why">
            This switch controls only the binder currently on screen. With it on, an agent you have
            connected can read and change this binder while you watch. Everything it does is
            attributed to the AI and journalled; its marks, tapes, shapes and bookmarks can be
            undone by run, while page changes like reorders and deletions stay in the history but
            are not automatically undone. Off by default, and off again every time the app starts.
          </p>
        </section>

        <section className="ap-section">
          <p className="ap-label">Folders available to standalone agents</p>
          {roots.length === 0 ? (
            <p className="ap-empty">
              None. An agent can work on the binder currently open when live access is on, but it
              cannot independently open or save files on disk.
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
            This approval remains in effect when live binder access is off and when LedgerPDF is
            closed. A standalone agent can read every document in an approved folder and create or
            update LedgerPDF binders and exports there. Page text can include a taxpayer's SSN.
            Where that text then goes depends on the agent, not on LedgerPDF: a locally-run model
            keeps it on this machine, a hosted one does not. Whether to send client return
            information to a third party is yours to decide — in the US, IRC §7216 and your firm's
            WISP are where that starts. Changes here apply to the agent's next request.
          </p>
        </section>

        {connect && connect.unstableReason && (
          <section className="ap-section">
            <p className="ap-label">Connect an agent</p>
            {/* The command bakes this app's absolute path into the agent's
                global config. From a DMG or a translocated run that path dies
                with the session, so offering it here would hand the user a
                registration that permanently breaks — explain instead. */}
            <p className="ap-why">{connect.unstableReason}</p>
          </section>
        )}
        {connect && !connect.unstableReason && (
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
