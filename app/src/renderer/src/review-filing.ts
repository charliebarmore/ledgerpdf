import {
  assignBookmarkPage, bookmarkSection, buildBookmarks, movePages, removeBookmark,
  type Session
} from './session'

export interface FilingSection {
  id: string
  title: string
}

/** A human may choose only an existing section, never invent a new filing tab. */
export function filingSections(session: Session): FilingSection[] {
  return buildBookmarks(session)
    .filter((bookmark) => bookmark.children.length > 0 && bookmark.title !== 'Needs filing')
    .map((bookmark) => ({ id: bookmark.key, title: bookmark.title }))
}

export function recordReviewerFiling(
  session: Session, inputIndex: number, sectionId: string, reason: string, by: string
): { session: Session } | { error: string } {
  const handoff = session.handoff
  if (!handoff || session.activeRun) return { error: 'Finish the agent run before recording a reviewer decision.' }
  const input = handoff.inputs[inputIndex]
  if (!input || input.filing?.status !== 'needs-decision' || !input.pageIds.length) {
    return { error: 'This input does not have a filing decision to make.' }
  }
  if (handoff.filingDecisions?.[String(inputIndex)]) {
    return { error: 'This filing decision has already been recorded.' }
  }
  const cleanReason = reason.trim()
  const reviewer = by.trim()
  if (!cleanReason || !reviewer) return { error: 'Enter a filing reason and your initials.' }
  const target = filingSections(session).find((section) => section.id === sectionId)
  if (!target) return { error: 'Choose an existing filing section.' }
  const inputIds = new Set(input.pageIds)
  if (inputIds.size !== input.pageIds.length ||
    !input.pageIds.every((id) => session.pages.some((page) => page.id === id))) {
    return { error: 'The receipt evidence pages changed; inspect them before filing.' }
  }
  const tree = buildBookmarks(session)
  const source = tree.find((bookmark) => bookmark.title === 'Needs filing' &&
    input.pageIds.every((id) => bookmarkSection(session, bookmark.key).includes(id)))
  if (!source) return { error: 'The input is no longer wholly under Needs filing.' }

  let next = session
  if (source.key.startsWith('u:')) {
    const remaining = bookmarkSection(session, source.key).filter((id) => !inputIds.has(id))
    if (!remaining.length) next = removeBookmark(next, source.key)
    else if (inputIds.has(source.page)) next = assignBookmarkPage(next, source.key, remaining[0])
  }

  const sections = tree.filter((bookmark) => bookmark.children.length > 0)
  const targetAt = sections.findIndex((section) => section.key === target.id)
  if (targetAt < 0) return { error: 'The chosen section is no longer in this binder.' }
  const boundary = sections[targetAt + 1]?.page
  const before = boundary ? next.pages.findIndex((page) => page.id === boundary) : next.pages.length
  next = movePages(next, input.pageIds, before)
  const result: Session = {
    ...next, reviewer, handoff: { ...handoff, filingDecisions: {
      ...(handoff.filingDecisions ?? {}),
      [String(inputIndex)]: { section: target.title, reason: cleanReason, by: reviewer, at: new Date().toISOString() }
    } }
  }
  const filed = new Set(bookmarkSection(result, target.id))
  if (!input.pageIds.every((id) => filed.has(id))) return { error: 'The pages did not land in the chosen section.' }
  return { session: result }
}
