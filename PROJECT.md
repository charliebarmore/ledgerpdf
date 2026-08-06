# Project Brief

## One-sentence summary

```text
This product lets tax preparers and reviewers — and the AI agents working alongside them —
assemble, read, mark up, and tie out workpaper binders from the documents a firm actually
has (PDFs, Excel, scans), locally, with client data never leaving the machine.
```

## Product context

- **Project name**: **LedgerPDF** (settled 2026-08-05). Published by **Ledger Labs LLC**; bundle identifier `co.ledgerlabs.ledgerpdf`. The **GitHub repo is `charliebarmore/ledgerpdf`** — it was renamed on 2026-08-06, when the history had to be republished into a fresh repo anyway to get the pre-scrub commits off GitHub, which was the one moment the name was free to change. The **local folder stays `workpaper-tool`**: renaming that needs Claude-history relinking (`~/Practice/_meta/WORKSPACE-REORG.md` §3) and buys nothing.
- **Licence**: **GPL-3.0-or-later**, copyright Ledger Labs LLC (`LICENSE`, rationale and dependency-compatibility check in `COPYRIGHT.md`). Copyleft is deliberate: the local-only claim is only worth what a firm can verify. Ledger Labs holds the copyright undivided and can relicense — until outside contributions are merged.
- **Industry / domain**: Tax & accounting firm software (workpaper preparation/review)
- **Primary audience**: Charlie's own practice first; then 2–3 TCR design-partner firms (tax preparers/reviewers, mostly Windows)
- **Secondary audience**: TCR community / small firms broadly, IF the business gate passes
- **Business model**: None yet — deliberately undecided until after the Phase 1 gate (candidates: paid app, TCR-member perk, authority/content asset)
- **Internal, client-facing, or public**: Internal alpha → small private beta. Not public.
- **Prototype, MVP, production, or mature product**: MVP (Tier 1). Re-bootstrap at Tier 2 before any firm-ready beta.

## Problem statement

Two problems, and the second is the bigger one.

**The tooling tax.** Firms pay twice for workpaper markup: Adobe Acrobat (~$240/user/yr) plus TicTie Calculate (~$150/user/yr) — and TTC *requires* Acrobat to run. Cheaper PDF editors miss the tax-specific pieces; TTC locks you into Adobe. Every seat pays ~$400/yr for two tools to do one bounded job, and the market's cloud alternatives raise data-custody questions a local tool avoids entirely.

**The labour.** Assembling a binder is hours of work a competent agent could do — ordering pages, naming schedules, finding a figure and ticking it, footing a column — but no workpaper tool is built for an agent to drive. Bolting a chat box onto a GUI does not count: an agent needs to *read* the documents (including the scans and the spreadsheets), address a figure by name, and act on the same binder the human has open. And because a workpaper is evidence, everything it does has to be attributable and reversible, or no CPA can sign the file.

That second problem is what this product is now organized around. The first is the wedge.

## Core user workflows

```text
BY HAND
1. Preparer drags in the sources they have — PDFs (tax-software output, client docs),
   Excel/CSV (trial balances, lead sheets), and scans or phone photos.
2. App shows a thumbnail rail; preparer reorders/rotates/deletes pages; bookmarks are
   generated from filenames and stay attached to their pages as they move.
3. Preparer/reviewer places tick marks and stamps, drops calculator tapes tied to figures,
   and links numbers to supporting pages.
4. App exports ONE portable PDF binder — marks, tapes, bookmarks, and links all render as
   standard annotations in Acrobat, Edge, Chrome, and macOS Preview. Source files untouched.

BY AGENT (same binder, same model, no second-class path)
5. Preparer turns on live agent access and says what they want in plain language.
6. Agent reads the pages — embedded text, exact cell values from a workbook, OCR for a
   scan — finds a figure by name, and gets back coordinates it can mark.
7. Agent organizes, bookmarks, marks, and foots; the preparer watches it happen in the
   window they already have open.
8. Every agent action is stamped, journaled, and revertible; the exported PDF attributes
   its marks to "(AI)" so a reviewer can tell automated work from their own.
```

## User roles

