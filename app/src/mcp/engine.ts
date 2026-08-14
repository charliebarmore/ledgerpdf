/**
 * Locating and calling the Python engine from outside Electron.
 *
 * Same JSON-over-stdio protocol the main process uses — one command in, one
 * result out. Kept separate from the Electron main process on purpose: the MCP
 * server is a second front door onto the same engine, not a fork of it.
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import { restrictedProcessEnv, runJsonCommand } from '../shared/json-process'

/**
 * Where the engine is, in both worlds this server runs in.
 *
 * TWO layouts, and only one of them used to be handled. From a source checkout
 * the engine is `engine/workpaper_engine/cli.py` run through the venv. Inside an
 * INSTALLED app there is no checkout and no Python at all: the engine is a
 * frozen PyInstaller sidecar in `Resources/engine`, and this file is bundled
 * inside `app.asar` beside it.
 *
 * Missing the packaged case is why an installed build could not serve MCP. The
 * server started, then failed on its first engine call with "could not locate
 * the workpaper engine" — so the feature the README advertises to every user was
 * reachable only from a clone. Same resolution as `engineCommand()` in the main
 * process; the two are deliberately parallel rather than shared, because the MCP
 * server must not import Electron.
 */
const FROZEN = process.platform === 'win32' ? 'workpaper-engine.exe' : 'workpaper-engine'

function findEngine(): { executable: string; args: string[]; cwd: string; python: boolean } {
  // An explicit interpreter wins outright — the escape hatch for odd installs.
  const override = process.env.WPT_ENGINE_PYTHON
  let dir = __dirname
  for (let i = 0; i < 6; i++) {
    // Frozen sidecar first. In a packaged app BOTH could theoretically match if
    // someone shipped a checkout, and the frozen one is the supported artifact.
    const frozen = path.join(dir, 'engine', FROZEN)
    if (!override && existsSync(frozen)) {
      return { executable: frozen, args: [], cwd: path.join(dir, 'engine'), python: false }
    }
    if (existsSync(path.join(dir, 'engine', 'workpaper_engine', 'cli.py'))) {
      const engineDir = path.join(dir, 'engine')
      const venv = path.join(
        engineDir,
        '.venv',
        process.platform === 'win32' ? 'Scripts' : 'bin',
        process.platform === 'win32' ? 'python.exe' : 'python'
      )
      return {
        executable: override || (existsSync(venv) ? venv : 'python3'),
        args: ['-m', 'workpaper_engine.cli'],
        cwd: engineDir,
        python: true
      }
    }
    dir = path.dirname(dir)
  }
  throw new Error(
    'could not locate the workpaper engine. Looked for a frozen sidecar ' +
      `(engine/${FROZEN}) and a source checkout (engine/workpaper_engine/cli.py) ` +
      `above ${__dirname}. Set WPT_ENGINE_PYTHON to point at an interpreter, or ` +
      'run this from an installed LedgerPDF.'
  )
}

export interface EngineResult {
  ok: boolean
  error?: string
  probe?: unknown
  text?: unknown
  cells?: unknown
  binder?: unknown
  result?: unknown
  warnings?: string
}

export async function runEngine(command: unknown): Promise<EngineResult> {
  // Resolved per call, not at module load: a throw at import time would kill the
  // server before it could answer initialize, so an installed app with a broken
  // engine would look like a broken MCP server rather than a missing engine.
  const engine = findEngine()
  const result = await runJsonCommand<EngineResult>({
    executable: engine.executable,
    args: engine.args,
    cwd: engine.cwd,
    // PYTHONPATH only means anything to a real interpreter. The frozen sidecar
    // carries its own modules, and setting it there has caused import shadowing.
    env: restrictedProcessEnv(engine.python ? { PYTHONPATH: engine.cwd } : {}),
    command
  })
  // An MCP server's stderr reaches the client's log without corrupting the
  // stdio protocol — the one place an engine warning is visible at all.
  if (result.warnings) console.error(`[engine warning] ${result.warnings}`)
  return result
}
