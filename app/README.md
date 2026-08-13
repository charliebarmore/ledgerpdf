# app — Electron shell (Phase 1: binder organizer)

Electron + React + TypeScript front end. **PDF.js renders; it never writes.**
Every byte written to disk goes through the Python engine (`../engine`) over a
JSON sidecar. See `../DATA-FLOW.md` for the security and process boundaries.

## Run it

```bash
npm ci
npm run dev        # copies pdfjs assets, then launches
```

The engine venv must exist (`../engine/.venv`) — created by the Phase 0 spike:
`engine/.venv/bin/python spike/run_spike.py` (`engine\.venv\Scripts\python` on
Windows). Packaging also needs the hashed build lock in
`../engine/requirements-build.lock`.

**Do not disable install scripts.** Electron 43 ships
no `postinstall` of its own — the binary download moved to an explicit
`install-electron` bin — so `package.json` calls it as our own `postinstall`.
Without it `node_modules/electron` installs with no `dist/`, and everything that
touches Electron fails with `Error: Electron uninstall`, naming nothing useful.
A `node_modules` predating the 43.x bump keeps working and hides this, which is
exactly how it went unnoticed until a clean Windows checkout hit it.

## Verify it

```bash
npm run verify     # typecheck + model verification + GUI smoke test
```

| Script | What it proves |
|---|---|
| `typecheck` | main/preload and renderer both typecheck |
| `verify:persistence` | 8 checks proving atomic session replacement, private POSIX permissions, recovery, temporary-file cleanup, and shell-independent installed MCP registration |
| `verify:model` | 274 checks on the pure session model, ending in **real engine exports + re-probes** (including source-integrity, owner-only working copies, atomic-output failure paths, reorder, rotation, bookmarks, marks, custom stamps, flattening, and review/preflight decisions) |
| `verify:text` | 68 checks that extracted/OCR text lands where the text actually is — against fixture coordinates and rendered pixels, including hostile page geometry |
| `verify:live` | 14 checks that an agent and the running app share ONE binder, plus socket permissions, authentication, approved roots, saving, follow behavior, and forged-push containment |
| `verify:closed-window` | 4 macOS checks that a live agent receives an actionable error when the binder window closes and succeeds after it reopens (other platforms quit when their last window closes) |
| `verify:mcp` | more than 100 checks driving the **MCP server** as a real client through a whole binder build, its filesystem guardrails, and its page-text privacy disclosure |
| `smoke` | drives the **actual Electron app** headlessly: imports two PDFs, a receipt photo and a two-sheet workbook → renders → places marks incl. a custom stamp → exports through IPC + engine → asserts page count, nested/retargeted bookmarks, mark coordinates in pdfium, `qpdf --check`, and snapshots the window to a PNG |
| `verify:package` | reads every Electron fuse from the packaged binary, launches the packaged main process, pings its frozen engine, checks required PDF.js assets in ASAR, confirms the renderer loaded from `ledgerpdf://app`, renders a synthetic PDF, and captures the native window — **asserting the binder that loaded is the expected 3 pages from 1 source, and that a real export completed through the frozen sidecar**, because a failed import or export still paints a window, still screenshots, and still exits 0 |

All suites use synthetic fixtures only — **never client documents**.

## Package it

The desktop package includes a platform-native, one-folder PyInstaller engine;
the destination machine needs neither Python nor this repository. Build on each
target OS because native Python dependencies are deliberately not cross-compiled.

```bash
# Once per build environment (Windows: ..\engine\.venv\Scripts\python):
../engine/.venv/bin/python -m pip install \
  --require-hashes -r ../engine/requirements.lock
../engine/.venv/bin/python -m pip install \
  --require-hashes -r ../engine/requirements-build.lock

# Local macOS/Windows directory build — for verification only, not distribution:
npm run package:dir
npm run verify:package
```

`package:dir` is explicitly ad-hoc/unsigned. `npm run dist` refuses to produce a
distributable unless `WPT_SIGNED_RELEASE=true`; electron-builder then requires a
valid platform identity and `forceCodeSigning` prevents an unsigned artifact.

For macOS, use a Developer ID Application certificate plus ONE of these three
credential sets, all checked before the build starts rather than at the notarize
step at the end of it:

```text
APPLE_KEYCHAIN_PROFILE                                   # preferred — see below
APPLE_ID  APPLE_APP_SPECIFIC_PASSWORD  APPLE_TEAM_ID     # an app-specific password
APPLE_API_KEY  APPLE_API_KEY_ID  APPLE_API_ISSUER        # App Store Connect key
```

**Prefer the keychain profile.** Store the credential once:

```bash
xcrun notarytool store-credentials ledgerpdf-notary \
  --apple-id you@example.com --team-id YOURTEAMID
```

It prompts for the app-specific password without echoing it, and the secret then
lives in the login keychain. The build needs only
`APPLE_KEYCHAIN_PROFILE=ledgerpdf-notary`. The other two sets put a live
credential in the environment, where it is inherited by every child process of
the build and recorded by any shell history that captured the command — for a
credential that can submit software to Apple under your name, that is a
meaningful difference.

The app-specific password itself is generated at appleid.apple.com under
Sign-In and Security, named per app. LedgerPDF needed none until now because no
notarized release had been cut: `package:dir` passes `-c.mac.notarize=false`, so
`notarytool` had never run. An App Store Connect key is the better choice for
CI — revocable on its own, and not tied to one person's Apple ID.

The release config enables hardened runtime, notarization, and the Electron JIT
entitlements; verify the result with `codesign`, `spctl`, and `xcrun stapler
validate` before distribution.

For Windows, create the release on Windows x64. The config uses Azure Trusted
Signing when these product-specific values are set:

```text
WPT_AZURE_PUBLISHER_NAME
WPT_AZURE_ENDPOINT
WPT_AZURE_CERTIFICATE_PROFILE
WPT_AZURE_SIGNING_ACCOUNT
```

Azure authentication itself uses its standard `AZURE_TENANT_ID`,
`AZURE_CLIENT_ID`, and `AZURE_CLIENT_SECRET` environment variables. No signing
secret or certificate is stored in the repository.

The bundle identifier is currently `co.ledgerlabs.ledgerpdf` and the
visible product name is still the working name “LedgerPDF.” Decide the
real product name before issuing certificates or giving a build to a design
partner; changing identity later disrupts OS trust and update continuity.

## Layout

```
src/main/       main process — ALL filesystem + subprocess access
src/mcp/        local MCP server — agents drive the same model + engine
src/preload/    the entire renderer API surface (contextBridge)
src/renderer/
  src/session.ts    the binder model: stable page ids, bookmarks, export spec (pure)
  src/pdf.ts        PDF.js rendering, image-page painting, render cancellation
  src/App.tsx       state, undo/redo, keyboard
  src/components/   ThumbnailRail · PageView · BookmarkPanel · MarkLayer · MarkInspector
                    TapeLayer · ShapeLayer · ShapeInspector
scripts/        asset copy, model verification, smoke test
```

## Security posture

This app holds client tax documents, so the boundaries are deliberate:

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
- The renderer can only read/probe paths the **user explicitly chose this
  session** (`allowedInputs`) and only write to a path from a **save dialog**
  (`allowedOutputs`). There is no generic "read any file" IPC.
- Every privileged IPC call is accepted only from the registered main frame of
  the app window. Navigation, webviews, popups, and browser permissions are
  denied. Drag/drop paths are extracted from genuine OS `File` objects inside
  preload; the renderer cannot authorize an arbitrary path string.
- The packaged renderer is served from the restricted `ledgerpdf://app` origin,
  not Electron's privileged `file://` scheme. Its handler resolves only bundled
  assets beneath `out/renderer`; CSP permits no remote origin at all.
  `wasm-unsafe-eval` is present only for PDF.js's JBIG2/JPEG2000 decoders.
