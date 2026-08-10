"""macOS OCR via the Vision framework.

Preferred over tesseract on a Mac: on the same fixture it read every figure at
confidence 1.000 in 0.49s where tesseract managed 92.9% average in ~2-3s. It is
on-device — nothing leaves the machine — and it needs no bundled binary, no
language data, and nothing extra to sign or notarize.

TWO THINGS THAT ARE NOT OBVIOUS:

1. **Vision is line-oriented.** It returns one observation per line, not per
   word, so a naive port would hand back "1 Wages, salaries, tips" as a single
   box and a figure could not be ticked. Per-word boxes come from
   `boundingBoxForRange`, which is exact and is what makes the word contract
   achievable here.

2. **Its coordinates are bottom-left origin, y UP** — the opposite of every
   other coordinate in this engine. Getting that backwards puts a tick at the
   mirror image of the figure it read, near enough the right place to look
   plausible and be wrong.

Confidence is reported per OBSERVATION, not per word, so every word on a line
carries that line's confidence. That is the honest reading of what Vision
provides; splitting it further would invent precision.
"""

from __future__ import annotations

import re

# Vision groups by line; these split a line into the tokens a preparer would
# point at. Keeping punctuation inside a token matters: "84,200.00" is one word.
_WORD = re.compile(r"\S+")


def name() -> str:
    return "macos-vision"


def available() -> bool:
    if __import__("sys").platform != "darwin":
        return False
    try:  # noqa: SIM105 — the import IS the availability test
        import Quartz  # noqa: F401
        import Vision  # noqa: F401
    except Exception:
        return False
    return True


def read(png_path: str) -> tuple[list[dict], str | None]:
    """Recognize text in a PNG. Returns (words, error) in normalized display
    space with the same origin convention as the rest of the engine: nx left to
    right, ny TOP to bottom."""
    try:
        import Quartz
        import Vision
        from Foundation import NSURL, NSRange
    except Exception as exc:  # pragma: no cover — guarded by available()
        return [], f"Vision unavailable: {exc}"

    source = Quartz.CGImageSourceCreateWithURL(NSURL.fileURLWithPath_(png_path), None)
    if source is None:
        return [], "Vision could not read the rendered page"
    image = Quartz.CGImageSourceCreateImageAtIndex(source, 0, None)
    if image is None:
        return [], "Vision could not decode the rendered page"

    captured: dict = {}
    request = Vision.VNRecognizeTextRequest.alloc().initWithCompletionHandler_(
        lambda req, err: captured.__setitem__("obs", req.results())
    )
    request.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
    # Off deliberately: language correction "fixes" figures. On a tax document
    # a plausible correction of a number is the worst possible failure.
    request.setUsesLanguageCorrection_(False)

    handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(image, None)
    ok, error = handler.performRequests_error_([request], None)
    if not ok:
        return [], f"Vision failed: {error}"

    words: list[dict] = []
    for observation in captured.get("obs") or []:
        candidates = observation.topCandidates_(1)
        if not candidates:
            continue
        candidate = candidates[0]
        line = candidate.string()
        confidence = float(candidate.confidence()) * 100.0
        for match in _WORD.finditer(line):
            box, _err = candidate.boundingBoxForRange_error_(
                NSRange(match.start(), match.end() - match.start()), None
            )
            if box is None:
                continue
            rect = box.boundingBox()
            x, y = float(rect.origin.x), float(rect.origin.y)
            w, h = float(rect.size.width), float(rect.size.height)
            # Vision's y is measured UP from the bottom; ours is down from the top.
            nx0, nx1 = x, x + w
            ny0, ny1 = 1.0 - (y + h), 1.0 - y
            words.append(
                {
                    "t": match.group(),
                    "nx": round((nx0 + nx1) / 2, 5),
                    "ny": round((ny0 + ny1) / 2, 5),
                    "box": [round(v, 5) for v in (nx0, ny0, nx1, ny1)],
                    "conf": round(confidence, 1),
                }
            )
    return words, None
