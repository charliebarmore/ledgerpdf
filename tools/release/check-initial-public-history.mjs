#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'

// macOS exposes /tmp through the /private/tmp symlink. Compare canonical paths
// so an otherwise valid export is not rejected merely because the caller used
// the conventional spelling.
const root = await realpath(path.resolve(process.argv[2] ?? '.'))
const expectedIdentity = {
  name: 'Charlie Barmore',
  email: '235893792+charliebarmore@users.noreply.github.com'
}
const expectedMessage = 'Initial public release'
const findings = []

function git(args) {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (error) {
    const stderr = error?.stderr?.toString().trim()
    throw new Error(`git ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`)
  }
}

try {
  await lstat(path.join(root, '.git'))
} catch (error) {
  if (error?.code === 'ENOENT') {
    console.error(`Initial-public-history validation failed: ${root} has no .git metadata`)
    process.exit(1)
  }
  throw error
}

const topLevel = path.resolve(git(['rev-parse', '--show-toplevel']).trim())
if (topLevel !== root) {
  findings.push(`repository root is ${topLevel}, not the requested export ${root}`)
}

const commits = Number.parseInt(git(['rev-list', '--all', '--count']).trim(), 10)
if (commits !== 1) findings.push(`public history must contain exactly one commit; found ${commits}`)

const branch = git(['symbolic-ref', '--short', 'HEAD']).trim()
if (branch !== 'main') findings.push(`initial branch must be main; found ${branch || '(detached)'}`)

const localBranches = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
  .split(/\r?\n/)
  .filter(Boolean)
if (localBranches.length !== 1 || localBranches[0] !== 'main') {
  findings.push(`initial history must have only the main branch; found ${localBranches.join(', ') || 'none'}`)
}

const tags = git(['tag', '--list'])
  .split(/\r?\n/)
  .filter(Boolean)
if (tags.length) findings.push(`initial history must not be tagged yet; found ${tags.join(', ')}`)

const headWithParents = git(['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(/\s+/)
if (headWithParents.length !== 1) findings.push('initial public commit must be a root commit with no parent')

const metadata = git(['show', '-s', '--format=%an%x00%ae%x00%cn%x00%ce%x00%B', 'HEAD'])
  .replace(/\r?\n$/, '')
  .split('\0')
const [authorName, authorEmail, committerName, committerEmail, ...messageParts] = metadata
const message = messageParts.join('\0').trim()

if (authorName !== expectedIdentity.name || authorEmail !== expectedIdentity.email) {
  findings.push(`unexpected author identity: ${authorName} <${authorEmail}>`)
}
if (committerName !== expectedIdentity.name || committerEmail !== expectedIdentity.email) {
  findings.push(`unexpected committer identity: ${committerName} <${committerEmail}>`)
}
if (message !== expectedMessage) {
  findings.push(`initial commit message must be exactly "${expectedMessage}"`)
}

const status = git(['status', '--porcelain=v1', '--untracked-files=all']).trim()
if (status) findings.push('public export worktree is not clean')

if (findings.length) {
  console.error('Initial-public-history validation failed:')
  for (const finding of findings) console.error(`  ${finding}`)
  process.exit(1)
}

console.log(
  `Initial-public-history validation passed: one clean main root by ${expectedIdentity.name} ` +
    `<${expectedIdentity.email}> with no tags or metadata trailers`
)
