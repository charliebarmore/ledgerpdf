import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.env.WPT_SIGNED_RELEASE !== 'true') {
  throw new Error(
    'Refusing to create a distributable without signing. Set WPT_SIGNED_RELEASE=true and the platform signing credentials; use npm run package:dir for a local ad-hoc build.'
  )
}

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const builder = path.join(
  appDir,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder'
)
const child = spawn(builder, ['--config', 'electron-builder.config.cjs'], {
  cwd: appDir,
  env: process.env,
  stdio: 'inherit'
})
const code = await new Promise((resolve, reject) => {
  child.once('error', reject)
  child.once('close', resolve)
})
if (code !== 0) throw new Error(`Signed release build failed with exit code ${code}`)

/**
 * Sign, notarize and staple the DMG itself.
 *
 * electron-builder notarizes the .app and THEN wraps it in a DMG, so the DMG
 * it hands you is unsigned and unnotarized. On the first real release that was
 * not theoretical: `spctl` on the finished DMG said "rejected — no usable
 * signature", while the app inside it was perfectly notarized. A design partner
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
  const profile = process.env.APPLE_KEYCHAIN_PROFILE

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
    const creds = profile
      ? ['--keychain-profile', profile]
      : [
          '--apple-id', process.env.APPLE_ID,
          '--password', process.env.APPLE_APP_SPECIFIC_PASSWORD,
          '--team-id', process.env.APPLE_TEAM_ID
        ]
    await run('xcrun', ['notarytool', 'submit', dmg, ...creds, '--wait'])
    await run('xcrun', ['stapler', 'staple', dmg])
    // Assert the outcome rather than trust three exit codes: this is the last
    // thing that touches the artifact a person downloads.
    await run('spctl', ['-a', '-t', 'open', '--context', 'context:primary-signature', dmg])
    await run('xcrun', ['stapler', 'validate', dmg])
    console.log(`${dmg}: signed, notarized, stapled, Gatekeeper-accepted`)
  }
}
