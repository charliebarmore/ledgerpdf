"""Page text with positions — what makes a binder addressable in words.

Without this an agent can place a tick at (0.72, 0.30) but has no idea what is
there, so every mark has to be positioned by a human. With it, "tie the repairs
figure on page 3" resolves to a word, and that word's center is already in the
coordinate space `place_mark` takes.

TWO COORDINATE SPACES, and they are not the same one:
  - pdfium's `get_charbox` reports **raw user space**, MediaBox origin, with
    page /Rotate NOT applied.
  - pdfium's `get_size` reports the **display** size, with /Rotate applied.
Dividing the first by the second looks right on an ordinary page and is wrong
on every rotated or CropBox-offset one. Verified against the hostile fixtures:
fixture_b page 0 draws its title at user-space (36, 840) under CropBox
[44,50,656,842], and pdfium reports x=36.99 — the crop origin is not
subtracted. So boxes go through `geometry.user_to_visual`, the same mapping the
marks use, and geometry comes from pikepdf via `geometry.page_geom` rather than
from pdfium, so text and marks cannot disagree about where a page's edges are.

Scanned pages carry no text layer and yield nothing. That is a true answer, not
a failure — see `has_text` on each page.
"""

from __future__ import annotations

import pikepdf
import pypdfium2 as pdfium

import io

from . import ocr as ocr_backend
from . import documents, sheets
from .geometry import page_geom, user_to_visual
from .probe import sanitize_text

# A dense page runs a few thousand words. These bound one command's output well
# below the sidecar's 16 MB protocol ceiling; truncation is always reported
# rather than silently dropping the tail.
MAX_WORDS_PER_PAGE = 4000
MAX_WORDS_TOTAL = 20000
MAX_CHARS_PER_PAGE = 40000


def _is_break(ch: str) -> bool:
    return not ch.strip()


def _page_words(text_page, geom, limit: int) -> tuple[list[dict], bool]:
    """Group pdfium's characters into words carrying normalized visual boxes."""
    words: list[dict] = []
    n = text_page.count_chars()
    buf: list[str] = []
    box: list[float] | None = None  # nx0, ny0, nx1, ny1 (display space)
    ubox: list[float] | None = None  # ux0, uy0, ux1, uy1 (user space)

    def flush() -> bool:
        """Close the pending word. Returns False once the limit is reached."""
        nonlocal buf, box, ubox
        if buf and box is not None:
            raw = sanitize_text("".join(buf)).strip()
            if raw:
                nx0, ny0, nx1, ny1 = box
                words.append(
                    {
                        "t": raw,
                        # Center — directly usable as a mark's (nx, ny).
                        "nx": round((nx0 + nx1) / 2, 5),
                        "ny": round((ny0 + ny1) / 2, 5),
                        "box": [round(v, 5) for v in (nx0, ny0, nx1, ny1)],
                        # User-space anchor, for line assembly only. Stripped
                        # before the result leaves this module.
                        "_u": ubox,
                    }
                )
        buf = []
        box = None
        ubox = None
        return len(words) < limit

    for i in range(n):
        ch = text_page.get_text_range(i, 1)
        if not ch or _is_break(ch):
            if not flush():
                return words, True
            continue
        left, bottom, right, top = text_page.get_charbox(i)
        # All four corners: at /Rotate 90/270 the axes swap, so transforming
        # only two corners would not bound the word.
        xs, ys = [], []
        for ux, uy in ((left, bottom), (right, bottom), (right, top), (left, top)):
            vx, vy = user_to_visual(geom, ux, uy)
            xs.append(vx)
            ys.append(vy)
        c = [min(xs), min(ys), max(xs), max(ys)]
        box = c if box is None else [
            min(box[0], c[0]), min(box[1], c[1]), max(box[2], c[2]), max(box[3], c[3])
        ]
        u = [min(left, right), min(bottom, top), max(left, right), max(bottom, top)]
        ubox = u if ubox is None else [
            min(ubox[0], u[0]), min(ubox[1], u[1]), max(ubox[2], u[2]), max(ubox[3], u[3])
        ]
        buf.append(ch)

    truncated = not flush()
    return words, truncated


