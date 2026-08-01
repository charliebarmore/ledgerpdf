/**
 * Runs the pdfium viewer conformance check through the engine venv.
 *
 * This exists because the npm script used to hardcode
 * `../engine/.venv/bin/python`, which is the POSIX layout only — a venv on
 * Windows puts the interpreter in `Scripts\python.exe`. Resolving it here
 * keeps the same one-liner working on every platform, and matches how
 * smoke.mjs already finds the interpreter.
 *
 *   npm run verify:viewers
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
const SCRIPT = path.join(REPO, 'spike', 'verify_viewers.py')

const child = spawn(PY, [SCRIPT], { stdio: 'inherit' })

child.once('error', (error) => {
  console.error(`Could not run the engine interpreter at ${PY}`)
  console.error(`  ${error.message}`)
  console.error('Create the venv first, then install engine/requirements.txt into it.')
  process.exit(1)
})
child.once('close', (code) => process.exit(code ?? 1))
