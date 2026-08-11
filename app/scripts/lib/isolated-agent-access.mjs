/**
 * Give a verification process the same approved-folders file production uses,
 * under an isolated synthetic user profile.
 *
 * There is deliberately no production environment variable that injects
 * approved roots. Tests move the OS config home instead, then write the exact
 * file LedgerPDF writes. That keeps the shipped access boundary honest while
 * preventing a test from reading or changing the developer's real approvals.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

export function isolatedAgentAccess(base, roots = []) {
  // Unix-domain sockets have a short platform limit (about 104 bytes on
  // macOS), so nesting the fake home under the repository makes live tests
  // fail before the product is reached. Hash the descriptive caller path into
  // a short temp profile; separate call sites still remain isolated.
  const key = createHash('sha256').update(path.resolve(base)).digest('hex').slice(0, 10)
  const tempRoot = process.platform === 'win32' ? os.tmpdir() : '/tmp'
  const profile = path.join(tempRoot, `wpt-a-${key}`)
  const home = path.join(profile, 'home')
  const appData = path.join(profile, 'appdata')
  const xdg = path.join(profile, 'xdg')
  const configRoot =
    process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support')
      : process.platform === 'win32'
        ? appData
        : xdg
  const rootsFile = path.join(configRoot, 'workpaper-binder', 'agent-roots.json')
  mkdirSync(path.dirname(rootsFile), { recursive: true, mode: 0o700 })
  writeFileSync(rootsFile, `${JSON.stringify({ roots }, null, 2)}\n`, { mode: 0o600 })
  return {
    rootsFile,
    env: {
      HOME: home,
      USERPROFILE: home,
      APPDATA: appData,
      XDG_CONFIG_HOME: xdg
    }
  }
}
