# LedgerPDF

**A local-first tax workpaper binder that a human and an AI agent can work in at the same time.**

Drag in what you actually have — PDFs from your tax software, client documents,
Excel trial balances, scans, phone photos of receipts — and LedgerPDF assembles
them into one ordered, bookmarked PDF binder. Place tick marks, drop calculator
tapes that show their addends, and link a figure to the page that supports it.

![LedgerPDF with a binder open](docs/screenshot.png)

## What it does

- **One binder, one file.** The binder PDF *is* the document. Saving overwrites
  it, and an editable session rides inside the file itself — there is no sidecar
  project file to lose.
- **Marks that survive.** Tick marks, stamps, calculator tapes, shapes and notes
  export as standard PDF annotations, and render in Acrobat, Edge, Chrome and
  macOS Preview. Every mark's position is pixel-verified against two independent
  render engines.
- **Bookmarks that follow their pages.** Reorder anything; the outline moves with
  it. Drag a bookmark and its whole section of pages moves.
- **Real inputs.** PDFs, `.xlsx`/`.xlsm`/`.csv`, `.md`/`.docx`, and images. A
  spreadsheet becomes pages whose cells are real text, so a figure off a trial
  balance can be read exactly — not OCR'd, not guessed.
- **Whole-cent arithmetic.** Calculator tapes never touch floating point, and
  anything ambiguous is refused rather than assumed. A figure guessed wrong
  agrees confidently, which is worse than no figure at all.
- **Agents work in the same binder.** Not a chat box bolted onto a GUI — an MCP
  server exposing the same model the UI drives, so an agent reads pages, finds a
  figure by name, and marks the binder you have open. Everything it does is
  attributed to the AI, journalled, and revertible.

## Where your data goes

**The application makes no network calls.** No telemetry, no accounts, no cloud,
no auto-update phoning home. Your binders and the documents behind them stay on
your machine. Live agent access is a **local** unix socket or named pipe — never
a TCP port — off by default, owner-only, with a fresh token each launch.

**One thing to be clear about, because the distinction matters professionally:**
if *you* point an AI agent at a binder, the page content that agent reads goes
wherever that agent runs. If it is a hosted model, that is a disclosure of client
information and, in the United States, an IRC §7216 decision that is yours to
make. LedgerPDF does not make it for you: agent filesystem access is disabled
unless you explicitly name approved engagement folders in `WPT_MCP_ROOTS`, and
reads outside them are refused. A locally-run model is the honest way to have
both.

## Status

**Alpha.** Used daily by its author on real engagements; not yet shipping signed
installers. Expect rough edges, and do not make it the only copy of anything.

Builds are produced by CI for Windows x64 and can be built from source on macOS
and Windows. Signed releases are pending code-signing certificates.

### Getting a build

**There is no download yet, and that is deliberate.** Code signing is the gate.
An unsigned Windows installer trips SmartScreen's "Windows protected your PC"
warning, and the first thing this tool should not do is teach an accountant to
click past a security prompt. Releases start once the certificate is in hand.

Until then there are two ways to run it, in order of effort:

1. **A CI build**, if you have access to this repository. The **Windows x64**
   workflow under the Actions tab runs on every non-docs push to `main` and on
   pull requests, and can also be dispatched by hand; download the artifact it
   attaches. Artifacts expire after 14 days and are **unsigned: for pilot
   testing, not for redistribution.**
2. **From source**, below. Works on macOS and Windows and takes about five
   minutes on a machine that already has Node and Python.

## Build from source

Requires Node 20+ (CI builds on 22) and Python 3.12+. Expect roughly 1.3 GB on
disk once `node_modules`, the venv and a packaged build are all present.

**macOS / Linux**

```bash
git clone https://github.com/charliebarmore/workpaper-tool.git
cd workpaper-tool

python3 -m venv engine/.venv
engine/.venv/bin/pip install -r engine/requirements.txt
engine/.venv/bin/pip install -r engine/requirements-build.txt   # packaging only

engine/.venv/bin/python spike/run_spike.py                      # build fixtures
```

**Windows (PowerShell)**

A virtual environment puts its interpreter in `Scripts\` on Windows rather than
`bin/`, and there is no `python3` on the PATH — `python3` there is a Microsoft
Store stub that will not create a venv.

```powershell
git clone https://github.com/charliebarmore/workpaper-tool.git
cd workpaper-tool

python -m venv engine\.venv
engine\.venv\Scripts\pip install -r engine\requirements.txt
engine\.venv\Scripts\pip install -r engine\requirements-build.txt   # packaging only

engine\.venv\Scripts\python spike\run_spike.py                      # build fixtures
```

**Then, on either platform**

```bash
cd app
npm install
npm run dev            # run it
npm run verify         # the full check suite
npm run package:dir    # a packaged app in app/release/
```

Two notes on the steps above, both of which otherwise fail on a clean clone:

- **Fixtures are gitignored** — they are synthetic and never committed — so
  `spike/run_spike.py` has to run once before `npm run verify` has anything to
  check. CI regenerates them the same way.
- **`requirements-build.txt` is separate** and holds PyInstaller, which freezes
  the Python engine into the packaged app. Skip it and `npm run dev` still
  works; `npm run package:dir` fails with `No module named PyInstaller`.

`npm run dev` takes roughly fifteen seconds to show a window the first time —
Vite builds the main and renderer bundles before Electron launches. It is not
hung.

## How it is built

An Electron + React front end over a **Python engine** (`pikepdf`/`qpdf`) that
does every PDF operation, spoken to as a JSON-over-stdio subprocess. The engine
is the same one the MCP server drives, so an agent and a person cannot produce
different artefacts. Annotation appearance streams are hand-authored, and page
geometry is resolved through one definition so a word's coordinates and a tick's
coordinates cannot mean different things.

## Licence

Copyright © 2026 **Ledger Labs LLC**. Released under the **GNU General Public
Licence v3.0 or later** — see [`LICENSE`](LICENSE), with the reasoning and a
dependency-compatibility audit in [`COPYRIGHT.md`](COPYRIGHT.md).

Copyleft is deliberate. The claim above — that nothing leaves your machine — is
only worth what your own IT reviewer can check, and this way they can check it.

## Contributing

Feedback and bug reports are the most useful thing you can send. See
[`CONTRIBUTING.md`](CONTRIBUTING.md) — and please read the note there about not
attaching real client documents.

---

Built by [Charlie Barmore](https://cbarmorecpa.com), CPA/CFE, because assembling
a binder is hours of work a competent agent could do, and no workpaper tool was
built for one to drive.
