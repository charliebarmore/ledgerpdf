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
Exclude an explicitly superseded predecessor from current-year pages by default;
its manifest reason preserves the disposition. If the request calls for retaining
it, label its bookmark SUPERSEDED and do not use it as current-year check evidence.

Compile a fresh editable binder in prior-year section order, adapted for this
year. Use binder_add_section at document boundaries to group imported bookmarks
under section headings; binder_add_bookmark adds an ordinary bookmark and does
not group imported documents. Preserve useful source bookmarks. Check
conversion of multi-sheet/wide workbooks and scans; import success alone does
not establish legibility or completeness. Use current-year labels and periods
when selecting evidence; comparison columns can contain plausible wrong figures.
Plan the section order once. binder_move_pages preserves the selected pages'
existing order; the pageIds array does not specify a new order. Move each section
as a group and verify the resulting order before placing marks or making a cover.
Inspect binder_bookmarks after adding sections: each document should be a child
of the intended section, with its own imported outline retained. Classify from
document contents and instructions, not a generic filename such as receipt.
If extraction/OCR cannot establish the document's purpose and visual inspection
is unavailable, file it under Needs filing and explain the classification decision
in its existing needs-decision input item. Do not guess a business section.

Use binder_foot and binder_tie for requested arithmetic checks. Read the inputs
from the actual pages or cells first; retain both evidence locations and values.
For each figure, call binder_find on its page and use the returned `beside nx`
and `ny` for its tick or tie. Never estimate a figure's position from line order
or choose a convenient blank location for a figure mark. Disambiguate repeated
amounts using the page text and period/column labels. If the correct position
cannot be established, record the check as unchecked. Place calculator tapes
in a verified clear area, keeping them away from source text.
Beside coordinates reserve room for a 24-point mark by default; pass markSize
when using a larger mark. If the tool reports beside unavailable, do not use
the raw text-center coordinate as a substitute.
Record agreement, discrepancy, and inability to check separately. Make findings
specific and actionable. Agent-created checks never constitute human review.

Call binder_record_handoff after assembly/checks and before the cover or first save. Its
inputs are file dispositions with their actual page IDs; checks include outcomes,
quotes, page coordinates, and worksheet/cell references where applicable. Add
the worksheet name in sheet and the bare range (such as B3:B6) in cells. Add
missing requirements as findings with an empty pageIds array. Failed/ambiguous
inputs and non-agreeing checks already create review items: avoid duplicate
findings for the same issue. A resolved duplicate or explicitly superseded file
belongs in the manifest rather than a review note that creates another open item.

For every retained input, supply filing with section, reason, and evidence
containing pageId and a verbatim quote of at least 12 characters from that input's
own pages. The quote must support the business purpose, not merely its file type
or a number. Use the exact section title and explain the interpretation. LedgerPDF
checks the quote against source text/OCR; it does not validate your interpretation.
When that support is unavailable, use section Needs filing, explain why, and
leave evidence empty. Unsupported choices are automatically moved there and
made needs-decision, even if you initially put them under a business section.
Inspect inventory and bookmarks after recording; generate the cover only then.
This v1 verification requires readable evidence in the input itself; a filename,
another document, or an unverified visual assertion cannot substitute for it.
Findings are actionable unresolved work only. Explain retired requirements and
other settled organizing decisions briefly in the cover narrative; adding them
as findings incorrectly asks the human to resolve something already settled.

If an imported image or document has unreadable content, keep its pages and use
an input disposition of needs-decision, naming what the human must inspect.
Use unreadable only for failed imports without pages. Do not add a redundant
unchecked check or page note for that same input issue. Likewise, unresolved version
decisions belong in their input dispositions, without additional page notes.
binder_tie already creates the necessary discrepancy notes; do not add more.
Keep checks scoped to the requested comparisons and footings. When a requested
check is impossible, record unchecked and attach any available source evidence;
do not invent a quote or replace a known page reference with a page ID in prose.

If the server does not offer binder_record_handoff, persist the
input dispositions, requested-check outcomes and limitations in binder_add_cover's
narrative, with notes/open items pointing to relevant evidence. Explicitly state
that this fallback is prose and does not supply a structured check register.
Missing documents and failed imports need a handoff entry even though they have
no binder page. Reference final pages through stable page IDs/tool-generated
references wherever supported; refresh the cover after structural changes.

Write for a reviewer opening the file cold. Aim for one sentence per input
reason and check detail (about 30 words). Keep additional cover narrative within
80 words. The generated cover already includes the manifest, checks and
open items. Use short check labels; let the numeric evidence carry the amounts.
Do not repeat the action log or every comparison column in narrative. State
visual inspection limits once; text extraction is not a visual inspection.

Save the editable binder at the supplied unused destination. Verify inventory,
review queue, and summary, and reopen the saved artifact when supported without
losing the session. Report the output and limitations honestly. Never invent
counts, claim checks that were not performed, silently discard an input, or mark
the result human reviewed. If required evidence cannot be read, leave it unchecked
with the reason. Recompilation of an existing human-edited binder is deferred.