- Packaged binaries carry an explicit, complete Electron fuse policy: Node
  options and inspector flags are disabled, app code must come from the
  integrity-checked ASAR, and `file://` receives no extra privileges. Run-as-Node
  remains enabled only because the installed MCP server uses the app binary as
  its bundled Node runtime.
- No telemetry. Nothing leaves the machine.
- Source files are opened read-only; a binder is always written to a new file.
  Images are converted in memory at export — the original is never rewritten.
- Every imported source is SHA-256 fingerprinted. Reopen verifies the same
  bytes (and offers a relink dialog when a file moved); export checks again
  before and after materialization, so old marks can never silently land on a
  replacement document at the same path.
- The Python PDF sidecar receives a minimal environment (no inherited API keys),
  is limited to five minutes and 16 MB of protocol output per command, and is
  killed if either bound is exceeded.
- Packaged builds run that engine as a frozen, platform-native executable from
  the app's sealed resources; they never discover or invoke a workstation's
  ambient Python installation.

## Memos as pages (Markdown and Word)

Most of what an agent produces for an engagement is prose — a memo, a summary
of positions taken, a list of what was reconciled. `.md`, `.markdown` and
`.docx` import like any other source.

**They are typeset, not dumped.** Dropping the raw file in would put
`## Heading` and `**bold**` on the page as literal characters, and a workpaper
that looks like source code is not support for anything. Headings read as
headings, lists as lists, tables as tables, with real word wrap.

- **reportlab, not our own text drawing.** Prose needs real font metrics to
  wrap; the sheet renderer dodges that with monospace, which is right for a
  column of figures and wrong for a paragraph. Standard-14 faces, so nothing is
  embedded.
- **Times-Roman body, 1-inch margins** — the firm's own document standard, so a
  rendered memo sits beside a Word deliverable without looking foreign.
- **No header or footer.** The binder numbers its own pages and the bookmark
  names the document; repeating either would fight it.
- The file name is a fallback title only — a memo that opens with its own `#`
  heading does not get the file name stamped above it.

Because the text is really drawn, extraction reads it exactly, so **a figure
quoted in a memo is addressable and tickable like any other**. Every block type
carries a check: the failure mode is silent — an unhandled construct does not
error, it vanishes from the page — and a workpaper quietly missing a paragraph
is worse than one that fails to import.

## Spreadsheets as pages

Excel is the format most workpapers actually arrive in — trial balances, lead
sheets, depreciation schedules. `.xlsx`, `.xlsm` and `.csv` import like any
other source: the session keeps pointing at the untouched workbook and the
pages are built in memory at export, exactly as images are.

- **We lay the grid out ourselves** rather than shelling out to LibreOffice or
  Excel. A 500 MB office suite cannot be bundled, and requiring an install
  repeats the problem OCR has. The honest cost: this renders the **data**, not
  Excel's print layout — no merged-cell art, conditional formatting or charts.
  For a trial balance that is fine and arguably more legible; print a formatted
  client-facing schedule to PDF first.
- **Courier, not Helvetica.** Standard-14 so nothing is embedded, and every
  glyph is exactly 0.6 em — column fitting becomes exact arithmetic instead of
  a font-metrics table, and figures line up the way an accountant reads them.
- **Uncalculated formulas are shown, not hidden.** `data_only` gives the value
  Excel last *calculated*; a workbook written by a tool that never calculated
  has none, and a blank where a number belongs is the worst outcome in a
  workpaper. Those cells render as their formula and the import warns.
- **One sheet is one page whenever it can still be read.** The largest type
  that fits everything on a single page is found first, and the page SHAPE is
  chosen per sheet — a tall narrow transaction register fits portrait, a short
  wide trial balance landscape. Fixing the orientation is what turned an 86-row
  register into a full page plus a **13-row orphan**.
- Only when one page would need type below ~4.5pt does it paginate, because two
  readable pages beat one nobody can read. Columns too wide even then split onto
  continuation pages rather than being truncated: a binder that silently drops a
  column is worse than one that runs on.

Because the cells are really drawn into the page, the ordinary text extraction
reads them **exactly** — no OCR anywhere in the path — so a figure off a trial
balance is addressable and tickable like any other.

**But an agent should read `binder_read_cells`, not the page.** The rendered
page is for a human, and flattening a row loses the blanks: a trial balance row
becomes `1001 Cash 7,412.68 5,310.40 4,982.15 7,740.93`, where nothing says
which figure is a beginning balance and which is an ending one. On a trial
balance that IS the meaning. `binder_read_cells` hands over the parsed grid —
header row, column names, every cell including the empty ones — because "this
column is blank for this account" is a fact a reconciliation depends on.

Two related rules in the renderer:

- **Number formatting follows the workbook**, not a guess. Account 1001 was
  being drawn as `1,001`; an agent searching for account 1001 would never find
  it. Grouping now happens only when the cell's own format asks for it.
- **Numeric columns right-align.** Accountants read a column of figures down
  its right edge; left-aligned money is why a rendered trial balance looked
  scattered.

The renderer draws with PDF.js, so `fs:readSource` hands it the pages a sheet
*becomes* rather than the workbook's own bytes — a ZIP got "Invalid PDF
structure" on every page while import, text and export all worked, and only the
thing a person looks at was broken. The window therefore shows exactly the pages
the export writes, which cannot drift from the binder. The GUI smoke now carries
a workbook for this reason.

## Reading scanned pages (OCR)

A large share of real workpaper source material is scanned or photographed, and
those pages carry no text layer — so the tie-out layer was blind on exactly the
documents a preparer most wants help with.

`binder_read_page` and `binder_find` take `ocr: true`. Two rules are treated as
non-negotiable:

- **OCR is a guess; a workpaper is evidence.** A misread digit that reaches a
  tie-out is worse than no reading, because it is wrong *confidently*. So every
  OCR word carries its confidence, hits are labelled `OCR 96.5%`, page reads
  end with "a machine reading of a picture, not the document's own text", and
  nothing is ever presented as the document's own text layer. Words below 40%
  confidence are dropped rather than shown as figures.
- **A page that HAS text is never OCR'd.** Embedded text is exact; OCR of the
  same page is slower and worse.

Coordinates come back in the same normalized display space as everything else,
so a figure read off a scan can be ticked where it sits.

**Backends, in preference order** (the one used is reported with every reading,
so a reviewer knows which engine read a figure):

| Backend | Notes |
|---|---|
| `macos-vision` | On-device Apple Vision. **Nothing to bundle, sign or notarize.** On the same fixture: every figure at confidence 1.000 in 0.49s, against tesseract's 92.9% average in ~2–3s. |
| `tesseract` | The portable fallback (Apache-2.0 — well clear of the MuPDF/AGPL line the licence guard protects), found on `PATH` or via `WPT_TESSERACT`. Shelled out to, so the engine gains no Python dependency. |
| none | Pages report `source: "none"` and say why — the same honest answer as before, not a failure. |

`WPT_OCR_ENGINE` pins one, which is how the cross-engine checks run both.

Two things about Vision that are not obvious, and are the reasons its port is
not a five-line wrapper: it is **line-oriented**, so per-word boxes come from
`boundingBoxForRange`; and its coordinates are **bottom-left origin, y up** —
the opposite of every other coordinate in this engine. Getting that backwards
puts a tick at the mirror image of the figure it read, near enough to look
plausible and be wrong. Two independent engines are asserted to place the same
figure within 0.02, which is what catches it — the same reason the viewer
conformance runs pdfium *and* poppler.

> **Windows is not wired up yet.** `Windows.Media.Ocr` is the equivalent and is
> also on-device, but it reports **no per-word confidence**, so it cannot
> honour the confidence rule the way these two do. That difference has to be
> surfaced rather than papered over — decide it deliberately.

> **Bundling is now a Windows-only question.** macOS needs nothing shipped. If
> Windows ends up on tesseract rather than `Windows.Media.Ocr`, that build has
> to bundle it (~15–40 MB plus signing a second native binary) or require an
> install. This remains an explicit release decision; the current Windows build
> does not advertise OCR support.

## Tie-out

