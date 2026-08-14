export interface AgentConnectCommand {
  command: string
  runner: string
  bundle: string
  needsElectronRunAsNode: boolean
  /** When set, the command must NOT be offered — see unstableInstallReason. */
  unstableReason?: string
}

/**
 * The registration command bakes the app's current absolute path into the
 * user's global MCP config (`-s user`). Run from a mounted disk image or a
 * Gatekeeper-translocated location, that path dies with the session — the MCP
 * client then reports the server failed with an ENOENT the user cannot
 * interpret, while LedgerPDF itself looks healthy and keeps displaying the
 * same doomed command. Recovering takes knowing `claude mcp remove` exists.
 * Detect those locations and explain instead of handing the command over.
 */
export function unstableInstallReason(
  resourcesPath: string,
  platform: NodeJS.Platform
): string | null {
  if (platform !== 'darwin') return null
  if (resourcesPath.startsWith('/Volumes/')) {
    return (
      'LedgerPDF is running from its downloaded disk image, so this command would break the ' +
      'moment the disk image is ejected. Drag LedgerPDF to Applications, open it from there, ' +
      'and come back to this panel.'
    )
  }
  if (resourcesPath.includes('/AppTranslocation/')) {
    return (
      'macOS is running LedgerPDF from a temporary location (it was opened straight from the ' +
      'download), so this command would break when the app quits. Move LedgerPDF to ' +
      'Applications, open it from there, and come back to this panel.'
    )
  }
  return null
}
/** Build a Claude Code registration command without relying on shell syntax. */
export function agentConnectCommand(options: {
  isDev: boolean
  runner: string
  bundle: string
}): AgentConnectCommand {
  const quote = (value: string): string => (/\s|"/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value)
  const env = options.isDev ? '' : '-e ELECTRON_RUN_AS_NODE=1 '
  return {
    command: `claude mcp add ledgerpdf -s user ${env}-- ${quote(options.runner)} ${quote(options.bundle)}`,
    runner: options.runner,
    bundle: options.bundle,
    needsElectronRunAsNode: !options.isDev
  }
}
