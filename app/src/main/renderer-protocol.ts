import path from 'node:path'

export const RENDERER_SCHEME = 'ledgerpdf'
export const RENDERER_HOST = 'app'
export const RENDERER_ENTRY_URL = `${RENDERER_SCHEME}://${RENDERER_HOST}/index.html`

/**
 * Resolve one renderer request without ever letting URL-controlled text escape
 * the bundled renderer directory.
 *
 * The custom scheme exists specifically to remove Electron's unusually broad
 * `file://` privileges, so this boundary stays deliberately boring: one host,
 * no credentials or ports, no backslashes/NULs, and a path.relative containment
 * check after decoding. Unknown assets are left for net.fetch to report as 404.
 */
export function rendererAssetPath(rendererRoot: string, requestUrl: string): string | null {
  let url: URL
  try {
    url = new URL(requestUrl)
  } catch {
    return null
  }

  if (
    url.protocol !== `${RENDERER_SCHEME}:` ||
    url.hostname !== RENDERER_HOST ||
    url.username ||
    url.password ||
    url.port
  ) {
    return null
  }

  let decoded: string
  try {
    decoded = decodeURIComponent(url.pathname)
  } catch {
    return null
  }
  if (decoded.includes('\\') || decoded.includes('\0')) return null

  const relativeRequest = decoded.replace(/^\/+/, '') || 'index.html'
  if (relativeRequest.split('/').some((segment) => segment === '.' || segment === '..')) {
    return null
  }

  const root = path.resolve(rendererRoot)
  const target = path.resolve(root, relativeRequest)
  const relativeTarget = path.relative(root, target)
  if (
    relativeTarget === '..' ||
    relativeTarget.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeTarget)
  ) {
    return null
  }
  return target
}
