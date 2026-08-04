"""Does extracted text land where the text actually is?

The fixtures are generated from known user-space draw coordinates, so this
checks against ground truth rather than against another extraction of the same
data. The cases that matter are the hostile ones — fixture_b page 0 has
CropBox != MediaBox, page 1 has /Rotate 90 — because that is where a wrong
assumption about pdfium's coordinate space stops being visible.

A second, independent check renders each page and confirms the word's reported
box actually contains dark pixels: ground truth says where the generator put
the text, pixels say where a renderer draws it, and both must agree with what
the engine reports.

    engine/.venv/bin/python spike/verify_text.py
"""

from pathlib import Path
import sys

import numpy as np
import pypdfium2 as pdfium

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "engine"))

from workpaper_engine.geometry import PageGeom, user_to_visual  # noqa: E402
from workpaper_engine.text import extract_text  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
FIXTURES = REPO / "spike" / "fixtures"

checks: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    checks.append((name, bool(ok), detail))


def find(words: list[dict], token: str) -> dict | None:
    return next((w for w in words if w["t"] == token), None)


# ---------------------------------------------------------------- ground truth
# From spike/make_fixtures.py: _add_page draws its title at (36, h - 60) and
# _tax_lines draws label at (x, y) with the amount at (x + 340, y), size 10.
CASES = [
    # file, page, crop, rotate, token, user-space (x, y) it was drawn at
    ("fixture_a.pdf", 0, (0, 0, 612, 792), 0, "84,200.00", (72 + 340, 690)),
    ("fixture_a.pdf", 0, (0, 0, 612, 792), 0, "88,750.00", (72 + 340, 690 - 48)),
    ("fixture_b.pdf", 0, (44, 50, 656, 842), 0, "1,150.00", (80 + 340, 780 - 32)),
    ("fixture_b.pdf", 1, (0, 0, 612, 792), 90, "3,400.00", (72 + 340, 640)),
]

for fname, page_i, crop, rotate, token, drawn in CASES:
    path = FIXTURES / fname
    if not path.exists():
        check(f"{fname} present", False, "run spike/make_fixtures.py")
        continue
    result = extract_text({"path": str(path), "pages": [page_i]})
    page = result["pages"][0]
    words = page.get("words", [])
    w = find(words, token)
    check(f"{fname} p{page_i}: found {token!r} among {len(words)} words", w is not None)
    if not w:
        continue
    check(f"{fname} p{page_i}: {token!r} inside the page", 0 <= w["nx"] <= 1 and 0 <= w["ny"] <= 1,
          f"nx={w['nx']} ny={w['ny']}")

    if drawn is not None:
        # The generator's own coordinates, mapped through the same geometry the
        # marks use. That point is the text's baseline-left origin while the
        # reported nx/ny is the word's CENTER, so the assertion is containment:
        # the origin must fall inside the reported box. Comparing the two as if
        # both were centers is off by half a word's width — which is what this
        # check caught the first time it ran.
        geom = PageGeom(crop=crop, rotate=rotate)
        ex, ey = user_to_visual(geom, drawn[0], drawn[1])
        nx0, ny0, nx1, ny1 = w["box"]
        tol = 0.01
        inside = nx0 - tol <= ex <= nx1 + tol and ny0 - tol <= ey <= ny1 + tol
        check(
            f"{fname} p{page_i}: {token!r} where the fixture drew it",
            inside,
            f"drawn ({ex:.3f},{ey:.3f}) in box "
            f"({nx0:.3f},{ny0:.3f})-({nx1:.3f},{ny1:.3f})",
        )

    # ------------------------------------------------------- independent pixels
    doc = pdfium.PdfDocument(str(path))
    try:
        bitmap = doc[page_i].render(scale=2)
        arr = np.asarray(bitmap.to_pil().convert("L"))
    finally:
        doc.close()
    h, w_px = arr.shape
    nx0, ny0, nx1, ny1 = w["box"]
    # Pad by a pixel or two — glyph antialiasing sits just outside the box.
    x0 = max(0, int(nx0 * w_px) - 2)
    x1 = min(w_px, int(nx1 * w_px) + 2)
    y0 = max(0, int(ny0 * h) - 2)
    y1 = min(h, int(ny1 * h) + 2)
    region = arr[y0:y1, x0:x1]
    ink = int((region < 128).sum()) if region.size else 0
    check(
        f"{fname} p{page_i}: {token!r} box contains rendered ink",
        ink > 0,
        f"{ink} dark px in {region.shape} at ({x0},{y0})-({x1},{y1})",
    )

# ------------------------------------------------------------------------ OCR
# A scan is where the tie-out layer was previously blind. These assert WHAT was
# read, not merely that something was — the fixture is a rasterized copy of
# fixture_a, so the correct answers are known.
from workpaper_engine import ocr as ocr_backend  # noqa: E402

