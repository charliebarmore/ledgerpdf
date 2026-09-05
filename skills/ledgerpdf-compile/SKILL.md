---
name: ledgerpdf-compile
description: Compile a fresh LedgerPDF engagement master using a prior-year master and current-year documents, perform requested evidence-backed checks, and hand it to a human reviewer. Use for initial compilation, not updates to a human-edited binder.
---

# Compile an engagement master

Use the connected LedgerPDF MCP server. Obtain the current-year input scope,
prior-year reference, current-year instructions, and an unused output path from
the request. Ask only for information needed to proceed. Existing authorization
applies; this skill does not grant additional folder or provider access.

Read the prior-year outline and relevant contents to establish section order.
Treat current-year instructions as authoritative. Prior-year presence alone
means “unmatched precedent,” not “required and missing.” Never import prior-year
pages as current-year evidence. Inspect the supplied instructions as documents
when necessary, then start a fresh compilation session before assembling output.

Inventory the current-year inputs before importing. Account for every input,
including skipped, unreadable, ambiguous, duplicate, and superseded documents.
Follow explicit supersession evidence; do not select competing versions solely
from names or dates. Keep unresolved versions identifiable for human review.
Only claim an exact duplicate when byte identity is established; otherwise
describe the observed matching contents and uncertainty. Sources remain unchanged.

Compile a fresh editable binder in prior-year section order, adapted for this
year. Preserve useful source bookmarks and add navigable section bookmarks. Check
conversion of multi-sheet/wide workbooks and scans; import success alone does
not establish legibility or completeness. Use current-year labels and periods
when selecting evidence; comparison columns can contain plausible wrong figures.

Use binder_foot and binder_tie for requested arithmetic checks. Read the inputs
from the actual pages or cells first; retain both evidence locations and values.
For each figure, call binder_find on its page and use the returned `beside nx`
and `ny` for its tick or tie. Never estimate a figure's position from line order
or choose a convenient blank location for a figure mark. Disambiguate repeated
amounts using the page text and period/column labels. If the correct position
cannot be established, record the check as unchecked. Place calculator tapes
in a verified clear area, keeping them away from source text.
Record agreement, discrepancy, and inability to check separately. Make findings
specific and actionable. Agent-created checks never constitute human review.

Call binder_record_handoff after assembly/checks and before the first save. Its
inputs are file dispositions with their actual page IDs; checks include outcomes,
quotes, page coordinates, and worksheet/cell references where applicable. Add
missing requirements as findings with an empty pageIds array. Failed/ambiguous
inputs and non-agreeing checks already create review items: avoid duplicate
findings for the same issue. A resolved duplicate or explicitly superseded file
belongs in the manifest rather than a review note that creates another open item.

If the server does not offer binder_record_handoff, persist the
input dispositions, requested-check outcomes and limitations in binder_add_cover's
narrative, with notes/open items pointing to relevant evidence. Explicitly state
that this fallback is prose and does not supply a structured check register.
Missing documents and failed imports need a handoff entry even though they have
no binder page. Reference final pages through stable page IDs/tool-generated
references wherever supported; refresh the cover after structural changes.

Keep any additional cover narrative short: the tool already generates the
manifest, recorded checks and open items. Do not reproduce the full action log
in narrative or call a text-extraction check a visual inspection.

Save the editable binder at the supplied unused destination. Verify inventory,
review queue, and summary, and reopen the saved artifact when supported without
losing the session. Report the output and limitations honestly. Never invent
counts, claim checks that were not performed, silently discard an input, or mark
the result human reviewed. If required evidence cannot be read, leave it unchecked
with the reason. Recompilation of an existing human-edited binder is deferred.
