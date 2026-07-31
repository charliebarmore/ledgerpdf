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
`engine/.venv/bin/python spike/run_spike.py`. Packaging also needs the pinned
build requirement in `../engine/requirements-build.txt`.

## Verify it

```bash
npm run verify     # typecheck + model verification + GUI smoke test
```

| Script | What it proves |
|---|---|
| `typecheck` | main/preload and renderer both typecheck |
| `verify:persistence` | 6 checks proving atomic session replacement, private POSIX permissions, previous-generation recovery, and cleanup of temporary files |
| `verify:model` | 106 checks on the pure session model, ending in **real engine exports + re-probes** (including source-integrity and atomic-output failure paths, reorder, rotation, bookmarks, marks, custom stamps, and flattening) |
| `verify:mcp` | 34 checks driving the **MCP server** as a real MCP client through a whole binder build, including default-deny and out-of-root file-access checks |
| `smoke` | drives the **actual Electron app** headlessly: imports two PDFs and a receipt photo → renders → places marks incl. a custom stamp → exports through IPC + engine → asserts page count, nested/retargeted bookmarks, mark coordinates in pdfium, `qpdf --check`, and snapshots the window to a PNG |
| `verify:package` | launches the packaged main process, pings its frozen engine, checks required PDF.js assets in ASAR, then renders a synthetic PDF under `file://` and captures the native window |

All suites use synthetic fixtures only — **never client documents**.

## Package it

The desktop package includes a platform-native, one-folder PyInstaller engine;
the destination machine needs neither Python nor this repository. Build on each
target OS because native Python dependencies are deliberately not cross-compiled.

```bash
# Once per build environment:
../engine/.venv/bin/python -m pip install \
  -r ../engine/requirements.txt -r ../engine/requirements-build.txt

# Local macOS/Windows directory build — for verification only, not distribution:
npm run package:dir
npm run verify:package
```

`package:dir` is explicitly ad-hoc/unsigned. `npm run dist` refuses to produce a
distributable unless `WPT_SIGNED_RELEASE=true`; electron-builder then requires a
valid platform identity and `forceCodeSigning` prevents an unsigned artifact.

For macOS, use a Developer ID Application certificate plus one of
electron-builder's notarization credential sets (App Store Connect API key is
preferred for CI). The release config enables hardened runtime, notarization,
and the Electron JIT entitlements; verify the result with `codesign`, `spctl`,
and `xcrun stapler validate` before distribution.

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

The bundle identifier is currently `com.charliebarmore.workpaperbinder` and the
visible product name is still the working name “Workpaper Binder.” Decide the
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
- CSP permits no remote origin at all — no `https:` source anywhere, so the
  renderer cannot reach the network. `wasm-unsafe-eval` is present only for
  PDF.js's JBIG2/JPEG2000 decoders.
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

**Every button routes through the same key handler as the keyboard**, and the
transition itself is a pure function in the model (`tapeKeyPress`), so the
panel, the keyboard and the tests all exercise one implementation. The
panel is a second way in, not the primary one — typing is faster than clicking
digits.

In the panel each line's note is editable, its operator toggles, and it can be
deleted individually: a mis-key in the middle shouldn't mean retyping the tape.

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

## Flatten on export

The **Flatten** toggle beside Export binder paints marks into the page content
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
claude mcp add --scope user \
  -e WPT_MCP_ROOTS=/absolute/path/to/approved/engagements \
  workpaper-binder -- node <repo>/app/out/mcp-server.cjs
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
disclosure decision. File access is now **disabled by default**. Registration
must set `WPT_MCP_ROOTS` to one or more path-delimited engagement roots; reads,
session opens/saves, and exports outside those canonical roots are refused,
including symlink escapes. This limits accidental reach but does not redact
identifying strings inside an allowed engagement. A future client-safe mode can
add handle mapping in `src/mcp/server.ts` before those strings reach transport.

Note this does not change the *product's* local-only claim: the app still has no
telemetry and reaches no network. What leaves the machine is whatever the agent
you point at it chooses to send to its own model.

## Save session vs Export PDF

Two different outputs, and the distinction is the whole design:

- **Save session** writes a `.wptsession.json` — page order, bookmarks, marks,
  tapes and shapes, **pointing at your source files without touching them**.
  It is the editable working record: reopen it and every tick is still a tick
  with its author and timestamp, not pixels.
- **Export PDF** writes the binder itself: pages assembled, bookmarks
  retargeted, annotations applied.

The buttons used to read "Save" and "Export", which was ambiguous at exactly
the moment it mattered — "Save" is what anyone reaches for when they want their
document, and they got a `.json`. They now say what they produce. The session
file is named after the binder for the same reason a folder of files all called
`binder.wptsession.json` helps nobody.

## Window layout

**The toolbar is two rows, deliberately.** The top one is the *document* —
add, rotate, move, delete, status, undo, and the file actions on the right. The
bottom one is *annotation* — marks, drawing tools, colors, initials. One row
had been patched for width three times, each patch abbreviating a label to buy
pixels, which is what made tools unreadable in the first place. Adding a tool
now costs height, not legibility.

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

- The unsigned local macOS arm64 package and PDF.js `file://` rendering are
  verified. Developer-ID signing/notarization and the Windows x64 build,
  SmartScreen, Acrobat, Edge, and installer checks require the real credentials
  and Windows hardware before any design-partner distribution.
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
