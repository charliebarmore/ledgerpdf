import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.env.WPT_SIGNED_RELEASE !== 'true') {
  throw new Error(
    'Refusing to create a distributable without signing. Set WPT_SIGNED_RELEASE=true and the platform signing credentials; use npm run package:dir for a local ad-hoc build.'
  )
}

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const builder = path.join(
  appDir,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder'
)
const child = spawn(builder, ['--config', 'electron-builder.config.cjs'], {
  cwd: appDir,
  env: process.env,
  stdio: 'inherit'
})
const code = await new Promise((resolve, reject) => {
  child.once('error', reject)
  child.once('close', resolve)
})
if (code !== 0) throw new Error(`Signed release build failed with exit code ${code}`)
