# Roadmap

Use Now / Next / Later to avoid false precision. Do not turn uncertain ideas into promised dates.

> **THE GATE (read this before promoting anything out of Next):** Phases 2+ are not committed.
> Promotion requires BOTH: (1) the Phase 0/1 vertical slice passes — two real PDFs imported,
> reordered, one tick mark + one calculator tape placed, exported, verified in Acrobat, Edge,
> Chrome, and macOS Preview, on both platforms; AND (2) an explicit business decision made with
> Charlie's August revenue picture in hand. The gate is a business call, not just a technical one.

## Now

Committed work — part-time, ~2 weeks total. This is the entire current commitment.

- **Phase 0 — compatibility spike (2–4 days).** Full checklist in `references/source-materials.md`. Weighted toward: appearance streams rendering identically in all 4 viewers · importing already-annotated PDFs and surviving merge/reorder · sidecar builds/spawns/survives AV on a real Windows machine · CropBox-normalized coordinates on real tax-software output. Stage gate: if annotations can't be made portable, evaluate a commercial PDF SDK before writing any UI.
- **Phase 1 — binder organizer (~1 week).** Import + drag-drop · thumbnail rail · reorder/rotate/delete · filename bookmarks nested with imported outlines · stable page IDs · versioned session save/reopen · export merged binder that never touches source files.
- **Vertical-slice checkpoint** (defined in the gate above) — the go/no-go artifact.

## Next

Only after the gate passes. Sequenced, with review amendments baked in.

- Phase 2 — review marks: tick palette, custom stamps, place/move/resize/delete, keyboard shortcuts, reviewer initials + timestamps, undo/redo
- Windows code signing (Azure Trusted Signing) — BEFORE any build goes to a design partner, not Phase 5
- Phase 3 — calculator tape (keyboard-first; spec it from a screen-share watching 2 TCR members drive TicTie — do not guess the keystroke feel)
- Phase 4 — links & navigation: page links, external URLs, broken-link detection, hideable indicators
- Session-file format versioning + migration story (before design partners keep real binders in it)
- One-page data-flow doc (local-only, no telemetry, storage locations) to ship with the first beta

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
