import { useState } from 'react'
import { buildBookmarks, stripPageCount, type BookmarkNode, type Session } from '../session'

/**
 * The bookmark tree exactly as it will be written at export: file-level
 * bookmark per source (suppressed when a single source already has its own
 * outline) with imported outlines nested beneath, numbered by FINAL binder
 * position. This is the visible proof that bookmarks follow pages on reorder.
 *
 * Double-click a title to rename it; renames are keyed to the bookmark's origin
 * so they survive reordering, and clearing the field reverts to the imported
 * title.
 */
export function BookmarkPanel({
  session,
  pageCounts,
  onTogglePageCounts,
  onRename,
  onJump
}: {
  session: Session
  pageCounts: boolean
  onTogglePageCounts: (next: boolean) => void
  onRename: (key: string, title: string | null) => void
  onJump: (pageId: string) => void
}): React.JSX.Element {
  const [editing, setEditing] = useState<{ key: string; value: string } | null>(null)
  const tree = buildBookmarks(session, { pageCounts })
  const numberOf = new Map(session.pages.map((p, i) => [p.id, i + 1]))

  const commit = (): void => {
    if (editing) onRename(editing.key, editing.value)
    setEditing(null)
  }

  const rows = (nodes: BookmarkNode[], depth = 0): React.JSX.Element[] =>
    nodes.flatMap((n, i) => {
      const pad = 8 + depth * 14
      const renamed = session.titles?.[n.key] !== undefined
      const isEditing = editing?.key === n.key

      return [
        isEditing ? (
          <div key={`${n.key}:${i}`} className="bm-row is-editing" style={{ paddingLeft: pad }}>
            <input
              className="bm-input"
              autoFocus
              value={editing.value}
              onChange={(e) => setEditing({ key: n.key, value: e.target.value })}
              onBlur={commit}
              onKeyDown={(e) => {
                e.stopPropagation() // don't let ⌫/arrows hit the page shortcuts
                if (e.key === 'Enter') commit()
                if (e.key === 'Escape') setEditing(null)
              }}
            />
          </div>
        ) : (
          <button
            key={`${n.key}:${i}`}
            className={`bm-row${renamed ? ' is-renamed' : ''}`}
            style={{ paddingLeft: pad }}
            onClick={() => onJump(n.page)}
            onDoubleClick={() => setEditing({ key: n.key, value: stripPageCount(n.title) })}
            // Full title in the tooltip — real workpaper names are long and the
            // panel will always truncate some of them.
            title={`${n.title}\nBinder page ${numberOf.get(n.page) ?? '?'}\nDouble-click to rename`}
          >
            <span className="bm-title">{n.title}</span>
            {renamed && (
              <span
                className="bm-revert"
                title="Revert to the imported title"
                onClick={(e) => {
                  e.stopPropagation()
                  onRename(n.key, null)
                }}
              >
                ↺
              </span>
            )}
            <span className="bm-page">{numberOf.get(n.page) ?? '—'}</span>
          </button>
        ),
        ...rows(n.children, depth + 1)
      ]
    })

  return (
    <div className="panel">
      <div className="panel-head">
        <span>
          Bookmarks <span className="muted">(as exported)</span>
        </span>
        <label className="toggle" title="Append the page span to each leaf bookmark, e.g. (2 pages)">
          <input
            type="checkbox"
            checked={pageCounts}
            onChange={(e) => onTogglePageCounts(e.target.checked)}
          />
          counts
        </label>
      </div>
      {tree.length === 0 ? (
        <div className="panel-empty">No pages yet.</div>
      ) : (
        <div className="bm-list">{rows(tree)}</div>
      )}
    </div>
  )
}
