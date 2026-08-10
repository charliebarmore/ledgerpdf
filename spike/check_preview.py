"""macOS Preview-engine verification (Phase 0 gate item).

macOS Preview is built on **PDFKit**, so driving PDFKit directly is the closest
automatable proxy for "does this render in Preview" — and, more importantly, for
the risk named in the technical review: *Preview rewrites PDFs on save and is a
notorious annotation-mangler.*

Two things are checked:
  1. RENDER — PDFKit sees our annotations and paints their appearance streams
     (tick on a flat page, tick on a /Rotate 90 page, calculator tape).
  2. ROUND-TRIP — re-saving through PDFKit (what Preview does on ⌘S) preserves
     our marks, the private /WPT_Data tape payload, bookmarks, and link targets.

macOS-only. Run:  engine/.venv/bin/python spike/check_preview.py
Exit: 0 = pass, 1 = at least one failure.
"""

from __future__ import annotations

import io
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
from Foundation import NSMakeSize, NSURL
from PIL import Image
from Quartz import PDFDocument, kPDFDisplayBoxCropBox

SPIKE = Path(__file__).resolve().parent
ROOT = SPIKE.parent
ENGINE_DIR = ROOT / "engine"
BINDER = SPIKE / "out" / "binder.pdf"
RESAVED = SPIKE / "out" / "binder_preview_resaved.pdf"

RESULTS: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    RESULTS.append((name, bool(ok), detail))


# ------------------------------------------------------------------ helpers

def engine_cli(command: dict) -> dict:
    proc = subprocess.run(
        [sys.executable, "-m", "workpaper_engine.cli"],
        input=json.dumps(command).encode(),
        capture_output=True,
        cwd=ENGINE_DIR,
        env={"PYTHONPATH": str(ENGINE_DIR), "PATH": "/usr/bin:/bin"},
        timeout=120,
    )
    try:
        return json.loads(proc.stdout.decode().strip())
    except json.JSONDecodeError:
        return {"ok": False, "error": proc.stdout.decode()[:300] + proc.stderr.decode()[:300]}


def open_doc(path: Path) -> PDFDocument:
    url = NSURL.fileURLWithPath_(str(path))
    doc = PDFDocument.alloc().initWithURL_(url)
    if doc is None:
        raise RuntimeError(f"PDFKit could not open {path}")
    return doc


def render_via_pdfkit(doc: PDFDocument, index: int, scale: float = 1.6) -> np.ndarray:
    """Render a page the way Preview draws it (annotations included)."""
    page = doc.pageAtIndex_(index)
    bounds = page.boundsForBox_(kPDFDisplayBoxCropBox)
    # bounds is ((x, y), (w, h)); rotation is applied by PDFKit for display.
    w = bounds[1][0] * scale
    h = bounds[1][1] * scale
    if page.rotation() % 180 == 90:
        w, h = h, w
    image = page.thumbnailOfSize_forBox_(NSMakeSize(w, h), kPDFDisplayBoxCropBox)
    tiff = image.TIFFRepresentation()
    pil = Image.open(io.BytesIO(bytes(tiff))).convert("RGB")
    return np.asarray(pil).copy()


def green_centroid(img: np.ndarray) -> tuple[float, float, int]:
    r, g, b = (img[:, :, i].astype(int) for i in range(3))
    mask = (g > 110) & (g > r + 35) & (g > b + 35)
    ys, xs = np.nonzero(mask)
    if len(xs) < 20:
        return (-1.0, -1.0, len(xs))
    h, w = mask.shape
    return (float(xs.mean()) / w, float(ys.mean()) / h, int(len(xs)))


def annot_types(doc: PDFDocument, index: int) -> list[str]:
    page = doc.pageAtIndex_(index)
    out = []
    for a in page.annotations() or []:
        t = a.type()
        out.append(str(t) if t is not None else "?")
    return out


# --------------------------------------------------------------------- main

