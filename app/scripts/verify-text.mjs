/**
 * Runs the text-position checks through the engine venv.
 *
 * Text extraction is only useful if a word's reported coordinates are the same
 * coordinates a mark would use, so these checks belong in `npm run verify`
 * rather than in the spike harness. The interpreter is resolved through
 * scripts/lib/build-python.mjs so the one-liner works on every platform and
 * that resolution lives in ONE place — this file used to carry its own copy.
 *
 *   npm run verify:text
 */

import { runPython } from './lib/build-python.mjs'

const code = await runPython('spike/verify_text.py', { label: 'The text-position check' })
process.exit(code ?? 1)
