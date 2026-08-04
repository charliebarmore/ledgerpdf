/**
 * Live agent access: a local socket that lets the MCP server work on the
 * binder the app has open, instead of a private copy.
 *
 * WHY A SOCKET AND NOT HTTP. MCP already works over stdio and is fully tested
 * there, so there is nothing to gain by moving the protocol. Only the session
 * state needs to cross. That makes this channel two verbs — pull and push —
 * rather than an endpoint that speaks arbitrary MCP, which is both far less to
 * get wrong and far less to attack.
 *
 * SECURITY. This opens a listening endpoint in an app that holds client tax
 * documents, so it is deliberately narrow:
 *
 *  - OFF unless the user turns it on. Same default-deny posture as
 *    WPT_MCP_ROOTS; an app that is merely running is not reachable.
 *  - A unix socket (POSIX) or named pipe (Windows) — never a TCP port, so
 *    there is no network surface at all, not even loopback.
 *  - The socket file is chmod 0600, so the OS keeps other accounts out.
 *  - A per-launch 32-byte token must be the first line a client sends. The
 *    endpoint file carrying it is also 0600.
 *  - Two verbs only. A client that authenticates can read and replace the
 *    working binder — it cannot reach the filesystem through this channel.
 *
 * Nothing here reaches the network outbound; the product's local-only claim is
 * unchanged.
 */

import { createServer, type Server as NetServer, type Socket } from 'node:net'
import { randomBytes } from 'node:crypto'
import { chmod, writeFile, rm, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { liveDir, liveEndpointFile } from '../shared/live-endpoint'

export interface LiveHandle {
  socketPath: string
  token: string
  endpointFile: string
}

export interface LiveHooks {
  pull: () => Promise<{ session: unknown; path: string | null }>
  push: (session: unknown) => Promise<void>
}

let server: NetServer | null = null
let handle: LiveHandle | null = null
const open = new Set<Socket>()

export function liveStatus(): LiveHandle | null {
  return handle
}

/** Windows has no filesystem socket; a named pipe is the equivalent. */
function socketPathFor(dir: string): string {
  if (process.platform === 'win32') {
    return path.join('\\\\.\\pipe', `workpaper-binder-${randomBytes(8).toString('hex')}`)
  }
  return path.join(dir, 'live.sock')
}

export async function startLive(hooks: LiveHooks): Promise<LiveHandle> {
  if (handle) return handle

  const dir = liveDir()
  await mkdir(dir, { recursive: true })
  const token = randomBytes(32).toString('hex')
  const socketPath = socketPathFor(dir)
  if (process.platform !== 'win32') await rm(socketPath, { force: true }).catch(() => {})

  server = createServer((socket) => {
    open.add(socket)
    socket.on('close', () => open.delete(socket))
    socket.setEncoding('utf8')

    let authed = false
    let buffer = ''
    const reply = (value: unknown): void => {
      socket.write(`${JSON.stringify(value)}\n`)
    }

    socket.on('data', (chunk: string) => {
      buffer += chunk
      // Newline-delimited JSON. A binder can be megabytes, so a request is not
      // assumed to arrive in one chunk.
      let cut = buffer.indexOf('\n')
      while (cut >= 0) {
        const line = buffer.slice(0, cut)
        buffer = buffer.slice(cut + 1)
        cut = buffer.indexOf('\n')
        if (!line.trim()) continue

        let msg: { id?: number; verb?: string; token?: string; session?: unknown }
        try {
          msg = JSON.parse(line)
        } catch {
          reply({ ok: false, error: 'bad json' })
          socket.end()
          return
        }

        if (!authed) {
          // The token must be the first thing said. Anything else and the
          // connection ends without revealing whether the token was close.
          if (msg.verb !== 'hello' || msg.token !== token) {
            reply({ id: msg.id, ok: false, error: 'unauthorized' })
            socket.end()
            return
          }
          authed = true
          reply({ id: msg.id, ok: true })
          continue
        }

        void (async () => {
          try {
            if (msg.verb === 'pull') {
              const got = await hooks.pull()
              reply({ id: msg.id, ok: true, session: got.session, path: got.path })
            } else if (msg.verb === 'push') {
              await hooks.push(msg.session)
              reply({ id: msg.id, ok: true })
            } else {
              reply({ id: msg.id, ok: false, error: `unknown verb: ${String(msg.verb)}` })
            }
          } catch (error) {
            reply({ id: msg.id, ok: false, error: String((error as Error).message ?? error) })
          }
        })()
      }
    })
    socket.on('error', () => socket.destroy())
  })

  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject)
    server!.listen(socketPath, resolve)
  })
  // Perms after listen: the socket file does not exist until then. Windows
  // named pipes are not files and carry their own ACLs.
  if (process.platform !== 'win32') await chmod(socketPath, 0o600).catch(() => {})

  const endpointFile = liveEndpointFile()
  await writeFile(endpointFile, JSON.stringify({ socketPath, token }, null, 2), { mode: 0o600 })
  await chmod(endpointFile, 0o600).catch(() => {})

  handle = { socketPath, token, endpointFile }
  return handle
}

export async function stopLive(): Promise<void> {
  const current = handle
  handle = null
  for (const socket of open) socket.destroy()
  open.clear()
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = null
  if (current) {
    // Remove the endpoint FIRST: a client that reads it after this point must
    // not be told to dial a socket that is already gone.
    await rm(current.endpointFile, { force: true }).catch(() => {})
    if (process.platform !== 'win32') await rm(current.socketPath, { force: true }).catch(() => {})
  }
}