def main() -> int:
    if not BINDER.exists():
        print(f"missing {BINDER} — run spike/run_spike.py first")
        return 1

    # Guard: if the binder was mutated since run_spike.py produced it, every
    # geometry assertion below is meaningless. The known cause is opening it in
    # the macOS Preview *app*, which rewrites the file in place.
    import hashlib

    fingerprint = BINDER.parent / "binder.sha256"
    if fingerprint.exists():
        want = fingerprint.read_text().strip()
        got = hashlib.sha256(BINDER.read_bytes()).hexdigest()
        if want != got:
            print(
                "ABORT: binder.pdf has changed since run_spike.py generated it.\n"
                "  Most likely cause: it was opened in the macOS Preview app, which\n"
                "  rewrites PDFs in place. Regenerate a clean one:\n"
                "    engine/.venv/bin/python spike/run_spike.py"
            )
            return 1

    doc = open_doc(BINDER)
    check("PDFKit opens binder", doc.pageCount() == 6, f"pageCount={doc.pageCount()}")

    # --- 1. PDFKit sees our annotations
    check(
        "PDFKit sees tick on flat page (idx 0)",
        "Stamp" in annot_types(doc, 0), f"idx0 types={annot_types(doc, 0)}",
    )
    check(
        "PDFKit sees legacy annots on moved page (idx 1)",
        {"Square", "Text"} <= set(annot_types(doc, 1)), f"idx1 types={annot_types(doc, 1)}",
    )
    check(
        "PDFKit sees tape (idx 2)",
        "Stamp" in annot_types(doc, 2), f"idx2 types={annot_types(doc, 2)}",
    )
    check(
        "PDFKit sees link (idx 0)",
        "Link" in annot_types(doc, 0), f"idx0 types={annot_types(doc, 0)}",
    )

    # --- 2. PDFKit paints the appearance streams (this is the Preview render)
    cx, cy, n = green_centroid(render_via_pdfkit(doc, 0))
    check(
        "Preview renders tick, flat page",
        n >= 20 and abs(cx - 0.75) < 0.04 and abs(cy - 0.25) < 0.04,
        f"centroid ({cx:.3f},{cy:.3f}) px={n} vs target (0.75,0.25)",
    )

    img4 = render_via_pdfkit(doc, 4)
    check(
        "Preview renders rotated page landscape",
        img4.shape[1] > img4.shape[0], f"{img4.shape[1]}x{img4.shape[0]}",
    )
    cx, cy, n = green_centroid(img4)
    check(
        "Preview renders tick, /Rotate 90 page",
        n >= 20 and abs(cx - 0.75) < 0.04 and abs(cy - 0.25) < 0.04,
        f"centroid ({cx:.3f},{cy:.3f}) px={n} vs target (0.75,0.25)",
    )

    img2 = render_via_pdfkit(doc, 2)
    h, w = img2.shape[:2]
    region = img2[int(0.54 * h):int(0.70 * h), int(0.48 * w):int(0.72 * w)]
    dark = int(np.count_nonzero(np.all(region < 120, axis=2)))
    check("Preview renders calculator tape", dark > 40, f"dark px in tape region: {dark}")

    # --- 3. Round-trip: re-save through PDFKit == Preview's ⌘S
    wrote = doc.writeToFile_(str(RESAVED))
    check("PDFKit re-saves the binder", bool(wrote) and RESAVED.exists(), str(RESAVED))
    if not wrote:
        return report()

    probe = engine_cli({"cmd": "probe", "path": str(RESAVED)})
    check("re-saved file still parses", probe.get("ok", False), probe.get("error", "")[:200])
    if not probe.get("ok"):
        return report()
    pages = probe["probe"]["pages"]
    outline = probe["probe"]["outline"]

    marks = [a for p in pages for a in p["annotations"] if a.get("wpt_kind")]
    check(
        "marks survive Preview save", len(marks) == 3,
        f"{len(marks)}/3 WPT marks found: {[m['wpt_kind'] for m in marks]}",
    )

    tapes = [m for m in marks if m["wpt_kind"] == "tape"]
    tape_ok = bool(tapes) and tapes[0].get("wpt_data", {}).get("total") == "1150.00"
    check(
        "private /WPT_Data tape payload survives", tape_ok,
        json.dumps(tapes[0].get("wpt_data") if tapes else None)[:160],
    )

    have_ap = all(m["has_ap"] for m in marks)
    check("appearance streams survive", have_ap, f"has_ap={[m['has_ap'] for m in marks]}")

    def flat(nodes, d=0):
        for n in nodes:
            yield (d, n["title"], n["dest_page"])
            yield from flat(n["children"], d + 1)

    got = list(flat(outline))
    want = [
        (0, "TaxForm-A.pdf", 0),
        (0, "SupportSchedules-B.pdf", 1),
        (1, "Schedule X", 2),
        (2, "Detail X-1", 4),
        (1, "Schedule Y", 4),
    ]
    check("bookmarks survive Preview save", got == want, f"got={got}")

    links = [a for a in pages[0]["annotations"] if a["subtype"] == "/Link"]
    check(
        "internal link target survives", len(links) == 1 and links[0].get("dest_page") == 2,
        f"dest_page={[l.get('dest_page') for l in links]}",
    )

    legacy = [a["subtype"] for a in pages[1]["annotations"]]
    check(
        "legacy annots survive Preview save",
        "/Square" in legacy and "/Text" in legacy, f"idx1={legacy}",
    )

    # --- 4. What exactly did the save change? (Preview is known to rewrite.)
    orig = engine_cli({"cmd": "probe", "path": str(BINDER)})["probe"]["pages"]

    rot_before = [p["rotate"] for p in orig]
    rot_after = [p["rotate"] for p in pages]
    check(
        "page /Rotate preserved through save", rot_before == rot_after,
        f"before={rot_before} after={rot_after}",
    )

    def stamp_rects(pgs):
        return [
            [round(v, 1) for v in a["rect"]]
            for p in pgs for a in p["annotations"] if a.get("wpt_kind")
        ]

    rb, ra = stamp_rects(orig), stamp_rects(pages)
    check(
        "mark /Rect unmoved through save", rb == ra,
        f"before={rb} after={ra}",
    )

    return report()


def report() -> int:
    print("\n=== macOS Preview (PDFKit) verification ===")
    fails = 0
    for name, ok, detail in RESULTS:
        if not ok:
            fails += 1
        print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f"  — {detail}" if detail else ""))
    print(f"\n{len(RESULTS) - fails}/{len(RESULTS)} checks passed")
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
