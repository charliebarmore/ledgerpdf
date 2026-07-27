/**
 * PDF.js render layer. Rendering ONLY — the engine remains the source of truth
 * for anything written to disk (canonical spec). Nothing here mutates a PDF.
 */

import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { PDFDocumentProxy } from 'pdfjs-dist'

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
const thumbs = new Map<string, string>()

/** Load (and cache) a source document by its session source id. */
export function getDoc(sourceId: string, filePath: string): Promise<PDFDocumentProxy> {
  let existing = docs.get(sourceId)
  if (!existing) {
    existing = (async () => {
      const bytes = await window.wpt.readPdf(filePath)
      // Copy: pdf.js takes ownership of the buffer it is handed.
      return pdfjs.getDocument({ ...DOC_OPTS, data: new Uint8Array(bytes) }).promise
    })()
    docs.set(sourceId, existing)
  }
  return existing
}

export function forgetDoc(sourceId: string): void {
  docs.delete(sourceId)
  for (const key of [...thumbs.keys()]) {
    if (key.startsWith(`${sourceId}:`)) thumbs.delete(key)
  }
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
  cssWidth = 132
): Promise<string> {
  const key = `${sourceId}:${index}:${rotate}:${cssWidth}`
  const hit = thumbs.get(key)
  if (hit) return hit

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

/** Render one page into a canvas at fit-width for the main view. */
export async function renderInto(
  canvas: HTMLCanvasElement,
  sourceId: string,
  filePath: string,
  index: number,
  rotate: number,
  cssWidth: number
): Promise<void> {
  inFlight.get(canvas)?.cancel()

  const doc = await getDoc(sourceId, filePath)
  const page = await doc.getPage(index + 1)
  const rotation = totalRotation(page.rotate, rotate)
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const base = page.getViewport({ scale: 1, rotation })
  const scale = (cssWidth * dpr) / base.width
  const viewport = page.getViewport({ scale, rotation })

  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)
  canvas.style.width = `${cssWidth}px`
  canvas.style.height = `${Math.ceil(viewport.height / dpr)}px`
  const ctx = canvas.getContext('2d')
  if (!ctx) return
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
}
