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
 * Walk up from wherever this file ended up until we find the engine. Works
 * whether the server runs bundled out of `app/out/` or straight from source,
 * and `WPT_ENGINE_PYTHON` overrides it outright for odd installs.
 */
function findRepoRoot(): string {
  let dir = __dirname
  for (let i = 0; i < 6; i++) {
    if (existsSync(path.join(dir, 'engine', 'workpaper_engine', 'cli.py'))) return dir
    dir = path.dirname(dir)
  }
  throw new Error(
    'could not locate the workpaper engine — expected engine/workpaper_engine/cli.py above ' +
      __dirname
  )
}

export const REPO = findRepoRoot()
export const ENGINE_DIR = path.join(REPO, 'engine')

export function pythonPath(): string {
  const override = process.env.WPT_ENGINE_PYTHON
  if (override) return override
  const venv = path.join(
    ENGINE_DIR,
    '.venv',
    process.platform === 'win32' ? 'Scripts' : 'bin',
    process.platform === 'win32' ? 'python.exe' : 'python'
  )
  return existsSync(venv) ? venv : 'python3'
}

export interface EngineResult {
  ok: boolean
  error?: string
  probe?: unknown
  result?: unknown
}

export function runEngine(command: unknown): Promise<EngineResult> {
  return runJsonCommand<EngineResult>({
    executable: pythonPath(),
    args: ['-m', 'workpaper_engine.cli'],
    cwd: ENGINE_DIR,
    env: restrictedProcessEnv({ PYTHONPATH: ENGINE_DIR }),
    command
  })
}