The split is deliberate: **the agent decides what should tie to what; the tool
does the arithmetic and leaves the evidence.** A model doing money arithmetic is
exactly where it should not be trusted, and a verdict in a chat log is not
support for anything.

- **`binder_tie`** checks a figure on one page against a figure on another. When
  they agree it ticks both and cross-references each to the other's page; when
  they do not, it notes both with the difference and flags both as open items.
- **`binder_foot`** adds a column and checks it against the stated total. **The
  tape it leaves IS the evidence** — it shows every addend, so a reviewer sees
  what was added rather than taking the sum on trust. Stamps `F` when it foots,
  notes and flags when it does not.
- Both take a `toleranceCents`, defaulting to **0 — exact**. What is material is
  the reviewer's call, not the tool's.

**Money is read in whole cents by `parseMoney`, never floats**, and it handles
what a workpaper actually writes: `(350.67)` is a negative — the accounting
convention, which the tape's own `parseAmount` reads as nothing at all —
along with currency symbols, thousands separators, trailing minus, and unicode
dashes. Anything it cannot read with certainty is **refused rather than
guessed**: a figure guessed wrong in a tie-out does not fail, it *agrees
confidently*.

Rounding is integer arithmetic end to end. `Number('1.005') * 100` is
`100.4999…`, so rounding the product gives 1.00 where a workpaper says 1.01 — a
systematic error at exactly the boundary money rounds on. 21 shapes of figure
are pinned down in `verify:model`.

When the tool reads a figure a person might read differently, it says so:
`(1,230.00): read as a negative — parentheses`.

## Point it at a folder

`binder_add_folder` imports everything in an engagement folder that a binder can
hold, in the order a person would file it: subfolders in turn, and **"9" before
"10"** rather than after — lexical sort puts `10 - Notes` before `2 -
Deductions`, which is not how anyone reads a numbered folder.

`dryRun: true` lists what it would take without touching the binder.

**Every skip carries a reason**, because "skipped 3 files" tells a reviewer
nothing and a document missing because a tool quietly ignored it is the worst
outcome this app has. Empty files, unsupported types, and unreadable folders are
all named.

One skip is a real signal rather than noise: an Office **lock file** (`~$…`)
means that workbook is **open right now**, so the copy on disk may be missing
unsaved changes. That is worth a preparer knowing before they build a binder out
of it, so it is reported by name. Dotfiles and `.DS_Store` stay silent — those
are OS noise, and reporting them would bury the signal.

Subfolders are listed back so an agent can bookmark by section afterwards.

## Where every document ended up

`binder_inventory` answers "I pointed you at a folder — what did you do with it
all?": one row per source, what it was, **how many of its pages made it in**,
where they sit in the binder right now, and what is marked on them.

A source that lost pages says so — `2 of 3 page(s) in the binder ⚠ 1 NOT
included` — because a document quietly left out is the thing a reviewer most
needs to notice.

**It never goes stale.** Pages are tracked by permanent id, not page number, so
a run that reads `p.4-6` today reads `p.9-11` after you reorder, with no linking
to maintain. That is the same mechanism that already keeps bookmarks and marks
attached to their pages.

The **printed** copy in the cover memo is a different matter: it is ink, and a
snapshot cannot follow a reorder. So the session records the page order at the
moment the cover was written, and `binder_status` says **"the cover memo is OUT
OF DATE"** when they diverge. Re-running `binder_add_cover` with the same path
refreshes it and reuses the narrative, so the reasoning does not have to be
retyped.

## The binder's own account of itself

A reviewer who did not do the work needs the context the worker had. The
journal answers *what changed*; this answers *what happened and why*.

`binder_summary` produces a brief, and `binder_add_cover` writes it to a real
markdown file and inserts it typeset as **page 1** — so the context arrives in
the binder, ahead of the evidence, rather than in a chat window the reviewer
will not have later.

**The split is deliberate: the facts are read from the binder, the narrative is
the agent's.** What was ingested, how it is organized, marks by kind, tapes with
their totals, what is still outstanding, and every agent action in order — none
of that is the agent's to assert. Same principle as the tape: the conclusion
arrives carrying its evidence.

Two things that are easy to get wrong and are checked:

- **Page references count the cover.** Inserting it at the front shifts every
  page number in it; references a reviewer cannot follow are worse than none. The
  cover is typeset first to learn its own length, then renumbered against the
  binder as delivered.
- **Re-running replaces the cover**, rather than stacking another. A binder with
  three covers has none.

`binder_current_page` tells an agent which page the reviewer is looking at, so
"why did you flag this one?" resolves without reading a page id off the screen.
It needs live agent access; standalone there is no window to look at.

## Review notes and flagging

An agent that finds a problem needs somewhere to put it that a human will see;
otherwise the finding dies in a chat log.

- **`binder_add_note`** leaves a comment at a spot on a page. It exports as a
  PDF **Text** annotation — the subtype Acrobat collects into its Comments pane
  — so a reviewer finds it where they already look, and it survives to anyone
  who opens the exported binder rather than only inside this app.
- **`note` is its own mark kind**, not a comment hung off a tick. A tick means
  *agreed*; putting one on something an agent is questioning tells a reviewer
  the opposite of what was meant, and a reviewer scanning a binder reads the
  glyph, not the hover text. Amber, because a note asks for attention without
  asserting a fault the way the cross does.
- **`binder_set_status`** gives agents the page statuses the app already had —
  `reviewed` / `open` / `na`, or a firm's own legend — so a flag an agent sets
  shows in the thumbnail rail and bookmark tree while a person scrolls.
- **`binder_review_queue`** lists everything waiting on a person, in binder
  order, with the note text and who left it. A page marked reviewed with
  nothing outstanding stays out of it. Reviewed/N/A resolves findings that
  existed when the status was applied; a later note or cross reopens the page,
  so a new agent finding cannot hide behind an older reviewer decision.

Notes carry attribution like every other agent artifact, so the exported
annotation reads `ABC (AI)`.

## Bookmarks move sections, not just labels

Dragging a bookmark in the panel moves **the pages it owns**, as one block, in
one undo step.

Acrobat's bookmark drag reorders the outline and leaves the pages where they
were. In a workpaper a bookmark is a tab divider, so moving one has to take its
section with it — otherwise the outline and the binder disagree, which is worse
than not being able to drag at all.

A bookmark owns the pages from its own page up to the page before the next
bookmark at the same or shallower depth — exactly the span the **"(N pages)"**
label already describes, so what a preparer reads is what moves. Nested
bookmarks come along because their pages are inside that run.

Dropping a section on itself, or inside itself, is a no-op rather than a
scramble; a landing strip at the bottom of the list moves a section to the end.
The span and move semantics carry direct checks in `verify:model`, because
getting them wrong reorders a binder silently.

## Agent attribution

A workpaper is evidence, so a reviewer must be able to tell automated work from
their own — and take it back out.

- Anything an agent creates is stamped `by: 'agent'` with the **run** it belongs
  to. Human work carries no extra fields, so a hand-made session is identical to
  one written before attribution existed.
- The session keeps a **journal** of every agent action, in order, in the
  reviewer's language. It travels with the file and is never pruned.
  Deliberately agent-only: journaling every human keystroke would turn an
  engagement record into an input log without answering the question anyone
  asks of it.
- The status bar says **"N AI-created items"** on open, and the mark inspector
  names the placer. Clicking the count opens the Review Center directly on the
  run history. Nobody has to go looking.
- In the exported PDF the visible author becomes `ABC (AI)` — the raw initials
  stay in `/WPT_Data`. Without this an agent placing marks under the reviewer's
  initials would appear in Acrobat as the reviewer: a person's signature on work
  they did not do.
- `binder_history` reads the journal back — what the agent did, in order, with
  the structural steps marked as things a revert cannot undo. It is how a
  reviewer answers "what did the AI actually change?" without diffing the file.
