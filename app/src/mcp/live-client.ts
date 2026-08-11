/**
 * Attaches the stdio MCP server to a running LedgerPDF, when there is
 * one listening.
 *
 * This is what makes "talk to it while you work" true. Without it the agent
 * keeps its own copy of the binder and the session file is the handoff — so
 * with the app open, its autosave silently overwrites whatever the agent wrote.
 * A lost update on an engagement record is not an acceptable failure mode.
 *
 * Falling back is deliberate and silent-safe: if the app is not running, or
 * live access is off, or the endpoint is stale, the server behaves exactly as
 * it always has and works on its own binder. The one thing it must never do is
 * *appear* attached while editing a private copy, which is why the mode is
 * reported in binder_status rather than left to be inferred.
 */

import { readFile } from 'node:fs/promises'
import { connect, type Socket } from 'node:net'
import { liveEndpointFile } from '../shared/live-endpoint'
import type { Session } from '../renderer/src/session'
import type { SessionOwner } from './server'

interface Reply {
  id?: number
  ok?: boolean
  error?: string
  session?: unknown
  path?: string | null
  currentPage?: string | null
  revision?: number
}

const MAX_REPLY_BYTES = 32 * 1024 * 1024

class LiveLink {
  private socket: Socket
  private seq = 0
  private buffer = ''
  private waiting = new Map<number, (r: Reply) => void>()

  constructor(socket: Socket) {
    this.socket = socket
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      this.buffer += chunk
      if (Buffer.byteLength(this.buffer, 'utf8') > MAX_REPLY_BYTES) {
        this.socket.destroy(new Error('live binder response was too large'))
        return
      }
      let cut = this.buffer.indexOf('\n')
      while (cut >= 0) {
        const line = this.buffer.slice(0, cut)
        this.buffer = this.buffer.slice(cut + 1)
        cut = this.buffer.indexOf('\n')
        if (!line.trim()) continue
        try {
          const reply = JSON.parse(line) as Reply
          const resolve = typeof reply.id === 'number' ? this.waiting.get(reply.id) : undefined
          if (resolve) {
            this.waiting.delete(reply.id as number)
            resolve(reply)
          }
        } catch {
          /* a malformed line cannot be matched to a caller; the timeout covers it */
        }
      }
    })
    // A dropped app must fail every in-flight call rather than hang the agent.
    const abandon = (): void => {
      for (const [id, resolve] of this.waiting) {
        this.waiting.delete(id)
        resolve({ ok: false, error: 'the binder window closed' })
      }
    }
    socket.on('close', abandon)
    socket.on('error', abandon)
  }

  send(verb: string, payload: Record<string, unknown> = {}): Promise<Reply> {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        reject(new Error('the binder window did not respond'))
      }, 20_000)
      this.waiting.set(id, (reply) => {
        clearTimeout(timer)
        resolve(reply)
      })
      this.socket.write(`${JSON.stringify({ id, verb, ...payload })}\n`)
    })
  }
}

/**
 * Returns a SessionOwner when a live app answers, or null to stay standalone.
 * Never throws: an agent must still be able to build a binder with the app shut.
 */
export async function attachToRunningApp(): Promise<SessionOwner | null> {
  // Explicit opt-out. Harnesses must be deterministic: without this, spawning
  // the server while any app happens to be running live silently redirects the
  // checks at that app's binder instead of their own.
  if (process.env.WPT_NO_LIVE === '1') return null
  let endpoint: { socketPath: string; token: string }
  try {
    endpoint = JSON.parse(await readFile(liveEndpointFile(), 'utf8'))
  } catch {
    return null
  }

  let link: LiveLink
  try {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = connect(endpoint.socketPath)
      // A stale endpoint file — app crashed, socket gone — must not wedge boot.
      const timer = setTimeout(() => {
        s.destroy()
        reject(new Error('timed out'))
      }, 2000)
      s.once('connect', () => {
        clearTimeout(timer)
        resolve(s)
      })
      s.once('error', (e) => {
        clearTimeout(timer)
        reject(e)
      })
    })
    socket.unref() // never hold the process open on this alone
    link = new LiveLink(socket)
    const hello = await link.send('hello', { token: endpoint.token })
    if (!hello.ok) return null
  } catch {
    return null
  }

  return {
    pull: async () => {
      const reply = await link.send('pull')
      if (!reply.ok) throw new Error(reply.error ?? 'pull failed')
      return {
        session: reply.session as Session,
        path: reply.path ?? null,
        currentPage: reply.currentPage ?? null,
        revision: reply.revision
      }
    },
    push: async (session, focus, expectedRevision) => {
      // `focus` rides the envelope beside the session, never inside it: the
      // payload stays a pure Session, so an older app that predates following
      // simply ignores the extra key.
      const reply = await link.send('push', {
        session,
        ...(focus ? { focus } : {}),
        ...(typeof expectedRevision === 'number' ? { expectedRevision } : {})
      })
      if (!reply.ok) throw new Error(reply.error ?? 'push failed')
    }
  }
}
