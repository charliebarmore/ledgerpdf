# Acrobat conformance checklist

Two independent engines (pdfium and poppler) already agree on every mark's
position — run `npm run verify:viewers`. This checklist covers the one thing
that cannot be automated: **Adobe Acrobat**, the viewer recipients actually use.

It takes about two minutes.

**macOS / Linux**

```bash
engine/.venv/bin/python spike/make_conformance.py
open -a "Adobe Acrobat" spike/out/conformance.pdf
```

**Windows (PowerShell)**

```powershell
engine\.venv\Scripts\python spike\make_conformance.py
start spike\out\conformance.pdf
```

`start` hands the file to whatever owns `.pdf`, which on Windows is often Edge.
This checklist is specifically about Acrobat, so confirm the title bar says so —
otherwise right-click the file and **Open with → Adobe Acrobat**.

Set the zoom to **Fit Page** (⌘0 on macOS, Ctrl+0 on Windows) and step through
with Page Down.

Everything below is synthetic fixture data. No client documents are involved.

---

## Page 1 — normal page (612 × 792)

- [ ] **Green tick** at the upper left, about a quarter across and a quarter down.
- [ ] **Blue `F`** at the same height, three quarters across.
- [ ] **Red rectangle** in the lower half, its centre about 40% across and 70% down.
- [ ] `WP-0001` in the bottom-right corner.

## Page 2 — CropBox ≠ MediaBox

This is the trap: the page's visible sheet is smaller than its media box.

- [ ] **Green tick** ~30% across, ~30% down **of the visible sheet** — not floating
      off the edge, and not offset by the crop margin.
- [ ] **Red ellipse** in the lower right, centre ~70% / ~70%.
- [ ] `WP-0002` inside the visible sheet, not clipped.

## Page 3 — `/Rotate 90`

Rotation compensation lives in the appearance `/Matrix`; this is where it shows.

- [ ] The page displays **landscape**.
- [ ] **Green tick is upright** — not lying on its side.
- [ ] Tick ~25% across, ~75% down of the displayed (landscape) frame.
- [ ] **Red rectangle** upright, centre ~65% / ~35%.
- [ ] `WP-0003` upright in the bottom-right of the displayed frame.

## Page 4 — legal size, with pre-existing annotations

The source page already carries a red square and a text note. They must survive.

- [ ] The source's **own red square and note are still present**.
- [ ] **Calculator tape** upper left, its brown-bordered card centred ~30% / ~30%,
      columns aligned: `1 - 1 | | 1,200.00 | +` over `1 - T | Total | 1,200.00 | *`.
- [ ] **Blue arrow**, head at the upper right end.
- [ ] **Yellow highlight** band near the bottom — the text under it still readable
      (it is a multiply blend, not an opaque fill).
- [ ] **Text note** box reading "Agreed to the general ledger.", wrapped inside its box.

## Page 5 — page status

- [ ] **Green border** around the whole visible sheet.
- [ ] **Status stamp** upper right: `ABC` over `7/31/2026 …`, in a rounded green box
      on a white card.

## Page 6 — flattened twin of page 1

Same marks as page 1, but burned into page content rather than annotations.

- [ ] Looks **identical to page 1**.
- [ ] Open the **Comments** panel: page 6 lists **no comments** (the marks are
      content now), while page 1 lists four.

## Bookmarks panel

- [ ] Six bookmarks, one per page.
- [ ] **"Normal page" is green and bold**; **"Rotated page" is red and bold**;
      the rest are plain black.

## Overall

- [ ] Acrobat reports **no errors or repair prompts** on open.
- [ ] The Comments panel totals **24** — our 22 annotations plus the 2 the source
      fixture already carried.

---

If anything here is off, note the page and what you saw. A mark landing in the
wrong place in Acrobat while pdfium and poppler agree would point at our
`/Matrix` or `/BBox` handling, and that is a correctness bug, not cosmetics.
