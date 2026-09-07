# Engagement compilation acceptance test

This opt-in test uses only generated synthetic documents. It exercises an
external Claude Code agent using LedgerPDF's MCP tools. It is not part of CI and
does not modify the user's configured agent-folder approvals.

## Reproduce

From the repository root:

```sh
engine/.venv/bin/python spike/make_engagement.py
cd app
npm run build:mcp
node scripts/engagement-agent-check.mjs my-run
cd ..
engine/.venv/bin/python spike/verify_engagement.py spike/out/engagement-acceptance/my-run
```

Use a unique run name. Generation replaces only the synthetic input directory;
do not regenerate it while a run is active. The runner requires an existing
Claude Code login, permits MCP tool discovery and LedgerPDF tools, and disables
shell and filesystem tools. It caps each run at $5 and 12 minutes, uses only its
specified MCP configuration, and writes transcript, prompt, execution result,
and any generated binder under the run directory. The external MCP server has
an isolated test profile approving only the synthetic inputs and that output
directory. The hidden answer key is outside its approved scope.

MCP tools connect lazily in current Claude Code; the runner explicitly enables
ToolSearch. See the [official MCP documentation](https://code.claude.com/docs/en/mcp).
Running the CLI in a restricted shell may prevent access to its existing login
or network connection. A runner failure before tools/model execution is separate
from a compilation failure. Never record either as a passing acceptance test.

The reusable instructions are in
[skills/ledgerpdf-compile/SKILL.md](../skills/ledgerpdf-compile/SKILL.md). For a
normal Claude Code project, install that folder under `.claude/skills/`; the
test runner supplies the same instructions directly to keep the run isolated.

## Packet and answer key

The packet contains 12 current-year inputs and a five-section prior-year master.
It includes text PDFs, a two-sheet wide workbook, a Markdown memo, a receipt
photo, duplicate receipts support, explicitly corrected bank interest, two
unapproved fee estimates, a damaged PDF, and an unsupported archive. Current-year
instructions retire last year's debt requirement and introduce a missing lease
statement. The hidden answer key records hashes, inclusion expectations, and
the exact amounts for four checks.

All source PDFs and images identify themselves as synthetic. There is no
personal data, live client, or real tax conclusion in the packet. Generated
files and run outputs are gitignored; generators, instructions, and the verifier
are committed so the case can be reproduced.

## Required manual review

The automated verifier checks structural facts and selected artifact evidence.
It does not establish successful preparation by itself. A reviewer should inspect
the PDF without the agent transcript, using the answer key only to score it:

- Does section order follow the prior-year reference with sensible current-year
  adaptation? Is last year's master excluded from current-year support?
- Does every input have an accurate reason for inclusion, exclusion, or deferral?
  Are the unapproved fee estimates clearly unresolved rather than silently chosen?
- Do receipts tie at 125,000, interest tie at 450, and expenses foot to 30,000?
  Does the 500 difference against the return's 30,500 remain an open finding?
- Are checks attached to the correct current-year figures, rather than prior-year
  comparison values? Are page locations and worksheet/cell references correct?
- Is the lease statement missing because the instructions require it? Is the
  retired Maple loan handled without a false missing-document claim?
- Is the receipt amount described as unreadable? Are damaged/unsupported files
  visible in the handoff even though they have no binder pages?
- Is every converted page legible, including the workbook's rightmost evidence
  column? Are marks/tapes clear of source figures? Do bookmarks and links work?
- Can the saved master reopen with editable marks and an intact handoff? Does
  agent work remain distinct from human review?

Record human setup, orientation, review and correction time separately from
agent elapsed time. A single packet/run establishes a baseline, not general
accuracy or user preference. Recompilation after human edits is deferred.

## Run results

### September 5, 2026

| Run | Result | Evidence |
| --- | --- | --- |
| `baseline-tools` | Failed acceptance | Finished in 373 seconds, 58 turns; reported cost $1.68. Produced a 16-page editable master. 36/38 automated artifact checks passed. |
| `handoff-v1` | Incomplete; failed acceptance | Stopped at the 12-minute limit before saving a master. All 12 inputs and the prior-year reference remained unchanged. |

The baseline got the four arithmetic outcomes right, preserved both unapproved
fee versions, and included the wide worksheet's rightmost evidence. But all six
tie marks missed their source figures. Rendering the return confirmed the marks
sat below the amounts. The missing lease and damaged-file issue lived in prose,
without a durable compilation record or corresponding missing-document queue
items. The six-page cover repeated too much action history. The receipt photo was
filed under Income, and the agent claimed visual legibility after text extraction.
These defects outweigh the passing mechanical checks.

The second run used explicit `binder_find` coordinate instructions and did call
that tool before making ties. It spent its remaining time arranging pages and
never reached handoff recording or save. There is no saved artifact on which to
claim that placement or handoff quality improved. Local execution was unusually
slow during this run; an earlier MCP integration attempt also timed out. The
subsequent integration retry passed all 148 checks. This does not establish why
the autonomous run timed out.

Implemented in response: a validated binder-owned handoff, missing-document queue
items, actual source hashes, save/reopen coverage, a shorter compilation summary,
and stricter evidence-location instructions. The integration tests verify these
mechanisms; at this stage an autonomous acceptance pass was still outstanding.
The follow-up below establishes completion and artifact correctness, with
remaining filing and usability limitations. Human timings were not collected.

New saves use embedded session format v4. Existing v1-v3 binders open in this
source build; the installed v0.3.1 app cannot open v4 editable binders. No release
or installed-app update was performed as part of this test.

Implementation validation passed: typecheck; 318 model checks; 148 MCP checks;
17 persistence checks; 5 recovery checks; 68 text-position checks; 40 UI smoke
checks; 4 closed-window checks; 18 live-agent checks; and PDFium/Poppler mark
conformance. Release configuration, disclosures, security, teardown, icon, and
skill validation also passed. The combined verification command initially stopped
at recovery after Electron process crashes; recovery and the remaining suites
passed when rerun sequentially. This is a passing set of checks after retries,
not a clean uninterrupted full-suite run.
The saved integration binder was also opened in an isolated development window:
both findings without pages appeared in Review, alongside the Compilation tab
and four pages without review status. Its generated cover was rendered and
visually inspected. The public-tree export validator passed.

Test-run transcripts and credentials are not source documentation and are not
published. Generated binders are local test artifacts, not reference masters.

### Follow-up: September 5, 2026 (local time)

Five further blind compilations used the same unchanged synthetic packet. The
agent received the reusable skill and MCP access, without the hidden answer key.
The verifier was strengthened as rendered artifacts exposed defects; historical
check totals above describe the verifier used at that time.

| Run | Result | Observation |
| --- | --- | --- |
| `acceptance-v2` | Failed visual acceptance | 272 seconds; 13 pages. Tie marks overlapped amounts; the cover was four pages and included redundant review work. |
| `acceptance-v3` | Failed visual acceptance | 194 seconds; 12 pages. Handoff improved, but all six tie marks still overlapped source text. |
| `acceptance-v4` | Failed visual acceptance | 204 seconds; 13 pages. Marks cleared text but touched adjacent marks; the footing stamp was covered by its tape. A retained superseded statement lacked a clear bookmark label. |
| `acceptance-v5` | Failed visual acceptance | 210 seconds; 11 pages. Compact ties and a two-page handoff worked. The footing stamp remained hidden; the final verifier rejects this artifact. |
| `acceptance-v6` | Automated artifact pass; human trial candidate | 187 seconds; reported cost $1.03. Eleven pages, including a two-page handoff. All 68 artifact checks passed. Filing and presentation corrections remain below. |

The final binder preserves all 12 input dispositions, four requested checks,
seven compilation review items, seven editable marks, and one calculator tape.
Receipts agree at 125,000; corrected interest agrees at 450; expenses foot to
30,000 and remain discrepant against the return's 30,500. The missing lease,
unapproved fee versions, unreadable receipt, damaged PDF, and unsupported archive
remain visible to the reviewer. The retired loan creates no false missing item.
All original input hashes remain unchanged; no page is human reviewed.

All eleven PDF pages were rendered with Poppler and visually inspected. Source
amounts remain clear, adjacent marks are distinct, the footing stamp is visible,
and the wide worksheet retains its rightmost evidence column. Current-year
figures and worksheet rows agree with the recorded checks. A separate isolated
development window reopened the saved master without the agent conversation:
Review showed seven compilation items plus two page flags, zero resolved items,
and nine pages without review status. These are counts of records/pages, not
nine independent business decisions.

Remaining manual findings prevent treating this as a polished final master:

- The receipt visibly says office supplies but is filed before the Expenses
  section, under Income. Its amount is correctly unresolved; its filing needs
  correction. The compiling agent disclosed that it used text extraction/OCR
  only and had not visually inspected the image.
- Section bookmarks appear in the correct order, but file bookmarks are flat
  siblings rather than a clean section hierarchy. The verifier checks section
  order, not every document's semantic classification or section counts.
- The cover repeats the worksheet name in references such as
  `Expenses!Expenses!B6`. The intended sheet/cells are identifiable, but the
  presentation needs cleanup. The narrative also exceeds the skill's target.

Implemented fixes reserve space for the entire mark and nearby text, return no
placement when nearby space is unavailable, use compact 14-point automatic ties
with matching link areas, and position footing stamps outside their tape's actual
height. The cover now points to page flags instead of repeating every note.
Compilation instructions reduce duplicate review work and clarify unresolved
inputs, supersession, page ordering, and limits of text-only inspection.

The independent verifier now checks source hashes, manifest coverage,
evidence provenance, section order, mark/text and mark/mark overlap, and visible
footing stamps. A prior-year reference may optionally appear as a hashed excluded
manifest entry. A superseded original may be retained only if its actual bookmark
identifies it as superseded and no current-year check uses it. These alternatives
honor the packet instructions without requiring one particular agent strategy.
Six deliberately corrupted handoffs were also rejected: missing input, duplicate
input, wrong hash, wrong evidence source, missing evidence page, and false retired
loan finding. Presence checks do not establish semantic correctness; visual review
remains required.

Final validation passed in one uninterrupted `npm run verify`: typecheck, 324
model checks, 153 MCP checks, 17 persistence checks, 5 recovery checks, 68 text
checks, 40 UI smoke checks, 4 closed-window checks, and 18 live-agent checks,
plus release configuration, disclosures, security, teardown, and icon checks.
`npm run verify:viewers` passed PDFium and Poppler conformance. Skill validation
and whitespace checks also passed.

The next acceptance step is a timed practitioner review of this saved candidate:
find the first actionable issue, navigate to its evidence, correct the filing,
and resolve one item. Record orientation and correction time separately. This
single tuned packet demonstrates a working preparation path, not general agent
accuracy, repeatability on unseen engagements, or satisfactory daily UX. No new
release or installed-app update was performed during this follow-up.

### September 7, 2026: filing and navigation

The follow-up adds `binder_add_section`: a section divider wraps the existing
document bookmarks until the next divider, preserving imported child outlines.
Sections start at document boundaries, reject duplicate starts and boundaries
that split an imported bookmark tree, and travel with their pages. Removing a
divider leaves its documents intact. This is a model capability as well as an
MCP tool; ordinary user bookmarks previously could not group imported roots.

Section metadata requires session format v5. This development build reads
v1-v4 binders, while earlier builds refuse its new editable saves. Source
outlines, source files, and physical page order are unchanged by grouping.
Saved PDFs carry the nested outline, which survives reopening without originals.
Review and generated covers now share a worksheet-reference formatter so both
bare ranges and already-qualified references display their sheet name once.
The original evidence record remains unchanged.

The compilation skill now calls the section tool and verifies the resulting
tree. A document whose purpose cannot be established from extraction/OCR goes
under Needs filing with its existing input review item explaining the limitation;
it is not assigned a business section from a generic filename. This provides an
honest handoff when the configured tools cannot inspect images visually.

Verifier version 3 adds nested-section and physical-filing checks. Applied to a
temporary copy of `acceptance-v6`, it passes 68/70 checks and rejects precisely
the two known defects: flat headings and the receipt under Income (8/9 source
pages correctly filed). Historical run artifacts and their original reports
were preserved. An explicitly unfiled receipt is allowed; its amount must still
remain unresolved with a page-linked review item.

Implementation validation passed: the full `npm run verify` suite, including
334 model checks and 156 MCP checks; PDFium/Poppler conformance; skill validation;
and whitespace checks. A final regression confirming that agent sections can be
reverted brings the model suite to 335 passing checks. New coverage exercises section grouping,
imported nesting, document spans, moving a section, invalid boundaries,
attribution, deletion, session serialization, actual PDF save/reopen, and
bare/qualified/quoted worksheet references.

One fresh blind run, `sections-v1`, completed in 432 seconds (60 turns; reported
cost $1.89). It produced eleven pages with a two-page handoff, four checks, and
seven compilation items. **69/70 artifact checks passed; acceptance still fails
on filing.** The agent used the section tool and produced the correct nested
outline, but again placed the office-supplies receipt under Income. Its review
item flags the unreadable amount without acknowledging uncertain classification;
the new Needs filing instruction was not followed. No additional autonomous
retries were run, and this result was not relabeled as a pass.

Visual inspection covered the two-page handoff, marked source pages, unreadable
receipt, and wide worksheet. Worksheet references now read `Expenses!B3:B6` and
`Expenses!B6` once, and all six ties and the footing stamp remain clear. A separate
isolated development window reopened the saved PDF with its nested sections,
seven compilation items plus two page flags, and zero resolved items intact.
Input hashes remained unchanged. The earlier candidate and this failed filing
case are retained locally as regression evidence, not finished reference masters.

The section tool and presentation fixes are validated. The next product gap is
accountable document classification: the agent needs to retain evidence for why
each document belongs in a business section, and leave unsupported classifications
explicitly awaiting a decision. This run shows that adding a prose instruction
alone does not reliably enforce that behavior. Practitioner orientation and
correction timings, unseen-packet accuracy, and release packaging remain untested
in this follow-up.

### September 7, 2026: recorded filing evidence

Handoff version 2 records a filing section, business-purpose reason, and verified
source quotations for each retained input. Validation reads the input's own
pages locally, normalizes extraction whitespace, and records source hashes and
text/OCR attribution. A quote must contain at least twelve characters. A quote
from another input, an invented quote, or missing evidence cannot support a
business filing choice. The interpretation of a valid quote is still the
agent's responsibility and remains subject to human review.

Unsupported choices become one needs-decision input and are moved as a group
to a final Needs filing section. If a moved input anchored a business divider,
that divider is retargeted to its remaining documents. Empty dividers are removed;
readable document order, stable page IDs, marks and evidence links are preserved.
The manifest must account for every retained page. Recording must precede the
cover and first save; validation completes before the session is mutated.
Review shows the filing reason and page-linked source quotes, while the cover
shows each input's section. The rejected section proposal remains in the record.

Session format v6 protects the new record. v1-v5 binders and handoff v1 remain
readable; old handoffs are labeled as lacking filing evidence rather than being
treated as verified. This initial validation needs evidence in the input itself
and treats each input as one filing unit; cross-document instructions and
unsupported visual interpretation do not bypass that constraint.

The full local suite passed, including 340 model checks and 162 MCP checks.
Regression cases include missing/invented/foreign-page evidence, wrong section
membership, all inputs awaiting filing, legacy handoffs, and a real MCP replay
that deliberately files an image with an invented quote. That replay verifies
automatic routing, retargeting the original divider, source hashes, and the
persisted review item through actual PDF save/reopen. It is an integration test,
not the autonomous acceptance result. Skill validation and whitespace checks passed.

Verifier version 4 additionally requires persisted filing decisions, supported
filing for readable inputs, independently matching source quotations and hashes,
and an explicitly unresolved receipt classification. It therefore cannot pass
merely by moving every document into Needs filing. The prior `sections-v1`
artifact scores 69/74 under this verifier: its original filing failure plus the
four absent filing-record checks. Its historical artifact and report are unchanged.

The fresh blind `filing-v1` run completed in 437 seconds (50 turns; reported cost
$1.85). **All 74 artifact checks passed.** It produced eleven pages with a
two-page handoff, seven supported input filing decisions, and one unresolved
receipt classification under Needs filing. Four arithmetic checks and seven
compilation review items remain recorded. Fee approval, missing/damaged inputs,
the unreadable receipt, and the expense discrepancy remain human work; no page
was marked human reviewed and all source hashes remained unchanged.

The quote check initially reported a difference between raw PDF character order
and positioned reading order: three title quotes omitted a short separator
hyphen that extraction placed on its own line. The verifier now re-extracts
positioned text from the saved PDF, matching the kind of reading supplied to the
agent, without consulting its transcript. The titles were also inspected against
raw page text; their words were unchanged. This verifies extracted quotations,
not verbatim typography. A valid baseline passed, and four in-memory mutations
were rejected: invented quote, wrong source hash, foreign evidence page, and an
unclassified readable input.

Rendered covers and marked pages were inspected, and a separate isolated app
window reopened the PDF with Needs filing at page 11 and its page-linked review
item intact. Review showed seven compilation items plus two page flags and zero
resolved items. PDFium/Poppler conformance also passed. The cover still has a
cosmetic pagination issue: its input-table header sits at the bottom of page 1
while the rows continue on page 2. This does not invalidate the filing record,
but the candidate is not a polished final report.

The previously failing filing criterion is now satisfied for this synthetic
packet. This is not evidence of general semantic classification accuracy or
practitioner usability. Next, measure a human's orientation, evidence navigation,
filing correction and resolution time, then test an unseen packet. No release
or installed-app update was performed here.
