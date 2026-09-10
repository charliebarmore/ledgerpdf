import { addSectionBookmark, assignBookmarkPage, bookmarkSection, movePages, removeBookmark, type Session } from '../renderer/src/session'
import type { CompilationHandoff } from '../renderer/src/handoff'

type Input = CompilationHandoff['inputs'][number]
export const NEEDS_FILING = 'Needs filing'
const normalize = (value: string): string => value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()

/** Verify provenance, not the agent's semantic interpretation of the quote. */
export async function recordFiling(
  session: Session,
  input: Omit<Input, 'filing'> & { filing?: { section: string; reason: string; evidence: { pageId: string; quote: string }[] } },
  read: (pageId: string) => Promise<{ text: string; source: string }>
): Promise<Input> {
  const { filing, ...base } = input
  if (!input.pageIds.length) return base
  const verified: NonNullable<Input['filing']>['evidence'] = []
  let problem = 'No verifiable evidence of the document’s business purpose was supplied.'
  if (filing && normalize(filing.section) !== normalize(NEEDS_FILING)) {
    for (const evidence of filing.evidence) {
      if (!input.pageIds.includes(evidence.pageId)) {
        problem = 'Filing evidence must come from this input’s own retained pages.'
        continue
      }
      const page = session.pages.find((p) => p.id === evidence.pageId)!
      try {
        const got = await read(page.id)
        const quote = normalize(evidence.quote)
        if (quote.length < 12 || !normalize(got.text).includes(quote)) {
          problem = 'A filing quote could not be verified on this input’s pages.'
          continue
        }
        verified.push({ ...evidence, sourceName: session.sources.find((s) => s.id === page.source)!.name,
          sourcePage: page.index + 1, sourceSha256: input.sha256, method: got.source === 'ocr' ? 'ocr' : 'text' })
      } catch {
        problem = 'The source text needed to verify filing evidence could not be read.'
      }
    }
    if (verified.length && verified.length === filing.evidence.length) {
      const sections = (session.bookmarks ?? []).filter((b) => b.section)
      const target = sections.find((b) => normalize(b.title) === normalize(filing.section))
      if (!target || !input.pageIds.every((id) => bookmarkSection(session, `u:${target.id}`).includes(id))) {
        throw new Error(`The filing section for ${input.path} does not contain all its pages. Arrange the pages and section before recording the handoff.`)
      }
      return { ...base, filing: { ...filing, section: target.title, status: 'supported', evidence: verified } }
    }
  }
  return { ...base, disposition: 'needs-decision', filing: {
    status: 'needs-decision', section: NEEDS_FILING,
    ...(filing ? { proposedSection: filing.section } : {}),
    reason: filing && normalize(filing.section) === normalize(NEEDS_FILING)
      ? filing.reason : `${problem} Confirm the document’s purpose and choose a section.`, evidence: verified
  } }
}

/** Move unresolved documents as a group before the handoff/cover is committed. */
export function routeUnfiled(session: Session, inputs: Input[]): Session {
  const ids = new Set(inputs.filter((input) => input.filing?.status === 'needs-decision').flatMap((input) => input.pageIds))
  if (!ids.size) return session
  let next = session
  for (const section of (session.bookmarks ?? []).filter((b) => b.section)) {
    const key = `u:${section.id}`
    const remaining = bookmarkSection(session, key).filter((id) => !ids.has(id))
    if (normalize(section.title) === normalize(NEEDS_FILING) || !remaining.length) next = removeBookmark(next, key)
    else if (ids.has(section.page)) next = assignBookmarkPage(next, key, remaining[0])
  }
  next = movePages(next, [...ids], next.pages.length)
  const first = next.pages.find((page) => ids.has(page.id))!
  const added = addSectionBookmark(next, first.id, NEEDS_FILING)
  if ('error' in added) throw new Error(`Cannot create Needs filing: ${added.error}`)
  return added.session
}
