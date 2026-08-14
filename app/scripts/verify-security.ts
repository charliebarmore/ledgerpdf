import assert from 'node:assert/strict'
import path from 'node:path'
import {
  RENDERER_ENTRY_URL,
  rendererAssetPath
} from '../src/main/renderer-protocol'
import { unstableInstallReason } from '../src/shared/agent-connect'
import { argvOpenTarget } from '../src/shared/argv-open'

const root = path.resolve(process.cwd(), 'out', 'renderer')
const inside = (candidate: string | null): boolean => {
  if (!candidate) return false
  const relative = path.relative(root, candidate)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

assert.equal(RENDERER_ENTRY_URL, 'ledgerpdf://app/index.html')
assert.equal(rendererAssetPath(root, 'ledgerpdf://app/'), path.join(root, 'index.html'))
assert.equal(
  rendererAssetPath(root, 'ledgerpdf://app/assets/main.js?v=1'),
  path.join(root, 'assets', 'main.js')
)

for (const refused of [
  'https://app/index.html',
  'ledgerpdf://other/index.html',
  'ledgerpdf://user@app/index.html',
  'ledgerpdf://app:443/index.html',
  'ledgerpdf://app/..%2f..%2fetc/passwd',
  'ledgerpdf://app/%2e%2e%5c%2e%2e%5cWindows%5cwin.ini',
  'ledgerpdf://app/%E0%A4%A'
]) {
  assert.equal(rendererAssetPath(root, refused), null, refused)
}

// WHATWG URL parsing canonicalizes literal and percent-encoded dot segments
// before the handler sees them. They may map to a same-root missing asset, but
// must never become an OS path outside the bundled renderer.
for (const traversal of [
  'ledgerpdf://app/../../etc/passwd',
  'ledgerpdf://app/%2e%2e/%2e%2e/etc/passwd'
]) {
  assert.equal(inside(rendererAssetPath(root, traversal)), true, traversal)
}

console.log('Restricted renderer protocol: origin and path containment checks passed')

// ---- MCP registration must never bake a path that dies with the session.
// A DMG-mounted or Gatekeeper-translocated run registers an absolute path in
// the user's global agent config; when the volume ejects or the app quits,
// the agent reports an uninterpretable ENOENT while LedgerPDF looks healthy.
{
  const dmg = unstableInstallReason(
    '/Volumes/LedgerPDF 0.2.0/LedgerPDF.app/Contents/Resources',
    'darwin'
  )
  assert.ok(dmg && /disk image/i.test(dmg) && /Applications/.test(dmg), String(dmg))
  const transloc = unstableInstallReason(
    '/private/var/folders/ab/xyz/T/AppTranslocation/0000-1111/d/LedgerPDF.app/Contents/Resources',
    'darwin'
  )
  assert.ok(transloc && /Applications/.test(transloc), String(transloc))
  assert.equal(
    unstableInstallReason('/Applications/LedgerPDF.app/Contents/Resources', 'darwin'),
    null
  )
  // Windows installs to a stable per-user location; no false positives there.
  assert.equal(
    unstableInstallReason('C:\\Users\\cb\\AppData\\Local\\LedgerPDF\\resources', 'win32'),
    null
  )
  console.log('Agent connect command: unstable install locations are refused')
}

// ---- The one rule for an OS-delivered file on the command line, cold or
// warm launch. Cold-start Explorer double-click passes the file in this
// process's argv; nothing consumed it, so the app opened empty — and only
// when the app was NOT already running, which is why casual testing passed.
{
  assert.equal(
    argvOpenTarget(['LedgerPDF.exe', 'C:\\Clients\\Binder.PDF']),
    'C:\\Clients\\Binder.PDF'
  )
  assert.equal(argvOpenTarget(['electron', '.', '--inspect=9229']), null)
  assert.equal(argvOpenTarget(['LedgerPDF.exe', '--squirrel-firstrun']), null)
  assert.equal(argvOpenTarget(['LedgerPDF.exe']), null)
  // The executable itself must never be read as the file to open.
  assert.equal(argvOpenTarget(['C:\\apps\\viewer.pdf.exe']), null)
  console.log('Cold-start argv: binder paths are recognized, flags and the exe are not')
}
