/**
 * The binder's review state, derived from the saved session.
 *
 * This module is deliberately pure and UI-free. The desktop Review Center,
 * send-out preflight, MCP review queue and generated cover must all describe
 * the same binder. Separate counts at those four doors will drift and make a
 * reviewer choose which one to believe.
 */

import {
  agentCreatedItems,
  connectorsUsed,
  coverIsStale,
  revertibleRunItems,
  statusCounts,
  statusDefs,
  statusOf,
  type JournalEntry,
  type Mark,
  type PageStatus,
  type Session,
  type StatusDef
} from './session'

export type ReviewFindingKind = 'note' | 'cross'

export interface ReviewFinding {
  id: string
  kind: ReviewFindingKind
  note?: string
  author?: string
  by?: 'human' | 'agent'
  run?: string
  created?: string
}

export interface ReviewPage {
  pageId: string
  pageNumber: number
  sourceId: string
  sourceName: string
  status: StatusDef | null
  statusRecord: PageStatus | null
  findings: ReviewFinding[]
  /** True means a reviewer status was applied after every finding on the page. */
  resolved: boolean
}

export interface SourceCoverage {
  sourceId: string
  name: string
  expectedPages: number
  includedPages: number
  leftOut: number
  extra: number
  pageNumbers: number[]
}

export interface ConnectorIssue {
  label: string
  kind: 'unpaired' | 'too-many-ends' | 'broken-reference'
  pageIds: string[]
  pageNumbers: number[]
}

export interface ReviewRun {
  run: string
  entries: JournalEntry[]
  pageIds: string[]
  remainingItems: number
  structural: JournalEntry[]
  firstAt?: string
  lastAt?: string
}

export type ReadinessLevel = 'attention' | 'advisory'
export type ReadinessKind =
  | 'open-items'
  | 'connector-integrity'
  | 'stale-cover'
  | 'source-coverage'
  | 'without-status'
  | 'missing-attribution'

export interface ReadinessFinding {
  kind: ReadinessKind
  level: ReadinessLevel
  count: number
  message: string
  pageIds: string[]
}

export interface ReviewSnapshot {
  pageCount: number
  sourceCount: number
  statusDefs: StatusDef[]
  statuses: ReturnType<typeof statusCounts>
  active: ReviewPage[]
  resolved: ReviewPage[]
  sources: SourceCoverage[]
  connectorIssues: ConnectorIssue[]
  coverStale: boolean
  attributionGaps: number
  agentCreatedItems: number
  runs: ReviewRun[]
  readiness: ReadinessFinding[]
}

function parsedTime(value?: string): number | null {
  if (!value) return null
  const n = Date.parse(value)
  return Number.isFinite(n) ? n : null
}

/**
 * Reviewed/N/A resolves observations only when it happened AFTER them.
 *
 * This is what lets a note remain as evidence without remaining an open item.
 * A later agent note becomes active again automatically. Missing/legacy dates
 * stay unresolved rather than pretending the order is known.
 */
function pageResolved(status: StatusDef | null, record: PageStatus | null, findings: ReviewFinding[]): boolean {
  if (!findings.length) return false
  if (status?.id !== 'reviewed' && status?.id !== 'na') return false
  const reviewedAt = parsedTime(record?.at)
  if (reviewedAt === null) return false
  return findings.every((finding) => {
    const foundAt = parsedTime(finding.created)
    return foundAt !== null && reviewedAt >= foundAt
  })
}

