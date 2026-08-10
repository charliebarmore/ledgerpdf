const { FuseV1Options, FuseVersion } = require('@electron/fuses')

/**
 * Every fuse in the Electron 43 wire is intentional. Keep this named object as
 * the reviewable policy and translate it to the numeric API only at build time.
 * `strictlyRequireAllFuses` makes a future Electron fuse fail packaging until
 * somebody decides which state LedgerPDF should ship.
 */
const expectedFuses = Object.freeze({
  RunAsNode: true, // Required by the installed MCP server command.
  EnableCookieEncryption: true, // No cookies today; future values still get OS-level encryption.
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  EnableEmbeddedAsarIntegrityValidation: true,
  OnlyLoadAppFromAsar: true,
  LoadBrowserProcessSpecificV8Snapshot: false, // Electron 43 ships no browser-specific snapshot.
  GrantFileProtocolExtraPrivileges: false,
  WasmTrapHandlers: true // PDF.js uses WASM; retain V8's bounds-trap protection.
})

function electronFuseConfig() {
  const config = {
    version: FuseVersion.V1,
    strictlyRequireAllFuses: true
  }
  for (const [name, enabled] of Object.entries(expectedFuses)) {
    const option = FuseV1Options[name]
    if (typeof option !== 'number') throw new Error(`Unknown Electron fuse: ${name}`)
    config[option] = enabled
  }
  return config
}

module.exports = { expectedFuses, electronFuseConfig }
