# Contributing to LedgerPDF

## Never attach a real client document

**Read this before opening an issue.** This is a tool for tax workpapers, so the
natural instinct when reporting a bug is to attach the binder it happened on.
Please don't.

A screenshot of a workpaper, a bookmark title, or even a filename can disclose a
client — `Revenue – Acme Holdings LLC` in an outline names them before anyone
opens the file. In the United States that is an IRC §7216 disclosure, and it is
not one an issue tracker can undo. Public repositories are indexed, mirrored, and
archived; a deleted attachment is not a retracted one.

Instead:

- Describe what you did and what happened.
- Rename or redact before you screenshot, or reproduce it on one of the synthetic
  fixtures in `spike/fixtures/`.
- If a bug only reproduces on a specific document, say so and describe its shape
  — "a 40-page PDF with an existing outline three levels deep, from Lacerte" —
  rather than sending it.

Maintainers cannot un-see an attachment. This one is on all of us to get right.

## Feedback is the contribution that helps most

This is built by a practising CPA for other people doing the same work, and the
most valuable thing you can send is **what broke, what felt wrong, or what you
expected it to do**. You do not need to write code to improve it. Genuinely
useful reports include:

- The platform and version — Windows 11 / macOS 15, and the app version.
- What you were trying to do, in workpaper terms rather than software terms.
- What happened instead, and whether it happened again.
- Whether the binder had been saved, reopened, or reordered first — a
  disproportionate share of real bugs live in that sequence.

## Code contributions

Pull requests are welcome. A few things worth knowing before you spend time:

**Licensing.** Contributions are accepted under the **GPL-3.0-or-later**, the
licence of the project. You keep copyright in what you write.

**A contributor licence agreement may be introduced later.** Ledger Labs LLC
currently holds the copyright undivided and may wish to preserve the option of
licensing LedgerPDF on other terms. If a CLA is adopted it will be announced
here first and will not be applied retroactively without asking you. Raising this
now rather than after the fact seems fairer than the reverse.

**Scope.** Open an issue before building anything substantial. This is a
deliberately narrow tool — see “What it does not do” in `README.md`, which rules out
things like text editing, redaction, and cloud sync on purpose rather than by
omission.

**The bar for changes that touch marks.** A mark's position is evidence. Anything
affecting geometry, appearance streams, or coordinates must keep the verification
suite green — including the cross-engine conformance checks that render binders in
both pdfium and poppler and assert marks land where they were placed. Run:

```bash
cd app && npm run verify              # typecheck, model, MCP, text, smoke, live
npm run verify:viewers               # cross-engine conformance (also from app/)
```

`verify_viewers.py` renders in **two** independent engines and compares them, so the full
run needs poppler's `pdftoppm` alongside pdfium (`brew install poppler`, or `apt install
poppler-utils`). Cross-engine agreement is therefore macOS/Linux only, since poppler is not
readily installable on Windows.

Windows CI runs `--engines pdfium`, which asserts every mark lands where it was placed
across the hostile geometries — rotation, `CropBox != MediaBox`, legal-with-existing-
annotations — without claiming an agreement it cannot check. That step **fails the job**.
It previously carried `continue-on-error: true`, under which the script died at the
`pdftoppm` check and reported success on every run for months, having verified nothing.
If you are changing mark geometry, run the two-engine version locally before pushing:
Windows CI will catch a mark that moved, but only macOS will catch the two renderers
disagreeing about where it moved to.

**Quit LedgerPDF before running `npm run verify`.** The smoke and live checks
launch the real app, and a single-instance lock means a second launch hands off to
the running window and exits instead of opening one. The checks then fail for a
reason that has nothing to do with your change.

**Two conventions that will look wrong and are not.** `live-endpoint.ts` and
`live-host.ts` still say `workpaper-binder` after the rename to LedgerPDF, on
purpose: that identifier is how a running app and an agent find each other, and it
must survive product renames. Both files explain themselves in place. Please don't
tidy them.

## Development setup

See [Build from source](README.md#build-from-source). The short version:

```bash
# macOS / Linux
python3 -m venv engine/.venv && engine/.venv/bin/pip install --require-hashes -r engine/requirements.lock
engine/.venv/bin/python spike/run_spike.py
cd app && npm ci && npm run dev
```

```powershell
# Windows — the venv is Scripts\ rather than bin/, and Windows PowerShell 5.1
# has no && operator, so these are separate lines rather than a chain.
python -m venv engine\.venv
engine\.venv\Scripts\pip install --require-hashes -r engine\requirements.lock
engine\.venv\Scripts\python spike\run_spike.py
cd app
npm ci
npm run dev
```

Add `engine/requirements-build.lock` on top of either if you intend to run
`npm run package:dir` — it carries PyInstaller. The `run_spike.py` line builds
the gitignored fixtures that `npm run verify` checks against.

Architecture notes live in `DATA-FLOW.md`; scope and non-goals live in the
README. Security defects belong in the private channel described in
`SECURITY.md`.
