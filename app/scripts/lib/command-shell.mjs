/** Return true only for Windows command shims that Node cannot spawn directly. */
export function commandNeedsShell(command, platform = process.platform) {
  return platform === 'win32' && /\.(?:cmd|bat)$/i.test(command)
}
