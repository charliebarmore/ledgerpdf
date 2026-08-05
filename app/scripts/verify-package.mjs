import { access, mkdir, readFile, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { listPackage } from '@electron/asar'

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const arch = process.arch === 'arm64' ? 'arm64' : process.arch
const packagedRoot =
  process.platform === 'darwin'
    ? path.join(appDir, 'release', `mac-${arch}`, 'Workpaper Binder.app')
    : path.join(appDir, 'release', 'win-unpacked')
const executable =
  process.platform === 'darwin'
    ? path.join(packagedRoot, 'Contents', 'MacOS', 'Workpaper Binder')
    : path.join(packagedRoot, 'Workpaper Binder.exe')
const resources =
  process.platform === 'darwin'
    ? path.join(packagedRoot, 'Contents', 'Resources')
    : path.join(packagedRoot, 'resources')
const fixture = path.resolve(appDir, '..', 'spike', 'fixtures', 'fixture_a.pdf')
const screenshot = path.join(appDir, 'build', 'package-smoke.png')
const exported = path.join(appDir, 'build', 'package-smoke-binder.pdf')
const smokeReport = path.join(appDir, 'build', 'package-smoke.txt')

await access(executable, constants.X_OK)
const asarPath = path.join(resources, 'app.asar')
// asar builds its listing with path.join, so on Windows the entries come back
// backslash-separated even though the archive's own separator is always '/'.
const entries = new Set(listPackage(asarPath).map((entry) => entry.split(path.sep).join('/')))
for (const required of [
  '/out/main/index.js',
  '/out/preload/index.js',
  '/out/renderer/index.html',
  '/out/renderer/pdfjs/wasm/openjpeg.wasm',
  // Without the worker PDF.js falls back to a main-thread "fake worker" that
  // needs the same file, so a missing one renders nothing at all.
  '/out/renderer/pdfjs/pdf.worker.min.mjs'
]) {
  if (!entries.has(required)) throw new Error(`Packaged app is missing ${required}`)
}

function runPackaged(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1', ...env },
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
  throw new Error(
    `Packaged app health check failed (${result.code})\nreport: ${reported}\n${result.stdout}\n${result.stderr}`
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
