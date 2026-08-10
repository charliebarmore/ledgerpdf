/**
 * Does a PACKAGED app open a binder handed to it by the OS — cold AND warm?
 *
 *   npm run verify:finder-open
 *
 * This is "save it, double-click to reopen" — the whole promise of the
 * single-file binder — and it did NOT work in a packaged build. The real bug,
 * which a user reported: binder:open honoured the incoming path only when isDev,
 * so a shipped app discarded what Finder handed it and opened a file picker
 * instead. Fixed by accepting a path only when main itself delivered it
 * (osRequestedOpens).
 *
 * A second change — the renderer PULLS a cold-start open on mount rather than
 * main pushing it on ready-to-show — is belt-and-suspenders against a genuine
 * ordering gap (ready-to-show does not guarantee the renderer's listener is
 * attached). Honesty for whoever reads this later: it was NOT proven necessary.
 * The push happened to work in every run; the failing checks that made it look
 * necessary were this script reading the wrong recents filename. The pull is
 * kept because the race is real even if rarely hit, not because a test caught it.
 *
 * Driven with `open -a`, exactly what Finder's Open With does, against a
 * uniquely named binder copy so a stale recents entry cannot pass it. Asserted
 * on recent-binders.json — written only when a binder truly LOADS (after the
 * engine's open_binder and clean_copy succeed), not on a screenshot and not on
 * the process starting, both of which happen either way. NB the filename: it is
 * recent-binders.json, and getting it wrong is exactly what turned a working
 * feature into a night of phantom failures.
 *
 * MUST run on a packaged build: in dev the old dev-seam branch fires and cannot
 * distinguish the fix from the bug.
 */
import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO = path.resolve(APP_DIR, '..')
const arch = process.arch === 'arm64' ? 'arm64' : process.arch
const APP =
  process.platform === 'darwin'
    ? path.join(APP_DIR, 'release', `mac-${arch}`, 'LedgerPDF.app')
    : path.join(APP_DIR, 'release', 'win-unpacked')
const RECENTS = path.join(os.homedir(), 'Library', 'Application Support', 'LedgerPDF', 'recent-binders.json')
const SOURCE = path.join(REPO, 'spike', 'out', 'live_binder.pdf')
const OUTDIR = path.join(REPO, 'spike', 'out')

// macOS only for now: the open/quit verbs and recents path below are Darwin.
// Windows Explorer association is a separate, later check.
if (process.platform !== 'darwin') {
  console.log('finder-open check is macOS-only for now — skipping')
  process.exit(0)
}
if (!existsSync(path.join(APP, 'Contents', 'MacOS', 'LedgerPDF'))) {
  console.error(`no packaged app at ${APP} — run: npm run package:dir`)
  process.exit(1)
}
if (!existsSync(SOURCE)) {
  console.error(`no binder at ${SOURCE} — run: npm run verify:live`)
  process.exit(1)
}
mkdirSync(OUTDIR, { recursive: true })

const checks = []
const check = (name, ok, detail = '') => {
  checks.push(ok)
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? `  — ${detail}` : ''}`)
}
const quit = () => run('osascript', ['-e', 'tell application "LedgerPDF" to quit']).catch(() => {})
const recentsHas = (base) => {
  try {
    return JSON.stringify(JSON.parse(readFileSync(RECENTS, 'utf8'))).includes(base)
  } catch {
    return false
  }
}
const waitForLoad = async (base, seconds) => {
  for (let i = 0; i < seconds; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    if (recentsHas(base)) return true
  }
  return false
}

// Register the built bundle so LaunchServices routes documents to it — an
// install to /Applications does this; a fresh release/ build has never been.
await run(
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
  ['-f', APP]
).catch(() => {})

try {
  // ---- COLD: no instance running, opened via LaunchServices with the doc.
  await quit()
  await new Promise((r) => setTimeout(r, 3000))
  const coldStamp = `finder-cold-${Date.now()}.pdf`
  const coldFile = path.join(OUTDIR, coldStamp)
  copyFileSync(SOURCE, coldFile)
  check('cold: the binder is not already in recents', !recentsHas(coldStamp))
  await run('open', ['-a', APP, coldFile])
  check(
    'cold: a freshly launched app opens the binder the OS handed it',
    await waitForLoad(coldStamp, 25),
    coldStamp
  )
  rmSync(coldFile, { force: true })

  // ---- WARM: app already running, second document handed to it.
  const warmStamp = `finder-warm-${Date.now()}.pdf`
  const warmFile = path.join(OUTDIR, warmStamp)
  copyFileSync(SOURCE, warmFile)
  check('warm: the binder is not already in recents', !recentsHas(warmStamp))
  await run('open', ['-a', APP, warmFile])
  check(
    'warm: a running app opens a second binder handed to it',
    await waitForLoad(warmStamp, 20),
    warmStamp
  )
  rmSync(warmFile, { force: true })
} finally {
  await quit()
}

const failed = checks.filter((ok) => !ok).length
console.log(`\n${checks.length - failed}/${checks.length} checks passed`)
process.exit(failed ? 1 : 0)
