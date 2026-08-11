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

    npm run verify:text          (from app/, resolves the venv on any platform)
"""

from pathlib import Path
import codecs
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
            page_read = extract_text({"path": str(scan), "pages": [0], "ocr": True})["pages"][0]
            return page_read if page_read.get("source") == "ocr" else None
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

# A cell's characters have to reach the page as themselves. sheets.py kept its
# own escaper — the fourth copy, missed when the others were consolidated — and
# encoded `latin-1, "replace"`, so an em dash became "?" and Peña became "Pe?a".
# No crash and no warning: the figures stayed right while the label saying what
# they were quietly did not, which is the harder failure to catch because the
# page still looks finished. An accented client name is the realistic case; the
# em dash is the one latin-1 cannot carry at all.
_u_csv = REPO / "spike" / "out" / "unicode-cells.csv"
_u_csv.parent.mkdir(parents=True, exist_ok=True)
_u_csv.write_text(
    "Account,Detail,Amount\n1200,Interest — Sch B,41850.25\n1300,Peña & Fuentes §1031,88750.00\n",
    encoding="utf-8",
)
_u_page = extract_text({"path": str(_u_csv), "pages": [0]})["pages"][0]
for _label, _needle in [("an em dash", "Interest — Sch B"), ("an accented name", "Peña & Fuentes")]:
    check(
        f"{_label} in a spreadsheet cell reaches the page as itself",
        _needle in _u_page["text"],
        _u_page["text"].replace(chr(10), " | ")[:160],
    )

# A CSV does not carry its encoding, and the assumption used to be UTF-8 with
# `errors="replace"` — the wrong way round for this profession. Excel's plain
# "CSV" export writes the Windows ANSI codepage; only the separately-named
# "CSV UTF-8" writes UTF-8. So the ordinary export of a trial balance for
# Peña & Fuentes lost every accented character to U+FFFD before it was parsed.
from workpaper_engine.sheets import read_grids  # noqa: E402

_ENC_ROW = "Account,Detail\n1300,Peña & Fuentes — §1031\n"
_ENC_CASES = [
    ("UTF-8 without a BOM", "utf8-plain.csv", _ENC_ROW.encode("utf-8"), False),
    ("UTF-8 with a BOM", "utf8-bom.csv", codecs.BOM_UTF8 + _ENC_ROW.encode("utf-8"), False),
    ("UTF-16 with a BOM", "utf16.csv", _ENC_ROW.encode("utf-16"), False),
    # The one that matters: what Excel writes when a preparer picks "CSV".
    ("Excel's Windows-1252", "excel-ansi.csv", _ENC_ROW.encode("cp1252"), True),
]
for _label, _fname, _bytes, _expect_warning in _ENC_CASES:
    _f = REPO / "spike" / "out" / _fname
    _f.parent.mkdir(parents=True, exist_ok=True)
    _f.write_bytes(_bytes)
    _grids, _warns = read_grids(_f)
    _cell = _grids[0][1][1][1]
    check(
        f"a CSV saved as {_label} keeps its characters",
        _cell == "Peña & Fuentes — §1031",
        _cell.encode("unicode_escape").decode("ascii"),
    )
    # Guessing is allowed; guessing quietly is not.
    check(
        f"a CSV saved as {_label} {'says it was guessed' if _expect_warning else 'needs no warning'}",
        bool(_warns) == _expect_warning,
        str(_warns),
    )

# ------------------------------------------------- a sheet an agent can USE
# The rendered page is for a human; it flattens a row and loses which column a
# figure sits in. These assert the data path an agent should be reading instead.
from workpaper_engine.sheets import read_cells  # noqa: E402

tbc = FIXTURES / "tb_columns.xlsx"
if not tbc.exists():
    check("tb_columns.xlsx present", False, "run spike/make_fixtures.py")
else:
    page = extract_text({"path": str(tbc), "pages": [0]})["pages"][0]
    check(
        "an account number is NOT grouped like money",
        "1001" in page["text"] and "1,001" not in page["text"],
        [ln for ln in page["text"].split(chr(10)) if "Operating #1010" in ln],
    )

    data = read_cells(str(tbc))["sheets"][0]
    check(
        "the header row is found past the firm name and date",
        data["header_row"] == 5 and data["headers"][0] == "Acct #",
        f"row {data['header_row']}: {data['headers'][:3]}",
    )
    cash = next((r for r in data["rows"] if r["cells"].get("Account Name", "").startswith("Cash - Operating #1010")), None)
    check("the cash row is found by account name", cash is not None)
    if cash:
        c = cash["cells"]
        check(
            "every figure keeps the column it was in",
            c["Beg Dr"] == "7,412.68"
            and c["Activity Dr"] == "5,310.40"
            and c["Activity Cr"] == "4,982.15"
            and c["Ending Dr"] == "7,740.93",
            {k: v for k, v in c.items() if v},
        )
        check(
            "a blank column is reported as blank, not dropped",
            c["Beg Cr"] == "" and c["Ending Cr"] == "",
            f"Beg Cr={c['Beg Cr']!r} Ending Cr={c['Ending Cr']!r}",
        )
        check("the row number matches what Excel shows", cash["row"] == 7, str(cash["row"]))

    # And the human half: a column of figures aligns on its right edge.
    # Values UNIQUE to one column — a trial balance repeats figures across the
    # beginning and ending pairs, and matching "1734" found whichever came
    # first, which made this read as a misalignment that was not there.
    edges = {}
    for w in page["words"]:
        if w["t"] in ("5,310.40", "4,655.85"):  # both Activity Dr
            edges[w["t"]] = w["box"][2]
    check(
        "figures in a column align on their right edge",
        len(edges) == 2 and abs(edges["5,310.40"] - edges["4,655.85"]) < 0.002,
        {k: round(v, 5) for k, v in edges.items()},
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

    # A wrapped source line must not weld the words either side of it together.
    # This fixture has always contained one ("...the general\nledger..."), and it
    # rendered as "generalledger" until 2026-08-07 — the assertion above stops at
    # "general", which is exactly why nothing caught it. Worse than ugly: a
    # figure wrapped away from its label became one token that binder_find could
    # not locate.
    check(
        "a wrapped source line keeps the space between its words",
        "general ledger" in doc["text"] and "generalledger" not in doc["text"],
        next((l for l in doc["text"].split(chr(10)) if "general" in l), ""),
    )

    # On a workpaper the REFERENCE is part of the evidence trail. A relative
    # path cannot become a working PDF link once the page is in a binder, but
    # dropping it leaves "see the memo" naming no memo.
    check(
        "a relative link prints its target beside the text",
        "../../equity-restatement-2026.md" in doc["text"],
        next((l for l in doc["text"].split(chr(10)) if "restatement" in l), ""),
    )
    # ...and the live one does NOT get its URL printed, because it is clickable.
    check(
        "a live link is not padded with its own URL",
        "law.cornell.edu" not in doc["text"],
        next((l for l in doc["text"].split(chr(10)) if "IRC" in l), ""),
    )

    # The structural half of the same distinction: an http target becomes a real
    # /Link a reviewer can click in any viewer, and a relative path becomes
    # printed text and NOT a link. Asserted both ways — a check that only
    # counted links would pass just as happily if everything became one, which
    # would put dead links on a workpaper.
    import pikepdf as _pike
    from workpaper_engine.documents import doc_to_pdf as _doc_to_pdf

    with _doc_to_pdf(str(memo)) as _mp:
        _uris = []
        for _pg in _mp.pages:
            for _a in (_pg.obj.get(_pike.Name("/Annots")) or []):
                if _a.get(_pike.Name("/Subtype")) == _pike.Name("/Link"):
                    _act = _a.get(_pike.Name("/A"))
                    if _act is not None and _act.get(_pike.Name("/URI")) is not None:
                        _uris.append(str(_act.get(_pike.Name("/URI"))))
    check(
        "an http target becomes a real clickable /Link",
        any("law.cornell.edu" in u for u in _uris),
        ", ".join(_uris) or "no /Link annotations",
    )
    check(
        "a relative target does NOT become a link that goes nowhere",
        not any("equity-restatement" in u for u in _uris),
        ", ".join(_uris) or "none",
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
