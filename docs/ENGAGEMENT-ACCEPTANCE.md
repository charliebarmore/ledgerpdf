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
mechanisms; **an autonomous acceptance pass is still outstanding**. The next run
should establish reliable completion before broader UX work, then measure human
orientation and correction time. Those human timings were not collected here.

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

Test-run transcripts and credentials are not source documentation and are not
published. Generated binders are local test artifacts, not reference masters.
