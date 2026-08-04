"""Spreadsheets as binder pages.

Excel IS the workpaper format for most of what a preparer assembles — trial
balances, lead sheets, depreciation schedules. Until now none of it could enter
a binder at all, which made "bring in the documents I actually have" false.

Follows the same invariant as images: the session keeps pointing at the
untouched .xlsx, and the pages are built in memory at export. Nothing here
rewrites a source file.

TWO DELIBERATE CHOICES:

1. **We lay the grid out ourselves rather than shelling out to LibreOffice or
   Excel.** A 500 MB office suite cannot be bundled, and requiring an install
   repeats the problem OCR already has. The honest cost: this is a clean
   rendering of the DATA, not Excel's own print layout — no merged-cell art, no
   conditional formatting, no charts. For a trial balance that is fine and
   arguably more legible; for a formatted client-facing schedule it is not, and
   the user should print that one to PDF themselves.

2. **Courier, not Helvetica.** Standard-14 so nothing is embedded, and every
   glyph is exactly 0.6 em — so column fitting is exact arithmetic instead of a
   font-metrics table, and figures line up in columns the way an accountant
   reads them.

Because the text is really drawn into the page, the existing text extraction
finds it with exact positions: a figure from a spreadsheet is addressable and
tickable with no OCR involved.
"""

from __future__ import annotations

import csv as csvlib
import datetime as dt
from pathlib import Path

import pikepdf
from pikepdf import Array, Dictionary, Name

SHEET_SUFFIXES = frozenset({".xlsx", ".xlsm", ".csv"})

# Both Letter orientations are tried per sheet: a transaction register is tall
# and narrow, a trial balance short and wide, and forcing one shape on both is
# what turned an 87-row sheet into a full page plus a 13-row orphan.
LANDSCAPE = (792.0, 612.0)
PORTRAIT = (612.0, 792.0)
MARGIN = 24.0
FONT_MAX = 9.0
FONT_MIN = 5.5
# How small we will go to keep a sheet on ONE page. Below this it stops being
# something a preparer can read, and two honest pages beat one unreadable one.
ONE_PAGE_MIN = 4.5
LINE_GAP = 1.35
CHAR_W = 0.6  # Courier advance, in em — exact, not an approximation
GRID_GREY = 0.75
# A runaway sheet must not turn one import into a thousand pages.
MAX_PAGES_PER_SHEET = 200
MAX_ROWS = 20000
MAX_COLS = 256


def is_sheet(path: str | Path) -> bool:
    return Path(path).suffix.lower() in SHEET_SUFFIXES


