import { spawn } from 'node:child_process'

export function restrictedProcessEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  return { ...env, ...extra }
}

/**
 * Run one JSON-over-stdio sidecar command with bounded time and protocol output.
 * The PDF parser handles untrusted client files outside the renderer sandbox;
 * it must not inherit API keys or be allowed to hang/grow output forever.
 */
export function runJsonCommand<T extends { ok: boolean; error?: string }>(options: {
  executable: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  command: unknown
  timeoutMs?: number
  maxOutputBytes?: number
}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 5 * 60_000
  const maxOutputBytes = options.maxOutputBytes ?? 16 * 1024 * 1024

  return new Promise((resolve) => {
    const child = spawn(options.executable, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let out = ''
    let err = ''
    let outputBytes = 0
    let settled = false

    const finish = (value: T): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const fail = (error: string): void => finish({ ok: false, error } as T)
    const capture = (kind: 'out' | 'err', data: Buffer): void => {
      outputBytes += data.length
      if (outputBytes > maxOutputBytes) {
        child.kill()
        return fail(`engine output exceeded ${Math.round(maxOutputBytes / 1024 / 1024)} MB`)
      }
      if (kind === 'out') out += data.toString('utf8')
      else err += data.toString('utf8')
    }

    const timer = setTimeout(() => {
      child.kill()
      fail(`engine timed out after ${Math.round(timeoutMs / 1000)} seconds`)
    }, timeoutMs)

    child.stdout.on('data', (data: Buffer) => capture('out', data))
    child.stderr.on('data', (data: Buffer) => capture('err', data))
    child.on('error', (error) => fail(`engine failed to start: ${error.message}`))
    child.on('close', () => {
      if (settled) return
      try {
        const parsed = JSON.parse(out.trim()) as T & { warnings?: string }
        // stderr used to be read only when stdout failed to parse, so a
        // dependency's loud, correct warning about data loss (pikepdf's
        // PageCopyWarning on dropped form fields) reached nobody for as long
        // as the call "succeeded". Carry it on the result instead.
        const warned = err.trim()
        if (warned && parsed.warnings === undefined) parsed.warnings = warned.slice(0, 2000)
        finish(parsed)
      } catch {
        fail(`engine returned no JSON: ${(err || out).slice(0, 500)}`)
      }
    })
    child.stdin.on('error', (error) => fail(`engine input failed: ${error.message}`))
    child.stdin.end(JSON.stringify(options.command))
  })
}
