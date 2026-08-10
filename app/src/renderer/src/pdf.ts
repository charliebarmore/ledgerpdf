/**
 * PDF.js render layer. Rendering ONLY — the engine remains the source of truth
 * for anything written to disk (canonical spec). Nothing here mutates a PDF.
 */

import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { imageLayout, type SourceKind } from './session'

/**
 * Runtime-relative asset base so it resolves under both the dev server and the
 * packaged ledgerpdf:// origin. Copied in by scripts/copy-pdfjs-assets.mjs.
 */
const ASSETS = new URL('./pdfjs/', document.baseURI).href

// The worker comes from that same tree rather than from node_modules. A
// `?url` import of it resolved in dev to a localhost/@fs URL tied to one dev
// server: kill or restart that server and PDF.js reports "Setting up fake
// worker failed" and renders nothing, while the packaged build was fine —
// a dev/prod divergence that hid the failure until someone hit it.
pdfjs.GlobalWorkerOptions.workerSrc = `${ASSETS}pdf.worker.min.mjs`

/** Decoders and font data that real (scanned) tax PDFs need. */
const DOC_OPTS = {
  // LedgerPDF renders pages and its own annotation UI; PDF-embedded JavaScript
  // has no product purpose. Keep it off even when PDF.js defaults change.
  enableScripting: false,
  isEvalSupported: false,
  wasmUrl: `${ASSETS}wasm/`, // JBIG2 + JPEG2000 — common in scans
  cMapUrl: `${ASSETS}cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${ASSETS}standard_fonts/`,
  iccUrl: `${ASSETS}iccs/`
} as const

const docs = new Map<string, Promise<PDFDocumentProxy>>()
const bitmaps = new Map<string, Promise<ImageBitmap>>()
const thumbs = new Map<string, string>()

/** Load (and cache) a source document by its session source id. */
export function getDoc(sourceId: string, filePath: string): Promise<PDFDocumentProxy> {
  let existing = docs.get(sourceId)
  if (!existing) {
    existing = (async () => {
      const bytes = await window.wpt.readSource(filePath)
      // Copy: pdf.js takes ownership of the buffer it is handed.
      return pdfjs.getDocument({ ...DOC_OPTS, data: new Uint8Array(bytes) }).promise
    })()
    docs.set(sourceId, existing)
  }
  return existing
}

/**
 * Load (and cache) an image source, EXIF rotation already applied.
 *
 * `imageOrientation: 'from-image'` is what keeps a phone photo of a receipt the
 * right way up — and it matches the engine, which honours the same EXIF tag
 * through the exported page's /Rotate.
 */
function getBitmap(sourceId: string, filePath: string): Promise<ImageBitmap> {
  let existing = bitmaps.get(sourceId)
  if (!existing) {
    existing = (async () => {
      const bytes = await window.wpt.readSource(filePath)
      const blob = new Blob([new Uint8Array(bytes)])
      return createImageBitmap(blob, { imageOrientation: 'from-image' })
    })()
    bitmaps.set(sourceId, existing)
  }
  return existing
}

export function forgetDoc(sourceId: string): void {
  docs.delete(sourceId)
  bitmaps.get(sourceId)?.then((b) => b.close()).catch(() => {})
  bitmaps.delete(sourceId)
  for (const key of [...thumbs.keys()]) {
    if (key.startsWith(`${sourceId}:`)) thumbs.delete(key)
  }
}

// ------------------------------------------------------------------- images

/**
 * Paint an image page onto a canvas at `zoom` CSS pixels per point, including
 * the user's rotation delta. Returns the displayed page size in points.
 */
function paintImage(
  canvas: HTMLCanvasElement,
  bmp: ImageBitmap,
  rotate: number,
  zoom: number,
  dpr: number
): { dispW: number; dispH: number } {
  const L = imageLayout(bmp.width, bmp.height)
  const rot = (((rotate % 360) + 360) % 360) as 0 | 90 | 180 | 270
  const quarter = rot === 90 || rot === 270
  const dispW = quarter ? L.pageH : L.pageW
  const dispH = quarter ? L.pageW : L.pageH

  const S = zoom * dpr
  canvas.width = Math.ceil(dispW * S)
  canvas.height = Math.ceil(dispH * S)
  canvas.style.width = `${Math.ceil(dispW * zoom)}px`
  canvas.style.height = `${Math.ceil(dispH * zoom)}px`

  const ctx = canvas.getContext('2d')
  if (!ctx) return { dispW, dispH }
  // Map unrotated page space onto the (possibly rotated) canvas.
  if (rot === 90) ctx.setTransform(0, S, -S, 0, L.pageH * S, 0)
  else if (rot === 180) ctx.setTransform(-S, 0, 0, -S, L.pageW * S, L.pageH * S)
  else if (rot === 270) ctx.setTransform(0, -S, S, 0, 0, L.pageW * S)
  else ctx.setTransform(S, 0, 0, S, 0, 0)

  // The exported page is a white sheet with the image on it — draw the sheet.
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, L.pageW, L.pageH)
  ctx.drawImage(bmp, L.x, L.y, L.w, L.h)
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  return { dispW, dispH }
}

