import { useEffect, useRef, useState } from 'react'
import { pageProvenance, sourceOf, type BinderPage, type Session } from '../session'
import { renderInto } from '../pdf'

export function PageView({
  session,
  page
}: {
  session: Session
  page: BinderPage | null
}): React.JSX.Element {
  const holder = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [width, setWidth] = useState(760)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const el = holder.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.max(240, Math.floor(entry.contentRect.width - 48))
      setWidth(Math.min(w, 1100))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const src = page ? sourceOf(session, page) : undefined
    if (!page || !src || !canvas.current) return
    setError(null)
    renderInto(canvas.current, src.id, src.path, page.index, page.rotate, width).catch((e) =>
      setError(String(e?.message ?? e))
    )
  }, [page?.id, page?.rotate, width, session.sources])

  return (
    <div className="pageview" ref={holder}>
      {page ? (
        <>
          <div className="pageview-caption">
            {pageProvenance(session, page)}
            {page.rotate !== 0 && <span className="tag">rotated {page.rotate}°</span>}
          </div>
          {error ? <div className="error">{error}</div> : <canvas ref={canvas} className="sheet" />}
        </>
      ) : (
        <div className="pageview-empty">No page selected</div>
      )}
    </div>
  )
}
