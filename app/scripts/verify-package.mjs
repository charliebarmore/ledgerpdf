import { access, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { listPackage } from '@electron/asar'
import { FuseState, FuseV1Options, getCurrentFuseWire } from '@electron/fuses'
import { isolatedAgentAccess } from './lib/isolated-agent-access.mjs'

const require = createRequire(import.meta.url)
const { expectedFuses } = require('./lib/electron-fuses.cjs')
const packageJson = require('../package.json')

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const arch = process.arch === 'arm64' ? 'arm64' : process.arch
const packagedRoot =
  process.platform === 'darwin'
    ? path.join(appDir, 'release', `mac-${arch}`, 'LedgerPDF.app')
    : path.join(appDir, 'release', 'win-unpacked')
const executable =
  process.platform === 'darwin'
    ? path.join(packagedRoot, 'Contents', 'MacOS', 'LedgerPDF')
    : path.join(packagedRoot, 'LedgerPDF.exe')
const resources =
  process.platform === 'darwin'
    ? path.join(packagedRoot, 'Contents', 'Resources')
    : path.join(packagedRoot, 'resources')
const fixture = path.resolve(appDir, '..', 'spike', 'fixtures', 'fixture_a.pdf')
const screenshot = path.join(appDir, 'build', 'package-smoke.png')
const exported = path.join(appDir, 'build', 'package-smoke-binder.pdf')
const smokeReport = path.join(appDir, 'build', 'package-smoke.txt')
const smokeUserData = path.join(appDir, 'build', 'userdata-package')
const PACKAGE_ACCESS = isolatedAgentAccess(
  path.resolve(appDir, '..', 'spike', 'out', 'agent-profile-package'),
  [path.resolve(appDir, '..', 'spike')]
)

await access(executable, constants.X_OK)

// Read the binary, not the config. A typo or a builder regression must fail on
// what will actually execute. The policy also names every fuse known to the
// pinned @electron/fuses version, so an Electron upgrade cannot add one unseen.
const currentFuses = await getCurrentFuseWire(executable)
const knownFuseNames = Object.values(FuseV1Options).filter((value) => typeof value === 'string')
if (
  knownFuseNames.length !== Object.keys(expectedFuses).length ||
  knownFuseNames.some((name) => !(name in expectedFuses))
) {
  throw new Error(
    `Electron fuse policy is incomplete: package knows ${knownFuseNames.join(', ')}, ` +
      `policy knows ${Object.keys(expectedFuses).join(', ')}`
  )
}
for (const [name, enabled] of Object.entries(expectedFuses)) {
  const option = FuseV1Options[name]
  const expected = enabled ? FuseState.ENABLE : FuseState.DISABLE
  if (currentFuses[option] !== expected) {
    throw new Error(
      `Packaged Electron fuse ${name} is ${currentFuses[option] === FuseState.ENABLE ? 'enabled' : 'disabled'}; ` +
        `expected ${enabled ? 'enabled' : 'disabled'}`
    )
  }
}
console.log(`Packaged Electron fuses: ${knownFuseNames.length}/${knownFuseNames.length} intentional states verified`)

const asarPath = path.join(resources, 'app.asar')
// asar builds its listing with path.join, so on Windows the entries come back
// backslash-separated even though the archive's own separator is always '/'.
const entries = new Set(listPackage(asarPath).map((entry) => entry.split(path.sep).join('/')))
for (const required of [
  '/out/main/index.js',
  '/out/preload/index.js',
  '/out/mcp-server.cjs',
  '/out/renderer/index.html',
  '/out/renderer/pdfjs/wasm/openjpeg.wasm',
  // Without the worker PDF.js falls back to a main-thread "fake worker" that
  // needs the same file, so a missing one renders nothing at all.
  '/out/renderer/pdfjs/pdf.worker.min.mjs',
  '/out/renderer/ui-fonts/Inter-Regular.woff2',
  '/out/renderer/ui-fonts/Inter-SemiBold.woff2',
  '/out/renderer/ui-fonts/JetBrainsMono-Regular.woff2',
  '/out/renderer/ui-fonts/JetBrainsMono-Bold.woff2',
  '/out/renderer/ui-fonts/OFL.md'
]) {
  if (!entries.has(required)) throw new Error(`Packaged app is missing ${required}`)
}
for (const forbidden of ['/out/verify-model.cjs', '/out/verify-persistence.cjs', '/out/mcp-bridge.cjs']) {
  if (entries.has(forbidden)) throw new Error(`Packaged app contains stale test output ${forbidden}`)
}
for (const legal of [
  'LICENSE.txt',
  'COPYRIGHT.md',
  'THIRD-PARTY-NOTICES.md',
  'THIRD-PARTY-LICENSES.txt',
  'LICENSE.electron.txt',
  'LICENSES.chromium.html',
  'npm-sbom.cdx.json',
  'python-environment.json'
]) {
  await access(path.join(resources, legal))
}
const licenses = await readFile(path.join(resources, 'THIRD-PARTY-LICENSES.txt'), 'utf8')
for (const dependency of [
  'NODE PACKAGE: react@',
  'NODE PACKAGE: pdfjs-dist@',
  'NODE PACKAGE: proper-lockfile@',
  'PYTHON PACKAGE: pikepdf@'
]) {
  if (!licenses.includes(dependency)) {
    throw new Error(`Packaged third-party license bundle is missing ${dependency}`)
  }
}
if (process.platform === 'darwin') {
  const plist = path.join(packagedRoot, 'Contents', 'Info.plist')
  const printed = spawnSync('/usr/bin/plutil', ['-p', plist], { encoding: 'utf8' })
  if (printed.status !== 0) throw new Error(`Could not inspect packaged Info.plist: ${printed.stderr}`)
  for (const forbidden of [
    'NSAllowsArbitraryLoads',
    'NSAllowsLocalNetworking',
    'NSAudioCaptureUsageDescription',
    'NSBluetoothAlwaysUsageDescription',
    'NSBluetoothPeripheralUsageDescription',
    'NSCameraUsageDescription',
    'NSMicrophoneUsageDescription'
  ]) {
    if (printed.stdout.includes(forbidden)) {
      throw new Error(`Packaged Info.plist declares unused capability ${forbidden}`)
    }
  }
}

function runPackaged(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env: {
        ...process.env,
        ELECTRON_ENABLE_LOGGING: '1',
        WPT_PACKAGE_SMOKE_USERDATA: smokeUserData,
        ...env
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    const timer = setTimeout(() => {
      child.kill()
      reject(
        new Error(
          `Packaged app smoke timed out\nstdout:\n${stdout.trim()}\nstderr:\n${stderr.trim()}`
        )
      )
    }, 20_000)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

// build/ is gitignored, so it does not exist on a clean checkout. The report,
// the screenshot and the exported binder all land here; without this the
// writes fail silently and a healthy app reads as a broken one.
await mkdir(path.join(appDir, 'build'), { recursive: true })
await rm(smokeUserData, { recursive: true, force: true })
await rm(smokeReport, { force: true })
const result = await runPackaged(['--wpt-package-smoke'], {
  WPT_PACKAGE_SMOKE_REPORT: smokeReport
})

// On Windows the packaged app is a GUI-subsystem binary and its main-process
// stdout never reaches this pipe — the run exits 0 with both streams empty. The
// report file is the reliable channel; stdout is kept as the fallback so a
// POSIX run still reads the same either way.
const reported = await readFile(smokeReport, 'utf8').catch(() => '')
const health = reported || result.stdout
if (result.code !== 0 || !health.includes('[package-smoke] engine')) {
  // Exit 0 with three empty channels means the smoke branch never ran, not that
  // the engine is unhealthy — so say which channels were empty rather than
  // leaving the next reader to guess the way the last several runs did.
  const built = await readdir(path.join(appDir, 'build')).catch((e) => `unreadable: ${e.code}`)
  throw new Error(
    `Packaged app health check failed (exit ${result.code})\n` +
      `  report file : ${reported ? JSON.stringify(reported) : '(empty or absent)'}\n` +
      `  stdout      : ${result.stdout ? JSON.stringify(result.stdout) : '(empty)'}\n` +
      `  stderr      : ${result.stderr ? JSON.stringify(result.stderr) : '(empty)'}\n` +
      `  build/      : ${JSON.stringify(built)}\n` +
      `  exe         : ${executable}\n` +
      `  All three empty with exit 0 means main quit before the smoke branch —\n` +
      `  the single-instance lock is claimed at module load and does exactly that.`
  )
}
if (!health.includes(`[package-smoke] engine ${packageJson.version} ready`)) {
  throw new Error(
    `Packaged engine version does not match app ${packageJson.version}: ${health.trim()}`
  )
}
console.log(health.trim())

await access(fixture)
await rm(exported, { force: true })
const ui = await runPackaged(['--wpt-package-ui-smoke'], {
  WPT_PACKAGE_SMOKE_OPEN: fixture,
  WPT_PACKAGE_SMOKE_SHOT: screenshot,
  WPT_PACKAGE_SMOKE_EXPORT: exported
})
if (ui.code !== 0) {
  throw new Error(`Packaged UI smoke failed (${ui.code})\n${ui.stdout}\n${ui.stderr}`)
}
if (!ui.stdout.includes('[package-smoke] renderer ledgerpdf://app/index.html')) {
  throw new Error(
    `Packaged renderer did not load from the restricted app protocol\n${ui.stdout}\n${ui.stderr}`
  )
}
// Exit code and a screenshot cannot tell a loaded binder from an empty window:
// a wrong fixture path renders a clear FileNotFoundError in the status bar and
// still exits 0. fixture_a.pdf is three pages from one source, so assert that.
const loaded = ui.stdout.match(/\[package-smoke\] loaded (\d+) pages from (\d+) sources/)
if (!loaded) {
  throw new Error(`Packaged UI never reported what it loaded\n${ui.stdout}\n${ui.stderr}`)
}
if (Number(loaded[1]) !== 3 || Number(loaded[2]) !== 1) {
  throw new Error(
    `Packaged UI loaded ${loaded[1]} pages from ${loaded[2]} sources; expected 3 from 1 (${fixture})\n${ui.stdout}`
  )
}
// The frozen sidecar writing a binder — not the venv Python the rest of the
// suite uses. This is the path that was broken on Windows for every user
// (fsync on a read-only handle) and that no automated check covered, because
// packaged builds used to ignore the export seam entirely.
if (!ui.stdout.includes('[package-smoke] export ok')) {
  throw new Error(`Packaged export did not succeed\n${ui.stdout}\n${ui.stderr}`)
}
const binder = await readFile(exported)
if (binder.length < 1_000 || !binder.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
  throw new Error(`Packaged export did not write a PDF: ${exported} (${binder.length} bytes)`)
}

const png = await readFile(screenshot)
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
if (png.length < 20_000 || !png.subarray(0, 8).equals(pngSignature)) {
  throw new Error(`Packaged UI did not produce a valid screenshot: ${screenshot}`)
}
console.log(
  `Packaged renderer assets, frozen engine, a ${loaded[1]}-page binder in the UI, ` +
    `and a real export through the frozen sidecar: OK (${screenshot})`
)

// ---------------------------------------------------------------------------
// "Pick up where you left off" — clicking a recent binder.
//
// PACKAGED ON PURPOSE, and it cannot be covered in dev. `binder:open` accepts
// any path when `isDev`, so a dev-mode check passes against a shipped app that
// opens a FILE PICKER instead — which is exactly how this surfaced: a recent
// binder was clicked by name and Finder asked the user to locate it again.
//
// The run above just exported a binder, and saving records it in recents, so
// the list is already populated with something real. The renderer clicks the
// top entry through the same openBinder the row does, and the reported page
// count is the assertion — a picker appearing instead leaves it at zero, and
// (with no one to dismiss the dialog) times the run out rather than passing.
{
  const recentUi = await runPackaged(['--wpt-package-ui-smoke'], {
    WPT_PACKAGE_SMOKE_RECENT: '1',
    WPT_PACKAGE_SMOKE_SHOT: path.join(appDir, 'build', 'package-smoke-recent.png')
  })
  if (recentUi.code !== 0) {
    throw new Error(`Packaged recents open failed (${recentUi.code})\n${recentUi.stdout}\n${recentUi.stderr}`)
  }
  const got = recentUi.stdout.match(/\[package-smoke\] loaded (\d+) pages from (\d+) sources/)
  if (!got || Number(got[1]) < 1) {
    throw new Error(
      `Clicking a recent binder in the PACKAGED app opened nothing ` +
        `(${got ? `${got[1]} pages` : 'no report'}). In a shipped build this is the file ` +
        `picker appearing instead of the binder.\n${recentUi.stdout}\n${recentUi.stderr}`
    )
  }
  console.log(`Packaged "Pick up where you left off": opened ${got[1]} pages by clicking a recent — OK`)
}

// ---------------------------------------------------------------------------
// Can the INSTALLED app serve MCP?
//
// This is the claim the README makes to every user — an agent and a person in
// the same binder — and until 2026-08-08 it was reachable only from a source
// checkout. Two things were wrong, and the first hid the second:
//
//   1. out/mcp-server.cjs ships inside app.asar, which plain `node` cannot read,
//      so the documented `claude mcp add ... node <path>` could not launch it.
//      Electron IS node and can read its own asar, so the app binary itself runs
//      it: ELECTRON_RUN_AS_NODE=1 <app> <asar>/out/mcp-server.cjs. No Node
//      install on the machine, and the same command shape on both platforms.
//   2. Once it started, the engine resolver only knew how to find a source tree,
//      so the first real call failed with "could not locate the workpaper
//      engine". An installed build connected and then did nothing useful.
//
// Both are covered here rather than by hand, because the failure mode is a
// feature that connects and then cannot work — which looks like a broken client.
{
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
  const mcpBundle = path.join(asarPath, 'out', 'mcp-server.cjs')
  // Inside the test roots on purpose. The roots gate WRITES as well as reads, so
  // a destination in app/build/ is refused — which is correct, and cost a failed
  // run to notice. The binder therefore lands beside the fixtures it came from.
  const mcpBinder = path.resolve(appDir, '..', 'spike', 'out', 'package-mcp-binder.pdf')
  await rm(mcpBinder, { force: true })

  const client = new Client({ name: 'verify-package', version: '1.0.0' })
  await client.connect(
    new StdioClientTransport({
      command: executable,
      args: [mcpBundle],
      env: {
        ...process.env,
        ...PACKAGE_ACCESS.env,
        ELECTRON_RUN_AS_NODE: '1',
      }
    })
  )
  const mcp = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args })
    return { text: (r.content ?? []).map((c) => c.text ?? '').join('\n'), isError: !!r.isError }
  }

  const tools = await client.listTools()
  if (tools.tools.length < 20) {
    throw new Error(`Packaged MCP handshake returned only ${tools.tools.length} tools`)
  }

  await mcp('binder_new')
  const added = await mcp('binder_add_pdfs', { paths: [fixture] })
  if (added.isError || !/3 page\(s\)/.test(added.text)) {
    throw new Error(`Packaged MCP could not reach the frozen engine: ${added.text}`)
  }

  const saved = await mcp('binder_save', { path: mcpBinder })
  const mcpBytes = await readFile(mcpBinder).catch(() => Buffer.alloc(0))
  if (saved.isError || mcpBytes.length < 1_000 || !mcpBytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
    throw new Error(`Packaged MCP did not write a binder: ${saved.text}`)
  }

  // The §7216 posture has to hold in this mode too. Asserted on "Added 0",
  // not on an error: the tool reports a skipped file rather than failing, so
  // keying on isError would pass whether or not the guard did anything.
  const outsideRoots = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/hosts'
  const refused = await mcp('binder_add_pdfs', { paths: [outsideRoots] })
  if (!/Added 0 file\(s\)/.test(refused.text)) {
    throw new Error(
      `Packaged MCP added a file outside the approved roots — the guard is not holding: ${refused.text}`
    )
  }

  await client.close()
  await rm(mcpBinder, { force: true })
  console.log(
    `Packaged MCP: handshake (${tools.tools.length} tools), a real probe and export through the ` +
      `frozen sidecar, and the roots guard refusing ${outsideRoots}: OK`
  )
}
