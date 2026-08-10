"""Verify that a mark lands in the exported PDF where the UI showed it.

This is the Phase 2 correctness property: the app places marks in normalized
display coordinates, and the engine converts them to PDF user space using the
CropBox and page rotation. If those two ever disagree, a reviewer's tick silently
moves — pointing at the wrong number on a workpaper, which is worse than useless.

    python spike/check_mark_positions.py <pdf> <page> <color> <nx> <ny> [...]

`color` is "green" (tick), "blue" (lettered mark), "red" (a drawn shape), or
"brown" (a calculator
tape's border — its outline's centroid is the tape's center). Repeat the
color/nx/ny triple to check several marks on one page. Exit 0 if every mark is
within tolerance of where it was placed.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pypdfium2 as pdfium

TOLERANCE = 0.03  # fraction of page width/height


def render(path: str, index: int, scale: float = 2.0) -> np.ndarray:
    doc = pdfium.PdfDocument(path)
    try:
        page = doc[index]
        bmp = page.render(scale=scale, draw_annots=True)
        return np.asarray(bmp.to_pil().convert("RGB")).copy()
    finally:
        doc.close()


def mask_for(img: np.ndarray, color: str) -> np.ndarray:
    r = img[:, :, 0].astype(int)
    g = img[:, :, 1].astype(int)
    b = img[:, :, 2].astype(int)
    if color == "green":
        return (g > 90) & (g > r + 30) & (g > b + 30)
    if color == "blue":
        return (b > 90) & (b > r + 30) & (b > g + 20)
    if color == "red":
        # Drawn shapes' red. Note this is the SAME red as the cross mark, so a
        # page under test should carry one or the other, not both.
        return (r > 120) & (r > g + 60) & (r > b + 60)
    if color == "brown":
        # Tape border, appearance.TAPE_BORDER_COLOR = rgb(89, 54, 20). The two
        # hue conditions are what make this disjoint from the tick's green and
        # the lettered mark's blue, so tapes and marks can be checked on one
        # page; the red floor only has to clear page ink and the card's tint.
        # Keep it low enough to survive a darker border — pinning it to one
        # exact shade is what broke this when the tape was restyled.
        return (r > 60) & (r > g + 30) & (g > b + 20)
    if color == "violet":
        # Connector ring, appearance.MARK_COLORS["conn"] = rgb(112, 58, 148).
        # Blue AND red both clearly above green is what makes violet disjoint
        # from the lettered mark's blue (which sits below its own red) and from
        # the shape red (whose blue is far below its red).
        return (b > 90) & (b > g + 40) & (r > g + 20) & (b > r + 20)
    raise SystemExit(f"unknown color {color!r}")


def centroid(mask: np.ndarray) -> tuple[float, float, int] | None:
    ys, xs = np.nonzero(mask)
    if len(xs) < 15:
        return None
    h, w = mask.shape
    return (float(xs.mean()) / w, float(ys.mean()) / h, int(len(xs)))


def main() -> int:
    if len(sys.argv) < 6 or (len(sys.argv) - 3) % 3 != 0:
        print(__doc__)
        return 2
    pdf = sys.argv[1]
    if not Path(pdf).exists():
        print(f"not found: {pdf}")
        return 1
    page = int(sys.argv[2])
    img = render(pdf, page)

    failures = 0
    args = sys.argv[3:]
    for i in range(0, len(args), 3):
        color, nx, ny = args[i], float(args[i + 1]), float(args[i + 2])
        got = centroid(mask_for(img, color))
        if got is None:
            print(f"FAIL {color}: no pixels found on page {page}")
            failures += 1
            continue
        cx, cy, n = got
        ok = abs(cx - nx) < TOLERANCE and abs(cy - ny) < TOLERANCE
        print(
            f"{'PASS' if ok else 'FAIL'} {color}: placed ({nx:.3f},{ny:.3f}) "
            f"-> exported ({cx:.3f},{cy:.3f}) px={n}"
        )
        failures += 0 if ok else 1
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
