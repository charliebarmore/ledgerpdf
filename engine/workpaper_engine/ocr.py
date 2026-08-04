"""OCR for pages that carry no text layer.

A large share of real workpaper source material is scanned or photographed — a
bank statement, a 1099 a client sent as a picture. Those pages are opaque to
everything else in this engine, so an agent asked to tie out a figure on one is
simply blind.

TWO THINGS THIS MODULE TREATS AS NON-NEGOTIABLE:

1. **OCR is a guess, and a workpaper is evidence.** A misread digit (8 for 3,
   1 for 7) that reaches a tie-out is worse than no reading at all, because it
   is wrong *confidently*. So every OCR word carries its confidence, results are
   labelled `source: "ocr"` all the way out to the agent, and nothing here is
   ever presented as the document's own text layer.

2. **A page that HAS text is never OCR'd.** The embedded text is exact; OCR of
   the same page is slower and worse.

Backend: the `tesseract` binary (Apache-2.0 — well clear of the MuPDF/AGPL line
the licence guard protects), invoked directly rather than through a wrapper
package so the engine gains no new Python dependency. It is OPTIONAL: with no
backend installed, pages report `source: "none"` and say why, which is the same
honest answer as before rather than a failure.
"""

from __future__ import annotations

import csv
import io
import os
import shutil
import subprocess
import tempfile

import pypdfium2 as pdfium

from .probe import sanitize_text

# 300 dpi is the usual floor for reliable OCR of body text; below it, digits in
# a tax table start to merge.
OCR_DPI = 300
# A very large sheet at 300 dpi is a big bitmap. Cap the long edge so a poster
# or a plan drawing cannot exhaust memory.
MAX_PIXELS = 4000
# Below this, tesseract is guessing at noise. Keeping such words would put
# invented figures in front of an agent, which is the one outcome to avoid.
MIN_CONFIDENCE = 40.0


def backend() -> str | None:
    """Path to the OCR binary, or None when OCR is unavailable."""
    return os.environ.get("WPT_TESSERACT") or shutil.which("tesseract")


def available() -> bool:
    return backend() is not None


def _scale_for(page) -> float:
    width, height = page.get_size()  # display size, /Rotate applied
    scale = OCR_DPI / 72.0
    longest = max(width, height) * scale
    return scale * (MAX_PIXELS / longest) if longest > MAX_PIXELS else scale


def ocr_page(page) -> tuple[list[dict], str | None]:
    """OCR one rendered pdfium page.

    Returns (words, error). Coordinates are normalized against the page AS
    DISPLAYED — pdfium's render applies /Rotate — which is the same space marks
    use, so a word's centre can be handed straight to a mark.
    """
    exe = backend()
    if not exe:
        return [], "no OCR backend: install tesseract, or set WPT_TESSERACT"

    bitmap = page.render(scale=_scale_for(page))
    image = bitmap.to_pil().convert("L")
    width, height = image.size
    if not width or not height:
        return [], "page rendered empty"

    with tempfile.TemporaryDirectory() as tmp:
        png = os.path.join(tmp, "page.png")
        image.save(png)
        try:
            done = subprocess.run(
                [exe, png, "stdout", "--psm", "6", "tsv"],
                capture_output=True,
                text=True,
                timeout=120,
                # The parser runs on client documents; give it nothing inherited.
                env={"PATH": os.environ.get("PATH", ""), "HOME": tmp},
            )
        except subprocess.TimeoutExpired:
            return [], "OCR timed out"
        except OSError as exc:
            return [], f"OCR failed to run: {exc}"
    if done.returncode != 0:
        return [], f"OCR failed: {(done.stderr or '').strip()[:200]}"

    words: list[dict] = []
    reader = csv.DictReader(io.StringIO(done.stdout), delimiter="\t")
    for row in reader:
        text = sanitize_text((row.get("text") or "")).strip()
        if not text:
            continue
        try:
            conf = float(row.get("conf", "-1"))
            left = float(row["left"])
            top = float(row["top"])
            w = float(row["width"])
            h = float(row["height"])
        except (TypeError, ValueError, KeyError):
            continue
        if conf < MIN_CONFIDENCE:
            continue
        nx0, ny0 = left / width, top / height
        nx1, ny1 = (left + w) / width, (top + h) / height
        words.append(
            {
                "t": text,
                "nx": round((nx0 + nx1) / 2, 5),
                "ny": round((ny0 + ny1) / 2, 5),
                "box": [round(v, 5) for v in (nx0, ny0, nx1, ny1)],
                # Travels all the way to the agent. A figure read at 61% is not
                # the same claim as one read at 97%, and a preparer signing the
                # file is entitled to know which they are looking at.
                "conf": round(conf, 1),
            }
        )
    return words, None


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
