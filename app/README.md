# app — Electron shell (Phase 1: binder organizer)

Electron + React + TypeScript front end. **PDF.js renders; it never writes.**
Every byte written to disk goes through the Python engine (`../engine`) over a
JSON sidecar. See `../references/source-materials.md` for the canonical spec.

## Run it

```bash
npm install
npm run dev        # copies pdfjs assets, then launches
```

The engine venv must exist (`../engine/.venv`) — created by the Phase 0 spike:
`engine/.venv/bin/python spike/run_spike.py`.

## Verify it

```bash
npm run verify     # typecheck + model verification + GUI smoke test
```

| Script | What it proves |
|---|---|
| `typecheck` | main/preload and renderer both typecheck |
| `verify:model` | 100 checks on the pure session model, ending in **two real engine exports + re-probes** (reorder, rotation, bookmark hoisting, session round-trip, version guard, marks, custom stamps, and a flattened binder pixel-compared against the annotated one) |
| `verify:mcp` | 32 checks driving the **MCP server** as a real MCP client through a whole binder build — import (PDFs and images), reorder, bookmark, mark, tape, export, save, reopen — plus the error paths, then verifies the PDF it produced |
| `smoke` | drives the **actual Electron app** headlessly: imports two PDFs and a receipt photo → renders → places marks incl. a custom stamp → exports through IPC + engine → asserts page count, nested/retargeted bookmarks, mark coordinates in pdfium, `qpdf --check`, and snapshots the window to a PNG |

All three suites use synthetic fixtures only — **never client documents**.

## Layout

```
src/main/       main process — ALL filesystem + subprocess access
src/mcp/        local MCP server — agents drive the same model + engine
src/preload/    the entire renderer API surface (contextBridge)
src/renderer/
  src/session.ts    the binder model: stable page ids, bookmarks, export spec (pure)
  src/pdf.ts        PDF.js rendering, image-page painting, render cancellation
  src/App.tsx       state, undo/redo, keyboard
  src/components/   ThumbnailRail · PageView · BookmarkPanel · MarkLayer · MarkInspector · TapeLayer
scripts/        asset copy, model verification, smoke test
```

## Security posture

This app holds client tax documents, so the boundaries are deliberate:

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
- The renderer can only read/probe paths the **user explicitly chose this
  session** (`allowedInputs`) and only write to a path from a **save dialog**
  (`allowedOutputs`). There is no generic "read any file" IPC.
- CSP permits no remote origin at all — no `https:` source anywhere, so the
  renderer cannot reach the network. `wasm-unsafe-eval` is present only for
  PDF.js's JBIG2/JPEG2000 decoders.
- No telemetry. Nothing leaves the machine.
- Source files are opened read-only; a binder is always written to a new file.
  Images are converted in memory at export — the original is never rewritten.

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
| `V` or `Esc` | back to the select tool |
| `+` `−` | resize the selected mark |
| `⌫` | delete the selected mark (else the selected pages) |
| `⌘/Ctrl B` | add a bookmark on the current page |
| `⌘/Ctrl I` · `E` · `S` · `O` | add files · export · save session · open session |

Click selects, `⌘/Ctrl`-click toggles, `⇧`-click selects a range. Drag thumbnails
to reorder; drop PDFs or images onto the window to import.

While the cursor is in a text field, the field owns the keyboard — none of the
single-key shortcuts fire. Without that, typing initials armed the `F` stamp and
`⌫` deleted a binder page.

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

## Review marks (Phase 2)

Arm a tool in the toolbar palette, then click the page. Marks are dragged to
move, `+`/`−` to resize, `⌫` to delete, and every change is undoable. Your
initials (Review panel) are stamped as the mark's author along with an ISO
timestamp — part of the review record, carried into the PDF as private metadata
alongside a standard `/Stamp` annotation.

Kinds: `tick` (agreed), `cross` (does not agree), and `text` (a short lettered
stamp — `F` for footed, or your initials). Adding another *kind* is an appearance
stream in `engine/workpaper_engine/appearance.py` plus a palette entry; adding
another *letter* needs no code at all (see custom stamps below).

**Custom stamps.** Every firm has its own tick-mark legend, so the fixed palette
can't be the whole story. Type a stamp in the Review panel (`TB`, `PY`, `A/R`, up
to 8 characters) and it is saved on the session and armed immediately. Saved
stamps live in the binder, so the legend travels with it. Removing a stamp from
the palette never touches marks already placed with it.

**Mark inspector.** Select a mark and the side panel exposes its letters, size,
author and note for editing after the fact — a review record has to be
correctable without deleting and re-placing the mark. The timestamp is the one
field that is *not* editable: a record you can backdate is not a record.

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

