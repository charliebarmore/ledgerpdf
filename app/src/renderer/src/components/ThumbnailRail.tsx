import { useEffect, useState } from 'react'
import { pageProvenance, sourceOf, type BinderPage, type Session } from '../session'
import { renderThumb } from '../pdf'

function Thumb({ session, page }: { session: Session; page: BinderPage }): React.JSX.Element {
  const [url, setUrl] = useState<string | null>(null)
  const src = sourceOf(session, page)

  useEffect(() => {
    let live = true
    if (!src) return
    renderThumb(src.id, src.path, page.index, page.rotate)
      .then((u) => live && setUrl(u))
      .catch(() => live && setUrl(null))
    return () => {
      live = false
    }
  }, [src?.id, src?.path, page.index, page.rotate])

  return url ? (
    <img className="thumb-img" src={url} alt="" draggable={false} />
  ) : (
    <div className="thumb-img thumb-placeholder" />
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

  const dragIds = (id: string): string[] =>
    selected.has(id) ? session.pages.filter((p) => selected.has(p.id)).map((p) => p.id) : [id]

  return (
    <div
      className="rail"
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDropAt(null)
      }}
    >
      {session.pages.map((page, i) => (
        <div
          key={page.id}
          className={[
            'thumb',
            selected.has(page.id) ? 'is-selected' : '',
            currentId === page.id ? 'is-current' : '',
            dropAt === i ? 'drop-before' : '',
            dropAt === session.pages.length && i === session.pages.length - 1 ? 'drop-after' : ''
          ]
            .filter(Boolean)
            .join(' ')}
          title={`${pageProvenance(session, page)}${page.rotate ? ` · rotated ${page.rotate}°` : ''}`}
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
          <div className="thumb-frame">
            <Thumb session={session} page={page} />
          </div>
          <div className="thumb-meta">
            <span className="thumb-num">{i + 1}</span>
            {page.rotate !== 0 && <span className="thumb-badge">{page.rotate}°</span>}
          </div>
        </div>
      ))}
    </div>
  )
}
