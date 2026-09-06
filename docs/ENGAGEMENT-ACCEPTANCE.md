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
