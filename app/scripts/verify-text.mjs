/**
 * Runs the text-position checks through the engine venv.
 *
 * Text extraction is only useful if a word's reported coordinates are the same
 * coordinates a mark would use, so these checks belong in `npm run verify`
 * rather than in the spike harness. Resolving the interpreter here keeps the
 * one-liner working on every platform, matching smoke.mjs.
 *
 *   npm run verify:text
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO = path.resolve(APP, '..')
const PY = path.join(
  REPO,
  'engine',
  '.venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
)
const SCRIPT = path.join(REPO, 'spike', 'verify_text.py')

const child = spawn(PY, [SCRIPT], { stdio: 'inherit' })

child.once('error', (error) => {
  console.error(`Could not run the engine interpreter at ${PY}`)
  console.error(`  ${error.message}`)
  console.error('Create the venv first, then install engine/requirements.txt into it.')
  process.exit(1)
})
child.once('close', (code) => process.exit(code ?? 1))
