import { useEffect, useMemo, useRef, useState } from 'react'
import {
  SHAPE_COLORS,
  marksByPage,
  statusOf,
  pageProvenance,
  sourceOf,
  type BinderPage,
  type Mark,
  type Session
} from '../session'
import { renderThumb } from '../pdf'
import { MARK_COLOR } from './MarkLayer'

function Thumb({ session, page }: { session: Session; page: BinderPage }): React.JSX.Element {
  const [url, setUrl] = useState<string | null>(null)
  const src = sourceOf(session, page)

  useEffect(() => {
    let live = true
    if (!src) return
    renderThumb(src.id, src.path, page.index, page.rotate, 132, src.kind)
      .then((u) => live && setUrl(u))
      .catch(() => live && setUrl(null))
    return () => {
      live = false
    }
  }, [src?.id, src?.path, src?.kind, page.index, page.rotate])

  return url ? (
    <img className="thumb-img" src={url} alt="" draggable={false} />
  ) : (
    <div className="thumb-img thumb-placeholder" />
  )
}

/**
 * Where the marks sit on this page, as colored dots.
 *
 * Deliberately dots and not the glyphs themselves: at rail scale a ✓ is
 * illegible and a lettered stamp is a smudge, and sizing either correctly would
 * need the page's point dimensions, which the rail doesn't have. The question
 * the rail answers is "which pages have I reviewed, and roughly where" — a dot
 * answers it honestly; a tiny glyph would only imply a precision it doesn't have.
 */
function MarkDots({ marks }: { marks: Mark[] }): React.JSX.Element {
  return (
    <div className="thumb-marks" aria-hidden="true">
      {marks.map((m) => (
        <span
          key={m.id}
          className="thumb-mark"
          style={{
            left: `${m.nx * 100}%`,
            top: `${m.ny * 100}%`,
            background: MARK_COLOR[m.kind]
          }}
        />
      ))}
    </div>
  )
}

interface Props {
  session: Session
  selected: Set<string>
  currentId: string | null
  onSelect: (id: string, mode: 'single' | 'toggle' | 'range') => void
  onReorder: (ids: string[], beforeIndex: number) => void
}

export function ThumbnailRail({
  session,
  selected,
  currentId,
  onSelect,
  onReorder
}: Props): React.JSX.Element {
  const [dropAt, setDropAt] = useState<number | null>(null)
  const railRef = useRef<HTMLDivElement>(null)
  const marks = useMemo(() => marksByPage(session), [session.marks])

  // Keep the current page visible. On a 62-page binder, navigating with the
  // keyboard or the page controls otherwise scrolls the selection off-screen.
  useEffect(() => {
    if (!currentId || !railRef.current) return
    const el = railRef.current.querySelector(`[data-page-id="${currentId}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [currentId])

  const dragIds = (id: string): string[] =>
    selected.has(id) ? session.pages.filter((p) => selected.has(p.id)).map((p) => p.id) : [id]

  return (
    <div
      className="rail"
      ref={railRef}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDropAt(null)
      }}
    >
      {session.pages.map((page, i) => {
        const pageMarks = marks.get(page.id) ?? []
        // The rail is where review coverage is read at a glance, so a status
        // shows as the frame colour rather than another badge to hunt for.
        const status = statusOf(session, page.id)
        return (
        <div
          key={page.id}
          data-page-id={page.id}
          className={[
            'thumb',
            selected.has(page.id) ? 'is-selected' : '',
            currentId === page.id ? 'is-current' : '',
            dropAt === i ? 'drop-before' : '',
            dropAt === session.pages.length && i === session.pages.length - 1 ? 'drop-after' : ''
          ]
            .filter(Boolean)
            .join(' ')}
          title={`${pageProvenance(session, page)}${page.rotate ? ` · rotated ${page.rotate}°` : ''}${
            pageMarks.length ? ` · ${pageMarks.length} mark${pageMarks.length === 1 ? '' : 's'}` : ''
          }${status ? ` · ${status.label}` : ''}`}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = 'move'
            e.dataTransfer.setData('application/x-wpt-pages', JSON.stringify(dragIds(page.id)))
          }}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes('application/x-wpt-pages')) return
            e.preventDefault()
            const box = e.currentTarget.getBoundingClientRect()
            setDropAt(e.clientY < box.top + box.height / 2 ? i : i + 1)
          }}
          onDrop={(e) => {
            const raw = e.dataTransfer.getData('application/x-wpt-pages')
            setDropAt(null)
            if (!raw) return
            e.preventDefault()
            onReorder(JSON.parse(raw) as string[], dropAt ?? i)
          }}
          onMouseDown={(e) =>
            onSelect(page.id, e.shiftKey ? 'range' : e.metaKey || e.ctrlKey ? 'toggle' : 'single')
          }
        >
          <div
            className="thumb-frame"
            style={
              status
                ? { borderColor: SHAPE_COLORS[status.color], borderWidth: 2, padding: 0 }
                : undefined
            }
          >
            <Thumb session={session} page={page} />
            {pageMarks.length > 0 && <MarkDots marks={pageMarks} />}
          </div>
          <div className="thumb-meta">
            <span className="thumb-num">{i + 1}</span>
            {status && (
              <span
                className="thumb-status"
                style={{ background: SHAPE_COLORS[status.color] }}
                title={status.label}
              />
            )}
            {pageMarks.length > 0 && (
              <span className="thumb-marks-count">✓{pageMarks.length}</span>
            )}
            {page.rotate !== 0 && <span className="thumb-badge">{page.rotate}°</span>}
          </div>
        </div>
        )
      })}
    </div>
  )
}
