import { buildBookmarks, type BookmarkNode, type Session } from '../session'

/**
 * The bookmark tree exactly as it will be written at export: file-level
 * bookmark per source (suppressed when a single source already has its own
 * outline) with imported outlines nested beneath, numbered by FINAL binder
 * position. This is the visible proof that bookmarks follow pages on reorder.
 */
export function BookmarkPanel({
  session,
  pageCounts,
  onTogglePageCounts,
  onJump
}: {
  session: Session
  pageCounts: boolean
  onTogglePageCounts: (next: boolean) => void
  onJump: (pageId: string) => void
}): React.JSX.Element {
  const tree = buildBookmarks(session, { pageCounts })
  const numberOf = new Map(session.pages.map((p, i) => [p.id, i + 1]))

  const rows = (nodes: BookmarkNode[], depth = 0): React.JSX.Element[] =>
    nodes.flatMap((n, i) => [
      <button
        key={`${n.page}:${depth}:${i}`}
        className="bm-row"
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => onJump(n.page)}
        // Full title in the tooltip — real workpaper bookmark names are long
        // and the panel will always truncate some of them.
        title={`${n.title}\nBinder page ${numberOf.get(n.page) ?? '?'}`}
      >
        <span className="bm-title">{n.title}</span>
        <span className="bm-page">{numberOf.get(n.page) ?? '—'}</span>
      </button>,
      ...rows(n.children, depth + 1)
    ])

  return (
    <div className="panel">
      <div className="panel-head">
        <span>
          Bookmarks <span className="muted">(as exported)</span>
        </span>
        <label className="toggle" title="Append the page span to each bookmark, e.g. (2 pages)">
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
