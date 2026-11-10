/** Verify editable reopen and imported annotation preservation through the sidecar. */
import { runPython } from './lib/build-python.mjs'

const code = await runPython('spike/check_single_file.py', { label: 'The single-file binder check' })
process.exit(code ?? 1)