| Role | What they need to do | What they must not access |
| --- | --- | --- |
| Preparer (primary) | Assemble binder, organize pages, place marks/tapes/links, export | n/a — local single-user app |
| Reviewer | Same surface + reviewer initials/timestamps on marks (Phase 2) | n/a |
| Agent (Claude or any MCP client) | Read pages, organize, bookmark, mark, foot, export — through the same model the UI drives | NO filesystem access by default; only folders explicitly named in `WPT_MCP_ROOTS`. Reading page text/OCR puts client *content* in a model's context — an IRC §7216 disclosure decision the tool does not make for the user |
| Design partner (beta) | Run signed builds on Windows, report friction | Never receives builds containing Charlie's client data; fixtures only |

## Goals

- Phase 0 spike proves portable annotations on real tax-software PDFs (the stage gate) within 2–4 days of part-time work
- Phase 1 delivers a binder organizer Charlie uses on his own real workpapers (dogfooding = the success test)
- An agent can build a real binder end to end — read the sources, order them, name them, mark them — with the preparer supervising rather than typing coordinates
- Agent work is defensible in a file review: attributed, journaled, and revertible, with automated marks distinguishable from a person's in the exported PDF
- Bookmarks/marks provably follow pages through any reorder — the headline feature vs. GUI tools
- Exported binders pass `qpdf --check` and render identically in 4 viewers (Acrobat, Edge, Chrome, Preview)
- Total spend through Phase 1 stays part-time (~2 weeks) — does NOT raid August income-replacement work

## Non-goals

- NOT an Acrobat replacement — no text/image editing, redaction, forms, signatures, comparison
- **OCR is read-only, and only so an agent can see a scan.** It is not a document-production feature: nothing writes a searchable text layer into an exported binder, and OCR output is always labelled a machine reading with confidence, never presented as the document's own text
- **Spreadsheets are rendered for data, not for fidelity** — a clean legible grid, not Excel's print layout. No merged-cell art, conditional formatting, or charts; print those to PDF first
- No cloud, no collaboration, no accounts, no telemetry that touches document content — local-only is a *feature* (§7216/Safeguards story). Live agent access is a LOCAL socket, off by default, never a network port
- **The AI tie-out layer itself is still not built** — matching figures across workpapers and flagging what does not foot. Everything it needs now exists (structured tapes, addressable figures, attribution), but the layer is a post-gate bet
- No Word, email, or scanned-to-searchable ingestion yet
- No commercial packaging/pricing decisions until the Phase 1 business gate

## MVP scope

- **Phase 0 (committed):** compatibility spike per `references/source-materials.md` — appearance streams, already-annotated imports, sidecar-survives-AV, 4-viewer matrix, `qpdf --check`
- **Phase 1 (committed):** import/drag-drop → thumbnail rail → reorder/rotate/delete → filename bookmarks (nested under file-level bookmarks) → stable page IDs → session save/reopen → export merged binder
- Vertical-slice checkpoint: two real PDFs in, reorder, one tick mark + one tape, export, verify in all viewers — on both platforms from the same source
- **Built past the original scope, at Charlie's direction (see `ROADMAP.md` for dates and detail):** review marks · calculator tape · drawn annotations · page status/numbering · images as pages · **spreadsheets as pages** · MCP agent access · **page text + OCR so an agent can read** · **agent attribution, journal and revert** · **live agent access to the open binder**

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
| ~~Real product name~~ | — | **Resolved 2026-08-05** | **LedgerPDF**, published by Ledger Labs LLC, bundle id `co.ledgerlabs.ledgerpdf`. Chosen for instant legibility to a CPA and family fit with the publisher; the accepted trade is that it is descriptive and therefore a weak mark — screen against Ledger SAS's Class 9 registrations before filing. Rejected with evidence in `references/naming-brief.md`: Tickmark (three companies in audit/tax software), Quire (established SaaS), Crossfoot (disliked). The identifier is only free to change until someone installs a build. |
| Sidecar packaging: PyInstaller vs Nuitka vs qpdf-CLI-only | Phase 5 | No (dev runs from the venv) | Decided by AV/SmartScreen behavior on the real Windows box |
| ~~Commercial PDF SDK fallback needed?~~ | — | **Resolved 2026-07-27: No** | pikepdf/qpdf produced portable annotations in both pdfium and PDFKit; stage gate passed |
| Real Windows x64 test hardware | Charlie | No (Phase 1), Yes (beta) | Mini PC vs. a design partner's workstation |
| Which 2–3 TCR members are the design partners | Charlie | No | From the TCR thread responses; confirm before Phase 2 |
| Business model if gate passes | Charlie | No | Decide WITH August revenue data, not before |
```
