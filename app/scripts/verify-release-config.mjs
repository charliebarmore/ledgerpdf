import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { FuseV1Options } from '@electron/fuses'
import { commandNeedsShell } from './lib/command-shell.mjs'
import { notaryCredentials } from './lib/notary-credentials.mjs'

const require = createRequire(import.meta.url)
const { expectedFuses, electronFuseConfig } = require('./lib/electron-fuses.cjs')
const builderConfig = require('../electron-builder.config.cjs')
const packageJson = require('../package.json')
const packageLock = require('../package-lock.json')
const engineInit = readFileSync(
  new URL('../../engine/workpaper_engine/__init__.py', import.meta.url),
  'utf8'
)

assert.equal(packageLock.version, packageJson.version)
assert.equal(packageLock.packages[''].version, packageJson.version)
const engineVersion = engineInit.match(/^__version__\s*=\s*["']([^"']+)["']/m)?.[1]
assert.equal(
  engineVersion,
  packageJson.version,
  `engine version ${engineVersion ?? '(missing)'} must match app version ${packageJson.version}`
)
const windowsWorkflow = readFileSync(
  new URL('../../.github/workflows/windows.yml', import.meta.url),
  'utf8'
)
assert.match(windowsWorkflow, /ConvertFrom-Json\)\.version/)
assert.doesNotMatch(windowsWorkflow, /LedgerPDF-\d+\.\d+\.\d+-win-x64\.exe/)

assert.deepEqual(notaryCredentials({ APPLE_KEYCHAIN_PROFILE: 'ledgerpdf' }), [
  '--keychain-profile', 'ledgerpdf'
])
assert.deepEqual(
  notaryCredentials({ APPLE_API_KEY: '/key.p8', APPLE_API_KEY_ID: 'KEY', APPLE_API_ISSUER: 'ISSUER' }),
  ['--key', '/key.p8', '--key-id', 'KEY', '--issuer', 'ISSUER']
)
assert.deepEqual(
  notaryCredentials({ APPLE_ID: 'release@example.com', APPLE_APP_SPECIFIC_PASSWORD: 'secret', APPLE_TEAM_ID: 'TEAM' }),
  ['--apple-id', 'release@example.com', '--password', 'secret', '--team-id', 'TEAM']
)
assert.throws(() => notaryCredentials({ APPLE_API_KEY: '/incomplete.p8' }), /no complete/)
assert.equal(commandNeedsShell('npm.cmd', 'win32'), true)
assert.equal(commandNeedsShell('electron-builder.BAT', 'win32'), true)
assert.equal(commandNeedsShell('python.exe', 'win32'), false)
assert.equal(commandNeedsShell('npm', 'darwin'), false)

const knownFuseNames = Object.values(FuseV1Options).filter((value) => typeof value === 'string')
assert.deepEqual(Object.keys(expectedFuses).sort(), knownFuseNames.sort())
const fuseConfig = electronFuseConfig()
assert.equal(fuseConfig.strictlyRequireAllFuses, true)
for (const [name, enabled] of Object.entries(expectedFuses)) {
  assert.equal(fuseConfig[FuseV1Options[name]], enabled, name)
}

assert.equal(builderConfig.nsis.oneClick, false)
assert.equal(builderConfig.nsis.perMachine, false)
assert.equal(builderConfig.nsis.include, 'resources/installer.nsh')
const installerHook = readFileSync(new URL('../resources/installer.nsh', import.meta.url), 'utf8')
assert.match(installerHook, /!macro customInstallMode/)
assert.match(installerHook, /HKCU "\$\{INSTALL_REGISTRY_KEY\}" InstallLocation/)
assert.match(installerHook, /HKLM "\$\{INSTALL_REGISTRY_KEY\}" InstallLocation/)
assert.match(installerHook, /\$\{FileExists\} "\$0\\\$\{APP_EXECUTABLE_FILENAME\}"/)
assert.match(installerHook, /!macro customInstall/)
assert.match(
  installerHook,
  /WriteRegStr SHELL_CONTEXT "\$\{UNINSTALL_REGISTRY_KEY\}" InstallLocation "\$INSTDIR"/
)
assert.match(installerHook, /ReadRegStr \$3 SHELL_CONTEXT "\$\{UNINSTALL_REGISTRY_KEY\}" DisplayName/)
assert.match(installerHook, /ReadRegStr \$4 SHELL_CONTEXT "\$\{UNINSTALL_REGISTRY_KEY\}" InstallLocation/)
assert.match(installerHook, /ReadRegStr \$5 SHELL_CONTEXT "\$\{UNINSTALL_REGISTRY_KEY\}" UninstallString/)
assert.match(installerHook, /SetErrorLevel 1\s+Abort/)

console.log(
  'Release credentials, command spawning, complete Electron fuse policy, and NSIS install/uninstall registration: OK'
)
