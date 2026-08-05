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
  appId: 'com.ledgerlabs.ledgerpdf',
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
