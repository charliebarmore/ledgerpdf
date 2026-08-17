/**
 * Drive the real crash-recovery prompt path through main + preload + renderer.
 *
 * verify:model creates roundtrip.pdf with an embedded editable session before
 * this check runs. Seed its hidden autosave sibling, recover it in the real app,
 * export what won the prompt, and inspect the resulting binder. Then prove that
 * Cancel releases the binder lease while preserving the recovery evidence.
 */

import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stopApp } from './lib/stop-app.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const APP = path.resolve(here, '..')
const REPO = path.resolve(APP, '..')
const ENGINE = path.join(REPO, 'engine')
const PY = path.join(
  ENGINE,
  '.venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
)
const SOURCE_BINDER = path.join(REPO, 'spike', 'out', 'roundtrip.pdf')
const RECOVER_BINDER = path.join(REPO, 'spike', 'out', 'recovery-check-source.pdf')
const CANCEL_BINDER = path.join(REPO, 'spike', 'out', 'recovery-cancel-source.pdf')
const RECOVERED = path.join(REPO, 'spike', 'out', 'recovery-check.pdf')
const SHOT = path.join(REPO, 'spike', 'out', 'recovery-check.png')
const USERDATA = path.join(REPO, 'spike', 'out', 'userdata-recovery-check')
const SENTINEL = 'Crash recovery sentinel — review note restored'

if (!existsSync(SOURCE_BINDER)) {
  console.error('roundtrip fixture missing — run npm run verify:model first')
  process.exit(1)
}

function recoveryPathFor(binder) {
  const dir = path.dirname(path.resolve(binder))
  return path.join(dir, `.${path.basename(binder, path.extname(binder))}.wpt-recovery.json`)
}

/** Remove a prior test artifact even when Windows marked it hidden. */
function removeArtifact(target) {
  if (!existsSync(target)) return
  if (process.platform === 'win32') {
    spawnSync('attrib', ['-h', '-s', '-r', target], { windowsHide: true, stdio: 'ignore' })
  }
  rmSync(target, { force: true, recursive: true })
}

function engine(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(PY, ['-m', 'workpaper_engine.cli'], {
      cwd: ENGINE,
      env: { ...process.env, PYTHONPATH: ENGINE }
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (data) => (stdout += data))
    child.stderr.on('data', (data) => (stderr += data))
    child.on('error', reject)
    child.on('close', () => {
      try {
        resolve(JSON.parse(stdout.trim()))
      } catch {
        reject(new Error(`engine returned no JSON: ${stderr.slice(0, 400)}`))
      }
    })
    child.stdin.end(JSON.stringify(command))
  })
}

function seedRecovery(binder, session) {
  const recovery = recoveryPathFor(binder)
  const recovered = structuredClone(session)
  recovered.seq = Number(recovered.seq ?? 0) + 1
  recovered.marks = [
    ...(Array.isArray(recovered.marks) ? recovered.marks : []),
    {
      id: `mk_${recovered.seq}`,
      page: recovered.pages[0].id,
      kind: 'note',
      nx: 0.25,
      ny: 0.22,
      size: 18,
      note: SENTINEL,
      author: 'RV',
      created: '2026-08-16T12:00:00.000Z'
    }
  ]
  writeFileSync(
    recovery,
    `${JSON.stringify({ binder, savedAt: '2026-08-16T12:00:00.000Z', session: recovered })}\n`,
    { mode: 0o600 }
  )
  const future = new Date(Date.now() + 2_000)
  utimesSync(recovery, future, future)
}

function runApp(binder, response, label, exportTo) {
  removeArtifact(SHOT)
  removeArtifact(USERDATA)
  return new Promise((resolve) => {
    const child = spawn('npm', ['run', 'dev'], {
      cwd: APP,
      shell: process.platform === 'win32',
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ELECTRON_ENABLE_LOGGING: '1',
        WPT_DEV_USERDATA: USERDATA,
        WPT_DEV_REOPEN: binder,
        WPT_DEV_RECOVERY_RESPONSE: response,
        WPT_DEV_SHOT: SHOT,
        WPT_DEV_EXIT: '1',
        ...(exportTo ? { WPT_DEV_EXPORT: exportTo } : {})
      }
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    child.stdout.on('data', (data) => (stdout += data))
    child.stderr.on('data', (data) => (stderr += data))
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const timer = setTimeout(() => {
      void stopApp(child).then(() =>
        finish({ code: null, stdout, stderr: `${stderr}\n${label} timed out` })
      )
    }, 120_000)
    child.on('close', (code) => {
      clearTimeout(timer)
      finish({ code, stdout, stderr })
    })
  })
}

const opened = await engine({ cmd: 'open_binder', path: SOURCE_BINDER })
if (!opened.ok || !opened.binder?.session) {
  console.error(`could not read roundtrip fixture: ${opened.error ?? 'no embedded session'}`)
  process.exit(1)
}

const checks = []
const check = (name, ok, detail = '') => checks.push([name, !!ok, detail])

for (const artifact of [
  RECOVER_BINDER,
  CANCEL_BINDER,
  recoveryPathFor(RECOVER_BINDER),
  recoveryPathFor(CANCEL_BINDER),
  RECOVERED
]) {
  removeArtifact(artifact)
}
copyFileSync(SOURCE_BINDER, RECOVER_BINDER)
copyFileSync(SOURCE_BINDER, CANCEL_BINDER)

seedRecovery(RECOVER_BINDER, opened.binder.session)
const recoveredRun = await runApp(
  RECOVER_BINDER,
  'recover',
  'recovery launch',
  RECOVERED
)
check(
  'recovery launch exits cleanly',
  recoveredRun.code === 0,
  recoveredRun.stderr.trim() || recoveredRun.stdout.trim()
)
check('recovered binder is exported', existsSync(RECOVERED), RECOVERED)
if (existsSync(RECOVERED)) {
  const recoveredBinder = await engine({ cmd: 'open_binder', path: RECOVERED })
  const notes = recoveredBinder.binder?.session?.marks?.map((mark) => mark.note) ?? []
  check('the autosaved review note wins the prompt', notes.includes(SENTINEL), JSON.stringify(notes))
}

seedRecovery(CANCEL_BINDER, opened.binder.session)
const canceledRun = await runApp(CANCEL_BINDER, 'cancel', 'cancel launch')
check(
  'cancel launch exits cleanly',
  canceledRun.code === 0,
  canceledRun.stderr.trim() || canceledRun.stdout.trim()
)
const canceledRecovery = recoveryPathFor(CANCEL_BINDER)
check(
  'Cancel preserves the recovery sibling',
  existsSync(canceledRecovery),
  canceledRecovery
)

for (const artifact of [
  RECOVER_BINDER,
  CANCEL_BINDER,
  recoveryPathFor(RECOVER_BINDER),
  recoveryPathFor(CANCEL_BINDER),
  SHOT,
  USERDATA
]) {
  removeArtifact(artifact)
}

for (const [name, ok, detail] of checks) {
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? ` — ${detail}` : ''}`)
}
const failed = checks.filter(([, ok]) => !ok)
console.log(`\n${checks.length - failed.length}/${checks.length} recovery checks passed`)
process.exit(failed.length ? 1 : 0)
