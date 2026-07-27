# Source Materials — Canonical Spec & Technical Review

Captured 2026-07-27 from the planning conversation. Two artifacts: (1) the Codex-generated build spec, (2) Charlie/Claude's technical review with six accepted pushbacks. Together these are the canonical spec. Where they conflict, **the review's pushbacks win** — they were accepted as amendments.

---

## Artifact 1 — Codex spec (as amended)

### Product definition

Windows + macOS local desktop **"tax workpaper binder"** — NOT an Acrobat replacement. Defining workflow:

> Import PDFs → organize pages → create bookmarks → review with tick marks/tapes/links → export one portable PDF.

### MVP boundary

**Include:** import multiple PDFs · page thumbnails · reorder/rotate/delete pages · merge into one binder · bookmarks generated from filenames · bookmarks that remain attached when pages move · tick marks + custom stamps · calculator tape · internal page hyperlinks + external web links · undo/redo · autosaved working session · "Save As" export that never modifies source files · annotations visible in Acrobat Reader, Edge, Chrome (+ macOS Preview per review).

**Exclude (later decisions, not unfinished MVP):** editing existing PDF text/images · OCR · redaction · forms & signatures · e-signatures · document comparison · cloud storage/collaboration · AI tie-out · mobile · cross-file links outside the exported binder.

### Architecture

```
Electron desktop shell
  ├── React/TypeScript interface (PDF viewer, thumbnail organizer, annotation overlay, calculator tape)
  ├── PDF.js rendering (renderer only — NOT the source of truth)
  └── Local PDF engine sidecar (pikepdf/qpdf): merge/reorder, bookmarks, annotations, validated export
```

- **Electron over Tauri** for v1 (fastest route to a polished PDF.js interface). Renderer sandboxed; filesystem isolated behind narrow IPC per Electron security guidance.
- **pikepdf/qpdf as engine** — qpdf handles damaged/encrypted documents far better than browser-only libs. **pdf-lib rejected as core engine** (its repo warns encrypted PDFs are unsupported — unacceptable for tax docs).
- Engine ↔ Electron interface: platform-neutral JSON commands (sidecar process).

### The internal model (load-bearing design decision)

- Every imported page gets a **permanent internal ID** (`page_01f3 → source.pdf, original page 7`). Bookmarks, tick marks, tapes, hyperlinks, comments all point at the ID. Visible page numbers are computed only at export → page moves carry everything with them automatically.
- Annotations stored with **coordinates normalized 0–1** (survives zoom, rotation, mixed page sizes, high-DPI). *(Amended: normalize against CropBox, not MediaBox — see review.)*
- Calculator tape is **structured data while editing**; on export it becomes a standard PDF annotation with a generated appearance stream + embedded private metadata so our app can reopen/edit it while ordinary viewers still display it.
- **PDF is materialized only at export; the working session = JSON + untouched source files.** Undo/redo operates on the internal model. "Never modifies source files" is free. Eliminates incremental-save corruption.

### Build phases

- **Phase 0 — Compatibility spike (2–4 days).** Prove on REAL tax-software output (not clean samples): open/render a real tax PDF · place tick mark on rotated + unrotated pages · export as standard annotation · merge + reorder · preserve/rebuild bookmarks · working internal hyperlink · result opens in Acrobat/Edge/Chrome (+ Preview) · passes `qpdf --check`. **Stage gate: if annotations can't be made reliably portable, evaluate a commercial PDF SDK before continuing.**
- **Phase 1 — Binder organizer (~1 wk).** Import + drag-drop · multi-doc thumbnail rail · reorder/rotate/delete · filename bookmarks · stable page identities · save/reopen session · export merged PDF.
- **Phase 2 — Review marks (~1 wk).** Tick-mark palette · custom stamps · click-to-place · select/move/resize/delete · keyboard shortcuts · reviewer initials + timestamp metadata · undo/redo.
- **Phase 3 — Calculator tape (~1 wk).** Keyboard-first calculator · running tape · subtotals/totals · edit previous entries · drop tape onto page · reopen/edit existing tape · copy final value · consistent printed appearance. *Exact behavior from observing intended users ~30 min (per review: screen-share with 2–3 TCR members driving TicTie).*
- **Phase 4 — Links & navigation (3–5 days).** Link text/rectangle to another binder page · external URLs · jump-to-target preview · broken-link detection after deletion · hideable link indicator for printing.
- **Phase 5 — Hardening (≥2 wks).** Crash recovery · atomic saves · large-doc performance · password prompt for encrypted files · corrupt-doc handling · existing-annotation preservation · output validation · installers + code signing · auto-updates · regression corpus · power-loss/interrupted-save testing.

### Cross-platform plan (Mac + Windows)