def _clean(value) -> str:
    """One cell as a string a Courier/WinAnsi page can actually show."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, float):
        # Trailing-zero noise ("1234.5600000000001") is not what was in the cell.
        text = f"{value:,.2f}" if value != int(value) else f"{int(value):,}"
    elif isinstance(value, int):
        text = f"{value:,}"
    elif isinstance(value, (dt.datetime, dt.date)):
        text = value.strftime("%Y-%m-%d")
    else:
        text = str(value)
    # WinAnsi cannot show every codepoint; a visible marker beats a broken glyph.
    return "".join(ch if 32 <= ord(ch) < 256 else "?" for ch in text.replace("\n", " "))


def read_grids(path: str | Path) -> tuple[list[tuple[str, list[list[str]]]], list[str]]:
    """(sheet name, rows of cell strings) per sheet, plus any warnings."""
    p = Path(path)
    warnings: list[str] = []
    if p.suffix.lower() == ".csv":
        with p.open(newline="", encoding="utf-8-sig", errors="replace") as handle:
            rows = [
                [_clean(cell) for cell in row[:MAX_COLS]]
                for row in list(csvlib.reader(handle))[:MAX_ROWS]
            ]
        return [(p.stem, rows)], warnings

    import openpyxl

    # data_only gives the value Excel last CALCULATED. A workbook written by a
    # tool that never calculated has none — the cell reads empty, which in a
    # workpaper is a blank where a number belongs. So the formulas are read too
    # and shown when their cached value is missing, flagged rather than hidden.
    values = openpyxl.load_workbook(p, data_only=True, read_only=True)
    formulas = openpyxl.load_workbook(p, data_only=False, read_only=True)
    grids: list[tuple[str, list[list[str]]]] = []
    uncalculated = 0
    try:
        for name in values.sheetnames:
            vsheet = values[name]
            fsheet = formulas[name] if name in formulas.sheetnames else None
            rows: list[list[str]] = []
            frows = fsheet.iter_rows(values_only=True) if fsheet else iter(())
            for row, frow in zip(vsheet.iter_rows(values_only=True), frows):
                out: list[str] = []
                for i, cell in enumerate(row[:MAX_COLS]):
                    text = _clean(cell)
                    if not text and i < len(frow):
                        raw = frow[i]
                        if isinstance(raw, str) and raw.startswith("="):
                            text = _clean(raw)
                            uncalculated += 1
                    out.append(text)
                rows.append(out)
                if len(rows) >= MAX_ROWS:
                    warnings.append(f"{name}: stopped at {MAX_ROWS} rows")
                    break
            grids.append((name, rows))
    finally:
        values.close()
        formulas.close()
    if uncalculated:
        warnings.append(
            f"{uncalculated} formula cell(s) had no calculated value and are shown "
            "as formulas — open and save the workbook in Excel to resolve them"
        )
    return grids, warnings


def _trim(rows: list[list[str]]) -> list[list[str]]:
    """Drop the empty right and bottom margins openpyxl reports."""
    while rows and not any(c.strip() for c in rows[-1]):
        rows.pop()
    width = max((max((i + 1 for i, c in enumerate(r) if c.strip()), default=0) for r in rows), default=0)
    return [r[:width] + [""] * (width - len(r)) for r in rows]


def _fits(rows, widest, page, size) -> tuple[bool, bool]:
    """(columns fit the width, all rows fit one page) at this size."""
    wide = sum((w + 2) * CHAR_W * size for w in widest) <= page[0] - 2 * MARGIN
    line = size * LINE_GAP
    tall = len(rows) * line <= page[1] - 2 * MARGIN - line
    return wide, tall


def _plan(rows: list[list[str]]) -> tuple[tuple[float, float], float, list[float], int, list[list[int]]]:
    """Choose page shape, font size, column widths, rows per page, column bands.

    ONE PAGE PER SHEET IS THE GOAL. A workbook that spills 13 rows onto a second
    page has not been paginated, it has been broken: the preparer gets a full
    page and an orphan. So the largest size that fits everything on a single
    page is found first, in BOTH Letter orientations — a transaction register is
    tall and narrow, a trial balance short and wide, and forcing one shape on
    both is what caused the orphan.

    Only when that would require type smaller than ONE_PAGE_MIN does it fall
    back to paginating, because two readable pages beat one that nobody can
    read.
    """
    if not rows:
        return LANDSCAPE, FONT_MAX, [], 1, [[]]
    n_cols = len(rows[0])
    # +2 chars of gutter, not +1: at 9pt one character is ~5pt and a label
    # ran straight into the figure beside it, which on a trial balance reads
    # as a single value.
    widest = [max((len(r[c]) for r in rows), default=0) for c in range(n_cols)]

    best: tuple[tuple[float, float], float] | None = None
    for page in (LANDSCAPE, PORTRAIT):
        size = FONT_MAX
        while size >= ONE_PAGE_MIN:
            wide, tall = _fits(rows, widest, page, size)
            if wide and tall:
                if best is None or size > best[1]:
                    best = (page, size)
                break
            size -= 0.25

    if best is not None:
        page, size = best
        cols = [(w + 2) * CHAR_W * size for w in widest]
        return page, size, cols, len(rows), [list(range(n_cols))]

    # Too much to fit legibly. Fall back to filling pages: pick the orientation
    # that needs fewer column bands, then paginate rows.
    page = LANDSCAPE
    size = FONT_MAX
    while size > FONT_MIN:
        if _fits(rows, widest, page, size)[0]:
            break
        size -= 0.5

    cols = [(w + 2) * CHAR_W * size for w in widest]
    usable = page[0] - 2 * MARGIN
    bands: list[list[int]] = []
    current: list[int] = []
    used = 0.0
    for i, width in enumerate(cols):
        # A single column wider than the page still gets its own band; it will
        # overflow rather than vanish.
        if current and used + width > usable:
            bands.append(current)
            current, used = [], 0.0
        current.append(i)
        used += width
    bands.append(current)

    line = size * LINE_GAP
    per_page = max(1, int((page[1] - 2 * MARGIN - line) // line))
    return page, size, cols, per_page, bands


def _esc(text: str) -> str:
    return text.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")


def _page_stream(
    rows: list[list[str]],
    band: list[int],
    cols: list[float],
    size: float,
    title: str,
    page: tuple[float, float],
) -> bytes:
    parts: list[str] = []
    line = size * LINE_GAP
    y = page[1] - MARGIN - size

    parts.append(f"BT /F1 {size:g} Tf {MARGIN:g} {y:g} Td ({_esc(title)}) Tj ET")
    y -= line

    # A hairline under the header keeps a long table readable without pretending
    # to reproduce the workbook's own formatting.
    parts.append(f"q {GRID_GREY:g} G 0.4 w {MARGIN:g} {y + size * 0.9:g} m "
                 f"{page[0] - MARGIN:g} {y + size * 0.9:g} l S Q")

    for row in rows:
        x = MARGIN
        for c in band:
            text = row[c] if c < len(row) else ""
            if text:
                parts.append(f"BT /F1 {size:g} Tf {x:g} {y:g} Td ({_esc(text)}) Tj ET")
            x += cols[c]
        y -= line
    return " ".join(parts).encode("latin-1", "replace")


def sheet_to_pdf(path: str | Path) -> pikepdf.Pdf:
    """Render a spreadsheet to an in-memory PDF. The file on disk is untouched."""
    grids, _warnings = read_grids(path)
    pdf = pikepdf.new()
    font = pdf.make_indirect(
        Dictionary(
            Type=Name.Font,
            Subtype=Name.Type1,
            BaseFont=Name("/Courier"),
            Encoding=Name("/WinAnsiEncoding"),
        )
    )
    resources = Dictionary(Font=Dictionary(F1=font))

    for name, raw in grids:
        rows = _trim(raw)
        shape, size, cols, per_page, bands = _plan(rows)
        chunks = [rows[i : i + per_page] for i in range(0, len(rows), per_page)] or [[]]
        made = 0
        for band_i, band in enumerate(bands):
            for chunk_i, chunk in enumerate(chunks):
                if made >= MAX_PAGES_PER_SHEET:
                    break
                label = name
                if len(chunks) > 1:
                    label += f"  (rows {chunk_i * per_page + 1}-{chunk_i * per_page + len(chunk)})"
                if len(bands) > 1:
                    label += f"  (columns {band_i + 1} of {len(bands)})"
                sheet_page = pdf.add_blank_page(page_size=shape)
                sheet_page.obj.Contents = pdf.make_stream(
                    _page_stream(chunk, band, cols, size, label, shape)
                )
                sheet_page.obj.Resources = resources
                made += 1
    if len(pdf.pages) == 0:
        blank = pdf.add_blank_page(page_size=LANDSCAPE)
        blank.obj.Contents = pdf.make_stream(
            _page_stream([], [], [], FONT_MAX, Path(path).name, LANDSCAPE)
        )
        blank.obj.Resources = resources
    return pdf


def probe_sheet(path: str | Path) -> dict:
    """Same shape probe_image returns, so import treats a sheet like any source."""
    grids, warnings = read_grids(path)
    boxes: list[list[float]] = []
    with sheet_to_pdf(path) as pdf:
        n_pages = len(pdf.pages)
        for page in pdf.pages:
            boxes.append([float(v) for v in page.obj.MediaBox])
    return {
        "path": str(path),
        "n_pages": n_pages,
        "kind": "sheet",
        "pages": [
            {"index": i, "rotate": 0, "mediabox": boxes[i], "cropbox": None}
            for i in range(n_pages)
        ],
        "outline": [],
        "sheet": {
            "sheets": [
                {"name": name, "rows": len(_trim(rows)), "columns": len(_trim(rows)[0]) if _trim(rows) else 0}
                for name, rows in grids
            ],
            "warnings": warnings,
        },
    }
