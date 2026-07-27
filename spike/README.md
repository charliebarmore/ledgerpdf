# Phase 0 Compatibility Spike — Results

**Run 2026-07-27 · 20/20 automated checks passed · STAGE GATE: PASS (pending manual viewer matrix)**

The spike proves the canonical architecture end-to-end with zero UI: JSON binder
spec → sidecar CLI → pikepdf/qpdf engine → single portable PDF, verified
structurally (pikepdf + `qpdf --check`) and visually (pdfium — the same render
engine as Chrome and Edge).

## What passed

| Criterion | Evidence |
|---|---|
| C1 open/parse tax-style PDFs | probe over CLI: pages, boxes, rotation, outline all read |
| C2 tick appearance, flat + rotated, CropBox-normalized | pixel centroid **(0.750, 0.250)** vs target (0.75, 0.25) on both; glyph upright on /Rotate 90 via AP /Matrix; CropBox honored (render ratio 0.7727 = CropBox, ≠ MediaBox 0.7778) |
| C3 calculator tape + private metadata | tape renders (card/border/Courier); `/WPT_Data` JSON round-trips intact |
| C4 merge/reorder, stable page IDs | 6 pages interleaved from 2 sources; provenance signatures verified per final index |
| C5 bookmarks preserved/rebuilt, imported outlines nested | file-level bookmarks + fixture B's own outline nested and retargeted through the shuffle |
| C6 internal hyperlink | /Dest resolves to the moved target page (final index 2) |
| C7 pre-existing annotations survive | legacy Square + Text note intact on the relocated page, /P repointed |
| C8 validation | engine syntax check clean; authentic `qpdf --check` exit 0; pdfium (≈Chrome/Edge) renders verified by pixel assertions |
| C9 spawnable sidecar | every engine call in this spike ran as `python -m workpaper_engine.cli`, JSON-over-stdio, as Electron will spawn it |

## How to re-run

```bash
engine/.venv/bin/python spike/run_spike.py     # regenerates fixtures + binder, re-asserts
```

Output: `spike/out/binder.pdf` (+ `page*.png` renders). Fixtures are synthetic —
no client data, ever.

## Manual viewer matrix (remaining)

| Viewer | Status | How |
|---|---|---|
| Chrome / Edge (pdfium) | ✅ automated | pixel checks in the harness |
| macOS Preview | ⏳ **manual — do now** | `open -a Preview spike/out/binder.pdf` — verify ticks/tape visible, bookmarks panel correct, link jumps, then Save a copy and re-run probe to confirm Preview didn't mangle the annotations |
| Acrobat Reader (Windows) | ⏳ deferred | needs the real Windows x64 box |
| Edge (Windows, real) | ⏳ deferred | same box |

## Deferred to Phase 1+ (tracked)

- **Sidecar packaging** (PyInstaller/Nuitka) + AV/SmartScreen survival on real Windows hardware — the packaging decision is *open* until that test runs
- Windows CI builds (GitHub Actions) once there's an app shell to build
- Appearance edge cases for the regression corpus: 270° rotation fixture, multi-page tape overflow, encrypted sources
