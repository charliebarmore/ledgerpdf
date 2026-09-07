# LedgerPDF product decisions

Accepted September 5, 2026. These decisions guide implementation; they do not
claim that the complete workflow has shipped.

## 1. Compile the engagement master for human review

The primary job is to turn an engagement's documents and workpapers into an
organized master file, with an agent assembling it and performing a specified
first pass before a human reviewer opens the binder. Manual annotation and
organization tools support correction and completion of that work.

Compilation complete, agent checks complete, and human review complete are
different states. Absence of flagged findings does not establish completeness.

## 2. External agent execution for the first version

Claude Code runs reusable compilation instructions and calls LedgerPDF's MCP
tools. LedgerPDF remains the local document engine and human review interface;
the desktop app does not call a hosted model. A later in-app launch action may
delegate to an external process without moving model execution into the app.
The connected agent's provider boundary remains as described in PRIVACY.md.

## 3. The binder owns its handoff

The editable PDF is the authoritative artifact for input dispositions, recorded
checks and evidence, findings, and preparation provenance. A rendered summary
and review counts must be derived from those records. A separate system may
index the record later; no ledgerkernel or agent-ledger integration is required
for this first workflow. Agent chat is not required to understand the result.

New structured records require explicit session schema/compatibility support
and save/reopen verification. Do not smuggle unknown fields through the existing
loader or substitute an unverified narrative for recorded evidence.

## 4. Prior-year master as the organizing reference

Start from the prior-year master for section order and precedent. Current-year
instructions override prior-year precedent. A document present last year but
unmatched this year is a question, not automatically a missing requirement.
New activities must be accommodated. Reusable templates and folder-driven
organization are deferred until the first workflow has evidence behind it.

## 5. One-shot compilation into a fresh binder

The first version creates a new candidate at an unused destination. Source files,
the prior-year master, and any human-reviewed binder remain unchanged. Existing
binders can be reviewed and saved normally. Recompilation into a human-edited
binder is outside this version; run-level undo cannot restore structural edits.

## 6. Acceptance before broader interface changes

Fix misleading review wording and discoverability now. Build a reproducible
synthetic engagement pair with a separate answer key, then run external-agent
compilation without exposing that key. Inspect the saved artifact independently.
Record omissions, version choices, evidence quality, and review effort, including
failed or unavailable checks. A scripted MCP replay is an integration test, not
an autonomous-agent acceptance result. Implementation and run results belong in
the acceptance documentation; the exploratory review is in
[docs/UX-REVIEW-2026-09-05.md](docs/UX-REVIEW-2026-09-05.md).

## 7. Filing choices need source evidence

Added September 7, 2026 after the unreadable-receipt acceptance failure.
Each retained input carries a proposed section, a business-purpose explanation,
and supporting source quotations in the binder-owned handoff. LedgerPDF verifies
that quotations occur on that input's own retained pages, with page references,
source hashes and text/OCR attribution. This verifies provenance, not semantic
correctness; filing remains an agent proposal for human review.

Missing or unverifiable support places the input under Needs filing, with one
unresolved input item explaining the limitation. This routing occurs before the
cover is generated, so printed page references use the final order. The original
source files remain unchanged. A filename or quoted content from a different
document cannot substitute for evidence in the input itself in this version.
An input is filed as a whole; documents requiring multiple business sections or
visual interpretation beyond available text/OCR remain for human classification.
Older handoffs remain readable without inventing filing evidence for them.
