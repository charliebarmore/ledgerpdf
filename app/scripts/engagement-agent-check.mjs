/** Opt-in external-agent acceptance run. Synthetic fixtures only; never in CI. */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isolatedAgentAccess } from './lib/isolated-agent-access.mjs'
import { stopApp } from './lib/stop-app.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const input = path.join(repo, 'spike/fixtures/engagement-acceptance/input')
const name = process.argv[2] ?? 'baseline'
if (!/^[a-z0-9-]+$/.test(name)) throw new Error('Use a simple run name, e.g. baseline-2')
const output = path.join(repo, 'spike/out/engagement-acceptance', name)
if (existsSync(output)) throw new Error(`Run directory already exists: ${output}. Choose a new run name.`)
if (!existsSync(path.join(input, 'prior-year-master.pdf'))) throw new Error('Run spike/make_engagement.py first')
mkdirSync(output, { recursive: true })
const access = isolatedAgentAccess(output, [input, output])
const config = path.join(output, 'mcp-config.json')
writeFileSync(config, JSON.stringify({ mcpServers: { ledgerpdf: {
  command: process.execPath,
  args: [path.join(repo, 'app/out/mcp-server.cjs')],
  env: { ...access.env, WPT_NO_LIVE: '1' }
} } }, null, 2))
const skill = readFileSync(path.join(repo, 'skills/ledgerpdf-compile/SKILL.md'), 'utf8')
const prompt = `Use these compilation instructions:\n${skill}\n\n` +
  `Compile Cedar Demo Studio's synthetic 2026 engagement. Inputs: ${input}/current-year. ` +
  `Prior-year organizing reference: ${input}/prior-year-master.pdf. ` +
  `Read notes-from-preparer.md for current-year instructions. ` +
  `Save a new editable master at ${output}/master.pdf and the generated cover at ${output}/handoff.md. ` +
  `All supplied documents are synthetic. Use only the LedgerPDF tools and these paths. ` +
  `The output folder is scratch space for this run. Do not access an answer key or other folders. ` +
  `Do not alter app code or source documents. Perform the requested checks and persist the handoff. ` +
  `Explain any capability that prevents completion rather than pretending it worked.`
writeFileSync(path.join(output, 'prompt.txt'), prompt)
const started = Date.now()
const child = spawn('claude', [
  '-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
  '--setting-sources', '', '--strict-mcp-config', '--mcp-config', config,
  // MCP definitions connect lazily; ToolSearch is required even with every
  // filesystem/shell tool disabled. See code.claude.com/docs/en/mcp.
  '--tools', 'ToolSearch', '--allowedTools', 'ToolSearch', 'mcp__ledgerpdf__*', '--permission-mode', 'dontAsk',
  '--max-budget-usd', '5', '--append-system-prompt',
  'This is a bounded synthetic-document acceptance test. Use the supplied MCP server only. Do not delegate to other agents.'
], { cwd: output, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
let stdout = ''
let stderr = ''
let timedOut = false
const timer = setTimeout(async () => {
  timedOut = true
  await stopApp(child)
}, 12 * 60_000)
child.stdout.on('data', (data) => {
  stdout += data
  writeFileSync(path.join(output, 'transcript.jsonl'), stdout)
})
child.stderr.on('data', (data) => {
  stderr += data
  writeFileSync(path.join(output, 'stderr.log'), stderr)
})
child.on('error', (error) => { stderr += String(error) })
child.stdin.end(prompt)
child.on('close', (code) => {
  clearTimeout(timer)
  const result = { code, timedOut, elapsedSeconds: Math.round((Date.now() - started) / 1000),
    masterExists: existsSync(path.join(output, 'master.pdf')), output }
  writeFileSync(path.join(output, 'run.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
  if (!result.masterExists && stderr) console.error(stderr.slice(-1500))
  process.exitCode = code === 0 && result.masterExists ? 0 : 1
})
console.log(`External-agent run: ${output}; maximum API budget $5; timeout 12 minutes.`)