- Develop/test daily on Charlie's Mac (Apple Silicon); GitHub Actions builds native Windows x64 installer + runs automated tests on every change (Electron Forge: build each platform on its native OS, no cross-compiling).
- Initial targets: macOS Apple Silicon + Windows 11 x64. Intel Mac only if users need it; Windows ARM waits.
- Three test layers: daily Mac · automated Windows CI · **real Windows x64 acceptance machine before firm use** (Apple Silicon VM = Windows ARM ≠ sufficient; cheap mini PC or a design partner's workstation).
- Day-one cross-platform accounting: Cmd vs Ctrl · menu conventions · paths/drive letters/long paths · Retina vs Windows scaling · drag-drop differences · file locking · print dialogs · AV interference with temp files · forced-termination recovery · path case-sensitivity.
- Engine sidecar needs native builds for both OSes; JSON interface keeps PDF behavior identical.

### Realistic lift (one experienced builder, AI-heavy)

Technical proof <1 wk · cross-platform spike 3–5 days · useful Mac+Windows personal alpha ~6–8 FT weeks · firm-ready beta ~3–4 months total · commercial product 6–12 months + permanent support.

**First serious checkpoint = vertical slice, not a pretty shell:** import two real PDFs, reorder pages, place one tick mark + one calculator tape, export, verify in three unrelated viewers (+ Preview). Both platforms must produce functionally equivalent exports from the same source. Real client documents stay off CI — local testing only.

---

## Artifact 2 — Technical review (six accepted pushbacks + adds)

**Agreements worth preserving:** the internal model (stable page IDs + normalized coords + own annotation store) is the best decision in the spec and the seam the future AI tie-out layer plugs into; export-only PDF materialization is load-bearing; pdf-lib rejection correct; Phase 0 stage gate + vertical-slice checkpoint правильно framed.

1. **Python sidecar cost is underplayed.** pikepdf = Python inside an Electron app → compiled sidecar binary (PyInstaller/Nuitka), two build toolchains, fatter installers, and **PyInstaller binaries are Windows Defender/SmartScreen false-positive magnets, especially unsigned.** Phase 0 must include: prove the sidecar builds, spawns, and survives AV on a real Windows box. License note: pikepdf (MPL) + qpdf (Apache) + PDF.js (Apache) is the license-clean stack; **MuPDF/mutool is AGPL — a trap if commercial. Never swap it in.**
2. **Appearance streams are the real Phase 0 risk; add macOS Preview to the viewer matrix.** Placing annotations is easy; making tick marks/stamps/tapes render identically everywhere means hand-authoring appearance streams (no pikepdf high-level helper). Weight the spike toward this. Preview is a notorious annotation-mangler that rewrites PDFs on save — it's in the gate. Also in the spike (not Phase 5): **importing PDFs that already carry annotations** (client-signed forms, prior-year marked workpapers) and surviving merge/reorder. Coordinate nit: **normalize against CropBox, not MediaBox** — tax-software output with mismatched boxes offsets every mark otherwise.
3. **Windows code signing moves earlier.** Design partners are mostly Windows firms; unsigned installer + unsigned PyInstaller sidecar = SmartScreen warnings + quarantined binaries → testers churn and the trust brand takes the hit. Azure Trusted Signing (~$10/mo) **before the first external Windows beta**, not Phase 5.
4. **Local-only compliance is a hard requirement and the moat.** Client data never leaves the machine → §7216/Safeguards story, WISP-friendly. Engineering requirements: no telemetry containing document content · scrubbed crash reports · session/autosave files (which contain client data) stored in user-chosen location outside cloud-sync folders · **never persist PDF passwords in plaintext in session files** · ship a one-page data-flow doc with the beta.
5. **Design for "me + 2–3 TCR design partners," not one user.** Version the session-file format early (it will churn; breaking testers' binders burns goodwill). Make the Phase 3 observation literal: screen-share watching two members drive TicTie before building the tape. The tape's keyboard feel is make-or-break for this audience.
6. **Strategic sequencing (the big one).** Charlie's last day at Nino is 2026-07-31; August income replacement (advisory sprints + cohort) is the plan of record. **Commit only to Phase 0 + Phase 1 now (~2 weeks part-time).** The Phase 2+ decision happens after the vertical slice as a BUSINESS call with August revenue data in hand — the stage gate covers the business question, not just the technical one.

**Two adds for the PRD:** flatten-on-export option (burn marks into page content — needed the first time a binder leaves the building) · nest imported files' existing bookmarks under each file-level bookmark (TicTie users expect it; Phase 1.5).

**Strategic framing:** matching TicTie feature-for-feature is table stakes. The eventual differentiator is the **AI tie-out layer** (auto-match numbers across workpapers and place the marks; auto-generate tapes from source docs; flag what doesn't foot before the reviewer looks). Excluded from MVP, but the internal model is deliberately the seam it plugs into. Wedge vs. TicTie: TTC requires Adobe Acrobat on top of its own ~$150/user/yr — an Adobe-free tool removes both fees.
