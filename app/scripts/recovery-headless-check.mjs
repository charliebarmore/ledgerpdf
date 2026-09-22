/** Linux regression: a launcher exit code is not proof that Electron started. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

assert.equal(process.platform, 'linux', 'this regression check requires Linux')
const env = { ...process.env }
delete env.DISPLAY
delete env.WAYLAND_DISPLAY
const result = spawnSync(process.execPath, ['scripts/recovery-check.mjs'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  env,
  encoding: 'utf8',
  timeout: 360_000,
  maxBuffer: 8 * 1024 * 1024
})
const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
writeFileSync(new URL('../../spike/out/recovery-headless.log', import.meta.url), output)
assert.ifError(result.error)
assert.equal(result.status, 1, `the suite must fail without a display:\n${output}`)
for (const label of ['recovery', 'cancel']) {
  assert.ok(
    output.includes(`[FAIL] ${label} launch reaches the prompt and renders`),
    `${label} must report a failed launch:\n${output}`
  )
}
assert.ok(
  output.includes('[FAIL] Cancel preserves the recovery sibling'),
  `Cancel must not pass when the app never started:\n${output}`
)
assert.doesNotMatch(output, /\[PASS\]/, 'no recovery assertion may pass without the app')
console.log('[PASS] missing display fails both launches and cannot pass Cancel')
