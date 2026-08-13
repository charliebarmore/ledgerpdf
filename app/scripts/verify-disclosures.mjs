#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const root = path.resolve(appRoot, '..')
const requiredFiles = [
  'DISCLAIMER.md',
  'PRIVACY.md',
  'SUPPORT.md',
  'TERMS.md'
]

const failures = []

async function body(relative) {
  try {
    return await readFile(path.join(root, relative), 'utf8')
  } catch (error) {
    failures.push(`${relative}: ${error.code === 'ENOENT' ? 'missing' : error.message}`)
    return ''
  }
}

function requireMatch(relative, text, pattern, description) {
  if (!pattern.test(text)) failures.push(`${relative}: missing ${description}`)
}

const documents = Object.fromEntries(
  await Promise.all(requiredFiles.map(async (relative) => [relative, await body(relative)]))
)
const readme = await body('README.md')
const exporter = await body('tools/release/prepare-public-tree.sh')

for (const relative of requiredFiles) {
  requireMatch('README.md', readme, new RegExp(`\\(${relative.replace('.', '\\.')}\\)`), `link to ${relative}`)
  requireMatch(
    'tools/release/prepare-public-tree.sh',
    exporter,
    new RegExp(`(?:^|\\s)${relative.replace('.', '\\.')}(?=\\s|$)`, 'm'),
    `${relative} in the public export allowlist`
  )
}

requireMatch('DISCLAIMER.md', documents['DISCLAIMER.md'], /not accounting, tax, legal, investment, audit,[\s\S]*assurance/i, 'professional-advice limitation')
requireMatch('DISCLAIMER.md', documents['DISCLAIMER.md'], /does not create a CPA-client/i, 'no CPA-client relationship statement')
requireMatch('DISCLAIMER.md', documents['DISCLAIMER.md'], /“0 open”[\s\S]*not an assurance/i, 'Review Center limitation')
requireMatch('DISCLAIMER.md', documents['DISCLAIMER.md'], /agent-generated work can be incomplete, inaccurate/i, 'agent-output limitation')
requireMatch('DISCLAIMER.md', documents['DISCLAIMER.md'], /“AS IS” and “WITH ALL FAULTS,”/i, 'as-is warranty language')

requireMatch('PRIVACY.md', documents['PRIVACY.md'], /no Ledger Labs account, hosted binder service,[\s\S]*telemetry/i, 'no-account and no-telemetry statement')
requireMatch('PRIVACY.md', documents['PRIVACY.md'], /does \*\*not\*\* encrypt/i, 'local-file encryption limitation')
requireMatch('PRIVACY.md', documents['PRIVACY.md'], /recent-binder list[\s\S]*complete filesystem paths/i, 'recent-path disclosure')
requireMatch('PRIVACY.md', documents['PRIVACY.md'], /Vercel/i, 'website host disclosure')
requireMatch('PRIVACY.md', documents['PRIVACY.md'], /GitHub/i, 'source and download host disclosure')
requireMatch('PRIVACY.md', documents['PRIVACY.md'], /hosted model provider may receive/i, 'hosted-agent disclosure')

requireMatch('TERMS.md', documents['TERMS.md'], /GPL-3\.0-or-later/i, 'GPL license identifier')
requireMatch('TERMS.md', documents['TERMS.md'], /Nothing in these terms[\s\S]*right that the GPL grants/i, 'GPL rights preservation')
requireMatch('SUPPORT.md', documents['SUPPORT.md'], /Never upload or paste a real client PDF/i, 'client-data support warning')
requireMatch('SUPPORT.md', documents['SUPPORT.md'], /Report a vulnerability/i, 'private vulnerability-reporting direction')

const combined = requiredFiles.map((relative) => documents[relative]).join('\n')
for (const [pattern, label] of [
  [/\bLedgerTB\b/i, 'LedgerTB product language'],
  [/\bMIT licen[cs]e/i, 'MIT license language'],
  [/\bCloudflare\b/i, 'Cloudflare hosting language'],
  [/\bGoogle Fonts\b/i, 'Google Fonts language'],
  [/\bSQLCipher\b/i, 'LedgerTB encryption language']
]) {
  if (pattern.test(combined)) failures.push(`disclosures: unexpected ${label}`)
}

if (failures.length) {
  console.error('Disclosure verification failed:')
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}

console.log('Disclosure verification passed: repository documents are present, tailored, linked, and publicly exportable')
