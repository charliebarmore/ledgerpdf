import { useEffect, useState } from 'react'
import {
  USER_BOOKMARK_PREFIX,
  buildBookmarks,
  stripPageCount,
  type BookmarkNode,
  type Session
} from '../session'

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
function findNode(nodes: BookmarkNode[], key: string): BookmarkNode | null {
  for (const n of nodes) {
    if (n.key === key) return n
    const hit = findNode(n.children, key)
    if (hit) return hit
  }
  return null
}

export function BookmarkPanel({
  session,
  pageCounts,
  onTogglePageCounts,
  onRename,
  onJump,
  onAdd,
  onRemove,
  onIndent,
  onMoveSection,
  currentPageId,
  onAssign,
  onClearAssign,
  canAdd,
  autoEditKey,
  onAutoEditDone
}: {
  session: Session
  pageCounts: boolean
  onTogglePageCounts: (next: boolean) => void
  onRename: (key: string, title: string | null) => void
  onJump: (pageId: string) => void
  onAdd: () => void
  onRemove: (key: string) => void
  onIndent: (key: string, delta: number) => void
  /** Drag a bookmark: its whole section of pages moves with it. */
  onMoveSection: (key: string, beforeKey: string | null) => void
  /** Where "assign here" would send a bookmark: the page you are on. */
  currentPageId: string | null
  onAssign: (key: string, pageId: string) => void
  onClearAssign: (key: string) => void
  canAdd: boolean
  autoEditKey: string | null
  onAutoEditDone: () => void
}): React.JSX.Element {
  const [editing, setEditing] = useState<{ key: string; value: string } | null>(null)
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [dropKey, setDropKey] = useState<string | null>(null)
  const tree = buildBookmarks(session, { pageCounts })
  const retargeted = new Set(Object.keys(session.bookmarkPages ?? {}))
  const numberOf = new Map(session.pages.map((p, i) => [p.id, i + 1]))

  // A just-added bookmark opens straight into rename — add, type, Enter.
  useEffect(() => {
    if (!autoEditKey) return
    const node = findNode(tree, autoEditKey)
    setEditing({ key: autoEditKey, value: node ? stripPageCount(node.title) : '' })
    onAutoEditDone()
  }, [autoEditKey])

  const commit = (): void => {
    if (editing) onRename(editing.key, editing.value)
    setEditing(null)
  }

  const rows = (nodes: BookmarkNode[], depth = 0): React.JSX.Element[] =>
    nodes.flatMap((n, i) => {
      const pad = 8 + depth * 14
      const isUser = n.key.startsWith(USER_BOOKMARK_PREFIX)
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
            className={
              `bm-row${renamed ? ' is-renamed' : ''}${isUser ? ' is-user' : ''}` +
              `${dragKey === n.key ? ' is-dragging' : ''}${dropKey === n.key ? ' drop-before' : ''}`
            }
            style={{ paddingLeft: pad }}
            draggable
            onDragStart={(e) => {
              setDragKey(n.key)
              e.dataTransfer.effectAllowed = 'move'
              // Some data is required or Firefox/Chromium refuse the drag.
              e.dataTransfer.setData('text/plain', n.key)
            }}
            onDragOver={(e) => {
              if (!dragKey || dragKey === n.key) return
              e.preventDefault()
              setDropKey(n.key)
            }}
            onDragLeave={() => setDropKey((k) => (k === n.key ? null : k))}
            onDrop={(e) => {
              e.preventDefault()
              if (dragKey && dragKey !== n.key) onMoveSection(dragKey, n.key)
              setDragKey(null)
              setDropKey(null)
            }}
            onDragEnd={() => {
              setDragKey(null)
              setDropKey(null)
            }}
            onClick={() => onJump(n.page)}
            onDoubleClick={() => setEditing({ key: n.key, value: stripPageCount(n.title) })}
            // Full title in the tooltip — real workpaper names are long and the
            // panel will always truncate some of them.
            title={`${n.title}\nBinder page ${numberOf.get(n.page) ?? '?'}\nDouble-click to rename${isUser ? ' · added by you' : ''}`}
          >
            <span className="bm-title">{n.title}</span>
            {currentPageId && n.page !== currentPageId && (
              // Labelled with the destination, not an icon: "→ 7" says exactly
              // where the bookmark lands, which an arrow glyph never could.
              <span
                className="bm-assign"
                title={`Move this bookmark to binder page ${numberOf.get(currentPageId)}`}
                onClick={(e) => {
                  e.stopPropagation()
                  onAssign(n.key, currentPageId)
                }}
              >
                →{numberOf.get(currentPageId)}
              </span>
            )}
            {!isUser && retargeted.has(n.key) && (
              <span
                className="bm-revert"
                title="Send this bookmark back to the page it was imported on"
                onClick={(e) => {
                  e.stopPropagation()
                  onClearAssign(n.key)
                }}
              >
                Reset
              </span>
            )}
            {isUser ? (
              // Words, not arrows. ⇤ ⇥ × told a preparer nothing about what
              // they do, and this panel is where the binder's structure is
              // edited — the one place guessing is expensive.
              <span className="bm-tools">
                <span
                  title="Move this bookmark out one level"
                  onClick={(e) => {
                    e.stopPropagation()
                    onIndent(n.key, -1)
                  }}
                >
                  Out
                </span>
                <span
                  title="Nest this bookmark under the one above it"
                  onClick={(e) => {
                    e.stopPropagation()
                    onIndent(n.key, 1)
                  }}
                >
                  In
                </span>
                <span
                  title="Remove this bookmark (the pages stay in the binder)"
                  onClick={(e) => {
                    e.stopPropagation()
                    onRemove(n.key)
                  }}
                >
                  Delete
                </span>
              </span>
            ) : (
              renamed && (
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
              )
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
        <span className="panel-title" title="The outline exactly as it will be written on export">
          Bookmarks
        </span>
        <button className="bm-add" onClick={onAdd} disabled={!canAdd} title="Add a bookmark on the current page  ⌘B">
          + Add
        </button>
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
        <div className="panel-empty">No bookmarks yet.</div>
      ) : (
        <div className="bm-list">
          {rows(tree)}
          {/* A landing strip at the end: without it a section can be dropped
              before any bookmark but never moved to the back of the binder. */}
          <div
            className={`bm-drop-end${dropKey === '__end__' ? ' is-over' : ''}`}
            onDragOver={(e) => {
              if (!dragKey) return
              e.preventDefault()
              setDropKey('__end__')
            }}
            onDragLeave={() => setDropKey((k) => (k === '__end__' ? null : k))}
            onDrop={(e) => {
              e.preventDefault()
              if (dragKey) onMoveSection(dragKey, null)
              setDragKey(null)
              setDropKey(null)
            }}
          >
            {dragKey ? 'Drop here to move to the end' : ''}
          </div>
        </div>
      )}
    </div>
  )
}