def _lines_from_words(words: list[dict]) -> str:
    """Rebuild readable lines from positioned words.

    pdfium concatenates text-showing operations with no separator, so a tax
    form comes back as "...84,200.002b Taxable interest..." — two different
    amounts welded together, which is exactly the kind of thing a model would
    misread as one figure. The words know where they are, so let position do
    the work.

    Grouping happens in **user** space, not display space. Text baselines are
    horizontal in user space whichever way /Rotate turns the sheet, so a
    rotated page's lines stay intact; grouping by the displayed ny instead
    reads a /Rotate 90 page in vertical stripes and welds unrelated lines
    together ("Agrees 1099-MISC / to / Form box 3").
    """
    if not words:
        return ""
    heights = sorted(abs(w["_u"][3] - w["_u"][1]) for w in words)
    median_h = heights[len(heights) // 2]
    tol = max(median_h * 0.6, 1.0)  # user-space points

    # Grouped by the box TOP, not its bottom. A descender drops the bottom of
    # "operating" ~2.6pt below its neighbours — past the tolerance — so a single
    # spreadsheet row split into two lines and read as two records. Ascenders
    # move the top by only ~1.2pt, comfortably inside it.
    #
    # y increases upward in user space, so descending top is reading order.
    ordered = sorted(words, key=lambda w: (-w["_u"][3], w["_u"][0]))
    lines: list[list[dict]] = []
    anchor = None
    for w in ordered:
        y = w["_u"][3]
        if anchor is None or abs(y - anchor) > tol:
            lines.append([w])
            anchor = y
        else:
            lines[-1].append(w)
    return "\n".join(
        " ".join(x["t"] for x in sorted(line, key=lambda x: x["_u"][0])) for line in lines
    )


def extract_text(spec: dict) -> dict:
    """`{"cmd":"text","path":...,"pages":[0,2],"words":true}` -> page text.

    `pages` is optional and indexes the source document; omitting it reads the
    whole file. `words` defaults to true — set it false for reading only, which
    is much smaller on the wire.
    """
    path = spec["path"]
    want_words = spec.get("words", True)
    wanted = spec.get("pages")
    # OCR is opt-in: it is slow, and it is a guess. Never implicit.
    want_ocr = spec.get("ocr", False)

    out_pages: list[dict] = []
    budget = MAX_WORDS_TOTAL

    # A spreadsheet has no PDF until export, so build its pages in memory and
    # read those. Because the cells are really DRAWN with a font, the ordinary
    # extraction finds them with exact positions — a figure off a trial balance
    # is addressable and tickable with no OCR anywhere in the path.
    source: object = path
    if sheets.is_sheet(path) or documents.is_doc(path):
        buffer = io.BytesIO()
        maker = documents.doc_to_pdf if documents.is_doc(path) else sheets.sheet_to_pdf
        with maker(path) as made:
            made.save(buffer)
        source = buffer.getvalue()

    with pikepdf.open(io.BytesIO(source) if isinstance(source, bytes) else source) as pdf:
        n_pages = len(pdf.pages)
        indices = (
            [i for i in wanted if 0 <= i < n_pages]
            if isinstance(wanted, list)
            else list(range(n_pages))
        )
        geoms = {i: page_geom(pdf.pages[i].obj) for i in indices}

    doc = pdfium.PdfDocument(source)
    try:
        for i in indices:
            page = doc[i]
            text_page = page.get_textpage()
            try:
                # Words are always computed — the readable text is rebuilt from
                # their positions — and only returned when asked for.
                limit = min(MAX_WORDS_PER_PAGE, max(budget, 0))
                words, truncated = _page_words(text_page, geoms[i], limit)
                budget -= len(words)
                body = _lines_from_words(words)
                for w in words:
                    w.pop("_u", None)
                clipped = len(body) > MAX_CHARS_PER_PAGE
                entry: dict = {
                    "index": i,
                    "text": body[:MAX_CHARS_PER_PAGE],
                    "has_text": bool(body.strip()),
                    # Where the reading came from. "pdf" is the document's own
                    # text and is exact; "ocr" is a machine reading of a picture
                    # and can be wrong. A caller must never have to guess which.
                    "source": "pdf" if body.strip() else "none",
                }
                if clipped:
                    entry["text_truncated"] = True

                # Only a page with NO text layer is a candidate: embedded text is
                # exact, so OCR of the same page would be slower and worse.
                if want_ocr and not entry["has_text"]:
                    read, problem, engine = ocr_backend.ocr_page(page)
                    if engine:
                        entry["ocr_engine"] = engine
                    if problem:
                        entry["ocr_error"] = problem
                    elif read:
                        words = read
                        body = ocr_backend.ocr_lines(read)
                        entry["text"] = body[:MAX_CHARS_PER_PAGE]
                        entry["has_text"] = True
                        entry["source"] = "ocr"
                        confs = [w["conf"] for w in read if "conf" in w]
                        if confs:
                            entry["ocr_confidence"] = round(sum(confs) / len(confs), 1)
                            entry["ocr_min_confidence"] = round(min(confs), 1)

                if want_words:
                    entry["words"] = words
                if truncated:
                    entry["words_truncated"] = True
                out_pages.append(entry)
            finally:
                text_page.close()
    finally:
        doc.close()

    scanned = [p["index"] for p in out_pages if not p["has_text"]]
    return {
        "pages": out_pages,
        "ocr_available": ocr_backend.available(),
        "ocr_engine": ocr_backend.engine_name(),
        # Named so a caller cannot mistake "this page is a scan" for "extraction
        # failed" — the distinction decides whether OCR is the missing piece.
        "pages_without_text": scanned,
    }
