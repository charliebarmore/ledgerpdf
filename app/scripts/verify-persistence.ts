import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  atomicWriteJson,
  readSessionWithRecovery,
  recoveryPathFor
} from '../src/main/persistence'
import { agentConnectCommand } from '../src/shared/agent-connect'

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wpt-persistence-'))
  const target = path.join(dir, 'engagement.wptsession.json')
  const recovery = recoveryPathFor(target)

  try {
    const first = { formatVersion: 1, seq: 1, note: 'first complete generation' }
    const second = { formatVersion: 1, seq: 2, note: 'latest complete generation' }

    await atomicWriteJson(target, first)
    assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), first)
    assert.equal((await readdir(dir)).some((name) => name.endsWith('.tmp')), false)

    if (process.platform !== 'win32') {
      assert.equal((await stat(target)).mode & 0o077, 0, 'session must not be group/world readable')
    }

    await atomicWriteJson(target, second)
    assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), second)
    assert.deepEqual(JSON.parse(await readFile(recovery, 'utf8')), first)

    // Simulate an interrupted/foreign rewrite of the primary. Opening the
    // engagement must recover the previous complete generation, never crash.
    await writeFile(target, '{"formatVersion":', 'utf8')
    const recovered = await readSessionWithRecovery(target)
    assert.deepEqual(recovered.session, first)
    assert.equal(recovered.recoveredFrom, recovery)
    assert.match(recovered.error ?? '', /primary session was unreadable/i)

    const installed = agentConnectCommand({
      isDev: false,
      runner: 'C:\\Program Files\\LedgerPDF\\LedgerPDF.exe',
      bundle: 'C:\\Program Files\\LedgerPDF\\resources\\app.asar\\out\\mcp-server.cjs'
    })
    assert.match(installed.command, /-e ELECTRON_RUN_AS_NODE=1 --/)
    assert.doesNotMatch(installed.command, /--\s+ELECTRON_RUN_AS_NODE=/)
    assert.match(installed.command, /"C:\\Program Files\\LedgerPDF\\LedgerPDF\.exe"/)

    const source = agentConnectCommand({
      isDev: true,
      runner: 'node',
      bundle: '/repo with spaces/app/out/mcp-server.cjs'
    })
    assert.doesNotMatch(source.command, /ELECTRON_RUN_AS_NODE/)
    assert.match(source.command, /-- node "\/repo with spaces\/app\/out\/mcp-server\.cjs"/)

    console.log('8/8 persistence and registration checks passed')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
