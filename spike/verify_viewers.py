"""Check the conformance binder in two INDEPENDENT render engines.

pdfium is what Chrome and Edge use. poppler is an unrelated codebase entirely.
If a mark lands in the same place in both, the geometry is a property of the
PDF rather than of one renderer's interpretation of it — which is the only kind
of claim worth making about a document that becomes a client record.

Neither engine is shipped. Both are invoked as dev-only tools, the same posture
as pypdfium2 in the existing harness; the MuPDF/AGPL guard in the engine
requirements is untouched.

    npm run verify:viewers       (from app/, resolves the venv on any platform)

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
        # The tape border is appearance.TAPE_BORDER_COLOR = rgb(89, 54, 20).
        # The red floor only has to clear page ink and the card's own tint; the
        # two hue conditions are what actually separate brown from everything
        # else we mark with, so keep the floor low enough to survive a darker
        # border rather than pinning it to one exact shade.
        return (r > 60) & (r > g + 30) & (g > b + 20)
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
        try:
            subprocess.run(
                ["pdftoppm", "-png", "-r", "144", "-f", str(index + 1), "-l", str(index + 1),
                 path, str(stem)],
                check=True, capture_output=True,
            )
        except FileNotFoundError:
            # Second engine missing is a setup gap, not a conformance failure, and
            # a bare FileNotFoundError traceback reads like the repo is broken.
            # Say what is missing and how to get it. Still exits non-zero: this
            # check is worth nothing with only one engine, so it must not look
            # like it passed. CI skips the step on Windows for the same reason.
            raise SystemExit(
                "pdftoppm not found — this check renders in TWO independent engines\n"
                "and poppler is the second one.\n"
                "  macOS:   brew install poppler\n"
                "  Linux:   apt install poppler-utils\n"
                "  Windows: not readily available; run this check on macOS or Linux.\n"
                "The pdfium half is exercised by `npm run verify` on every platform."
            ) from None
        pngs = sorted(Path(tmp).glob("page*.png"))
        if not pngs:
            raise SystemExit("pdftoppm produced no output")
        return np.asarray(Image.open(pngs[0]).convert("RGB")).copy()


ENGINES = {"pdfium": render_pdfium, "poppler": render_poppler}


def main(argv: list[str] | None = None) -> int:
    """`--engines pdfium` runs one engine instead of two.

    Not a convenience. On Windows poppler is not readily installable, so this
    script died at the pdftoppm check — and CI hid that behind
    `continue-on-error: true`, reporting success on every run while verifying
    nothing at all. A step that cannot fail is not a check, and one named
    "(pdfium)" that never reached pdfium is worse than an absent one, because
    the green tick is read as coverage.

    One engine cannot prove cross-engine agreement, so the closing line says
    which engines actually ran rather than claiming both. What it CAN prove on
    Windows is that every mark lands where it was placed across the hostile
    geometries — rotation, CropBox != MediaBox, legal-with-existing-annotations
    — which is more than the smoke's single-page position check covers.
    """
    args = list(sys.argv[1:] if argv is None else argv)
    engines = dict(ENGINES)
    if "--engines" in args:
        wanted = args[args.index("--engines") + 1].split(",")
        unknown = [w for w in wanted if w not in ENGINES]
        if unknown:
            print(f"unknown engine(s): {', '.join(unknown)}")
            return 2
        engines = {k: ENGINES[k] for k in wanted}

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
            for engine, render in engines.items():
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
        names = " AND ".join(engines)
        agreement = (
            f"every mark lands in the same place in {names}"
            if len(engines) > 1
            # Say what was actually proven. "Agreement" across one engine is not
            # a thing, and a line claiming it would be the same lie the
            # continue-on-error tick was telling.
            else f"every mark lands where it was placed in {names} (single engine — "
            "cross-engine agreement NOT checked)"
        )
        print(agreement)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
