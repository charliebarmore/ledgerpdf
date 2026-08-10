const { execFileSync } = require('node:child_process')
const path = require('node:path')
const { flipFuses } = require('@electron/fuses')
const { electronFuseConfig } = require('./lib/electron-fuses.cjs')

/**
 * Electron's generated Info.plist includes generic privacy descriptions and an
 * arbitrary-load ATS exception. LedgerPDF uses none of those capabilities.
 * Remove them before signing so the artifact describes the product truthfully.
 */
module.exports = async function afterPack(context) {
  // electron-builder 26's configuration schema predates Electron 43's
  // WasmTrapHandlers fuse. Flip the complete wire here, still in builder's
  // documented afterPack-before-signing window, so strict coverage includes
  // the newest fuse instead of silently inheriting it.
  const executable =
    context.electronPlatformName === 'darwin'
      ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
      : path.join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}${context.electronPlatformName === 'win32' ? '.exe' : ''}`
        )
  await flipFuses(executable, electronFuseConfig())

  if (context.electronPlatformName !== 'darwin') return
  const plist = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Info.plist')
  const remove = (key) => {
    try {
      execFileSync('/usr/bin/plutil', ['-remove', key, plist], { stdio: 'ignore' })
    } catch {
      // Missing keys are already in the desired state.
    }
  }
  for (const key of [
    'NSAppTransportSecurity',
    'NSAudioCaptureUsageDescription',
    'NSBluetoothAlwaysUsageDescription',
    'NSBluetoothPeripheralUsageDescription',
    'NSCameraUsageDescription',
    'NSMicrophoneUsageDescription'
  ]) remove(key)
}
