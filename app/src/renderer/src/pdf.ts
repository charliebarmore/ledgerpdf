/**
 * PDF.js render layer. Rendering ONLY — the engine remains the source of truth
 * for anything written to disk (canonical spec). Nothing here mutates a PDF.
 */

import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { imageLayout, type SourceKind } from './session'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

/**
 * Runtime-relative asset base so it resolves under both the dev server and a
 * packaged file:// load. Copied in by scripts/copy-pdfjs-assets.mjs.
 */
const ASSETS = new URL('./pdfjs/', document.baseURI).href

/** Decoders and font data that real (scanned) tax PDFs need. */
const DOC_OPTS = {
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