- `binder_revert_run` removes everything a run added. It is **not** a snapshot
  restore, deliberately: rolling the binder back would also discard whatever a
  person did alongside the agent, and would mean storing a copy of the
  engagement record inside itself. The cost is that reordering, rotation and
  deletion are not undone — so the result says exactly which ones survived
  rather than looking complete. Deletions name the pages they removed, because
  nothing else can bring them back.
- `activeRun` is process state and is stripped before writing. A file on disk
  must never claim an agent is working in it.

Session format **2** carries this. The version was bumped rather than added
quietly: a build predating attribution would open a v2 session, ignore the
journal, and drop it on the next save — silently destroying an audit trail. The
guard makes such a build refuse the file instead, which is the right failure for
a record.

## Live agent access

Off by default. Turn it on from the status bar and an agent works on the binder
you have open, instead of its own copy.

Before this, the MCP server kept its own session and the file was the handoff —
so with the app open, its autosave silently overwrote whatever the agent wrote.
A lost update on an engagement record is not an acceptable failure mode.

- **The protocol stays on stdio.** MCP already works there and is fully tested;
  moving it gains nothing. Only the session crosses, which makes this channel
  **two verbs — pull and push** — rather than an endpoint speaking arbitrary
  MCP. Far less to get wrong, and far less to attack.
- **A unix socket (POSIX) or named pipe (Windows), never a TCP port.** There is
  no network surface at all, not even loopback. POSIX applies `0600` to the
  socket and endpoint file. On Windows the endpoint file inherits the per-user
  `%APPDATA%` ACL, Node's machine-wide pipe options stay disabled, and the
  randomized pipe still requires the same 256-bit per-launch token.
- **A 32-byte per-launch token** must be the first line a client sends;
  anything else and the connection ends.
- **The same `mcp-server.cjs`** an MCP client already spawns becomes live
  automatically when the app is listening, and falls back to its own binder
  when it is not. `binder_status` says which — **LIVE** or **Standalone** —
  because editing a private copy while believing you are editing the open
  window is the confusion this exists to remove.
- **Changes arrive through the same `apply` a click does**, so an agent's edit
  lands on the undo stack and autosaves like any other: nothing appears that a
  person cannot take back with the undo they already know.
- The endpoint lives in a **product-name-independent** directory
  (`src/shared/live-endpoint.ts`). Electron's userData is named after the
  display name, which is still a working title — a rename would have silently
  stopped the agent finding the app and left it working on a copy.

The status-bar indicator is driven by the main process, not by the button, so
it cannot read "off" while the socket is open.

## Session durability

The session is the editable engagement record, not a disposable preference
file. After its first manual save:

- edits autosave after 1.5 seconds of inactivity;
- every write is flushed to a same-directory temporary file and atomically
  renamed over the destination;
- the previous complete generation is retained as
  `*.recovery.wptsession.json`;
- a damaged primary automatically opens from that recovery generation and
  requires Save As, preserving both originals;
- closing or opening another binder with unsaved changes is guarded; and
- session and recovery files are owner-only (`0600`) on POSIX systems.

An engagement that has never been manually saved has no user-approved storage
location, so it cannot autosave. The status bar says `unsaved changes`, and the
native close/open guard prevents accidental loss until the user chooses Save.

## Keyboard

| Keys | Action |
|---|---|
| `⌘/Ctrl +` `−` | zoom in / out |
| `⌘/Ctrl 0` · `9` | fit width · fit page |
| `⌘/Ctrl` + scroll | continuous zoom |
| `↑` `↓` | go to the previous / next page |
| `⌘/Ctrl ↑ ↓` | **move** the selected page(s) within the binder |
| `[` `]` | rotate left / right |
| `⌫` | delete (undoable — no confirmation dialog, per DESIGN.md) |
| `⌘/Ctrl Z` / `⇧⌘Z` | undo / redo |
| `T` `X` `F` | arm the tick / cross / footed mark tool |
| `C` | arm the calculator tape |
| `R` `O` `L` `A` | rectangle · ellipse · line · arrow (drag to draw) |
| `H` `N` | highlighter · text note |
| `⇧` while drawing | constrain to square / circle / 45° |
| `V` or `Esc` | back to the select tool |
| `+` `−` | resize the selected mark |
| `⌫` | delete the selected mark or shape (else the selected pages) |
| `⌘/Ctrl B` | add a bookmark on the current page |
| `⌘/Ctrl I` · `E` · `S` · `O` | add files · export PDF · save session · open session |

Click selects, `⌘/Ctrl`-click toggles, `⇧`-click selects a range. Drag thumbnails
to reorder; drop PDFs or images onto the window to import.

While the cursor is in a text field, the field owns the keyboard — none of the
single-key shortcuts fire. Without that, typing initials armed the `F` stamp and
`⌫` deleted a binder page.

## Scrolling

The page area is a **continuous column** — scroll straight through the binder
with the wheel or a trackpad, as in any PDF reader. The page number tracks what
you are reading, taken a third of the way down the viewport rather than at the
very top, so at a page boundary it names the page filling the screen rather
than the one you have mostly scrolled past.

**Only pages near the viewport are rendered.** A 62-page master file cannot
hold 62 live canvases. Unrendered pages still occupy their exact height, taken
from the page size recorded at import (`BinderPage.w/h`), so scrolling past
them never reflows the column under the cursor — which is why the size is in
the model rather than measured from a canvas that may not exist yet.

Every page carries its own annotation layers, sized to its own canvas. That is
what preserves the invariant everything depends on: coordinates are normalized
**per page**, so a mark placed on page 40 exports to page 40 at the same spot.
Clicking with a tool armed acts on the page you clicked, not on "the current
page".

**Navigating vs. moving are different actions.** `‹ 3 / 62 ›` in the page bar
navigates (and the page number is editable — type to jump). The `Move ↑` /
`Move ↓` toolbar buttons reorder the selected page and deliberately leave you on
it; they disable at the ends of the binder rather than silently doing nothing.
The thumbnail rail scrolls to keep the current page visible.

## Dev seams

Dev builds only (ignored when packaged), used by `npm run smoke`:

| Env var | Effect |
|---|---|
| `WPT_DEV_OPEN` | `path`-delimited PDFs/images to import at startup |
| `WPT_DEV_EXPORT` | export to this path (pre-authorized, no dialog) |
| `WPT_DEV_SHOT` | capture the window to this PNG once loaded |
| `WPT_DEV_EXIT` | quit after capturing |

The packaged app ignores all of the above. It has its own set, honoured **only**
when launched with the `--wpt-package-ui-smoke` argv flag — one no shipped app
is ever started with — and used by `npm run verify:package`:

| Env var | Effect |
|---|---|
| `WPT_PACKAGE_SMOKE_OPEN` | `path`-delimited sources to import at startup |
| `WPT_PACKAGE_SMOKE_EXPORT` | export to this path (pre-authorized, no dialog) |
| `WPT_PACKAGE_SMOKE_SHOT` | capture the window to this PNG, then quit |

Both sets still go through `allowedInputs`/`allowedOutputs`, so the seam widens
what a *test* can reach without widening what the renderer may ask for.
`WPT_PACKAGE_SMOKE_EXPORT` exists because it is the only automated path that
exercises the **frozen** sidecar writing a binder — the rest of the suite goes
through the venv Python, which is how a Windows-only export bug survived every
check the project had.

## Review marks (Phase 2)

Arm a tool in the toolbar palette, then click the page. Marks are dragged to
move, `+`/`−` to resize, `⌫` to delete, and every change is undoable. Your
initials (Status ▸ Options) are stamped as the mark's author along with an ISO
timestamp — part of the review record, carried into the PDF as private metadata
alongside a standard `/Stamp` annotation. Initials are set in **Status ▸
Options**, next to the stamp that displays them most visibly; the same initials
author every mark, tape and shape.

Kinds: `tick` (agreed), `cross` (does not agree), and `text` (a short lettered
stamp — `F` for footed, or your initials). Adding another *kind* is an appearance
stream in `engine/workpaper_engine/appearance.py` plus a palette entry; adding
another *letter* needs no code at all (see custom stamps below).

