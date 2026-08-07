/**
 * Regenerate app/resources/icon.png from its script, before packaging.
 *
 * electron-builder points at that PNG and bakes it into icon.icns / icon.ico.
 * Until now the PNG was a committed artifact that only changed when somebody
 * remembered to run tools/launcher/make-icon.py by hand — so the script and the
 * icon that actually ships could drift apart with nothing to catch it, and a
 * packaged build would carry the stale one silently.
 *
 * (They had NOT drifted when this was written: the committed PNG hashed
 * identically to a fresh render. This closes the gap rather than fixing a
 * mismatch.)
 *
 * The render is deterministic — same bytes every run — so this is safe in a
 * build step: it will not dirty the working tree or churn git on every package.
 *
 * Same venv resolution and the same WPT_BUILD_PYTHON escape hatch as
 * build-engine.mjs, so a machine that can package can always do this too.
 */

import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoDir = path.resolve(appDir, '..')
const engineDir = path.join(repoDir, 'engine')
const script = path.join(repoDir, 'tools', 'launcher', 'make-icon.py')
const python =
  process.env.WPT_BUILD_PYTHON ||
  (process.platform === 'win32'
    ? path.join(engineDir, '.venv', 'Scripts', 'python.exe')
    : path.join(engineDir, '.venv', 'bin', 'python'))

await access(python, constants.X_OK).catch(() => {
  console.error(
    `Icon build needs Python at ${python}. Install engine/requirements.txt, or set WPT_BUILD_PYTHON.`
  )
  process.exit(1)
})

const code = await new Promise((resolve, reject) => {
  const child = spawn(python, [script], { cwd: repoDir, stdio: 'inherit' })
  child.on('error', reject)
  child.on('close', resolve)
})

// Fail the build rather than package a stale icon. A wrong icon is cosmetic;
// a build step that reports success having skipped its work is not.
if (code !== 0) {
  console.error(`make-icon.py exited ${code}`)
  process.exit(code ?? 1)
}
