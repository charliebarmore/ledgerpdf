"""OCR for pages that carry no text layer.

A large share of real workpaper source material is scanned or photographed — a
bank statement, a 1099 a client sent as a picture. Those pages are opaque to
everything else in this engine, so an agent asked to tie out a figure on one is
simply blind.

TWO THINGS THIS MODULE TREATS AS NON-NEGOTIABLE:

1. **OCR is a guess, and a workpaper is evidence.** A misread digit (8 for 3,
   1 for 7) that reaches a tie-out is worse than no reading at all, because it
   is wrong *confidently*. So every OCR word carries its confidence, results are
   labelled `source: "ocr"` with the engine that produced them, and nothing here
   is ever presented as the document's own text layer.

2. **A page that HAS text is never OCR'd.** The embedded text is exact; OCR of
   the same page is slower and worse.

BACKENDS, in preference order:
  - macOS Vision — on-device, no bundled binary, nothing extra to sign, and on
    the same fixture it beat tesseract on both accuracy and speed.
  - tesseract — the portable fallback (Apache-2.0, well clear of the MuPDF/AGPL
    line the licence guard protects), shelled out to so the engine gains no
    Python dependency.
  - none — pages report `source: "none"` and say why, which is the same honest
    answer as before rather than a failure.

Windows has an equivalent (`Windows.Media.Ocr`) that is not wired up yet. Note
before it is: it reports no per-word confidence, so it cannot honour rule 1 the
way these two do, and that difference has to be surfaced rather than papered
over.
"""

from __future__ import annotations

import csv
import io
import os
import shutil
import subprocess
import tempfile

from . import ocr_vision
from .probe import sanitize_text

# 300 dpi is the usual floor for reliable OCR of body text; below it, digits in
# a tax table start to merge.
OCR_DPI = 300
# A very large sheet at 300 dpi is a big bitmap. Cap the long edge so a poster
# or a plan drawing cannot exhaust memory.
MAX_PIXELS = 4000
# Below this, the engine is guessing at noise. Keeping such words would put
# invented figures in front of an agent, which is the one outcome to avoid.
MIN_CONFIDENCE = 40.0


# ------------------------------------------------------------------ tesseract


def _tesseract_exe() -> str | None:
    return os.environ.get("WPT_TESSERACT") or shutil.which("tesseract")


def _tesseract_available() -> bool:
    return _tesseract_exe() is not None


def _tesseract_read(png_path: str) -> tuple[list[dict], str | None]:
    exe = _tesseract_exe()
    if not exe:
        return [], "tesseract not found"
    from PIL import Image

    with Image.open(png_path) as image:
        width, height = image.size
    try:
        done = subprocess.run(
            [exe, png_path, "stdout", "--psm", "6", "tsv"],
            capture_output=True,
            text=True,
            timeout=120,
            # The parser runs on client documents; give it nothing inherited.
            env={"PATH": os.environ.get("PATH", ""), "HOME": os.path.dirname(png_path)},
        )
    except subprocess.TimeoutExpired:
        return [], "OCR timed out"
    except OSError as exc:
        return [], f"OCR failed to run: {exc}"
    if done.returncode != 0:
        return [], f"OCR failed: {(done.stderr or '').strip()[:200]}"

    words: list[dict] = []
    for row in csv.DictReader(io.StringIO(done.stdout), delimiter="\t"):
        text = sanitize_text((row.get("text") or "")).strip()
        if not text:
            continue
        try:
            conf = float(row.get("conf", "-1"))
            left, top = float(row["left"]), float(row["top"])
            w, h = float(row["width"]), float(row["height"])
        except (TypeError, ValueError, KeyError):
            continue
        nx0, ny0 = left / width, top / height
        nx1, ny1 = (left + w) / width, (top + h) / height
        words.append(
            {
                "t": text,
                "nx": round((nx0 + nx1) / 2, 5),
                "ny": round((ny0 + ny1) / 2, 5),
                "box": [round(v, 5) for v in (nx0, ny0, nx1, ny1)],
                "conf": round(conf, 1),
            }
        )
    return words, None


# -------------------------------------------------------------------- registry

_BACKENDS = (
    ("macos-vision", ocr_vision.available, ocr_vision.read),
    ("tesseract", _tesseract_available, _tesseract_read),
)


def engine_name() -> str | None:
    """The backend that would be used, or None. Reported alongside every
    reading so a reviewer knows which engine read a figure."""
    forced = os.environ.get("WPT_OCR_ENGINE")
    for name, is_available, _read in _BACKENDS:
        if forced and name != forced:
            continue
        if is_available():
            return name
    return None


def available() -> bool:
    return engine_name() is not None


def _scale_for(page) -> float:
    width, height = page.get_size()  # display size, /Rotate applied
    scale = OCR_DPI / 72.0
    longest = max(width, height) * scale
    return scale * (MAX_PIXELS / longest) if longest > MAX_PIXELS else scale


def ocr_page(page) -> tuple[list[dict], str | None, str | None]:
    """OCR one rendered pdfium page.

    Returns (words, error, engine). Coordinates are normalized against the page
    AS DISPLAYED — pdfium's render applies /Rotate — which is the same space
    marks use, so a word's centre can be handed straight to a mark.
    """
    chosen = engine_name()
    if not chosen:
        return [], "no OCR backend: install tesseract, or set WPT_TESSERACT", None
    read = next(fn for name, _avail, fn in _BACKENDS if name == chosen)

    bitmap = page.render(scale=_scale_for(page))
    image = bitmap.to_pil().convert("L")
    if not image.size[0] or not image.size[1]:
        return [], "page rendered empty", chosen

    with tempfile.TemporaryDirectory() as tmp:
        png = os.path.join(tmp, "page.png")
        image.save(png)
        words, problem = read(png)
    if problem:
        return [], problem, chosen
    # Applied here, not per backend, so the floor means the same thing whichever
    # engine produced the number.
    return [w for w in words if w.get("conf", 100.0) >= MIN_CONFIDENCE], None, chosen


def ocr_lines(words: list[dict]) -> str:
    """Readable lines from OCR words, grouped by vertical band.

    Unlike embedded text there is no user space to group in — the words are
    already in display space, which is the right space here because that is how
    the scan was laid out.
    """
    if not words:
        return ""
    heights = sorted(w["box"][3] - w["box"][1] for w in words)
    tol = max(heights[len(heights) // 2] * 0.6, 0.004)
    ordered = sorted(words, key=lambda w: (w["ny"], w["nx"]))
    lines: list[list[dict]] = []
    anchor = None
    for w in ordered:
        if anchor is None or abs(w["ny"] - anchor) > tol:
            lines.append([w])
            anchor = w["ny"]
        else:
            lines[-1].append(w)
    return "\n".join(
        " ".join(x["t"] for x in sorted(line, key=lambda x: x["nx"])) for line in lines
    )