**Custom stamps.** Every firm has its own tick-mark legend, so the fixed palette
can't be the whole story. Hit `+` at the end of the mark palette, type a stamp
(`TB`, `PY`, `A/R`, up to 8 characters), and it is saved on the session and armed
immediately — saved stamps sit in the palette alongside the fixed tools, because
it's the same gesture: arm it, click the page. The legend lives in the binder, so
it travels with it. Removing a stamp (`×`) never touches marks already placed
with it.

**Mark inspector.** Select a mark and the side panel exposes its letters, size,
author and note for editing after the fact — a review record has to be
correctable without deleting and re-placing the mark. The timestamp is the one
field that is *not* editable: a record you can backdate is not a record.

**An armed stamp becomes the cursor.** Arm the tick and the pointer is a tick,
drawn at the point of aim rather than only shown in the toolbar — including
your custom stamps, which use their own letters. Point-placed marks only: a
rectangle or ellipse is *dragged out*, so its cursor stays a crosshair marking
the corner you are starting from. A glyph there would sit where nothing is
about to appear.

The cursor is a 32×32 SVG data URI with a white halo so it reads over dark
scans as well as white paper, hotspot at the centre because a mark is centred
on the click. 32px is deliberate — macOS silently ignores larger cursors — and
lettered stamps shrink to fit. Every cursor falls back to `crosshair`, so a
tool is never invisible.

**Coordinates are the whole ballgame.** Marks are stored normalized against the
page *as displayed* (CropBox-relative, rotation applied) — exactly what a click
on the rendered canvas produces and exactly what the engine's geometry module
consumes, so there is no conversion step to get wrong. `npm run smoke` asserts
the round trip: a mark placed at (0.72, 0.30) must render at (0.72, 0.30) in the
exported PDF, checked in pdfium. If that ever drifts, a reviewer's tick moves to
the wrong number, which is worse than no tick at all.

The thumbnail rail shows a colored dot per mark plus a count badge, so review
coverage across a 60-page binder is visible without paging through it. Dots, not
glyphs: at rail scale a ✓ is illegible, and sizing one correctly would need page
dimensions the rail doesn't have — a dot answers "reviewed, and roughly where"
without implying precision it doesn't have.

## Images as pages

PNG, JPEG, TIFF, GIF, BMP and WebP can be dropped in alongside PDFs — a phone
photo of a receipt or a screenshot is a workpaper page like any other. Each
image becomes **one Letter page, auto-oriented** (portrait image → portrait
page), with the picture centred inside an 18pt margin. A binder is a document,
not a photo album: mixed sources have to print and paginate consistently.

**Conversion happens at export, in memory.** The session keeps pointing at
`receipt.png` untouched, exactly like every other source — no derived files, no
hidden state, and the invariant the whole app rests on (session = JSON +
untouched sources, a PDF exists only at export) is preserved. `engine/images.py`
is the single place that knows how; the rest of the codebase sees an ordinary
page and orders, marks, tapes, bookmarks and flattens it unchanged.

**A JPEG goes in byte-for-byte.** Its compressed data is embedded raw as
`/DCTDecode`, so the receipt in the binder is the file the client sent rather
than a recompression of it — and **EXIF rotation is honoured through the page's
`/Rotate`**, so a photo taken with the phone held sideways lands upright without
touching a pixel. Only cases PDF genuinely can't consume fall back to
re-encoding (losslessly, as Flate): PNG and other non-JPEG formats, CMYK,
progressive scans, and mirrored EXIF orientations. `probe` reports which
happened and why, so it is never a silent downgrade.

The app draws image pages itself rather than through PDF.js, which means the
Letter framing exists **twice** — `imageLayout()` in `session.ts` and `_layout()`
in `images.py`. If those ever disagree, a tick placed over a receipt exports
somewhere else, silently. `verify:model` compares the two implementations
directly rather than trusting them to agree; keep it that way.

## Page status

A small legend the firm defines — Reviewed, Open item, N/A out of the box —
applied from the **Status** dropdown in the toolbar. It sits there rather than
in the side pane because applying a status is an *action on the selection*,
like rotating or deleting; the side pane is for navigation and for inspecting
what is already there. The button carries a dot showing the current page's
status, so it reports as well as acts. It works on the selection, so a
range of pages can be marked at once, and applying a second status **replaces**
the first: a page is in one state, not several.

One status draws three things, each independently switchable under *Options*:

- a **stamp** carrying your initials and the time you applied it, in one of the
  four page corners so it can dodge content
- a **colored page border**, width adjustable
- a **colored, bold bookmark** for that page

That last one is real PDF, not a UI trick — outline entries carry a color and
bold/italic flags, so the coverage map shows up in Acrobat's bookmark panel
too, not just here. The thumbnail rail frames each page in its status color, so
a 62-page binder reads as done / not done at a glance, and the panel counts
double as a progress readout.

**Statuses are generated at export, never stored as shapes.** Change the
legend, recolor it, or switch a part off and the next export simply draws it
differently. Storing them as ordinary annotations would leave stale artwork on
pages whose status had moved on — the one failure mode that would make the
whole feature untrustworthy.

Removing a status from the legend clears it from every page holding it, rather
than leaving those pages pointing at something that no longer exists.

## Review Center

The status bar always names how many pages have open review work. Clicking it
opens one reviewer pass with three views, all derived from the saved session:

- **Needs attention** walks notes and crosses in binder order, preserves the
  full note text, and can jump to the page or mark it Reviewed/N/A in place.
- **Coverage** accounts for imported source pages, page-status progress, stale
  cover text, incomplete connectors, and page items missing reviewer initials.
- **AI work** groups the journal by run and makes the exact surviving Undo count
  visible beside the actions and any structural changes that cannot be undone.

The desktop view, `binder_review_queue`, generated cover summary, and send-out
preflight all call the same pure `reviewSnapshot()`. This is the important part:
four review surfaces cannot quietly develop four definitions of "open."

## Drawn annotations

Rectangle, ellipse, line, arrow, highlighter and text note — drag to draw. Hold
`⇧` for a true square, circle or 45° line. Keys: `R` `O` `L` `A` `H` `N`, with
`V`/`Esc` back to select. A selected shape drags to move, `⌫` deletes it, and
the side inspector edits color, stroke weight and note after the fact.

**A shape tool disarms after one shape**, unlike the mark tools. A tick is
placed dozens of times in a row; a rectangle is drawn once and then adjusted.
Staying armed meant every click meant to *grab* a shape drew another one on top
of it. The new shape is left selected with its handles showing, so it can be
moved or resized straight away; press the tool's key again to draw another.

**Selecting and editing.** Drag a shape to move it, drag a corner handle to
resize — endpoints for a line or arrow, four corners for everything else. `⌫`
deletes. `V`/`Esc` returns to the select arrow if a tool is armed.

Every shape carries an **invisible fat hit area** underneath it. SVG
hit-testing follows what is painted, so a `fill="none"` outline is only
clickable on its stroke — a 2pt arrow meant hitting a 2px line exactly, and the
inside of a circled figure was not a target at all. Shapes also stop
intercepting the pointer while any tool is armed, so a tick aimed inside a
circled figure lands on the page rather than selecting the circle.

Color is a fixed six (red, green, blue, black, orange, grey) rather than a free
picker: red-for-problem and green-for-agreed already mean something in review
work, and an arbitrary color has no legend to explain it. The color button sits in the
toolbar and also recolors the selected shape, so picking a color before *or*
after drawing both work.

Geometry is two normalized corners on the page *as displayed*, the same
convention marks and tapes use, so what you draw is what exports — pixel-checked
in pdfium by `verify:model`.

Two engine details worth knowing before touching `engine/shapes.py`, because
both produce **invalid PDFs** rather than ugly ones:

- **Degenerate drags.** A perfectly horizontal line has zero height. A
  zero-height `/BBox` makes the viewer's BBox→Rect fit divide by zero. Every
  shape is padded by its stroke width so the box always has real extent.
