import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { commandNeedsShell } from './lib/command-shell.mjs'
import { notaryCredentials } from './lib/notary-credentials.mjs'

if (process.env.WPT_SIGNED_RELEASE !== 'true') {
  throw new Error(
    'Refusing to create a distributable without signing. Set WPT_SIGNED_RELEASE=true and the platform signing credentials; use npm run package:dir for a local ad-hoc build.'
  )
}
if (process.platform === 'darwin') {
  // Preflight before freezing Python. electron-builder validates this too, but
  // only after every expensive preparation step has already completed.
  notaryCredentials(process.env)
}
if (process.platform === 'win32') {
  const required = [
    'WPT_AZURE_PUBLISHER_NAME',
    'WPT_AZURE_ENDPOINT',
    'WPT_AZURE_CERTIFICATE_PROFILE',
    'WPT_AZURE_SIGNING_ACCOUNT'
  ]
  const missing = required.filter((key) => !process.env[key])
  if (missing.length) throw new Error(`Signed Windows release is missing: ${missing.join(', ')}`)
}

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const builder = path.join(
  appDir,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder'
)
const runInherited = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: appDir,
      env: process.env,
      // npm and electron-builder are .cmd shims on Windows. Node's command
      // spawn hardening requires those shims to run through the shell.
      shell: commandNeedsShell(command),
      stdio: 'inherit'
    })
    child.once('error', reject)
    child.once('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${path.basename(command)} ${args.join(' ')} failed with exit code ${code}`))
    )
  })

// This preparation deliberately lives AFTER the signing guard above. An npm
// `predist` lifecycle hook runs before the named script, which meant an unsafe
// unsigned attempt spent minutes freezing Python and packaging before it was
// finally refused.
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
for (const script of ['build:icon', 'build:engine', 'build', 'release:metadata']) {
  await runInherited(npm, ['run', script])
}
await runInherited(builder, ['--config', 'electron-builder.config.cjs'])

/**
 * Sign, notarize and staple the DMG itself.
 *
 * electron-builder notarizes the .app and THEN wraps it in a DMG, so the DMG
 * it hands you is unsigned and unnotarized. On the first real release that was
 * not theoretical: `spctl` on the finished DMG said "rejected — no usable
 * signature", while the app inside it was perfectly notarized. A recipient
 * downloading the thing we asked them to trust with client files would have met
 * a Gatekeeper warning, and everyone would have concluded the signing had not
 * worked, when in fact only the wrapper was bare.
 *
 * Apple's rule is to staple what you actually distribute. We distribute the DMG.
 *
 * The ZIP is deliberately left alone: it carries the stapled .app, a zip cannot
 * hold a ticket of its own, and it exists for auto-update rather than for a
 * person to double-click.
 */
if (process.platform === 'darwin') {
  const { readdir } = await import('node:fs/promises')
  const releaseDir = path.join(appDir, 'release')
  const dmgs = (await readdir(releaseDir)).filter((f) => f.endsWith('.dmg'))
  if (!dmgs.length) throw new Error('signed release produced no .dmg to staple')

  const identity = process.env.WPT_MAC_IDENTITY ?? 'Developer ID Application'

  const run = (cmd, args) =>
    new Promise((resolve, reject) => {
      const c = spawn(cmd, args, { cwd: releaseDir, stdio: 'inherit' })
      c.once('error', reject)
      c.once('close', (rc) =>
        rc === 0 ? resolve() : reject(new Error(`${cmd} ${args[0]} exited ${rc}`))
      )
    })

  for (const dmg of dmgs) {
    console.log(`\nsigning + notarizing ${dmg}`)
    await run('codesign', ['--sign', identity, '--timestamp', dmg])
    // Credentials: the keychain profile if there is one, otherwise notarytool
    // reads the same APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID the
    // config already preflighted, so this cannot ask for anything the build did
    // not already establish.
    const creds = notaryCredentials(process.env)
    await run('xcrun', ['notarytool', 'submit', dmg, ...creds, '--wait'])
    await run('xcrun', ['stapler', 'staple', dmg])
    // Assert the outcome rather than trust three exit codes: this is the last
    // thing that touches the artifact a person downloads.
    await run('spctl', ['-a', '-t', 'open', '--context', 'context:primary-signature', dmg])
    await run('xcrun', ['stapler', 'validate', dmg])
    console.log(`${dmg}: signed, notarized, stapled, Gatekeeper-accepted`)
  }
}
