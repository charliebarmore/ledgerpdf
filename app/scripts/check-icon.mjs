/**
 * Fail the build if the committed icons are not what make-icon.py draws.
 *
 *   npm run verify:icon
 *
 * Wired into `verify` rather than into the packaging hooks on purpose. The
 * hooks already regenerate the icons, so they can never catch drift — they
 * paper over it. Windows CI runs `npm run verify` and then invokes
 * electron-builder directly, bypassing those hooks entirely, so before this
 * existed the runner packaged whatever PNG happened to be committed and nothing
 * anywhere compared it to the script.
 *
 * Running here also buys the cross-platform proof that cannot be produced on one
 * machine: the check asserts decoded pixels, so when it passes on the Windows
 * runner, Windows Pillow has been shown to render the same icon as macOS
 * Pillow. See tools/launcher/check-icon.py for why it is pixels and not bytes.
 */

import { runPython } from './lib/build-python.mjs'

const code = await runPython('tools/launcher/check-icon.py', { label: 'The icon check' })
if (code !== 0) process.exit(code ?? 1)
