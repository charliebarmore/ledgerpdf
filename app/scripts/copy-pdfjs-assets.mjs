/**
 * Copy the generated/runtime assets we need into the renderer's public/ dir.
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
const repo = path.resolve(app, '..')
const pdfjsFrom = path.join(app, 'node_modules', 'pdfjs-dist')
const pdfjsTo = path.join(app, 'src', 'renderer', 'public', 'pdfjs')
const fontsFrom = path.join(repo, 'site', 'fonts')
const fontsTo = path.join(app, 'src', 'renderer', 'public', 'ui-fonts')

const DIRS = ['wasm', 'cmaps', 'standard_fonts', 'iccs']
/**
 * The worker travels with them. Imported straight from node_modules it
 * resolved, in dev only, to a `http://localhost:PORT/@fs/...` URL that dies
 * with the dev server — restart it, or run two, and PDF.js fails with "Setting
 * up fake worker failed" and renders nothing. Copying it here makes dev and a
 * packaged custom-protocol load resolve the worker the same way.
 */
const FILES = [['build/pdf.worker.min.mjs', 'pdf.worker.min.mjs']]
const FONT_FILES = [
  'Inter-Regular.woff2',
  'Inter-SemiBold.woff2',
  'JetBrainsMono-Regular.woff2',
  'JetBrainsMono-Bold.woff2',
  'OFL.md'
]

await rm(pdfjsTo, { recursive: true, force: true })
await mkdir(pdfjsTo, { recursive: true })
for (const dir of DIRS) {
  await cp(path.join(pdfjsFrom, dir), path.join(pdfjsTo, dir), { recursive: true })
}
for (const [src, dest] of FILES) {
  await cp(path.join(pdfjsFrom, src), path.join(pdfjsTo, dest))
}

// The UI names Inter and JetBrains Mono explicitly. Depending on whatever font
// happens to be installed changes button widths and can wrap the toolbar on a
// clean Windows machine. These are already the OFL-licensed site/brand fonts;
// copy the exact same files and their licence into the app build.
await rm(fontsTo, { recursive: true, force: true })
await mkdir(fontsTo, { recursive: true })
for (const file of FONT_FILES) await cp(path.join(fontsFrom, file), path.join(fontsTo, file))

console.log(
  `renderer assets -> ${path.relative(app, pdfjsTo)} (${DIRS.join(', ')}, ${FILES.map((f) => f[1]).join(', ')}) + ${path.relative(app, fontsTo)} (${FONT_FILES.join(', ')})`
)
