import { rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(appDir, 'out')

// Never let a package inherit a bundle produced by a test or an earlier build.
// The path is derived from this script, not from an environment variable.
await rm(outDir, { recursive: true, force: true })
