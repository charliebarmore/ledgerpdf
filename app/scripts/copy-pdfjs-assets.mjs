/**
 * Copy the PDF.js runtime assets we need into the renderer's public/ dir.
 *
 * Why this matters for THIS app: pdfjs v6 decodes JBIG2 and JPEG2000 images via
 * WASM, and both are common in scanned tax documents (bank statements, 1099s a
 * client photographed, prior-year workpapers). Without `wasm/` those pages fail
 * to render. `cmaps/` and `standard_fonts/` cover non-embedded fonts, which
 * tax-software output also relies on.
 *
 * Run automatically before dev/build. The copied tree is gitignored — it is a
 * build artifact of node_modules, not source.
 */

import { cp, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(here, '..')
const from = path.join(app, 'node_modules', 'pdfjs-dist')
const to = path.join(app, 'src', 'renderer', 'public', 'pdfjs')

const DIRS = ['wasm', 'cmaps', 'standard_fonts', 'iccs']

await rm(to, { recursive: true, force: true })
await mkdir(to, { recursive: true })
for (const dir of DIRS) {
  await cp(path.join(from, dir), path.join(to, dir), { recursive: true })
}
console.log(`pdfjs assets -> ${path.relative(app, to)} (${DIRS.join(', ')})`)