/**
 * Total display rotation = the page's own /Rotate plus the user's delta.
 * pdf.js `rotation` REPLACES the intrinsic rotation, so it must be summed here.
 */
function totalRotation(intrinsic: number, delta: number): number {
  return (((intrinsic + delta) % 360) + 360) % 360
}

/** Small cached thumbnail as a data URL. */
export async function renderThumb(
  sourceId: string,
  filePath: string,
  index: number,
  rotate: number,
  cssWidth = 132,
  kind: SourceKind = 'pdf'
): Promise<string> {
  const key = `${sourceId}:${index}:${rotate}:${cssWidth}`
  const hit = thumbs.get(key)
  if (hit) return hit

  if (kind === 'image') {
    const bmp = await getBitmap(sourceId, filePath)
    const L = imageLayout(bmp.width, bmp.height)
    const quarter = rotate % 180 !== 0
    const canvas = document.createElement('canvas')
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    paintImage(canvas, bmp, rotate, cssWidth / (quarter ? L.pageH : L.pageW), dpr)
    const url = canvas.toDataURL('image/png')
    thumbs.set(key, url)
    return url
  }

  const doc = await getDoc(sourceId, filePath)
  const page = await doc.getPage(index + 1)
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const base = page.getViewport({ scale: 1, rotation: totalRotation(page.rotate, rotate) })
  const scale = (cssWidth * dpr) / base.width
  const viewport = page.getViewport({ scale, rotation: totalRotation(page.rotate, rotate) })

  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no 2d context')
  await page.render({ canvasContext: ctx, viewport, canvas }).promise

  const url = canvas.toDataURL('image/png')
  thumbs.set(key, url)
  return url
}

/**
 * In-flight render per canvas. pdf.js throws "Cannot use the same canvas during
 * multiple render() operations" if two renders overlap — which happens easily
 * when a resize and a page change land together. Cancelling here keeps that
 * concern out of every component.
 */
const inFlight = new WeakMap<HTMLCanvasElement, { cancel: () => void }>()

/**
 * How big to draw the page.
 *  - `fitWidth` / `fitPage` — scale to the given viewport box
 *  - `scale` — absolute zoom, where 1 = 100% (one PDF point per CSS pixel)
 */
export type Sizing =
  | { mode: 'fitWidth'; boxW: number }
  | { mode: 'fitPage'; boxW: number; boxH: number }
  | { mode: 'scale'; factor: number }

/** Render one page into a canvas at fit-width for the main view. */
export async function renderInto(
  canvas: HTMLCanvasElement,
  sourceId: string,
  filePath: string,
  index: number,
  rotate: number,
  sizing: Sizing,
  kind: SourceKind = 'pdf'
): Promise<number> {
  inFlight.get(canvas)?.cancel()

  if (kind === 'image') {
    const bmp = await getBitmap(sourceId, filePath)
    const L = imageLayout(bmp.width, bmp.height)
    const quarter = rotate % 180 !== 0
    const baseW = quarter ? L.pageH : L.pageW
    const baseH = quarter ? L.pageW : L.pageH
    const zoom =
      sizing.mode === 'scale'
        ? sizing.factor
        : sizing.mode === 'fitWidth'
          ? sizing.boxW / baseW
          : Math.min(sizing.boxW / baseW, sizing.boxH / baseH)
    paintImage(canvas, bmp, rotate, zoom, Math.min(window.devicePixelRatio || 1, 2))
    return zoom
  }

  const doc = await getDoc(sourceId, filePath)
  const page = await doc.getPage(index + 1)
  const rotation = totalRotation(page.rotate, rotate)
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const base = page.getViewport({ scale: 1, rotation })

  // Effective zoom: 1 = 100% (one PDF point per CSS pixel).
  const zoom =
    sizing.mode === 'scale'
      ? sizing.factor
      : sizing.mode === 'fitWidth'
        ? sizing.boxW / base.width
        : Math.min(sizing.boxW / base.width, sizing.boxH / base.height)

  const viewport = page.getViewport({ scale: zoom * dpr, rotation })

  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)
  canvas.style.width = `${Math.ceil(base.width * zoom)}px`
  canvas.style.height = `${Math.ceil(base.height * zoom)}px`
  const ctx = canvas.getContext('2d')
  if (!ctx) return zoom
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  // A newer render may have started while we awaited the page.
  inFlight.get(canvas)?.cancel()
  const task = page.render({ canvasContext: ctx, viewport, canvas })
  inFlight.set(canvas, task)
  try {
    await task.promise
  } catch (err) {
    // Cancellation is expected and not an error worth surfacing.
    if ((err as { name?: string })?.name !== 'RenderingCancelledException') throw err
  } finally {
    if (inFlight.get(canvas) === task) inFlight.delete(canvas)
  }
  return zoom
}