- **Stroke overflow.** A stroke straddles its path, so a rectangle drawn on the
  BBox edge is clipped in half. The same padding gives it room.

The highlighter is a translucent multiply-blend fill, not a stroke — multiply so
the number underneath stays readable. A highlight that hides what it marks is
worse than none.

**Text notes** are placed, not sized: a plain click gives a default box rather
than nothing, since a drag is the wrong gesture for a note. A new note takes
the caret immediately — without that, the single-key tool shortcuts eat every
letter you type (`n` re-arms the note tool, `r` arms rectangle…), which is
exactly how it failed first time round.

Only the SELECTED note takes the pointer. Unselected, the hit area underneath
handles click-to-select and drag-to-move; a `<textarea>` sitting on top would
swallow both. Auto-focus is limited to empty notes, so selecting an existing
one to move it doesn't steal the caret.

They render through a real `<textarea>` so wrapping and editing behave like
text; the engine re-wraps with Helvetica metrics at export. Base-14 fonts only,
so nothing is embedded — same rule as the lettered stamps.

## Calculator tape (Phase 3)

`Tape` in the palette (or `C`), then click the page. A **10 Key panel** opens
beside it with the tape's lines and a keypad.

The tape is an adding-machine grid, the format a preparer recognises:

```
Repairs
1 - 0 |         |          |
1 - 1 | Jan fee | 1,200.00 | +
1 - 2 |         |   340.00 | +
1 - 3 | credit  |    50.00 | -
1 - T | Total   | 1,490.00 | *
```

Section-and-line labels make every figure addressable — that is what lets a
reviewer point at `1 - 3` rather than "the third number". Each line carries an
optional note and its operator.

| Keys | Action |
|---|---|
| `0`–`9` `.` `00` | key into the current figure |
| `+` `-` | **postfix**, adding-machine style: add / subtract *this* figure, committed immediately |
| `*` `/` | **infix**, calculator style: arm × or ÷ for the *next* figure |
| `=` or `Enter` | close the calculation with the armed operator |
| `±` | flip the sign of what is being keyed |
| `⌫` | take back the keystroke — or, once empty, the last committed line |
| `C` / `CE` | clear everything / clear the current figure |
| `Esc` | put the tape down (an untouched tape deletes itself) |

The two conventions coexist because both are muscle memory and neither alone is
enough: `1200 + 340 + 50 -` foots a column, while `5 × 5 =` gives 25 and
`…subtotal… × 0.35 =` applies a rate. Pressing `×` with a figure already keyed
commits it as an addend first, which is what makes all three work. The armed
operator is shown to the left of the display, so `×` is never silently pending.

**The numeric keypad works, and so does typing anywhere in the window.** Keys
are routed at the window level rather than from the tape card, because the
moment you touch a keypad button focus leaves the card and card-level handling
goes dead — which it did.

**Click a tape to pick it back up.** Any tape on the page reopens the 10 Key
panel on that tape, so a total can be corrected later without rebuilding it.
Closing the panel puts the tape down as well — an "active" tape with no visible
keypad is a mode you cannot see.

While a tool is armed, tapes let the pointer through, so a tick aimed near one
lands on the page rather than opening the calculator. Same rule as shapes.

**Every button routes through the same key handler as the keyboard**, and the
transition itself is a pure function in the model (`tapeKeyPress`), so the
panel, the keyboard and the tests all exercise one implementation. The
panel is a second way in, not the primary one — typing is faster than clicking
digits.

In the panel every part of a line is editable — **click an amount and retype
it**, edit its note, click the operator to cycle `+ − × ÷`, or delete just that
line. The total and every running Result re-foot immediately. A mis-key in the
middle should never mean retyping the tape, and correcting a figure against the
source document is the normal case, not an edge case.

An amount keeps a local draft while you type, so a half-entered figure ("3",
"30.") never reaches the model and momentarily wrecks the total; Enter or click
away commits, Escape reverts. An unparseable entry is discarded rather than
zeroed — silently turning a mis-key into 0.00 would be worse than ignoring it.

**Chain semantics.** Every operator applies to the **running total**, exactly
like a physical 10-key — `1,200 + 340` then `× 0.35` gives `539.00`, because
the `×` acts on `1,540.00`, not on a column of independent addends. The first
line seeds the total, so a tape that opens with `×` isn't silently zero.

**Arithmetic is carried in integer cents and rounded at every step.** That is
what makes the tape auditable: each printed line is exact, so the figures shown
always foot to the total shown. The visible consequence is that
`100 ÷ 3 × 3` prints `99.99`, not `100.00` — the tape shows what it actually
did. Carrying full precision and rounding only at the end would print lines
that don't add up to their own total, which is indefensible in a workpaper.
Dividing by zero is refused at the keypad, and leaves the total untouched if
one ever reaches the model from a hand-edited or agent-written session.

The **Result** column appears only on tapes that use `×` or `÷`. An operand
alone (`0.35`) says nothing without the running value it acted on; on an
add-only tape the amounts already foot by eye and a second number column is
just noise.

**Entries are stored structurally, not as the rendered text.** A total on a
workpaper with no addends is an assertion; a total with its addends is
evidence. Both go into the PDF: the drawn lines are what any viewer shows, and
the entries, operators, notes and total ride along in `/WPT_Data` — the seam
the AI tie-out layer reads.

The card's geometry mirrors `engine/workpaper_engine/appearance.py` (`TAPE_*`),
and the card is built from the model's `tapeLines()` — the same strings the
engine draws — so the preview and the PDF cannot drift. `npm run smoke`
pixel-checks the tape's position in pdfium.

## Page numbering

**Options** in the toolbar turns on binder page numbers, in three styles:
plain (`1, 2, 3…`), `Page 14 of 62`, or **Bates** with a prefix and zero-padding
(`WP-000014`). Start number, corner and size are all settable, and the menu
shows what the first and last pages will actually print so the settings can be
checked before committing to an export.

**Numbers are computed at export from each page's FINAL position, never stored
per page.** This is the whole design: store a number and the first reorder
leaves a binder reading 1, 2, 5, 3, 4 — worse than no numbers at all, because
it still looks authoritative. `verify:model` pins it: move page 1 to the end and
it prints the last number, not a stale 1.

Numbering is off by default. An export should never silently stamp something
onto a client's pages that wasn't asked for.

## Flatten on export

The **Flatten marks** toggle in **Options** paints marks into the page content
stream instead of attaching them as `/Stamp` annotations. For a binder that
leaves the building: nothing a recipient can select, drag, or delete, and nothing
for a viewer to silently reposition (see the Preview finding in `spike/README.md`).

It reuses the very same appearance Form XObject the annotation would have used,
placed with the matrix a viewer would compute from `/Matrix`, `/BBox` and `/Rect`
(PDF 2.0 §12.5.5) — so a flattened mark is pixel-identical to the annotated one,
including on rotated pages. `verify:model` proves both halves: identical
centroids in pdfium, and the flattened binder still renders its marks with
annotation drawing turned **off** while the annotated one goes blank.

The trade is deliberate and one-way: flattened marks carry no `/WPT_Data`, so
that PDF can never be re-edited. **The session file stays the editable master** —
flatten is for the copy you send out, not the copy you keep.

## Agent access (MCP server)

`app/src/mcp/` is a local MCP server that lets Claude — or any MCP client —
build binders: import PDFs, order pages, bookmark, place marks and tapes, and
export. It is a **second front door onto the same session model and the same
Python engine** the desktop app drives, not a reimplementation, so the two can't
drift.

```bash
npm run build:mcp     # bundles to out/mcp-server.cjs
npm run verify:mcp    # drives it as a real MCP client through a whole build
```

Registered for Claude Code. **From a source checkout:**

```bash
claude mcp add ledgerpdf --scope user -- node <repo>/app/out/mcp-server.cjs
```

**From an installed app** — and this is the form that matters, because it is the
only one most users can run:

