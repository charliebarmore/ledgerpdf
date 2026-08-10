/**
 * The folders an agent is allowed to read, and the one place they are written.
 *
 * ONE definition, imported by the app that writes it and the MCP server that
 * reads it — the same arrangement as live-endpoint.ts, and it lives in the same
 * directory for the same reason: that directory is named independently of the
 * product, so a rename cannot silently orphan it. An agent quietly losing its
 * approved folders would look like a broken tool rather than a moved file.
 *
 * WHY THIS EXISTS AT ALL. Roots used to come only from `WPT_MCP_ROOTS`, an
 * environment variable set when registering the MCP server. That works for one
 * developer and fails for every user: it means hand-editing a JSON config to
 * insert your own absolute paths before an agent can read a single document, and
 * the audience here is accountants. Worse, it made the §7216 decision a thing
 * you paste into a file rather than a thing you choose — with nowhere to see
 * afterwards what you had approved.
 *
 * `WPT_MCP_ROOTS` is still honoured and still wins, because CI and every
 * verification harness set it, and an operator overriding config from the
 * environment is a reasonable thing to be able to do.
 *
 * WHAT THIS IS NOT. It is not a permission system. It is the record of a
 * decision the person made deliberately, in a folder dialog, and can revisit.
 * Everything inside an approved folder is readable by whatever agent the user
 * connects, including page text — which on a 1040 includes the SSN.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { liveDir } from './live-endpoint'

/** Overridable for tests, like WPT_LIVE_ENDPOINT — never for shipped config. */
export function agentRootsFile(): string {
  return process.env.WPT_AGENT_ROOTS_FILE ?? path.join(liveDir(), 'agent-roots.json')
}

interface RootsFile {
  roots?: unknown
}

/**
 * Canonical, absolute, de-duplicated. A root is resolved through realpath so a
 * symlinked approval cannot be used to reach outside itself later — the same
 * containment the request-time guard depends on.
 *
 * A root that no longer exists is KEPT rather than dropped: an unplugged drive
 * or an unmounted share is not a revocation, and silently forgetting an approval
 * would be the wrong way to find out.
 */
export function normalizeRoots(value: unknown): string[] {
  const list = Array.isArray(value) ? value : []
  const out: string[] = []
  for (const entry of list) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim()
    if (!trimmed) continue
    const absolute = path.resolve(trimmed)
    const canonical = existsSync(absolute) ? realpathSync(absolute) : absolute
    if (!out.includes(canonical)) out.push(canonical)
  }
  return out
}

/** Separator-aware containment shared by the MCP server and live app bridge. */
export function isPathInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  )
}

/**
 * The roots in effect. Env wins; otherwise the file the app writes.
 *
 * Read per call rather than cached at module load, so approving a folder in the
 * app takes effect on the agent's NEXT request instead of after restarting the
 * MCP client. Restarting Claude to pick up a folder choice is the kind of
 * friction that makes people widen the roots once and never revisit them.
 */
export function readAgentRootsSync(): string[] {
  const fromEnv = process.env.WPT_MCP_ROOTS
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    return normalizeRoots(fromEnv.split(path.delimiter))
  }
  try {
    // Sync on purpose: the guard that calls this is synchronous, and making it
    // async would mean every path check awaits a file read.
    const raw: unknown = JSON.parse(readFileSync(agentRootsFile(), 'utf8'))
    if (!raw || typeof raw !== 'object') return []
    return normalizeRoots((raw as RootsFile).roots)
  } catch {
    // No file yet, or unreadable. No approvals is the safe answer and the same
    // state a first run is in.
    return []
  }
}

/** Async twin for the app side, which has no reason to block. */
export async function readAgentRoots(): Promise<string[]> {
  try {
    const raw: unknown = JSON.parse(await readFile(agentRootsFile(), 'utf8'))
    if (!raw || typeof raw !== 'object') return []
    return normalizeRoots((raw as RootsFile).roots)
  } catch {
    return []
  }
}

/**
 * Replace the approved list. 0600 like every other file this app owns: the list
 * of folders a firm has opened to an agent is not interesting to other accounts
 * on the machine.
 */
export async function writeAgentRoots(roots: unknown): Promise<string[]> {
  const normalized = normalizeRoots(roots)
  const file = agentRootsFile()
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await writeFile(file, `${JSON.stringify({ roots: normalized }, null, 2)}\n`, { mode: 0o600 })
  // Set explicitly as well as on create: an existing file keeps its old mode.
  await chmod(file, 0o600).catch(() => {})
  return normalized
}
