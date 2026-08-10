/**
 * Regenerate the app icons from their script, before packaging.
 *
 * make-icon.py writes app/resources/icon.png (macOS) and icon-win.png
 * (Windows); electron-builder points at those per platform and bakes them into
 * icon.icns / icon.ico. Until this existed the PNG was a committed artifact
 * that only changed when somebody remembered to run make-icon.py by hand — so
 * the script and the icon that actually ships could drift apart with nothing to
 * catch it, and a packaged build would carry the stale one silently.
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

import { runPython } from './lib/build-python.mjs'

const code = await runPython('tools/launcher/make-icon.py', { label: 'The icon build' })

// Fail the build rather than package a stale icon. A wrong icon is cosmetic;
// a build step that reports success having skipped its work is not.
if (code !== 0) {
  console.error(`make-icon.py exited ${code}`)
  process.exit(code ?? 1)
}
