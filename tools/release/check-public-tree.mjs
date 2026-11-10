#!/usr/bin/env node
import { lstat, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

const args = process.argv.slice(2)
const termsFlag = args.indexOf('--private-terms')
const termsFile = termsFlag >= 0 ? args.splice(termsFlag, 2)[1] : undefined
if (termsFlag >= 0 && !termsFile) {
  console.error('--private-terms requires a file path')
  process.exit(2)
}
const unknown = args.find((arg) => arg.startsWith('--'))
if (unknown || args.length > 1) {
  console.error('usage: check-public-tree.mjs [--private-terms <file>] [root]')
  process.exit(2)
}
const root = path.resolve(args[0] ?? '.')
// Keep aligned with prepare-public-tree.sh. A validator run on a copied tree
// must enforce the same boundary as the exporter, including empty directories.
const publicRoots = new Set([
  '.github', '.gitignore', '.node-version', '.nvmrc',
  'CHANGELOG.md', 'CODE_OF_CONDUCT.md', 'CONTRIBUTING.md', 'COPYRIGHT.md', 'DATA-FLOW.md',
  'DECISIONS.md', 'DESIGN.md', 'DISCLAIMER.md', 'LICENSE', 'PRIVACY.md',
  'README.md', 'RELEASING.md', 'SECURITY.md', 'SUPPORT.md', 'TERMS.md', 'THIRD-PARTY-NOTICES.md',
  'app', 'docs', 'engine', 'skills', 'spike', 'tools'
])
const privateDirectories = new Set(['.agents', '.claude', '.codex', 'internal', 'output', 'tmp'])
const sensitiveFilename = /^(?:\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$|\.(?:key|pem|p12|pfx|keystore|jks|book|ledgerbook|ledgertb|wptsession\.json)$/i
const privateContentTerms = [
  { pattern: /https?:\/\/(?:(?:app|www)\.)?notion\.(?:com|so)\/(?:p\/)?[^\s<>"']*(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\b/i, label: 'private workspace URL' },
  { pattern: /https?:\/\/(?:chatgpt\.com\/(?:c|g|backend-api\/conversations)|claude\.ai\/(?:chat|project))\/[^\s<>"']+/i, label: 'private agent session URL' },
  { pattern: /codex:\/\/(?:threads|tasks)\/[^\s<>"']+/i, label: 'private agent session URL' },
  { pattern: /op:\/\/[^\s<>"']+\/[^\s<>"']+/i, label: 'concrete credential-vault reference' },
  { pattern: /\b(?:vault|keychain)[-_ ](?:item|entry)(?:[-_ ](?:id|name))?\s*[:=]\s*[`"'][^`"'<>]+[`"']/i, label: 'concrete credential-vault identifier' },
  { pattern: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/, label: 'private key material' }
]
const skip = new Set([
  'tools/release/check-public-tree.mjs',
  'tools/release/prepare-public-tree.sh'
])
const privateReferenceAllowlist = new Set([
  '.github/workflows/macos.yml',
  '.github/workflows/windows.yml',
  '.gitignore'
])
// Names that must never appear in the published tree are kept outside it: a
// denylist that ships with the source publishes the very terms it guards. The
// exporter supplies the list with --private-terms and refuses to run without
// it. Each entry is { "pattern": "<regular expression>", "label": "<what to
// report>", "example": "<text the pattern must match>" }. Matching is always
// case-insensitive. The example proves the entry still works after an edit: a
// JSON "\b" is a backspace, not a word boundary, and would otherwise disable
// the term without any error. Neither pattern nor match is ever printed.
const privateRelationshipTerms = []
if (termsFile) {
  let entries
  try {
    entries = JSON.parse(await readFile(termsFile, 'utf8'))
  } catch (error) {
    console.error(`private term list could not be read: ${error.message}`)
    process.exit(2)
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    console.error('private term list must be a non-empty JSON array')
    process.exit(2)
  }
  for (const [index, entry] of entries.entries()) {
    const fail = (reason) => {
      console.error(`private term list entry ${index + 1}: ${reason}`)
      process.exit(2)
    }
    if (
      typeof entry?.pattern !== 'string' || typeof entry?.label !== 'string' ||
      typeof entry?.example !== 'string' || !entry.example
    ) fail('needs a string pattern, label and example')
    if (entry.flags !== undefined) fail('flags are not configurable; matching is always case-insensitive')
    let pattern
    try {
      pattern = new RegExp(entry.pattern, 'i')
    } catch {
      fail('pattern is not a valid regular expression')
    }
    if (!pattern.test(entry.example) || !pattern.test(entry.example.toUpperCase()) || !pattern.test(entry.example.toLowerCase())) {
      fail('pattern does not match its own example')
    }
    privateRelationshipTerms.push({ pattern, label: entry.label })
  }
}
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
    const parts = relative.split('/')
    if (!publicRoots.has(parts[0])) {
      findings.push(`${relative}: root entry is not approved for public export`)
      continue
    }
    if (privateDirectories.has(entry.name.toLowerCase()) && entry.isDirectory()) {
      findings.push(`${relative}: private working directory is not allowed in the public export`)
      continue
    }
    if (sensitiveFilename.test(entry.name)) {
      findings.push(`${relative}: sensitive artifact filename is not allowed in the public export`)
      continue
    }
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
    // Windows evidence can be UTF-16; NUL bytes must not hide text reports.
    let text
    if (body[0] === 0xff && body[1] === 0xfe) text = body.subarray(2).toString('utf16le')
    else if (body[0] === 0xfe && body[1] === 0xff && body.length % 2 === 0) {
      text = Buffer.from(body.subarray(2)).swap16().toString('utf16le')
    } else if (body.includes(0)) {
      if (/\.(?:md|txt|json|ya?ml|log|csv|toml|ini)$/i.test(entry.name)) {
        findings.push(`${relative}: text artifact contains unsupported binary encoding`)
      }
      continue
    } else text = body.toString('utf8')
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
      // workspace roots are personal, though: the Library and Applications
      // folders under a home directory are generic macOS paths that user
      // documentation legitimately names, so the pattern is the roots.
      if (/~[/\\](LedgerLabs|Practice|Projects|Desktop|Documents|Downloads)\b/i.test(line)) {
        findings.push(`${relative}:${index + 1}: personal absolute path`)
      }
      for (const { pattern, label } of [...privateContentTerms, ...privateRelationshipTerms]) {
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
  'Public-tree validation passed: approved roots; no private artifacts, references, identifiers, personal paths, retired release terms, or symlinks' +
    (termsFile
      ? `; ${privateRelationshipTerms.length} private terms checked`
      : '. NOTE: no --private-terms list was supplied, so private names were not checked')
)
