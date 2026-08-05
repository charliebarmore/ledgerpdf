# Phase 0 Compatibility Spike — Results

**2026-07-27 · 20/20 engine + render checks · 19/19 macOS Preview-engine checks · STAGE GATE: PASS**

The spike proves the canonical architecture end-to-end with zero UI: JSON binder
spec → sidecar CLI → pikepdf/qpdf engine → single portable PDF, verified
structurally (pikepdf + `qpdf --check`) and visually in **two independent render
engines** — pdfium (what Chrome and Edge use) and PDFKit (what macOS Preview uses).

## What passed

| Criterion | Evidence |
|---|---|
| C1 open/parse tax-style PDFs | probe over CLI: pages, boxes, rotation, outline all read |
| C2 tick appearance, flat + rotated, CropBox-normalized | pixel centroid **(0.750, 0.250)** vs target (0.75, 0.25) — in *both* pdfium and PDFKit, on *both* flat and `/Rotate 90` pages; glyph stays upright via AP `/Matrix`; CropBox honored (render ratio 0.7727 = CropBox, ≠ MediaBox 0.7778) |
| C3 calculator tape + private metadata | renders in both engines; `/WPT_Data` JSON round-trips intact |
| C4 merge/reorder, stable page IDs | 6 pages interleaved from 2 sources; per-page provenance signatures verified at each final index |
| C5 bookmarks preserved/rebuilt, imported outlines nested | file-level bookmarks + fixture B's own outline nested and retargeted through the shuffle |
| C6 internal hyperlink | `/Dest` resolves to the moved target page (final index 2) |
| C7 pre-existing annotations survive | legacy Square + Text note intact on the relocated page, `/P` repointed |
| C8 validation | engine syntax check clean; authentic `qpdf --check` exit 0; pixel assertions in pdfium **and** PDFKit |
| C9 spawnable sidecar | every engine call runs as `python -m workpaper_engine.cli`, JSON-over-stdio, exactly as Electron will spawn it |

## ⚠️ Finding: the macOS Preview *app* rewrites PDFs in place

Discovered live during this spike. Two different things must not be conflated:

- **PDFKit's programmatic save is lossless.** `PDFDocument.writeToFile_` preserved
  everything we care about: page `/Rotate`, annotation `/Rect` values (unmoved to
  0.1pt), appearance streams, the private `/WPT_Data` tape payload, the nested
  bookmark tree, link destinations, and third-party legacy annotations. 19/19.
- **The interactive Preview app is destructive.** After `open -a Preview binder.pdf`,
  the file on disk had been rewritten with no explicit save action. Observed damage:
  `/Rotate 90` → `0` (rotation flattened into content), the tick's `/Rect` moved
  from `[447, 582, 471, 606]` → `[472.22, 684.91, 498.22, 710.91]`, its appearance
  `/Matrix` dropped, `/BBox` grown 24→26, and the appearance stream re-authored with
  a clip path and a `/Cs1` named colorspace we never wrote.

Attribution is **inferred, not directly observed**: the mtime advanced after the
spike wrote the file, Preview was the only application that opened it, and the
damage signature (full Quartz re-generation rather than an incremental update) is
not what PDFKit's own writer produces. Worth a deliberate 30-second reproduction
on the Mac to confirm.

**Product implications** (tracked in ROADMAP):
- A workpaper binder is a *record*. Users casually opening one in Preview on a Mac
  can silently alter it. Warrants a documented warning and possibly guidance to
  keep the canonical binder in the app, exporting copies for distribution.
- Never treat a Preview-touched file as canonical or as a test fixture.
- **The guard:** `run_spike.py` now writes `spike/out/binder.sha256`, and
  `check_preview.py` aborts loudly if the binder changed since generation. This
  cost real debugging time once (every geometry assertion failed against a file
  nobody thought had changed) — it won't again.

## How to re-run

```bash
engine/.venv/bin/python spike/run_spike.py       # fixtures + binder + 20 checks
engine/.venv/bin/python spike/check_preview.py   # macOS Preview engine, 19 checks
```

On Windows the venv is `Scripts\` rather than `bin/`, and `check_preview.py`
does not apply — it drives the macOS Preview engine:

```powershell
engine\.venv\Scripts\python spike\run_spike.py
```

Outputs land in `spike/out/`. Fixtures are synthetic — **no client data, ever**.
If `check_preview.py` aborts on the hash guard, just re-run `run_spike.py`.

## Viewer matrix

| Viewer | Engine | Status |
|---|---|---|
| Chrome / Edge | pdfium | ✅ automated (pixel assertions) |
| macOS Preview | PDFKit | ✅ automated (pixel assertions + lossless save round-trip) |
| Acrobat Reader (Windows) | Acrobat | ⏳ needs the real Windows x64 box |
| Edge (Windows, real device) | pdfium | ⏳ same box — engine already covered above |

## Deferred to Phase 1+ (tracked in ROADMAP)

- **Sidecar packaging** (PyInstaller/Nuitka) + AV/SmartScreen survival on real
  Windows hardware — the packaging choice stays open until that test runs
- Windows CI builds (GitHub Actions) once there's an app shell to build
- Regression corpus additions: 270° rotation, multi-page tape overflow, encrypted
  sources, and real tax-software output (Drake/Lacerte/UltraTax) as dogfood arrives
