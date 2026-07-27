# Project Brief

## One-sentence summary

```text
This product helps tax preparers and reviewers assemble, mark up, and tie out PDF workpaper
binders (tick marks, calculator tapes, bookmarks, hyperlinks) so they can drop both Adobe
Acrobat and TicTie Calculate — locally, with client data never leaving the machine.
```

## Product context

- **Project name**: workpaper-tool (working name — real name TBD, see Open questions)
- **Industry / domain**: Tax & accounting firm software (workpaper preparation/review)
- **Primary audience**: Charlie's own practice first; then 2–3 TCR design-partner firms (tax preparers/reviewers, mostly Windows)
- **Secondary audience**: TCR community / small firms broadly, IF the business gate passes
- **Business model**: None yet — deliberately undecided until after the Phase 1 gate (candidates: paid app, TCR-member perk, authority/content asset)
- **Internal, client-facing, or public**: Internal alpha → small private beta. Not public.
- **Prototype, MVP, production, or mature product**: MVP (Tier 1). Re-bootstrap at Tier 2 before any firm-ready beta.

## Problem statement

Firms pay twice for workpaper markup: Adobe Acrobat (subscription, ~$240/user/yr) plus TicTie Calculate (~$150/user/yr) — and TTC *requires* Acrobat to run. The actual daily workflow is narrow: combine source PDFs into a binder, keep bookmarks attached to pages, place tick marks, run calculator tapes, hyperlink supporting docs. Cheaper PDF editors miss the tax-specific pieces; TTC locks you into Adobe. Cost of not solving: every seat pays ~$400/yr for two tools to do one bounded job, and the market's cloud alternatives raise data-custody questions a local tool avoids entirely.

## Core user workflows

```text
1. Preparer drags source PDFs (tax-software output, client docs) into the app.
2. App shows a thumbnail rail; preparer reorders/rotates/deletes pages; bookmarks are
   generated from filenames and stay attached to their pages as they move.
3. Preparer/reviewer places tick marks and stamps, drops calculator tapes tied to figures,
   and links numbers to supporting pages.
4. App exports ONE portable PDF binder — marks, tapes, bookmarks, and links all render as
   standard annotations in Acrobat, Edge, Chrome, and macOS Preview. Source files untouched.
```

## User roles

| Role | What they need to do | What they must not access |
| --- | --- | --- |
| Preparer (primary) | Assemble binder, organize pages, place marks/tapes/links, export | n/a — local single-user app |
| Reviewer | Same surface + reviewer initials/timestamps on marks (Phase 2) | n/a |
| Design partner (beta) | Run signed builds on Windows, report friction | Never receives builds containing Charlie's client data; fixtures only |

## Goals

- Phase 0 spike proves portable annotations on real tax-software PDFs (the stage gate) within 2–4 days of part-time work
- Phase 1 delivers a binder organizer Charlie uses on his own real workpapers (dogfooding = the success test)
- Bookmarks/marks provably follow pages through any reorder — the headline feature vs. GUI tools
- Exported binders pass `qpdf --check` and render identically in 4 viewers (Acrobat, Edge, Chrome, Preview)
- Total spend through Phase 1 stays part-time (~2 weeks) — does NOT raid August income-replacement work

## Non-goals

- NOT an Acrobat replacement — no text/image editing, OCR, redaction, forms, signatures, comparison
- No cloud, no collaboration, no accounts, no telemetry that touches document content — local-only is a *feature* (§7216/Safeguards story)
- No AI tie-out in MVP — the internal model is built as the seam for it, but the layer itself is a post-gate bet
- No commercial packaging/pricing decisions until the Phase 1 business gate

## MVP scope

- **Phase 0 (committed):** compatibility spike per `references/source-materials.md` — appearance streams, already-annotated imports, sidecar-survives-AV, 4-viewer matrix, `qpdf --check`
- **Phase 1 (committed):** import/drag-drop → thumbnail rail → reorder/rotate/delete → filename bookmarks (nested under file-level bookmarks) → stable page IDs → session save/reopen → export merged binder
- Vertical-slice checkpoint: two real PDFs in, reorder, one tick mark + one tape, export, verify in all viewers — on both platforms from the same source

## Out of scope for now

- Phases 2–5 (marks palette, calculator tape, links UI, hardening) — **gated**, see ROADMAP.md
- Windows/macOS store distribution, auto-update infrastructure
- Flatten-on-export and cross-file links (parked in ROADMAP)
- Any use of design partners' or clients' real documents in CI or shared fixtures

## Success metrics

| Metric | Baseline | Target | How measured |
| --- | --- | --- | --- |
| Phase 0 gate: portable annotations on real tax PDFs | unknown | pass in 4 viewers + `qpdf --check` | ✅ 2026-07-27 — 2 engines automated (pdfium, PDFKit); Acrobat/Windows pending |
| Phase 1: organize + export a binder from the GUI | Adobe today | working app | ✅ 2026-07-27 — `app/` + `npm run verify` (29 automated checks) |
| Charlie prepares a real binder start-to-finish in the tool | Adobe today | 1 real workpaper set via Phase 1 build | dogfood log |
| Bookmark/mark integrity through reorder | manual in GUI tools | 0 detached marks across test corpus | regression fixtures |
| Part-time budget respected | — | ≤ ~2 wks part-time through Phase 1 | honest calendar check at the gate |

## Open questions

| Question | Owner | Blocking? | Notes |
| --- | --- | --- | --- |
| Real product name | Charlie | No | "workpaper-tool" is the working name; decide before design partners see it |
| Sidecar packaging: PyInstaller vs Nuitka vs qpdf-CLI-only | Phase 5 | No (dev runs from the venv) | Decided by AV/SmartScreen behavior on the real Windows box |
| ~~Commercial PDF SDK fallback needed?~~ | — | **Resolved 2026-07-27: No** | pikepdf/qpdf produced portable annotations in both pdfium and PDFKit; stage gate passed |
| Real Windows x64 test hardware | Charlie | No (Phase 1), Yes (beta) | Mini PC vs. a design partner's workstation |
| Which 2–3 TCR members are the design partners | Charlie | No | From the TCR thread responses; confirm before Phase 2 |
| Business model if gate passes | Charlie | No | Decide WITH August revenue data, not before |
```