```bash
claude mcp add ledgerpdf --scope user -e ELECTRON_RUN_AS_NODE=1 -- \
  /Applications/LedgerPDF.app/Contents/MacOS/LedgerPDF \
  /Applications/LedgerPDF.app/Contents/Resources/app.asar/out/mcp-server.cjs
```

`out/mcp-server.cjs` ships inside `app.asar`, and a system `node` cannot read
inside an asar — so the first command cannot launch an installed build. Electron
IS node and can read its own archive, which is why the app binary runs the bundle
itself. It also means the machine needs no Node install, which matters when the
audience is accountants. The app shows this command, correct for wherever it is
installed, under **Agent access** in the status bar.

The `-e ELECTRON_RUN_AS_NODE=1` option belongs to Claude Code rather than to a
shell, so this command shape works in macOS shells, PowerShell, and `cmd.exe`.

Notice that neither command supplies folder paths. Approved folders are chosen
in the app, and that visible list is authoritative. There is no environment
override that can silently replace it; verification uses an isolated synthetic
user profile containing the same approval file the app writes.

**Two modes, and `binder_status` names which one is in effect.** When the app is
listening, the agent edits the binder you already have open and you watch it
happen — see *Live agent access* above. Standalone, the saved binder is the
handoff: the agent assembles one, calls `binder_save`, and you open it in the
app to review and finish. An agent can also `binder_export` straight to PDF
when no review is wanted.

`binder_export` may safely reuse one stable output name. After a successful
export it records that file's canonical path and SHA-256 in the binder journal;
the next export may replace it only if the bytes at that path still match. A
human-edited copy, an unrelated file, a symlink, or a file changed while the new
PDF is being built is refused. There is deliberately no `overwrite: true`
escape hatch: replacement authority comes from measured provenance, not an
agent's promise.

The orange switch controls **only the binder on screen**. Approved folders are
the separate, persistent permission for standalone work: an agent may read
documents and create or update LedgerPDF files there even while open-binder
access is off or the app is closed. The panel states both facts rather than
using "agent access off" as an accidental master-switch claim.

One saved binder has one writer. The desktop app and standalone MCP processes
hold the same cross-process lease while a binder is open; a second process is
refused until the first closes it. Live pushes also carry the revision they
read, so a user edit or another agent change that lands first makes the stale
push fail and retry instead of replacing newer work. In live mode, the app owns
the document: `binder_open` is refused and `binder_save` may write only the
binder already open, never a hidden Save As destination.

(This paragraph said "there is no live link to a running app window" until
2026-08-06. Live access shipped on 2026-08-04 and the section above documented
it correctly — this second, older copy further down the file was missed. Worth
a look whenever the MCP surface changes: there is more than one place here that
describes it.)

Tools — all 36: `probe_pdf` · `binder_new` / `binder_open` / `binder_save` /
`binder_status` · `binder_add_pdfs` / `binder_add_folder` · `binder_move_pages`
/ `binder_rotate_pages` / `binder_delete_pages` · `binder_bookmarks` /
`binder_add_bookmark` / `binder_rename_bookmark` · `binder_set_reviewer` /
`binder_place_mark` / `binder_draw` / `binder_annotations` /
`binder_remove_marks` / `binder_add_note` · `binder_add_tape` / `binder_foot` /
`binder_tie` · `binder_set_status` / `binder_review_queue` · `binder_read_page`
/ `binder_read_cells` / `binder_find` · `binder_current_page` ·
`binder_history` / `binder_revert_run` · `binder_inventory` / `binder_summary`
/ `binder_add_cover` · `binder_place_connector` / `binder_legend` ·
`binder_export`.

Page ids (`pg_*`) are permanent and are how every tool refers to pages, so an
agent reads them once from `binder_status` and they stay valid across reordering.

### What crosses the boundary

This matters more here than anywhere else in the app, so it is stated plainly.

**Does cross:** file paths, file names, page counts, page order and rotation,
bookmark titles, mark/tape metadata (positions, letters, notes, totals), **and
the page text itself** via `binder_read_page` and `binder_find`.

**Page text crossing is new, and it is the largest disclosure in this app.**
Until text extraction shipped, the worst case was a model learning a client's
name from a file name; the engine probed structure and could not report what a
page said. Now a model can be handed the figures off a return — wages,
balances, and on a 1040 the taxpayer's SSN. That was a deliberate trade: an
agent that cannot read a page cannot tie one out, and every mark it places has
to be positioned by hand, which defeats the point. But it changes the §7216
question from *metadata* to *content*, and it deserves a fresh decision rather
than inheriting the old one.

Two mitigations, neither of which is a substitute for that decision. Text is
only readable from folders the user approved under Agent access. Nothing is
approved by default.
And **whether the model is local or hosted is the part only you know** — a
local model keeps this on the machine and is the honest way to have both.

**File names and bookmark titles also routinely carry client names** — a real
62-page master file had `Revenue – Triland Partners LLC` in its outline. Pointing an
agent at real client files is therefore an IRC §7216
disclosure decision. File access is **disabled by default**. The practitioner
must approve one or more engagement folders in LedgerPDF; reads, binder
opens/saves, and exports outside those canonical roots are refused,
including symlink escapes. This limits accidental reach but does not redact
identifying strings inside an allowed engagement. A future client-safe mode can
add handle mapping in `src/mcp/server.ts` before those strings reach transport.

Within an approved folder, standalone access is read/write rather than
read-only. New binders, exports and cover memos may be created there. An MCP
save/export refuses to overwrite an unrelated existing file, and opening an
existing binder requires its exclusive lease; updating the binder already held
by that same standalone session remains supported.

Note this does not change the *product's* local-only claim: the app still has no
telemetry and reaches no network. What leaves the machine is whatever the agent
you point at it chooses to send to its own model.

## Viewer conformance

Every annotation this tool writes is a **hand-authored appearance stream**. That
is the core risk in the whole design: a viewer that reads `/Matrix` or `/BBox`
differently, or synthesises its own appearance, would put a reviewer's tick
somewhere other than where it was placed — and a tick pointing at the wrong
number is worse than no tick.

```bash
# from the repo root; on Windows: engine\.venv\Scripts\python spike\make_conformance.py
engine/.venv/bin/python spike/make_conformance.py   # build the fixture
npm run verify:viewers                              # check it in two engines (from app/)
```

`spike/make_conformance.py` builds a six-page binder carrying every kind —
tick, lettered stamp, rectangle, ellipse, arrow, highlight, text note, tape,
status stamp, page border, page number, coloured bookmarks — across the page
geometries that actually break things: a normal page, one where **CropBox ≠
MediaBox**, one with **`/Rotate 90`**, and a legal-size page that already
carries annotations from its source. Page 6 repeats page 1's marks **flattened**
into page content.

`spike/verify_viewers.py` renders it in **pdfium** (what Chrome and Edge use)
and **poppler** (an unrelated codebase) and asserts every mark's centroid.
Agreement across two independent implementations makes the geometry a property
of the PDF rather than of one renderer's interpretation. Neither is shipped —
both are dev-only subprocesses, the same posture as pypdfium2, and the
MuPDF/AGPL guard in the engine requirements is untouched. poppler comes from
`brew install poppler`.

One rule the harness depends on: **at most one asserted colour per page.** Two
objects of the same colour average into a centroid that proves nothing — which
is exactly what an orange arrow sharing a page with the brown tape did the
first time.

**Acrobat is a separate, manual pass** and is not automated. Acrobat DC opens
the fixture, renders the streams, and its Comments panel enumerates exactly the
annotations in the file. A page-by-page visual check is still a human job; see
`spike/ACROBAT-CHECKLIST.md`.

## Save, and Save a copy to send out

**The binder PDF is the document.** One Save. Double-click to reopen. This is
Acrobat's model, and the tool is sold as an alternative to Acrobat, so every
departure from it is something a preparer has to be taught.

