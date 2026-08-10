/**
 * Resolve the engine venv's Python, the same way for every script that needs it.
 *
 * A venv puts its interpreter in `bin/` on POSIX and `Scripts\` on Windows, and
 * `WPT_BUILD_PYTHON` is the escape hatch for a machine that keeps it somewhere
 * else. That is three facts, and every script that shells out to Python needs
 * all three — which is precisely the shape that ends up copy-pasted and then
 * fixed in one copy. scripts/lib/stop-app.mjs exists for the same reason, and
 * that lesson cost a 45-minute CI hang.
 */

import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const APP = path.resolve(here, '..', '..')
export const REPO = path.resolve(APP, '..')

export function buildPython() {
  return (
    process.env.WPT_BUILD_PYTHON ||
    path.join(
      REPO,
      'engine',
      '.venv',
      ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python'])
    )
  )
}

/**
 * Run a Python script from the repo root, inheriting stdio. Resolves with the
 * exit code rather than throwing, so each caller decides what a failure means:
 * a missing icon is a build stopper, a mismatched one is a failed check.
 */
export async function runPython(scriptRelPath, { label = 'This' } = {}) {
  const python = buildPython()
  await access(python, constants.X_OK).catch(() => {
    console.error(
      `${label} needs Python at ${python}. Install engine/requirements.lock with --require-hashes, or set WPT_BUILD_PYTHON.`
    )
    process.exit(1)
  })
  return new Promise((resolve, reject) => {
    const child = spawn(python, [path.join(REPO, scriptRelPath)], { cwd: REPO, stdio: 'inherit' })
    child.on('error', reject)
    child.on('close', resolve)
  })
}
