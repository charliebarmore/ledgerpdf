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
// ID with an app-specific password (generated at appleid.apple.com),
// or an App Store Connect API key, which is the better choice for CI because it
// is revocable per key and not tied to a person's Apple ID.
const APPLE_PASSWORD_KEYS = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']
const APPLE_API_KEYS = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']
if (signedRelease && process.platform === 'darwin') {
  const has = (keys) => keys.every((key) => process.env[key])
  // THREE paths, not two. The keychain profile is the one to prefer and the
  // one this check originally missed — which would have rejected the safest
  // setup while accepting the two that put a live credential in the
  // environment, where it reaches every child process and any shell history
  // that recorded the command.
  if (!process.env.APPLE_KEYCHAIN_PROFILE && !has(APPLE_PASSWORD_KEYS) && !has(APPLE_API_KEYS)) {
    throw new Error(
      'Signed macOS release needs notarization credentials, and none of the three sets is complete.\n' +
        '  Keychain (preferred):  APPLE_KEYCHAIN_PROFILE — store it once with\n' +
        '                         xcrun notarytool store-credentials\n' +
        `  App-specific password: ${APPLE_PASSWORD_KEYS.join(', ')}\n` +
        `  App Store Connect:     ${APPLE_API_KEYS.join(', ')}\n` +
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
  files: [
    'out/main/**/*',
    'out/preload/**/*',
    'out/renderer/**/*',
    'out/mcp-server.cjs',
    'package.json',
    '!node_modules/**/*'
  ],
  extraResources: [
    {
      from: 'build/engine-sidecar/workpaper-engine',
      to: 'engine'
    },
    {
      from: '../LICENSE',
      to: 'LICENSE.txt'
    },
    {
      from: '../COPYRIGHT.md',
      to: 'COPYRIGHT.md'
    },
    {
      from: '../THIRD-PARTY-NOTICES.md',
      to: 'THIRD-PARTY-NOTICES.md'
    },
    {
      from: 'build/THIRD-PARTY-LICENSES.txt',
      to: 'THIRD-PARTY-LICENSES.txt'
    },
    {
      from: 'node_modules/electron/dist/LICENSE',
      to: 'LICENSE.electron.txt'
    },
    {
      from: 'node_modules/electron/dist/LICENSES.chromium.html',
      to: 'LICENSES.chromium.html'
    },
    {
      from: 'build/npm-sbom.cdx.json',
      to: 'npm-sbom.cdx.json'
    },
    {
      from: 'build/python-environment.json',
      to: 'python-environment.json'
    }
  ],
  asar: true,
  afterPack: 'scripts/after-pack.cjs',
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
    // A different icon from macOS, on purpose. The brand kit ships two: a
    // Vellum tile with ink artwork for macOS, a Deep Teal tile with cream
    // artwork for Windows. Not a light/dark pair — one per platform. Both are
    // rendered by tools/launcher/make-icon.py.
    icon: 'resources/icon-win.png',
    ...(azureSignOptions ? { azureSignOptions, signExts: ['.exe', '.dll'] } : {})
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    perMachine: false
  },
  // Never publish as a side effect of building. package.json now carries a
  // `repository`, from which electron-builder infers a GitHub publish provider
  // and — on detecting CI — uploads a release unasked. That turned a green
  // Windows packaging step red the moment the field was added, asking for a
  // GH_TOKEN no build should need. Releases here are cut deliberately: built,
  // verified, hashed, then attached by hand (see RELEASING.md). Stating it
  // explicitly also survives electron-builder v27, which drops the implicit
  // CI behaviour entirely.
  publish: null
}