export function reviewPages(session: Session): { active: ReviewPage[]; resolved: ReviewPage[] } {
  const active: ReviewPage[] = []
  const resolved: ReviewPage[] = []
  session.pages.forEach((page, index) => {
    const source = session.sources.find((candidate) => candidate.id === page.source)
    const marks = (session.marks ?? []).filter(
      (mark): mark is Mark & { kind: ReviewFindingKind } =>
        mark.page === page.id && (mark.kind === 'note' || mark.kind === 'cross')
    )
    const findings: ReviewFinding[] = marks.map((mark) => ({
      id: mark.id,
      kind: mark.kind,
      ...(mark.note ? { note: mark.note } : {}),
      ...(mark.author ? { author: mark.author } : {}),
      ...(mark.by ? { by: mark.by } : {}),
      ...(mark.run ? { run: mark.run } : {}),
      ...(mark.created ? { created: mark.created } : {})
    }))
    const status = statusOf(session, page.id)
    const statusRecord = session.statuses?.[page.id] ?? null

    // A plain reviewed/N/A page is coverage, not an issue. A plain Open page
    // is still a handoff even if its explanatory note has not been added yet.
    if (!findings.length && status?.id !== 'open') return

    const item: ReviewPage = {
      pageId: page.id,
      pageNumber: index + 1,
      sourceId: page.source,
      sourceName: source?.name ?? '(missing source)',
      status,
      statusRecord,
      findings,
      resolved: pageResolved(status, statusRecord, findings)
    }
    if (item.resolved) resolved.push(item)
    else active.push(item)
  })
  return { active, resolved }
}

export function sourceCoverage(session: Session): SourceCoverage[] {
  return session.sources.map((source) => {
    const pageNumbers = session.pages
      .map((page, index) => (page.source === source.id ? index + 1 : null))
      .filter((n): n is number => n !== null)
    return {
      sourceId: source.id,
      name: source.name,
      expectedPages: source.nPages,
      includedPages: pageNumbers.length,
      leftOut: Math.max(0, source.nPages - pageNumbers.length),
      extra: Math.max(0, pageNumbers.length - source.nPages),
      pageNumbers
    }
  })
}

function reciprocalLinkExists(session: Session, from: string, to: string): boolean {
  return (session.links ?? []).some((link) => link.page === from && link.target === to)
}

export function connectorIssues(session: Session): ConnectorIssue[] {
  const issues: ConnectorIssue[] = []
  const issue = (
    label: string,
    kind: ConnectorIssue['kind'],
    pageIds: string[]
  ): ConnectorIssue => ({
    label,
    kind,
    pageIds,
    pageNumbers: pageIds
      .map((pageId) => session.pages.findIndex((page) => page.id === pageId) + 1)
      .filter((pageNumber) => pageNumber > 0)
  })
  for (const [label, marks] of connectorsUsed(session)) {
    const pageIds = [...new Set(marks.map((mark) => mark.page))]
    if (marks.length === 1) {
      issues.push(issue(label, 'unpaired', pageIds))
      continue
    }
    if (marks.length !== 2) {
      issues.push(issue(label, 'too-many-ends', pageIds))
      continue
    }
    const [a, b] = marks
    if (a.page === b.page) continue
    const intact =
      a.refTarget === b.page &&
      b.refTarget === a.page &&
      reciprocalLinkExists(session, a.page, b.page) &&
      reciprocalLinkExists(session, b.page, a.page)
    if (!intact) issues.push(issue(label, 'broken-reference', pageIds))
  }
  return issues
}

export function reviewRuns(session: Session): ReviewRun[] {
  const journal = session.journal ?? []
  const runOrder: string[] = []
  const seen = new Set<string>()
  const notice = (run?: string): void => {
    if (!run || seen.has(run)) return
    seen.add(run)
    runOrder.push(run)
  }
  // Preserve the existing history view's small "Your changes" group for
  // legacy/non-agent journal entries while keeping agent runs identifiable.
  for (const entry of journal) notice(entry.run ?? 'you')
  for (const item of [
    ...(session.marks ?? []),
    ...(session.tapes ?? []),
    ...(session.shapes ?? []),
    ...(session.links ?? []),
    ...(session.bookmarks ?? [])
  ]) notice(item.run)

  return runOrder
    .map((run) => {
      const entries = journal.filter((entry) =>
        run === 'you' ? !entry.run : entry.run === run
      )
      const pages = new Set<string>()
      for (const item of session.marks ?? []) if (item.run === run) pages.add(item.page)
      for (const item of session.tapes ?? []) if (item.run === run) pages.add(item.page)
      for (const item of session.shapes ?? []) if (item.run === run) pages.add(item.page)
      for (const item of session.links ?? []) {
        if (item.run !== run) continue
        pages.add(item.page)
        pages.add(item.target)
      }
      for (const item of session.bookmarks ?? []) if (item.run === run) pages.add(item.page)
      return {
        run,
        entries,
        pageIds: session.pages.filter((page) => pages.has(page.id)).map((page) => page.id),
        remainingItems: run === 'you' ? 0 : revertibleRunItems(session, run),
        structural: entries.filter((entry) => entry.structural),
        ...(entries[0]?.at ? { firstAt: entries[0].at } : {}),
        ...(entries.at(-1)?.at ? { lastAt: entries.at(-1)!.at } : {})
      }
    })
    .reverse()
}

