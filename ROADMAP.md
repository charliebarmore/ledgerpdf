# Roadmap

Use Now / Next / Later to avoid false precision. Do not turn uncertain ideas into promised dates.

> **THE GATE (read this before promoting anything out of Next):** Phases 2+ are not committed.
> Promotion requires BOTH: (1) the Phase 0/1 vertical slice passes — two real PDFs imported,
> reordered, one tick mark + one calculator tape placed, exported, verified in Acrobat, Edge,
> Chrome, and macOS Preview, on both platforms; AND (2) an explicit business decision made with
> Charlie's August revenue picture in hand. The gate is a business call, not just a technical one.

## Now

Committed work — part-time, ~2 weeks total. This is the entire current commitment.

- **Phase 0 — compatibility spike. ✅ DONE 2026-07-27 (20/20 engine + 19/19 macOS Preview checks — see `spike/README.md`).** Appearance streams, CropBox normalization, rotation compensation, stable-ID reorder, nested/retargeted bookmarks, links, legacy-annotation survival, `qpdf --check`, spawnable JSON sidecar — all proven on synthetic fixtures in **two independent render engines** (pdfium = Chrome/Edge, PDFKit = macOS Preview). Stage gate outcome: **no commercial SDK needed — proceed.** Remaining from the checklist, non-blocking for Phase 1: Acrobat Reader on a real Windows x64 box · sidecar AV/SmartScreen packaging test (needs that hardware).
- **Phase 1 — binder organizer. ✅ FUNCTIONALLY COMPLETE 2026-07-27** (Electron + React + PDF.js over the Phase 0 engine — see `app/README.md`). Import via dialog + drag-drop · thumbnail rail with drag-reorder, multi-select, keyboard · rotate/delete with undo/redo · file-level bookmarks with imported outlines nested and retargeted · stable page IDs · versioned session save/reopen with a format guard · export merged binder that never touches source files. Verified by `npm run verify`: typecheck + **22 model checks ending in a real engine export** + a **7-check GUI smoke test that drives the actual app headlessly** (import → render → export → `qpdf --check`).
  - **Phase 1.5 (done, from dogfooding a real 62-page master tax file):** zoom in the page view (fit-width/fit-page/100%/steps, ⌘± and ⌘-scroll) · auto page counts on leaf bookmarks with a toggle · editable bookmark titles (double-click, revert, keyed to origin so renames survive reordering) · **add/remove/nest your own bookmarks** (the app previously only derived them, so a PDF with no outline got exactly one) · redundant single-source file wrapper suppressed · `.pdf` stripped from file titles · full-title tooltips and a drag-resizable bookmark panel (real titles are long).
  - Polish still deferred, non-blocking: thumbnail windowing for very large binders (62 pages was not reported as slow) · bookmark fallback to nearest surviving page instead of drop-and-hoist · richer empty/error states.
- **Phase 3 — calculator tape. ✅ DONE 2026-07-30.** 10-key adding machine (digits key the line, Enter commits and the running total updates, `-` flips the sign, `⌫` takes back the keystroke then the last line, Esc puts it down), optional caption, drag to position, each line one undo step. **Money sums in whole cents, never floats.** Entries are stored structurally and exported alongside the drawn lines as `/WPT_Data`, so a total always carries its addends — the seam the tie-out layer reads. Card geometry mirrors the engine's `TAPE_*` constants, and the tape's position is pixel-checked in pdfium alongside the marks.
  - Keystroke feel was specced from Charlie directly rather than a TCR screen-share. Worth 10 minutes of watching a TCR member drive TicTie to confirm the `⌫` and sign behavior before design partners see it.
