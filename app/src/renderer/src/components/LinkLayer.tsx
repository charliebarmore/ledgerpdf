import { useEffect, useState } from 'react'
import { pageLinks, type PageLink } from '../pdf'
import { sourceOf, type BinderPage, type Session } from '../session'

/**
 * The links a source page already carried, made clickable inside the app.
 *
 * A binder's tab references ("« Back to Wages lead (p. 3)") are real /Link
 * annotations, and they worked in Acrobat and Chrome while doing nothing here —
 * so the one place a preparer assembles the binder was the one place its
 * navigation was dead. Nothing is written: this reads the source document and
 * draws hit regions over the canvas.
 *
 * Regions come from pdf.ts already normalized to DISPLAY space, so they need no
 * geometry of their own and stay on the ink at every zoom and rotation.
 */
export function LinkLayer({
  session,
  page,
  width,
  height,
  armed,
  onFollow
}: {
  session: Session
  page: BinderPage
  width: number
  height: number
  /** While a tool is armed the page is a canvas to mark, not a document to browse. */
  armed: boolean
  /** Resolved by the caller: only it knows which binder page holds a source page. */
  onFollow: (sourceId: string, toIndex: number) => void
}): React.JSX.Element | null {
  const [links, setLinks] = useState<PageLink[]>([])
  const src = sourceOf(session, page)

  useEffect(() => {
    if (!src) return
    let live = true
    pageLinks(src.id, src.path, page.index, page.rotate, src.kind)
      .then((ls) => {
        if (live) setLinks(ls)
      })
      // A source that cannot be read for links is not worth an error on the
      // page — the canvas beside this has already reported anything real.
      .catch(() => {})
    return () => {
      live = false
    }
  }, [src?.id, src?.path, page.index, page.rotate, src?.kind])

  if (!src || links.length === 0) return null

  return (
    <div className={`linklayer${armed ? ' is-armed' : ''}`}>
      {links.map((l, i) => {
        const internal = l.toIndex !== null
        // An external URL is deliberately NOT clickable yet. Opening a browser
        // from a tool whose whole claim is that it makes no network calls is a
        // decision for the person using it, not a side effect of a click. The
        // target is shown so the reference is still readable.
        const title = internal
          ? `Go to page ${(l.toIndex as number) + 1} of ${src.name}`
          : l.url
            ? `${l.url} — external links do not open from inside LedgerPDF`
            : 'This link has no destination'
        return (
          <button
            key={i}
            type="button"
            className={`pdflink${internal ? '' : ' is-dead'}`}
            disabled={!internal}
            title={title}
            style={{
              left: l.nx * width,
              top: l.ny * height,
              width: Math.max(6, (l.nx2 - l.nx) * width),
              height: Math.max(6, (l.ny2 - l.ny) * height)
            }}
            onClick={(e) => {
              e.stopPropagation()
              if (l.toIndex !== null) onFollow(src.id, l.toIndex)
            }}
          />
        )
      })}
    </div>
  )
}
