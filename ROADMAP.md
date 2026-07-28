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
  - **Phase 1.5 (done, from dogfooding a real 62-page master tax file):** zoom in the page view (fit-width/fit-page/100%/steps, ⌘± and ⌘-scroll) · auto page counts on leaf bookmarks with a toggle · editable bookmark titles (double-click, revert, keyed to origin so renames survive reordering) · redundant single-source file wrapper suppressed · `.pdf` stripped from file titles · full-title tooltips and a drag-resizable bookmark panel (real titles are long).
  - Polish still deferred, non-blocking: thumbnail windowing for very large binders (62 pages was not reported as slow) · bookmark fallback to nearest surviving page instead of drop-and-hoist · richer empty/error states.
- **Vertical-slice checkpoint** — engine + organizer halves are proven; the marks/tape half arrives with Phase 2–3, which is when the full slice (place a tick + a tape, export, verify in 4 viewers) closes.

## Next

Only after the gate passes. Sequenced, with review amendments baked in.

- Phase 2 — review marks: tick palette, custom stamps, place/move/resize/delete, keyboard shortcuts, reviewer initials + timestamps, undo/redo
- Windows code signing (Azure Trusted Signing) — BEFORE any build goes to a design partner, not Phase 5
- Phase 3 — calculator tape (keyboard-first; spec it from a screen-share watching 2 TCR members drive TicTie — do not guess the keystroke feel)
- Phase 4 — links & navigation: page links, external URLs, broken-link detection, hideable indicators
- Session-file format versioning + migration story (before design partners keep real binders in it)
- One-page data-flow doc (local-only, no telemetry, storage locations) to ship with the first beta
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

- Flatten-on-export option (burn marks into content for external sharing) — cheap, add when a binder first leaves the building
- Cross-file links outside the exported binder
- Intel Mac + Windows ARM builds
- Index-sheet / Bates-style numbering generation
- Batch "folder in → binder out" headless mode (the original afternoon-script idea — could ship as a freebie TCR giveaway independent of the app)
- OCR, redaction, forms, e-sign, comparison (explicitly excluded from MVP — they live here so nobody "helpfully" adds them)
