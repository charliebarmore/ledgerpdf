/**
 * Runs the pdfium viewer conformance check through the engine venv.
 *
 * This exists because the npm script used to hardcode
 * `../engine/.venv/bin/python`, which is the POSIX layout only — a venv on
 * Windows puts the interpreter in `Scripts\python.exe`. Resolving it through
 * scripts/lib/build-python.mjs keeps the one-liner working on every platform,
 * and keeps that resolution in ONE place: this file used to carry its own copy,
 * which is the shape that gets fixed in one copy and not the others.
 *
 *   npm run verify:viewers
 */

import { runPython } from './lib/build-python.mjs'

const code = await runPython('spike/verify_viewers.py', { label: 'The viewer conformance check' })
process.exit(code ?? 1)