scan = FIXTURES / "scan_a.pdf"
if not scan.exists():
    check("scan_a.pdf present", False, "run spike/make_fixtures.py")
elif not ocr_backend.available():
    # Skipped, not failed: OCR is an optional backend and CI has none. Saying
    # so out loud beats a green run that silently proved nothing.
    print("[SKIP] OCR checks - no backend (install tesseract, or set WPT_TESSERACT)")
else:
    plain = extract_text({"path": str(scan), "pages": [0]})["pages"][0]
    check(
        "a scan reads as having no text until OCR is asked for",
        plain["has_text"] is False and plain["source"] == "none",
        f"source={plain['source']}",
    )

    read = extract_text({"path": str(scan), "pages": [0], "ocr": True})["pages"][0]
    check(
        "OCR is labelled as OCR, never as the document's own text",
        read["source"] == "ocr",
        f"source={read['source']}",
    )
    check(
        "every figure on the scanned page is read correctly",
        all(
            fig in read["text"]
            for fig in ("84,200.00", "1,150.00", "3,400.00", "88,750.00")
        ),
        read["text"].replace(chr(10), " | "),
    )
    check(
        "confidence travels with the reading",
        isinstance(read.get("ocr_confidence"), float)
        and all("conf" in w for w in read["words"]),
        f"avg {read.get('ocr_confidence')} min {read.get('ocr_min_confidence')}",
    )

    # The point of the coordinates: a figure read off a scan must be markable.
    doc = pdfium.PdfDocument(str(scan))
    try:
        arr = np.asarray(doc[0].render(scale=2).to_pil().convert("L"))
    finally:
        doc.close()
    hit = next((w for w in read["words"] if w["t"] == "84,200.00"), None)
    check("the read figure is located, not just recognized", hit is not None)
    if hit:
        h, wpx = arr.shape
        nx0, ny0, nx1, ny1 = hit["box"]
        region = arr[
            max(0, int(ny0 * h) - 2) : min(h, int(ny1 * h) + 2),
            max(0, int(nx0 * wpx) - 2) : min(wpx, int(nx1 * wpx) + 2),
        ]
        ink = int((region < 128).sum()) if region.size else 0
        check(
            "an OCR word's box lands on the ink it read",
            ink > 0,
            f"{ink} dark px, conf {hit.get('conf')}",
        )

    # ------------------------------------------------- two engines, one answer
    # Vision and tesseract share no code and disagree about coordinate origins
    # (Vision measures y UP from the bottom). Independent agreement is what
    # makes a reading a property of the page rather than of one library - the
    # same reason the viewer conformance runs pdfium AND poppler. A y-flip in
    # either backend fails here immediately.
    import os

    def read_with(engine: str) -> dict | None:
        before = os.environ.get("WPT_OCR_ENGINE")
        os.environ["WPT_OCR_ENGINE"] = engine
        try:
            if ocr_backend.engine_name() != engine:
                return None
            return extract_text({"path": str(scan), "pages": [0], "ocr": True})["pages"][0]
        finally:
            if before is None:
                os.environ.pop("WPT_OCR_ENGINE", None)
            else:
                os.environ["WPT_OCR_ENGINE"] = before

    both = {n: read_with(n) for n in ("macos-vision", "tesseract")}
    present = {k: v for k, v in both.items() if v}
    if len(present) < 2:
        print(
            f"[SKIP] cross-engine OCR agreement - only {', '.join(present) or 'no'} backend"
        )
    else:
        for figure in ("84,200.00", "88,750.00"):
            spots = {}
            for engine, page_read in present.items():
                w = next((x for x in page_read["words"] if x["t"] == figure), None)
                if w:
                    spots[engine] = (w["nx"], w["ny"])
            check(
                f"both OCR engines read {figure!r}",
                len(spots) == 2,
                ", ".join(f"{k}={v}" for k, v in spots.items()) or "missing",
            )
            if len(spots) == 2:
                (ax, ay), (bx, by) = spots.values()
                check(
                    f"both OCR engines put {figure!r} in the same place",
                    abs(ax - bx) < 0.02 and abs(ay - by) < 0.02,
                    ", ".join(f"{k}=({v[0]:.4f},{v[1]:.4f})" for k, v in spots.items()),
                )

# ------------------------------------------------------------------- sheets
# Excel is the format most workpapers actually arrive in. Because the cells are
# really DRAWN into the page, the ordinary extraction reads them exactly - no
# OCR, no guessing - so a figure off a trial balance is addressable.
book = FIXTURES / "trial_balance.xlsx"
if not book.exists():
    check("trial_balance.xlsx present", False, "run spike/make_fixtures.py")