## Calculator tape (Phase 3)

`C` (or the 🖩 button), then click the page. The tape is a **10-key adding
machine**, because that is the muscle memory every preparer already has:

| Keys | Action |
|---|---|
| `0`–`9` `.` | key into the current line |
| `Enter` | commit the line; the running total updates |
| `-` / `+` | flip the sign of the line being keyed |
| `⌫` | take back the keystroke — or, once the buffer is empty, the last committed line |
| `Esc` | put the tape down (an untouched tape deletes itself rather than leaving an empty card) |

Each committed line is one undo step. The caption field above the numbers is
optional and is what makes the tape a workpaper artifact rather than a
calculator — "Repairs" beside a total is the thing a reviewer needs.

**Money is summed in whole cents**, never as floats. `0.1 + 0.2` must be `0.30`
and a total that doesn't foot to the cent is a defect, not a rounding curiosity.

**Entries are stored structurally, not as the rendered text.** A total on a
workpaper with no addends is an assertion; a total with its addends is evidence.
Both go into the PDF: the drawn lines are what any viewer shows, and the entries
plus total ride along in `/WPT_Data` — which is the seam the AI tie-out layer
reads later.

The card's geometry mirrors `engine/workpaper_engine/appearance.py` (`TAPE_*`)
exactly — same font size, line height, padding, and Courier character advance —
so the tape you line up beside a number on screen is the tape that lands in the
PDF. Alignment is monospace padding, which is why the right-aligned amounts
survive the trip verbatim. `npm run smoke` pixel-checks the tape's position in
pdfium alongside the marks.

## Flatten on export

The **Flatten marks** toggle (Binder panel) paints marks into the page content
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

Registered for Claude Code with:

```bash
claude mcp add --scope user workpaper-binder -- node <repo>/app/out/mcp-server.cjs
```

**The session file is the handoff.** There is no live link to a running app
window: the agent assembles a binder and calls `binder_save`, you open that
`.wptsession.json` in the app (`⌘O`) to review and finish it. An agent can also
`binder_export` straight to PDF when no review is wanted.

Tools: `probe_pdf` · `binder_new` / `binder_open` / `binder_save` /
`binder_status` · `binder_add_pdfs` · `binder_move_pages` / `binder_rotate_pages`
/ `binder_delete_pages` · `binder_bookmarks` / `binder_add_bookmark` /
`binder_rename_bookmark` · `binder_set_reviewer` / `binder_place_mark` /
`binder_annotations` / `binder_remove_marks` · `binder_add_tape` ·
`binder_export`.

Page ids (`pg_*`) are permanent and are how every tool refers to pages, so an
agent reads them once from `binder_status` and they stay valid across reordering.

### What crosses the boundary

This matters more here than anywhere else in the app, so it is stated plainly.

**Does cross:** file paths, file names, page counts, page order and rotation,
bookmark titles, and mark/tape metadata (positions, letters, notes, totals).

**Does not cross:** page text. The engine probes *structure*, not content —
there is no tool that returns what a page says or what numbers are on it. This
server cannot put the figures off a client return into a model's context.

That is still not zero-disclosure. **File names and bookmark titles routinely
carry client names** — a real 62-page master file had `Revenue – Triland Partners LLC`
in its outline. Pointing an agent at real client files is therefore an IRC §7216
disclosure decision. The tool does not make that decision, gate it, or redact
anything: that was a deliberate call (2026-07-30), taken so the agent workflow
stays frictionless. If a client-safe mode is ever wanted, the place for it is a
handle-mapping layer in `src/mcp/server.ts` that swaps identifying strings before
they reach the transport.

Note this does not change the *product's* local-only claim: the app still has no
telemetry and reaches no network. What leaves the machine is whatever the agent
you point at it chooses to send to its own model.

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

## Known gaps (tracked in ../ROADMAP.md)

- Packaging is not set up (Phase 5). In particular PDF.js's WASM/cmap assets are
  loaded relative to `document.baseURI`, which works in dev; `file://` fetch
  behavior in a packaged build still needs verifying.
- No links UI yet — that is Phase 4. The engine already supports links (proven
  in the Phase 0 spike). Marks (Phase 2) and tapes (Phase 3) are done.
- A tape's caption and drag position are not individually undoable — they fold
  into the undo entry that opened the gesture, like the reviewer-initials field.
- Flatten burns **our** marks only; annotations that came in on a source page
  stay annotations. Deliberate for now — worth revisiting when a binder first
  goes to someone outside the firm.
- Thumbnails render eagerly as they mount; a 300-page binder needs windowing.
