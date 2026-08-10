export interface AgentConnectCommand {
  command: string
  runner: string
  bundle: string
  needsElectronRunAsNode: boolean
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
