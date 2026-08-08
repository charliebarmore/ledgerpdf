const signedRelease = process.env.WPT_SIGNED_RELEASE === 'true'
const azureKeys = [
  'WPT_AZURE_PUBLISHER_NAME',
  'WPT_AZURE_ENDPOINT',
  'WPT_AZURE_CERTIFICATE_PROFILE',
  'WPT_AZURE_SIGNING_ACCOUNT'
]
const missingAzure = azureKeys.filter((key) => !process.env[key])
if (signedRelease && process.platform === 'win32' && missingAzure.length) {
  throw new Error(`Signed Windows release is missing: ${missingAzure.join(', ')}`)
}
// Notarization credentials, checked BEFORE the build rather than at the end of
// it. electron-builder does validate these — but not until the notarize step,
// which runs after the frozen Python engine is rebuilt, the app is packaged and
// the bundle is signed. On this project that is minutes of work thrown away to
// learn that an environment variable was unset, and the error names one missing
// var at a time.
//
// Two accepted paths, matching app-builder-lib's own MacTargetHelper: an Apple
// ID with an app-specific password (what Charlie already keeps for ProBooks and
// Cockpit — generate one more at appleid.apple.com and name it ledgerpdf-notary),
// or an App Store Connect API key, which is the better choice for CI because it
// is revocable per key and not tied to a person's Apple ID.
const APPLE_PASSWORD_KEYS = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']
const APPLE_API_KEYS = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']
if (signedRelease && process.platform === 'darwin') {
  const has = (keys) => keys.every((key) => process.env[key])
  if (!has(APPLE_PASSWORD_KEYS) && !has(APPLE_API_KEYS)) {
    throw new Error(
      'Signed macOS release needs notarization credentials, and neither set is complete.\n' +
        `  App-specific password: ${APPLE_PASSWORD_KEYS.join(', ')}\n` +
        `  or App Store Connect:  ${APPLE_API_KEYS.join(', ')}\n` +
        'Generate an app-specific password at appleid.apple.com > Sign-In and Security.'
    )
  }
}

const azureSignOptions =
  signedRelease && process.platform === 'win32'
    ? {
        publisherName: process.env.WPT_AZURE_PUBLISHER_NAME,
        endpoint: process.env.WPT_AZURE_ENDPOINT,
        certificateProfileName: process.env.WPT_AZURE_CERTIFICATE_PROFILE,
        codeSigningAccountName: process.env.WPT_AZURE_SIGNING_ACCOUNT,
        fileDigest: 'SHA256',
        timestampDigest: 'SHA256'
      }
    : undefined

/** @type {import('electron-builder').Configuration} */
module.exports = {
  // Reverse-DNS of ledgerlabs.co, the publisher's actual domain. NOT
  // com.ledgerlabs.* — ledgerlabs.com has belonged to someone else since
  // 2003. Frozen once anyone installs a build: changing it makes the next
  // update install a second app instead of upgrading the first.
  appId: 'co.ledgerlabs.ledgerpdf',
  productName: 'LedgerPDF',
  // Offered under "Open With" for a PDF, deliberately NOT registered as the
  // default handler: a workpaper tool has no business becoming the machine's
  // PDF viewer. `role: 'Editor'` is what puts it in that menu; double-clicking
  // a binder still needs the user to choose it once, or set it per-file.
  fileAssociations: [
    {
      ext: 'pdf',
      name: 'Workpaper binder',
      description: 'Workpaper binder (PDF with an editable session inside)',
      role: 'Editor',
      rank: 'Alternate',
      isPackage: false
    }
  ],
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
  directories: {
    output: 'release',
    buildResources: 'resources'
  },
  // The Electron UI is fully bundled by electron-vite. MCP's server-side npm
  // dependencies are a separate distribution and must not ride inside the app.
  files: ['out/**/*', 'package.json', '!node_modules/**/*'],
  extraResources: [
    {
      from: 'build/engine-sidecar/workpaper-engine',
      to: 'engine'
    }
  ],
  asar: true,
  npmRebuild: false,
  forceCodeSigning: signedRelease,
  mac: {
    target: ['dmg', 'zip'],
    category: 'public.app-category.finance',
    icon: 'resources/icon.png',
    hardenedRuntime: true,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    notarize: signedRelease
  },
  win: {
    target: ['nsis'],
    icon: 'resources/icon.png',
    ...(azureSignOptions ? { azureSignOptions, signExts: ['.exe', '.dll'] } : {})
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    perMachine: false
  }
}
