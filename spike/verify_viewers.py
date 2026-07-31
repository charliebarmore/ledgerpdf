"""Check the conformance binder in two INDEPENDENT render engines.

pdfium is what Chrome and Edge use. poppler is an unrelated codebase entirely.
If a mark lands in the same place in both, the geometry is a property of the
PDF rather than of one renderer's interpretation of it — which is the only kind
of claim worth making about a document that becomes a client record.

Neither engine is shipped. Both are invoked as dev-only tools, the same posture
as pypdfium2 in the existing harness; the MuPDF/AGPL guard in the engine
requirements is untouched.

    engine/.venv/bin/python spike/verify_viewers.py

Exit 0 if every expected mark is within tolerance in BOTH engines.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import pypdfium2 as pdfium
from PIL import Image

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "spike"))

from make_conformance import EXPECTED, build  # noqa: E402

TOLERANCE = 0.03  # fraction of the page's width/height


def mask_for(img: np.ndarray, color: str) -> np.ndarray:
    r = img[:, :, 0].astype(int)
    g = img[:, :, 1].astype(int)
    b = img[:, :, 2].astype(int)
    if color == "green":
        return (g > 90) & (g > r + 30) & (g > b + 30)
    if color == "blue":
        return (b > 90) & (b > r + 30) & (b > g + 20)
    if color == "red":
        return (r > 120) & (r > g + 60) & (r > b + 60)
    if color == "brown":
        return (r > 100) & (r > g + 30) & (g > b + 20)
    raise SystemExit(f"unknown colour {color!r}")


def centroid(mask: np.ndarray) -> tuple[float, float, int] | None:
    ys, xs = np.nonzero(mask)
    if len(xs) < 15:
        return None
    h, w = mask.shape
    return (float(xs.mean()) / w, float(ys.mean()) / h, int(len(xs)))


def render_pdfium(path: str, index: int) -> np.ndarray:
    doc = pdfium.PdfDocument(path)
    try:
        return np.asarray(doc[index].render(scale=2.0, draw_annots=True).to_pil().convert("RGB")).copy()
    finally:
        doc.close()


def render_poppler(path: str, index: int) -> np.ndarray:
    """poppler via pdftoppm. `-r 144` matches pdfium's scale=2.0 (72dpi base)."""
    with tempfile.TemporaryDirectory() as tmp:
        stem = Path(tmp) / "page"
        subprocess.run(
            ["pdftoppm", "-png", "-r", "144", "-f", str(index + 1), "-l", str(index + 1),
             path, str(stem)],
            check=True, capture_output=True,
        )
        pngs = sorted(Path(tmp).glob("page*.png"))
        if not pngs:
            raise SystemExit("pdftoppm produced no output")
        return np.asarray(Image.open(pngs[0]).convert("RGB")).copy()


ENGINES = {"pdfium": render_pdfium, "poppler": render_poppler}


def main() -> int:
    info = build()
    if info["problems"]:
        print(f"FAIL  qpdf reported: {info['problems']}")
        return 1
    print(f"built {info['pages']}-page conformance binder\n")

    failures = 0
    for label, path in (("annotated", info["output"]), ("flattened", info["flat_output"])):
        for page, wants in sorted(EXPECTED.items(), key=lambda kv: kv[0]):
            # The flattened file is the same binder; page 6 is the flattened twin
            # of page 1, so only assert the pages that carry marks either way.
            for engine, render in ENGINES.items():
                img = render(path, page)
                for color, nx, ny in wants:
                    got = centroid(mask_for(img, color))
                    if got is None:
                        print(f"FAIL  {label} p{page + 1} {engine:8} {color}: not found")
                        failures += 1
                        continue
                    cx, cy, n = got
                    ok = abs(cx - nx) < TOLERANCE and abs(cy - ny) < TOLERANCE
                    failures += 0 if ok else 1
                    print(
                        f"{'PASS' if ok else 'FAIL'}  {label} p{page + 1} {engine:8} "
                        f"{color:6} placed ({nx:.2f},{ny:.2f}) -> ({cx:.3f},{cy:.3f}) px={n}"
                    )

    print()
    if failures:
        print(f"{failures} check(s) FAILED")
    else:
        print("every mark lands in the same place in pdfium AND poppler")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
