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
| `verify:model` | 22 checks on the pure session model, ending in a **real engine export + re-probe** (reorder, rotation, bookmark hoisting, session round-trip, version guard) |
| `smoke` | drives the **actual Electron app** headlessly: imports two fixtures → renders → exports through IPC + engine → asserts page count, nested/retargeted bookmarks, `qpdf --check`, and snapshots the window to a PNG |

Both suites use synthetic fixtures only — **never client documents**.

## Layout

```
src/main/       main process — ALL filesystem + subprocess access
src/preload/    the entire renderer API surface (contextBridge)
src/renderer/
  src/session.ts    the binder model: stable page ids, bookmarks, export spec (pure)
  src/pdf.ts        PDF.js rendering + per-canvas render cancellation
  src/App.tsx       state, undo/redo, keyboard
  src/components/   ThumbnailRail · PageView · BookmarkPanel
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
- Source PDFs are opened read-only; a binder is always written to a new file.

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
| `V` or `Esc` | back to the select tool |
| `+` `−` | resize the selected mark |
| `⌫` | delete the selected mark (else the selected pages) |
| `⌘/Ctrl B` | add a bookmark on the current page |
| `⌘/Ctrl I` · `E` · `S` · `O` | add PDFs · export · save session · open session |

Click selects, `⌘/Ctrl`-click toggles, `⇧`-click selects a range. Drag thumbnails
to reorder; drop PDFs onto the window to import.

**Navigating vs. moving are different actions.** `‹ 3 / 62 ›` in the page bar
navigates (and the page number is editable — type to jump). The `Move ↑` /
`Move ↓` toolbar buttons reorder the selected page and deliberately leave you on
it; they disable at the ends of the binder rather than silently doing nothing.
The thumbnail rail scrolls to keep the current page visible.

## Dev seams

Dev builds only (ignored when packaged), used by `npm run smoke`:

| Env var | Effect |
|---|---|
| `WPT_DEV_OPEN` | `path`-delimited PDFs to import at startup |
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
stamp — `F` for footed, or your initials). Adding another is an appearance
stream in `engine/workpaper_engine/appearance.py` plus a palette entry.

**Coordinates are the whole ballgame.** Marks are stored normalized against the
page *as displayed* (CropBox-relative, rotation applied) — exactly what a click
on the rendered canvas produces and exactly what the engine's geometry module
consumes, so there is no conversion step to get wrong. `npm run smoke` asserts
the round trip: a mark placed at (0.72, 0.30) must render at (0.72, 0.30) in the
exported PDF, checked in pdfium. If that ever drifts, a reviewer's tick moves to
the wrong number, which is worse than no tick at all.

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
- No marks/tapes/links UI yet — that is Phase 2–4. The engine already supports
  them (proven in the Phase 0 spike).
- Thumbnails render eagerly as they mount; a 300-page binder needs windowing.