- **Save** writes the binder: pages assembled, bookmarks retargeted, marks and
  tapes applied as real PDF annotations so any viewer displays them — *and* the
  editable session stored inside the file. Reopen it and every tick is still a
  tick with its author and timestamp, not pixels.
- **Save a copy to send out** writes the copy that leaves the firm: marks
  flattened into the page content, nothing a recipient can drag or delete, and
  **no session inside**. It is a different destination, never the working
  binder, and it cannot be reopened for editing. Before the file picker opens,
  a preflight names open findings, incomplete connectors, a stale cover,
  source-page differences, unset statuses, and missing initials. Attention
  items take a deliberate second confirmation to send anyway; advisories remain
  professional judgment rather than hard blocks. That is the point of it.

If someone later opens that send-out copy in LedgerPDF, the app identifies it
before importing and explains that the existing marks and note icons are
permanent ink. Opening it anyway starts a new binder where newly added marks are
editable; it does not make the flattened marks editable again. Copies created
before the explicit marker was added are recognized from their LedgerPDF page
resources, so the safeguard also covers already-delivered files.

This replaced a two-file model — a `.wptsession.json` master plus an exported
binder. The buttons had already been renamed once, from "Save"/"Export" to
"Save session"/"Export PDF", because "Save" is what anyone reaches for when
they want their document and they got a `.json`. The rename fixed the labels; it
did not fix the model, and the model was what confused. The first real packaged
workflow exposed it (issue #3).

**Where the session lives inside the PDF is not arbitrary.**
`spike/CARRIER-SPIKE.md` measured six candidate locations against seven
rewriters and found that every single-anchor location has a rewriter that
destroys it. So it is written twice — as a document-level attachment *and* as a
page-level associated file. A document-level one is lost when an editor rebuilds
the file from its pages; a page-level one is lost when the user deletes that
page. Neither failure takes out both.

**Surviving is not the same as being right.** A binder also records a
fingerprint of its own page geometry — page count, order, box sizes, rotation.
If another program rewrites the file and moves the pages, the session still
loads perfectly and every mark on a moved page is now in the wrong place, which
is worse than losing it because the binder reopens looking fine. Opening one
that fails this check says so, in those words.

### While a binder is open

Two siblings appear beside it, both hidden and both deleted on a clean close:

- `.<name>.wpt-working.pdf` — the binder with our marks stripped out. The app
  renders from this and draws its own interactive layer on top; without it every
  tick would appear twice, once from the PDF and once from the app. Annotations
  that arrived on the client's original PDF are **not** stripped and still show.
- `.<name>.wpt-recovery.json` — the autosave. Rewriting a several-hundred-page
  PDF after every edit is not something to do on a timer, so edits land here and
  are folded into the binder when you save. Finding one at open time means the
  app did not close cleanly.

Both sit **beside the binder, not in the OS temp directory**. A working copy of
a binder is client data, and an engagement folder is somewhere a firm has already
decided is appropriate for it. "A de-marked copy of client workpapers is written
to the user's Temp folder" is not a sentence anyone wants in a WISP.

### Older `.wptsession.json` files

Still open, once. Saving converts them to a binder; the old file is left where it
is and never written to again.

## Window layout

**The toolbar has a deliberate responsive contract.** At the 1440px design
window it is one row, with measured spare width for small rendering differences.
At the supported 1100px minimum it wraps into two complete rows rather than
clipping controls. Document actions lead the row, annotation tools follow, and
file actions remain visible at the end. Adding a tool must preserve both layouts
or move an existing group into a menu; abbreviating labels to buy pixels is not
an acceptable fix.

Three columns: **bookmarks** on the left (where a reader looks for a contents
pane), the **page** in the middle, the **thumbnail rail** on the right. Drag the
divider to widen the bookmark pane — real workpaper titles are long.

The side pane holds only navigation and the selected mark's inspector.
Everything that is a *control* lives in the toolbar: the mark palette (including
your custom stamps), reviewer initials, and `Flatten` beside Export binder,
where an export option belongs. Everything that is a *readout* — pages, sources,
selected, marks, tapes — lives in the status bar. The toolbar wraps rather than
clipping on a narrow window.

## Bookmark behavior

- One bookmark per source file, with that source's own imported outline nested
  beneath and retargeted to final binder positions.
- The file-level wrapper is **suppressed** when a single source supplies the
  whole binder and already has its own outline — otherwise it's a dead level.
- `.pdf` is stripped from file-level titles.
- **Page counts** (`counts` toggle, on by default) append `(N pages)` to **leaf**
  bookmarks only — the span from that bookmark's page to the next one. Leaves
  only because in real workpaper files the count describes a *document*, not a
  section heading; a heading whose first child shares its page would otherwise
  read "(1 page)" while covering a dozen. A hand-typed `(N pages)` in an imported
  title is replaced, never doubled.
- **Add** a bookmark on the current page with `+ Add` or `⌘/Ctrl B`; it opens
  straight into rename, so it's add → type → Enter. Hover a user bookmark for
  `⇤`/`⇥` to outdent/indent (indenting nests it under the entry above) and `×`
  to remove. User bookmarks are anchored to a page id, so they move with their
  page, and they merge into any imported outline by binder page order.
- **Rename** any bookmark by double-clicking it; `↺` reverts to the imported
  title. Renames are keyed to the bookmark's *origin* (`f:<source>` or
  `o:<source>:<outline path>`), never its position, so they survive reordering,
  rotation, deletion of other pages, and save/reopen. A renamed title still gets
  a generated page count appended if counts are on.
- **Re-assign** a bookmark to another page: go to the page you want, hover the
  bookmark row, and click the `→ 7` button — labelled with the destination page
  rather than an icon, because "→ 7" says exactly where it lands. A bookmark
  added on the wrong page previously had to be deleted and retyped, and an
  imported one whose destination was wrong could not be fixed at all.
  Re-targeting an imported bookmark stores an **override** (`bookmarkPages`,
  the page-level twin of `titles`) rather than rewriting the source outline, so
  the original destination is never lost — `⇱` sends it home. An override onto
  a page that is later deleted is dropped, and the bookmark falls back to its
  imported destination rather than dangling.

- A bookmark whose target page is deleted is dropped and its children hoisted —
  and those children keep their own renames.

## Real-world PDF quirks handled

Findings from dogfooding actual tax-software output, each pinned by a test:

- **NUL-terminated bookmark titles.** One package ends every outline title with
  `U+0000`. Invisible, but it defeats `$`-anchored matching (page-count suffixes
  never stripped, so generated counts doubled) and survives `.trim()`. All text
  decoded from a PDF is now scrubbed of control characters — in the engine on
  both read and write, and again at the app's model boundary.
- **Hand-typed page counts** in a variety of shapes (`(2 pages)`, `(6 pgs)`,
  `(1 page.)`, non-breaking spaces) are recognized and replaced rather than
  doubled. A parenthetical that isn't a count — `Form 1120S (2024)` — is left
  alone.

## Known gaps

- Unsigned macOS arm64 and Windows x64 packages, PDF.js rendering from the
  restricted `ledgerpdf://app` origin, the Electron fuse policy, the frozen
  engine, and packaged import/export are verified in CI. Signed and
  notarized release artifacts still require the platform credentials described
  in `../RELEASING.md` and final clean-machine installation checks.
- Windows OCR is not implemented; scanned pages need OCR from a supported macOS
  build or another approved workflow.
- No links UI yet — that is Phase 4. The engine already supports links (proven
  in the Phase 0 spike). Marks (Phase 2) and tapes (Phase 3) are done.
- A tape's caption and drag position are not individually undoable — they fold
  into the undo entry that opened the gesture, like the reviewer-initials field.
- Flatten burns **our** marks only; annotations that came in on a source page
  stay annotations. Deliberate for now — worth revisiting when a binder first
  goes to someone outside the firm.
- Thumbnails render eagerly as they mount; a 300-page binder needs windowing.
- Recovery retains one previous generation, not a configurable history. There
  is not yet a recent-engagement/recovery browser.