function attributionGapCount(session: Session): number {
  const empty = (author?: string): boolean => !author?.trim()
  return (
    (session.marks ?? []).filter((item) => empty(item.author)).length +
    (session.tapes ?? []).filter((item) => empty(item.author)).length +
    (session.shapes ?? []).filter((item) => empty(item.author)).length
  )
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

export function reviewSnapshot(session: Session): ReviewSnapshot {
  const pages = reviewPages(session)
  const sources = sourceCoverage(session)
  const connectors = connectorIssues(session)
  const stale = coverIsStale(session)
  const attributionGaps = attributionGapCount(session)
  const statuses = statusCounts(session)
  const readiness: ReadinessFinding[] = []

  if (pages.active.length) {
    readiness.push({
      kind: 'open-items',
      level: 'attention',
      count: pages.active.length,
      message: `${plural(pages.active.length, 'page')} ${pages.active.length === 1 ? 'needs' : 'need'} attention`,
      pageIds: pages.active.map((page) => page.pageId)
    })
  }
  if (connectors.length) {
    readiness.push({
      kind: 'connector-integrity',
      level: 'attention',
      count: connectors.length,
      message: `${plural(connectors.length, 'connector')} incomplete or inconsistent`,
      pageIds: [...new Set(connectors.flatMap((issue) => issue.pageIds))]
    })
  }
  if (stale) {
    readiness.push({
      kind: 'stale-cover',
      level: 'attention',
      count: 1,
      message: 'Cover summary is out of date',
      pageIds: []
    })
  }
  const omitted = sources.reduce((total, source) => total + source.leftOut + source.extra, 0)
  if (omitted) {
    readiness.push({
      kind: 'source-coverage',
      level: 'advisory',
      count: omitted,
      message: `${plural(omitted, 'source page')} deliberately or accidentally differs from its imported source`,
      pageIds: []
    })
  }
  if (statuses.unset) {
    readiness.push({
      kind: 'without-status',
      level: 'advisory',
      count: statuses.unset,
      message: `${plural(statuses.unset, 'page')} without a review status`,
      pageIds: session.pages.filter((page) => !session.statuses?.[page.id]).map((page) => page.id)
    })
  }
  if (attributionGaps) {
    readiness.push({
      kind: 'missing-attribution',
      level: 'advisory',
      count: attributionGaps,
      message: `${plural(attributionGaps, 'page item')} without reviewer initials`,
      pageIds: [
        ...(session.marks ?? []).filter((item) => !item.author?.trim()).map((item) => item.page),
        ...(session.tapes ?? []).filter((item) => !item.author?.trim()).map((item) => item.page),
        ...(session.shapes ?? []).filter((item) => !item.author?.trim()).map((item) => item.page)
      ]
    })
  }

  return {
    pageCount: session.pages.length,
    sourceCount: session.sources.length,
    statusDefs: statusDefs(session),
    statuses,
    active: pages.active,
    resolved: pages.resolved,
    sources,
    connectorIssues: connectors,
    coverStale: stale,
    attributionGaps,
    agentCreatedItems: agentCreatedItems(session),
    runs: reviewRuns(session),
    readiness
  }
}
