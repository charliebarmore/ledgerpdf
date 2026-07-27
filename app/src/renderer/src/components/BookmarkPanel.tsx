import { buildBookmarks, type BookmarkNode, type Session } from '../session'

/**
 * Shows the bookmark tree exactly as it will be written at export: file-level
 * bookmark per source with each source's own imported outline nested beneath,
 * numbered by FINAL binder position. This is the visible proof that bookmarks
 * follow pages when you reorder.
 */
export function BookmarkPanel({
  session,
  onJump
}: {
  session: Session
  onJump: (pageId: string) => void
}): React.JSX.Element {
  const tree = buildBookmarks(session)
  const numberOf = new Map(session.pages.map((p, i) => [p.id, i + 1]))

  const rows = (nodes: BookmarkNode[], depth = 0): React.JSX.Element[] =>
    nodes.flatMap((n) => [
      <button
        key={`${n.page}:${n.title}:${depth}`}
        className="bm-row"
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => onJump(n.page)}
        title={`Go to binder page ${numberOf.get(n.page) ?? '?'}`}
      >
        <span className="bm-title">{n.title}</span>
        <span className="bm-page">{numberOf.get(n.page) ?? '—'}</span>
      </button>,
      ...rows(n.children, depth + 1)
    ])

  return (
    <div className="panel">
      <div className="panel-head">Bookmarks <span className="muted">(as exported)</span></div>
      {tree.length === 0 ? (
        <div className="panel-empty">No pages yet.</div>
      ) : (
        <div className="bm-list">{rows(tree)}</div>
      )}
    </div>
  )
}
