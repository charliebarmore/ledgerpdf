#!/usr/bin/env node
import { lstat, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(process.argv[2] ?? '.')
const skip = new Set([
  'tools/release/check-public-tree.mjs',
  'tools/release/prepare-public-tree.sh'
])
const privateReferenceAllowlist = new Set([
  '.github/workflows/macos.yml',
  '.github/workflows/windows.yml',
  '.gitignore'
])
// These phrases disclosed a private client/community relationship in the first
// sanitized history. Keep the terms here, rather than relying on somebody to
// remember the incident during the next export review. The checker itself is
// skipped above so the denylist does not report its own definitions.
const privateRelationshipTerms = [
  { pattern: /\bTCR\b/i, label: 'private community abbreviation' },
  { pattern: /\bcollaboration[\s-]+room\b/i, label: 'private community name' },
  { pattern: /\bdesign[\s-]+partners?\b/i, label: 'private partner relationship' }
]
const retiredReleaseTerms = [
  {
    pattern: /ledgerpdf-win-installer-UNSIGNED/i,
    label: 'retired Windows artifact name; use ledgerpdf-win-installer-ci'
  }
]
const findings = []

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name)
    const relative = path.relative(root, absolute).split(path.sep).join('/')
    // A recurring release is checked inside a clone of the already-public
    // repository. Repository metadata is not part of the exported source tree
    // and can contain binary objects, hooks or local remote configuration.
    if (relative === '.git' || relative.startsWith('.git/')) continue
    const stats = await lstat(absolute)
    if (stats.isSymbolicLink()) {
      findings.push(`${relative}: symbolic links are not allowed in the public export`)
      continue
    }
    if (entry.isDirectory()) {
      await visit(absolute)
      continue
    }
    if (!entry.isFile() || skip.has(relative)) continue
    const body = await readFile(absolute)
    if (body.includes(0)) continue
    const text = body.toString('utf8')
    const lines = text.split(/\r?\n/)
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]
      if (
        !privateReferenceAllowlist.has(relative) &&
        /(?:PROJECT|ROADMAP)\.md|references\/|templates\//.test(line)
      ) {
        findings.push(`${relative}:${index + 1}: reference to a private-only path`)
      }
      if (
        /\/Users\/(?!\.\.\.\/)[^/\s]+\/|[A-Za-z]:\\Users\\(?!\.\.\.\\)[^\\\s]+\\/.test(line)
      ) {
        findings.push(`${relative}:${index + 1}: personal absolute path`)
      }
      // Tilde paths escape the /Users/ pattern above. Only the maintainer's
      // workspace roots are personal, though — ~/Library, ~/Applications and
      // the like are generic macOS paths that user documentation legitimately
      // names, so the pattern is the roots, not the tilde.
      if (/~[/\\](LedgerLabs|Practice|Projects|Desktop|Documents|Downloads)\b/i.test(line)) {
        findings.push(`${relative}:${index + 1}: personal absolute path`)
      }
      for (const { pattern, label } of privateRelationshipTerms) {
        if (pattern.test(line)) {
          findings.push(`${relative}:${index + 1}: possible ${label}`)
        }
      }
      for (const { pattern, label } of retiredReleaseTerms) {
        if (pattern.test(line)) findings.push(`${relative}:${index + 1}: ${label}`)
      }
    }
  }
}

await visit(root)
if (findings.length) {
  console.error('Public-tree validation failed:')
  for (const finding of findings) console.error(`  ${finding}`)
  process.exit(1)
}
console.log(
  'Public-tree validation passed: no private references, relationship terms, personal paths, retired release terms, or symlinks'
)
