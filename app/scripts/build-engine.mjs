import { access, mkdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoDir = path.resolve(appDir, '..')
const engineDir = path.join(repoDir, 'engine')
const buildRoot = path.join(appDir, 'build', 'engine-pyinstaller')
const distRoot = path.join(appDir, 'build', 'engine-sidecar')
const entry = path.join(engineDir, 'workpaper_sidecar.py')
const python =
  process.env.WPT_BUILD_PYTHON ||
  (process.platform === 'win32'
    ? path.join(engineDir, '.venv', 'Scripts', 'python.exe')
    : path.join(engineDir, '.venv', 'bin', 'python'))

function run(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd ?? repoDir,
      env: options.env ?? process.env,
      stdio: options.input === undefined ? 'inherit' : ['pipe', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    if (options.input !== undefined) {
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk) => (stdout += chunk))
      child.stderr.on('data', (chunk) => (stderr += chunk))
      child.stdin.end(options.input)
    }
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${path.basename(executable)} exited ${code}${stderr ? `: ${stderr.trim()}` : ''}`))
    })
  })
}

await access(python, constants.X_OK).catch(() => {
  throw new Error(
    `Packaging Python is missing at ${python}. Install engine/requirements.lock and engine/requirements-build.lock with --require-hashes, or set WPT_BUILD_PYTHON.`
  )
})
const provenance = await run(
  python,
  [
    '-c',
    'import json,platform,sys; print(json.dumps({"executable":sys.executable,"base_prefix":sys.base_prefix,"version":platform.python_version()}))'
  ],
  { input: '' }
)
const pythonInfo = JSON.parse(provenance.stdout)
console.log(
  `Packaging Python ${pythonInfo.version}: ${pythonInfo.executable} (base ${pythonInfo.base_prefix})`
)
if (
  process.env.WPT_SIGNED_RELEASE === 'true' &&
  /(?:^|[\\/])(?:anaconda|miniconda|conda)(?:\d*)?(?:[\\/]|$)/i.test(String(pythonInfo.base_prefix))
) {
  throw new Error(
    'Refusing a signed release from a Conda-derived Python. Use a clean python.org/setup-python 3.12 environment so the frozen runtime has controlled provenance.'
  )
}
await mkdir(buildRoot, { recursive: true })
await mkdir(distRoot, { recursive: true })

await run(
  python,
  [
    '-m',
    'PyInstaller',
    '--noconfirm',
    '--clean',
    '--onedir',
    '--noupx',
    '--name',
    'workpaper-engine',
    '--paths',
    engineDir,
    '--distpath',
    distRoot,
    '--workpath',
    buildRoot,
    '--specpath',
    buildRoot,
    entry
  ],
  {
    cwd: engineDir,
    env: {
      ...process.env,
      // PyInstaller otherwise writes to ~/Library/Application Support on macOS,
      // making builds depend on mutable user state and awkward to sandbox in CI.
      PYINSTALLER_CONFIG_DIR: path.join(appDir, 'build', 'pyinstaller-cache')
    }
  }
)

const executable = path.join(
  distRoot,
  'workpaper-engine',
  process.platform === 'win32' ? 'workpaper-engine.exe' : 'workpaper-engine'
)
await access(executable, constants.X_OK)
const ping = await run(executable, [], { input: `${JSON.stringify({ cmd: 'ping' })}\n` })
const result = JSON.parse(ping.stdout)
if (result.ok !== true || result.engine !== 'workpaper_engine') {
  throw new Error(`Frozen sidecar failed its protocol check: ${ping.stdout.trim()}`)
}
console.log(`Frozen engine ready: ${executable} (${result.version})`)