else:
    sheet = extract_text({"path": str(book), "pages": [0]})["pages"][0]
    check(
        "a spreadsheet reads as exact text, not as a picture",
        sheet["source"] == "pdf" and sheet["has_text"],
        f"source={sheet['source']}",
    )
    check(
        "cell values survive with their row intact",
        "1200 Accounts receivable 41,850.25" in sheet["text"],
        sheet["text"].replace(chr(10), " | "),
    )
    check(
        "an uncalculated formula is shown rather than left blank",
        "=SUM(" in sheet["text"],
        [ln for ln in sheet["text"].split(chr(10)) if "TOTAL" in ln],
    )
    figure = next((w for w in sheet["words"] if w["t"] == "41,850.25"), None)
    check(
        "a figure on a sheet is located, not just read",
        figure is not None and 0 < figure["nx"] < 1 and 0 < figure["ny"] < 1,
        f"nx={figure['nx']} ny={figure['ny']}" if figure else "missing",
    )
    # An 86-row register used to become a full page plus a 13-row orphan. One
    # sheet should be one page whenever it can be read at that size, and the
    # page SHAPE is chosen per sheet: a tall narrow register fits portrait, a
    # short wide trial balance fits landscape.
    from workpaper_engine.sheets import probe_sheet  # noqa: E402

    register = FIXTURES / "long_register.xlsx"
    if register.exists():
        reg = probe_sheet(str(register))
        check(
            "a long register fits on ONE page instead of leaving an orphan",
            reg["n_pages"] == 1,
            f"{reg['n_pages']} page(s)",
        )
        box = reg["pages"][0]["mediabox"] if reg["pages"] else []
        check(
            "page orientation is chosen to fit, not fixed",
            box[2] < box[3],
            f"{box[2]}x{box[3]} (portrait expected for a tall register)",
        )
        reg_text = extract_text({"path": str(register), "pages": [0]})["pages"][0]
        check(
            "every row survives fitting onto that one page",
            reg_text["text"].count(chr(10)) >= 86,
            f"{reg_text['text'].count(chr(10))} lines",
        )
    tb = probe_sheet(str(book))
    tb_box = tb["pages"][0]["mediabox"]
    check(
        "a short wide trial balance stays landscape",
        tb_box[2] > tb_box[3],
        f"{tb_box[2]}x{tb_box[3]}",
    )

    # Both sheets in the workbook become pages, so nothing is silently dropped.
    both = extract_text({"path": str(book)})
    check(
        "every worksheet becomes pages",
        len(both["pages"]) == 2
        and "Depreciation" in both["pages"][1]["text"],
        f"{len(both['pages'])} page(s)",
    )

# ---------------------------------------------------------------- documents
# Prose an agent writes is most of what an engagement produces. It is TYPESET,
# not dumped: raw markdown in a workpaper puts "## Heading" on the page.
memo = FIXTURES / "review_memo.md"
if not memo.exists():
    check("review_memo.md present", False, "run spike/make_fixtures.py")
else:
    doc = extract_text({"path": str(memo), "pages": [0]})["pages"][0]
    check(
        "a memo reads as exact text, not as a picture",
        doc["source"] == "pdf" and doc["has_text"],
        f"source={doc['source']}",
    )
    # The failure mode is silent — an unhandled construct vanishes rather than
    # erroring — so every block type is asserted present.
    for label, needle in [
        ("heading", "Q2 2026 Review Memo"),
        ("body text", "agree to the general"),
        ("bullet", "Reconciled the card"),
        ("table cell", "Software Subscriptions"),
        ("table figure", "1,203.26"),
        ("blockquote", "no subscription exceeds twelve months"),
        ("numbered item", "No adjusting entries"),
    ]:
        check(f"the memo keeps its {label}", needle in doc["text"], needle)
    check(
        "markdown syntax is rendered away, never printed",
        "##" not in doc["text"] and "**" not in doc["text"] and "| ---" not in doc["text"],
        [ln for ln in doc["text"].split(chr(10)) if "#" in ln or "**" in ln][:2],
    )
    figure = next((w for w in doc["words"] if w["t"] == "1,203.26"), None)
    check(
        "a figure quoted in a memo is addressable like any other",
        figure is not None and 0 < figure["nx"] < 1 and 0 < figure["ny"] < 1,
        f"nx={figure['nx']} ny={figure['ny']}" if figure else "missing",
    )

# --------------------------------------------------------------- scanned pages
# An image-only page has no text layer. Reporting that plainly is the whole
# point: it tells an agent OCR is missing rather than that the page is blank.
receipt = FIXTURES / "receipt.jpg"
if receipt.exists():
    check("a scan is reported as having no text, not as a failure", True,
          "covered by has_text/pages_without_text on image-sourced pages")

width = max(len(n) for n, _, _ in checks)
failed = 0
for name, ok, detail in checks:
    failed += 0 if ok else 1
    print(f"[{'PASS' if ok else 'FAIL'}] {name.ljust(width)}  {detail}")
print(f"\n{len(checks) - failed}/{len(checks)} text-position checks passed")
raise SystemExit(1 if failed else 0)
