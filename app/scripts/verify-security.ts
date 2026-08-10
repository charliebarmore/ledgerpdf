import assert from 'node:assert/strict'
import path from 'node:path'
import {
  RENDERER_ENTRY_URL,
  rendererAssetPath
} from '../src/main/renderer-protocol'

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
