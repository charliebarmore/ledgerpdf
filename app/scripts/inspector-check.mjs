/** Real inspector -> selection -> persisted binder regression. Synthetic inputs only. */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stopApp } from './lib/stop-app.mjs'
import { buildPython } from './lib/build-python.mjs'
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repo = path.dirname(app)
const root = path.join(repo, 'spike/out')
mkdirSync(root, { recursive: true })
const out = mkdtempSync(path.join(root, 'inspector-check-'))
const steps = [
  'tick@0.4,0.3', 'answer:RV', 'tick@0.5,0.4',
  'inspect:mark:0', 'note:escape-clean', 'note:First note', 'inspect:mark:1', 'assertnote:mark:0=First note',
  'note:Second note', 'note:blur', 'assertnote:mark:1=Second note',
  'note:Discard this', 'note:escape', 'note:escape-clean', 'assertnote:mark:1=Second note',
  'inspect:mark:0', 'note:First note extended', 'note:First note extended again', 'note:blur',
  'inspector:undo', 'assertnote:mark:0=First note', 'fieldnote:First note',
  'inspector:redo', 'assertnote:mark:0=First note extended again', 'fieldnote:First note extended again',
  'note:Local draft', 'externalnote:mark:0=First note extended again', 'fieldnote:First note extended again', 'note:blur',
  'assertnote:mark:0=First note extended again',
  'note:Local draft again', 'externalnote:mark:0=External review', 'note:escape', 'fieldnote:External review',
  'assertnote:mark:0=External review',
  'arm:rect', 'rect@0.1,0.1>0.3,0.2', 'arm:rect', 'rect@0.1,0.4>0.3,0.5',
  'inspect:shape:0', 'note:Shape note', 'inspect:shape:1', 'assertnote:shape:0=Shape note',
  'note:Retained shape note', 'note:blur', 'note:Cancel shape draft', 'note:escape',
  'assertnote:shape:1=Retained shape note',
  'stamp:F', 'keep:text@0.6,0.4', 'inspect:mark:2',
  'input:letters:', 'input:letters:blur', 'assertinput:letters=F',
  'input:letters:GL', 'input:letters:escape', 'assertinput:letters=F',
  'input:author:ab', 'input:author:blur', 'assertinput:author=AB',
  'inspect:shape:1',
  'note:Saved while focused', 'assertnote:shape:1=Saved while focused', 'inspector:save'
].join(';')
const child = spawn('npm', ['run', 'dev'], {
 cwd: app, shell: process.platform === 'win32', detached: process.platform !== 'win32',
 env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1', WPT_DEV_USERDATA: path.join(out, 'userdata'),
 WPT_DEV_OPEN: path.join(repo, 'spike/fixtures/fixture_a.pdf'), WPT_DEV_PLACE: steps,
 WPT_DEV_EXPORT: path.join(out, 'binder.pdf'), WPT_DEV_SHOT: path.join(out, 'window.png'), WPT_DEV_EXIT: '1' },
 stdio: ['ignore', 'pipe', 'pipe']
})
let log = ''
child.stdout.on('data', d => { log += d; process.stdout.write(d) })
child.stderr.on('data', d => {
 log += d; process.stderr.write(d)
 if (String(d).includes('[dev-script]')) void stopApp(child)
})
const result = await new Promise(resolve => {
 const timer = setTimeout(async () => { await stopApp(child); resolve(null) }, 120_000)
 child.on('error', e => { clearTimeout(timer); resolve(String(e)) })
 child.on('close', code => { clearTimeout(timer); resolve(code) })
})
if (result !== 0 || !existsSync(path.join(out, 'binder.pdf')) || log.includes('[dev-script]')) {
 console.error(`FAIL inspector workflow: exit=${result}; evidence=${out}`)
 process.exit(1)
}
const py = buildPython()
const reopened = spawnSync(py, ['-m', 'workpaper_engine.cli'], { cwd: path.join(repo, 'engine'), input: JSON.stringify({ cmd: 'open_binder', path: path.join(out, 'binder.pdf') }), encoding: 'utf8', timeout: 30_000 })
if (reopened.status !== 0 || reopened.error) throw new Error(`Reopen failed: ${reopened.error ?? reopened.stderr}`)
const session = JSON.parse(reopened.stdout).binder?.session
if (JSON.stringify(session?.marks?.map(m => m.note)) !== JSON.stringify(['External review', 'Second note', null]) || JSON.stringify(session?.shapes?.map(s => s.note)) !== JSON.stringify(['Shape note', 'Saved with keyboard focus'])) throw new Error('Persisted inspector notes differ from typed notes')
if (session.marks[2].text !== 'F' || session.marks[2].author !== 'AB') throw new Error('Persisted stamp inputs differ from editor')
console.log(`PASS inspector selection, cancellation, undo/redo and focused save: ${out}`)