/**
 * A link annotation on a source page, in NORMALIZED DISPLAY space.
 *
 * Same coordinate convention as marks and shapes — nx/ny 0→1, y from the TOP —
 * so a hit region lands on the ink at every zoom and rotation without the
 * caller doing any PDF-space arithmetic.
 */
export type PageLink = {
  /** Display-space box, normalized. */
  nx: number
  ny: number
  nx2: number
  ny2: number
  /** Target page INDEX inside the same source document, when internal. */
  toIndex: number | null
  /** Target URL, when the link points out of the document. */
  url: string | null
}

const linkCache = new Map<string, Promise<PageLink[]>>()

/**
 * The link annotations on one source page.
 *
 * Read from the PDF rather than from the session: an imported binder inherits
 * whatever links its sources carried, and those are the ones a preparer expects
 * to work. Nothing here mutates the document.
 *
 * Geometry via `convertToViewportRectangle` on a scale-1 viewport, which is the
 * same transform `renderInto` paints through — so it already accounts for the
 * page's own /Rotate, the user's rotation delta, and a CropBox that differs
 * from the MediaBox. Doing this arithmetic by hand is how a hit region ends up
 * mirrored on a rotated page, which is the trap the OCR work hit.
 */
export function pageLinks(
  sourceId: string,
  filePath: string,
  index: number,
  rotate: number,
  kind: SourceKind = 'pdf'
): Promise<PageLink[]> {
  // Images carry no annotations, and a spreadsheet's pages do not exist until
  // export — asking either for links would load a document for nothing.
  if (kind !== 'pdf') return Promise.resolve([])
  const key = `${sourceId}:${index}:${rotate}`
  let existing = linkCache.get(key)
  if (existing) return existing
  existing = (async () => {
    const doc = await getDoc(sourceId, filePath)
    const page = await doc.getPage(index + 1)
    const rotation = totalRotation(page.rotate, rotate)
    const base = page.getViewport({ scale: 1, rotation })
    const annots = await page.getAnnotations({ intent: 'display' })
    const out: PageLink[] = []
    for (const a of annots as Array<Record<string, unknown>>) {
      if (a.subtype !== 'Link') continue
      const rect = a.rect as number[] | undefined
      if (!rect || rect.length < 4) continue
      // Both corners through convertToViewportPoint rather than the rectangle
      // helper: this pdf.js version does not declare the latter, and casting to
      // reach it would trade a compile-time check for nothing — two points carry
      // the same transform.
      const [x1, y1] = base.convertToViewportPoint(rect[0], rect[1]) as number[]
      const [x2, y2] = base.convertToViewportPoint(rect[2], rect[3]) as number[]
      const nx = Math.min(x1, x2) / base.width
      const nx2 = Math.max(x1, x2) / base.width
      const ny = Math.min(y1, y2) / base.height
      const ny2 = Math.max(y1, y2) / base.height
      // A zero-area link is unclickable and usually a generator artefact.
      if (nx2 - nx <= 0 || ny2 - ny <= 0) continue

      let toIndex: number | null = null
      // `dest` is either an explicit array or the NAME of one, and only the
      // document can resolve a name. Both forms start with a page reference.
      let dest = a.dest as unknown
      if (typeof dest === 'string') dest = await doc.getDestination(dest)
      if (Array.isArray(dest) && dest.length > 0) {
        try {
          toIndex = await doc.getPageIndex(dest[0] as never)
        } catch {
          // A destination that no longer resolves is a broken link, not a crash.
          toIndex = null
        }
      }
      out.push({
        nx,
        ny,
        nx2,
        ny2,
        toIndex,
        url: typeof a.url === 'string' ? a.url : null
      })
    }
    return out
  })()
  linkCache.set(key, existing)
  return existing
}
