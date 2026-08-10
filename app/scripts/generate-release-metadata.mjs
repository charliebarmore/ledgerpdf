import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { commandNeedsShell } from './lib/command-shell.mjs'

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoDir = path.resolve(appDir, '..')
const buildDir = path.join(appDir, 'build')
const pythonLicenseScript = path.join(appDir, 'scripts', 'python-license-inventory.py')
const python = process.env.WPT_BUILD_PYTHON || (
  process.platform === 'win32'
    ? path.join(repoDir, 'engine', '.venv', 'Scripts', 'python.exe')
    : path.join(repoDir, 'engine', '.venv', 'bin', 'python')
)

function capture(command, args, cwd, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      // npm is a .cmd shim on Windows, which Node refuses to launch directly.
      // Keep Python off the shell so its inventory arguments remain literal.
      shell: commandNeedsShell(command),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`${command} exited ${code}: ${stderr.trim()}`))
    })
  })
}

async function nodeLicenseSections(tree) {
  const packages = new Map()
  const visit = (node) => {
    if (node?.name && node?.version && node?.path && node.name !== 'workpaper-tool') {
      packages.set(`${node.name}@${node.version}`, node)
    }
    for (const child of Object.values(node?.dependencies ?? {})) visit(child)
  }
  visit(tree)

  const sections = []
  for (const [key, pkg] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
    const files = (await readdir(pkg.path, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /^(licen[cs]e|copying|notice)(\..*)?$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort()
    const bodies = await Promise.all(files.map((file) => readFile(path.join(pkg.path, file), 'utf8')))
    sections.push(
      [
        `NODE PACKAGE: ${key}`,
        `Declared license: ${pkg.license ?? 'not declared'}`,
        ...(files.length
          ? files.flatMap((file, index) => [`\n--- ${file} ---\n`, bodies[index].trim()])
          : ['License file: not included by the package; see its declared license above.'])
      ].join('\n')
    )
  }
  return sections
}

await mkdir(buildDir, { recursive: true })
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
// Dependency metadata and license texts are Unicode. Windows Python otherwise
// inherits the legacy console code page and can crash while printing valid JSON
// containing (for example) an emoji from a package description.
const pythonUtf8Env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
const [nodeSbom, pythonInventory, npmTreeRaw, pythonLicensesRaw] = await Promise.all([
  capture(npm, ['sbom', '--omit=dev', '--sbom-format', 'cyclonedx'], appDir),
  capture(python, ['-m', 'pip', 'inspect', '--local'], repoDir, pythonUtf8Env),
  capture(npm, ['ls', '--omit=dev', '--all', '--json', '--long'], appDir),
  capture(python, [pythonLicenseScript], repoDir, pythonUtf8Env)
])
const nodeLicenses = await nodeLicenseSections(JSON.parse(npmTreeRaw))
const pythonLicenses = JSON.parse(pythonLicensesRaw)
const licenseBundle = [
  'LedgerPDF third-party license texts',
  'Generated from the exact dependency environments used for this package.',
  '',
  ...nodeLicenses,
  ...pythonLicenses.map((pkg) =>
    [
      `PYTHON PACKAGE: ${pkg.name}@${pkg.version}`,
      `Declared license: ${pkg.license || 'not declared'}`,
      ...(pkg.files.length
        ? pkg.files.flatMap((file) => [`\n--- ${file.path} ---\n`, file.text.trim()])
        : ['License file: not included by the distribution; see its declared license above.'])
    ].join('\n')
  )
].join(`\n\n${'='.repeat(78)}\n\n`) + '\n'
await writeFile(path.join(buildDir, 'npm-sbom.cdx.json'), nodeSbom, 'utf8')
await writeFile(path.join(buildDir, 'python-environment.json'), pythonInventory, 'utf8')
await writeFile(path.join(buildDir, 'THIRD-PARTY-LICENSES.txt'), licenseBundle, 'utf8')
console.log(
  `release metadata -> SBOMs + ${nodeLicenses.length} Node and ${pythonLicenses.length} Python license records`
)
