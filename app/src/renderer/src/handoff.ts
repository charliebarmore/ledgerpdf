import { z } from 'zod'
import type { Session } from './session'

const description = z.string().trim().min(1).max(4000)
const pageIds = z.array(z.string().min(1)).max(1000)
const filingEvidenceDraft = z.object({ pageId: z.string().min(1), quote: description }).strict()
export const filingDraft = z.object({
  section: z.string().trim().min(1).max(200),
  reason: description,
  evidence: z.array(filingEvidenceDraft).max(20)
}).strict()
const filingRecord = filingDraft.extend({
  status: z.enum(['supported', 'needs-decision']),
  proposedSection: z.string().optional(),
  evidence: z.array(filingEvidenceDraft.extend({
    sourceName: z.string(), sourcePage: z.number().int().min(1), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    method: z.enum(['text', 'ocr'])
  })).max(20)
}).strict()
export const handoffEvidenceDraft = z.object({
  pageId: z.string().min(1),
  quote: description,
  nx: z.number().min(0).max(1),
  ny: z.number().min(0).max(1),
  sheet: z.string().min(1).max(200).optional().describe('Worksheet name, separate from the cell range'),
  cells: z.string().min(1).max(200).optional().describe('Cell or range only, e.g. B3:B6; put the worksheet name in sheet')
}).strict()
export const handoffInputDraft = z.object({
  path: z.string().min(1),
  disposition: z.enum(['included', 'excluded', 'needs-decision', 'unreadable', 'unsupported']),
  reason: description,
  pageIds,
  filing: filingDraft.optional().describe('For included pages: proposed section, business-purpose reason, and verbatim quotes from this input\'s own pages. Missing or unverifiable evidence routes the input to Needs filing. A filename is not evidence.')
}).strict()
export const handoffCheckDraft = z.object({
  label: description,
  outcome: z.enum(['agrees', 'discrepancy', 'unchecked']),
  detail: description,
  evidence: z.array(handoffEvidenceDraft).max(100)
}).strict().refine((check) => check.outcome === 'unchecked' || check.evidence.length > 0,
  'A performed check needs evidence; otherwise record it as unchecked')
export const handoffFinding = z.object({ label: description, detail: description, pageIds }).strict()
export const handoffDraftShape = {
  inputs: z.array(handoffInputDraft).min(1).max(1000),
  checks: z.array(handoffCheckDraft).max(1000),
  findings: z.array(handoffFinding).max(1000)
}
const sourceEvidence = handoffEvidenceDraft.extend({
  sourceName: z.string().min(1),
  sourcePage: z.number().int().min(1),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/).optional()
})
export const handoffSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  recordedAt: z.string().datetime(),
  by: z.literal('agent'),
  run: z.string().min(1),
  inputs: z.array(handoffInputDraft.extend({ sha256: z.string().regex(/^[a-f0-9]{64}$/), filing: filingRecord.optional() })).min(1).max(1000),
  checks: z.array(z.object({
    label: description, outcome: z.enum(['agrees', 'discrepancy', 'unchecked']),
    detail: description, evidence: z.array(sourceEvidence).max(100)
  }).strict().refine((check) => check.outcome === 'unchecked' || check.evidence.length > 0)).max(1000),
  findings: z.array(handoffFinding).max(1000),
  resolutions: z.record(z.string(), z.object({ by: z.string(), at: z.string().datetime() }).strict())
}).strict().refine((h) => h.version === 1 || h.inputs.every((input) => !input.pageIds.length ||
  (input.filing && (input.filing.status === 'supported'
    ? input.filing.evidence.length > 0 && input.filing.section !== 'Needs filing'
    : input.disposition === 'needs-decision' && input.filing.section === 'Needs filing'))),
  'Every retained input needs a filing decision; supported decisions need evidence')
export type CompilationHandoff = z.infer<typeof handoffSchema>

/** Display both bare and already-qualified references without altering evidence. */
export function evidenceLocation(evidence: { sheet?: string; cells?: string }): string {
  const sheet = evidence.sheet?.trim() ?? ''
  const cells = evidence.cells?.trim() ?? ''
  if (!sheet) return cells
  if (!cells) return sheet
  // A qualified reference may include a quoted sheet name or a workbook name.
  // Preserve it verbatim, including conflicting sheet names, for human review.
  if (cells.includes('!')) {
    const prefix = cells.slice(0, cells.lastIndexOf('!')).replace(/^'|'$/g, '').replace(/''/g, "'")
    return prefix === sheet ? cells : `${sheet} (cell reference: ${cells})`
  }
  const qualifiedSheet = /^[A-Za-z_][A-Za-z0-9_]*$/.test(sheet)
    ? sheet : `'${sheet.replace(/'/g, "''")}'`
  return `${qualifiedSheet}!${cells}`
}
export interface HandoffItem {
  id: string
  label: string
  detail: string
  pageIds: string[]
  resolved: boolean
}

/** The record is a compilation snapshot; resolutions are separate human acts. */
export function handoffItems(session: Session): HandoffItem[] {
  const h = session.handoff
  if (!h) return []
  const items: HandoffItem[] = []
  const add = (id: string, label: string, detail: string, pages: string[]): void => {
    items.push({ id, label, detail, pageIds: pages, resolved: !!h.resolutions[id] })
  }
  h.inputs.forEach((input, i) => {
    if (['needs-decision', 'unreadable', 'unsupported'].includes(input.disposition) || input.filing?.status === 'needs-decision') {
      add(`input:${i}`, `${input.path.split(/[\\/]/).pop()} · ${input.disposition}`,
        input.filing?.status === 'needs-decision' ? `${input.reason} Filing: ${input.filing.reason}` : input.reason, input.pageIds)
    }
  })
  h.checks.forEach((check, i) => {
    if (check.outcome !== 'agrees') add(`check:${i}`, check.label, check.detail, check.evidence.map((e) => e.pageId))
  })
  h.findings.forEach((finding, i) => add(`finding:${i}`, finding.label, finding.detail, finding.pageIds))
  const live = new Set(session.pages.map((page) => page.id))
  const refs = [...h.inputs.map((input) => [...input.pageIds, ...(input.filing?.evidence.map((e) => e.pageId) ?? [])]), ...h.checks.map((check) => check.evidence.map((e) => e.pageId)), ...h.findings.map((f) => f.pageIds)]
  const missing = [...new Set(refs.flat().filter((page) => !live.has(page)))]
  if (missing.length) add(`missing:${missing.join(',')}`, 'Compilation evidence was removed',
    `${missing.length} referenced page(s) are no longer in this binder. Review the compilation record before relying on its checks.`, [])
  return items
}

export function resolveHandoffItem(session: Session, id: string, by: string): Session {
  if (!session.handoff || session.activeRun || !handoffItems(session).some((item) => item.id === id)) return session
  return { ...session, handoff: { ...session.handoff, resolutions: {
    ...session.handoff.resolutions, [id]: { by, at: new Date().toISOString() }
  } } }
}