- **Agent access — MCP server. ✅ DONE 2026-07-30** (added at Charlie's direction, outside the original phase plan). `app/src/mcp/` exposes the binder to Claude and any MCP client: import, reorder, bookmark, mark, tape, export. It is a second front door onto the *same* session model and Python engine, not a reimplementation, so the two can't drift. Registered at user scope as `workpaper-binder`. The `.wptsession.json` is the handoff — no live link to a running app window. 28-check harness drives it as a real MCP client through a whole build plus the error paths.
  - **§7216 note.** Page *text* never crosses — the engine probes structure, not content. But file names and bookmark titles carry client names, so pointing an agent at real client files is a disclosure decision. **Charlie chose no enforced boundary or redaction (2026-07-30)**, deliberately, to keep the workflow frictionless. If a client-safe mode is ever wanted, the seam is a handle-mapping layer in `src/mcp/server.ts`. This does not change the product's local-only claim: the app still has no telemetry and reaches no network.
- **Vertical-slice checkpoint — ✅ CLOSED on this machine 2026-07-30.** Import → organize → tick → tape → export → validate now runs end to end: 88 model checks and a 12-check GUI smoke that drives the real app and asserts marks *and* the tape land at the exact coordinates placed, `qpdf --check` clean. **Still outstanding for the formal gate:** verification in all four viewers (Acrobat, Edge, Chrome, macOS Preview) on **both** platforms — pdfium (Chrome/Edge) and PDFKit (Preview) are covered by the spike harness, but Acrobat on real Windows x64 has never been run.

## Next

Only after the gate passes. Sequenced, with review amendments baked in.

- **Phase 2 — review marks. ✅ COMPLETE 2026-07-30** (built ahead of the gate at Charlie's direction). Palette (tick / cross / lettered `F` / initials stamp), click-to-place, drag-to-move, resize, delete, keyboard tools, reviewer initials + ISO timestamps, all undoable and persisted. Verified end-to-end: 72 model checks, 24 engine spike checks (incl. pixel checks on the new glyphs), and an 11-check GUI smoke that places marks in the real app, exports, and asserts they land **at the exact coordinates placed**.
  - **Phase 2 remainder (done 2026-07-30):** user-defined custom stamps — a firm's own tick-mark legend, saved on the session so it travels with the binder · a mark inspector (edit letters/size/author/note after the fact; the timestamp stays read-only) · marks visible in the thumbnail rail as positional dots + a count badge · **flatten-on-export**, which reuses the annotation's own appearance stream and the viewer's `/Matrix`+`/BBox`→`/Rect` placement math so a flattened mark is pixel-identical to the annotated one, proven by rendering with annotations turned off.
  - Also fixed while here: single-key shortcuts fired while typing in a text field — entering reviewer initials armed the `F` stamp, and `⌫` deleted a binder page.
  - Deliberately left: flatten burns *our* marks only, not annotations inherited from source pages. Revisit when a binder first goes outside the firm.
- Windows code signing (Azure Trusted Signing) — BEFORE any build goes to a design partner, not Phase 5
- Phase 4 — links & navigation: page links, external URLs, broken-link detection, hideable indicators
- Session-file format versioning + migration story (before design partners keep real binders in it)
- One-page data-flow doc (local-only, no telemetry, storage locations) to ship with the first beta — **must now also cover the MCP server**, which is the one surface where data can leave the machine (via the agent, not the app)
- Rebuild `out/mcp-server.cjs` is a manual `npm run build:mcp` today; the registered MCP command points at the built file, so a stale bundle is a silent way to run old code
- **Preview-rewrites-binders mitigation** (finding from Phase 0 — see `spike/README.md`): the macOS Preview app rewrote an exported binder in place with no explicit save, flattening `/Rotate` and moving annotation `/Rect`s. A binder is a *record*, so decide the response: user-facing warning · guidance to keep the canonical binder in-app and export copies for distribution · possibly an integrity check (store a hash with the session and flag externally-modified exports). Also worth deliberately reproducing to confirm attribution.

## Later

Strategic bets — not committed, revisit at each gate.

- Phase 5 hardening: crash recovery, atomic saves, large-doc perf, encrypted-file handling, regression corpus, installers, auto-update
- Re-bootstrap project at Tier 2 (DATA-SECURITY.md, TESTING.md, DEPLOYMENT.md, RISK-REGISTER.md) when firm-ready beta work starts
- **AI tie-out layer** — the differentiator: auto-match numbers across workpapers and place marks, auto-generate tapes from source docs, flag what doesn't foot. The internal model (page IDs + structured tapes) is the seam it plugs into.
- Commercial decision: paid product vs. TCR-member perk vs. pure authority asset — decided with revenue data, never by momentum
- "Built in public" TCR content series / paid-lab episodes from the build

## Parking lot

Useful ideas that should not distract the current build.

- Cross-file links outside the exported binder
- Intel Mac + Windows ARM builds
- Index-sheet / Bates-style numbering generation
- Batch "folder in → binder out" headless mode (the original afternoon-script idea — could ship as a freebie TCR giveaway independent of the app)
- OCR, redaction, forms, e-sign, comparison (explicitly excluded from MVP — they live here so nobody "helpfully" adds them)
