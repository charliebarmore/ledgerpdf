"""Markdown and Word documents as binder pages — typeset, not dumped.

Most of what an agent produces for an engagement is prose: a memo, a summary of
positions taken, a list of what was reconciled. Dropping the raw file in would
put "## Heading" and "**bold**" on the page as literal characters, and a
workpaper that looks like source code is not support for anything.

So these are LAID OUT: headings read as headings, lists as lists, tables as
tables. The output is a document a reviewer would accept as a memo.

Deliberate choices:

  - **Times/Helvetica via reportlab, not our own text drawing.** Prose needs
    real font metrics to wrap; the sheet renderer dodged that with monospace,
    which is right for a column of figures and wrong for a paragraph.
    Standard-14 faces, so nothing is embedded.
  - **Times-Roman body, 1-inch margins** — Charlie's own document standard for
    anything the firm issues, so a rendered memo sits beside a Word deliverable
    without looking foreign.
  - **No header or footer.** The binder numbers its own pages and the bookmark
    names the document; repeating either here would fight it.

Because the text is really drawn, the ordinary extraction reads it exactly —
a figure quoted in a memo is addressable and tickable like any other.
"""

from __future__ import annotations

import io
from pathlib import Path

import pikepdf

DOC_SUFFIXES = frozenset({".md", ".markdown", ".docx"})

PAGE = (612.0, 792.0)  # Letter portrait — a memo, not a spreadsheet
MARGIN = 72.0  # 1 inch, per the firm's document standard
BODY = 11
LEAD = 15.4
MAX_PAGES = 400


def is_doc(path: str | Path) -> bool:
    return Path(path).suffix.lower() in DOC_SUFFIXES


# ------------------------------------------------------------------- parsing
# Both formats reduce to the same short list of blocks, so there is one
# renderer rather than one per input format.
#   ("h", level, text) ("p", text) ("li", level, ordered, text)
#   ("code", text) ("quote", text) ("rule",) ("table", rows)


def _escape(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _inline(tokens) -> str:
    """markdown-it inline tokens -> the mini-markup reportlab paragraphs take."""
    out: list[str] = []
    for t in tokens:
        if t.type == "text":
            out.append(_escape(t.content))
        elif t.type == "code_inline":
            out.append(f'<font face="Courier">{_escape(t.content)}</font>')
        elif t.type in ("strong_open",):
            out.append("<b>")
        elif t.type in ("strong_close",):
            out.append("</b>")
        elif t.type in ("em_open",):
            out.append("<i>")
        elif t.type in ("em_close",):
            out.append("</i>")
        elif t.type == "softbreak":
            out.append(" ")
        elif t.type == "hardbreak":
            out.append("<br/>")
        elif t.children:
            out.append(_inline(t.children))
    return "".join(out)


def _blocks_from_markdown(text: str) -> list[tuple]:
    from markdown_it import MarkdownIt

    md = MarkdownIt("commonmark").enable("table").enable("strikethrough")
    tokens = md.parse(text)

    blocks: list[tuple] = []
    list_stack: list[bool] = []  # True = ordered
    table: list[list[str]] | None = None
    row: list[str] | None = None
    i = 0
    while i < len(tokens):
        t = tokens[i]
        if t.type == "heading_open":
            level = int(t.tag[1])
            blocks.append(("h", level, _inline(tokens[i + 1].children or [])))
            i += 3
            continue
        if t.type == "paragraph_open":
            body = _inline(tokens[i + 1].children or [])
            if list_stack:
                blocks.append(("li", len(list_stack), list_stack[-1], body))
            elif body.strip():
                blocks.append(("p", body))
            i += 3
            continue
        if t.type in ("bullet_list_open", "ordered_list_open"):
            list_stack.append(t.type.startswith("ordered"))
        elif t.type in ("bullet_list_close", "ordered_list_close"):
            if list_stack:
                list_stack.pop()
        elif t.type in ("fence", "code_block"):
            blocks.append(("code", t.content.rstrip("\n")))
        elif t.type == "blockquote_open":
            # Contents arrive as ordinary paragraphs; mark the next one.
            if i + 2 < len(tokens) and tokens[i + 2].type == "inline":
                blocks.append(("quote", _inline(tokens[i + 2].children or [])))
                i += 5
                continue
        elif t.type == "hr":
            blocks.append(("rule",))
        elif t.type == "table_open":
            table = []
        elif t.type == "table_close":
            if table:
                blocks.append(("table", table))
            table = None
        elif t.type == "tr_open":
            row = []
        elif t.type == "tr_close":
            if table is not None and row is not None:
                table.append(row)
            row = None
        elif t.type in ("th_open", "td_open"):
            if row is not None and i + 1 < len(tokens):
                row.append(_inline(tokens[i + 1].children or []))
        i += 1
    return blocks


def _blocks_from_docx(path: str | Path) -> list[tuple]:
    import docx

    document = docx.Document(str(path))
    blocks: list[tuple] = []

    def runs(paragraph) -> str:
        out: list[str] = []
        for run in paragraph.runs:
            piece = _escape(run.text)
            if run.bold:
                piece = f"<b>{piece}</b>"
            if run.italic:
                piece = f"<i>{piece}</i>"
            out.append(piece)
        return "".join(out) or _escape(paragraph.text)

    # Tables are not interleaved with paragraphs by python-docx's simple API;
    # body order is recovered from the underlying XML so a memo's tables land
    # where the author put them rather than all at the end.
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    body = document.element.body
    for child in body.iterchildren():
        tag = child.tag.split("}")[-1]
        if tag == "p":
            paragraph = Paragraph(child, document)
            style = (paragraph.style.name or "").lower()
            text = runs(paragraph)
            if not text.strip():
                continue
            if style.startswith("heading"):
                digits = "".join(c for c in style if c.isdigit())
                blocks.append(("h", int(digits or 1), text))
            elif "list" in style:
                ordered = "number" in style
                blocks.append(("li", 1, ordered, text))
            elif "quote" in style:
                blocks.append(("quote", text))
            else:
                blocks.append(("p", text))
        elif tag == "tbl":
            table = Table(child, document)
            rows = [[_escape(cell.text) for cell in r.cells] for r in table.rows]
            if rows:
                blocks.append(("table", rows))
    return blocks


def read_blocks(path: str | Path) -> list[tuple]:
    p = Path(path)
    if p.suffix.lower() == ".docx":
        return _blocks_from_docx(p)
    return _blocks_from_markdown(p.read_text(encoding="utf-8", errors="replace"))


# ----------------------------------------------------------------- rendering


def _story(blocks: list[tuple], title: str):
    from reportlab.lib import colors
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.platypus import HRFlowable, Paragraph, Spacer, Table, TableStyle

    body = ParagraphStyle(
        "body", fontName="Times-Roman", fontSize=BODY, leading=LEAD, spaceAfter=7
    )
    heads = {
        1: ParagraphStyle("h1", parent=body, fontName="Times-Bold", fontSize=17,
                          leading=21, spaceBefore=4, spaceAfter=9),
        2: ParagraphStyle("h2", parent=body, fontName="Times-Bold", fontSize=14,
                          leading=18, spaceBefore=12, spaceAfter=6),
        3: ParagraphStyle("h3", parent=body, fontName="Times-Bold", fontSize=12,
                          leading=16, spaceBefore=10, spaceAfter=4),
    }
    quote = ParagraphStyle("quote", parent=body, leftIndent=20, textColor=colors.HexColor("#4a4a45"),
                           fontName="Times-Italic")
    code = ParagraphStyle("code", parent=body, fontName="Courier", fontSize=9, leading=12,
                          leftIndent=14, spaceBefore=4, spaceAfter=8)

    # The file name is a fallback title, not a second one. A memo that opens
    # with its own H1 was getting "memo" stamped above it, which reads as a
    # mistake in a document meant to be shown to a reviewer.
    flow = []
    if not (blocks and blocks[0][0] == "h" and int(blocks[0][1]) == 1):
        flow.extend([Paragraph(_escape(title), heads[1]), Spacer(1, 4)])
    counters: dict[int, int] = {}
    for block in blocks:
        kind = block[0]
        if kind == "h":
            level = min(max(int(block[1]), 1), 3)
            flow.append(Paragraph(block[2], heads[level]))
            counters.clear()
        elif kind == "p":
            flow.append(Paragraph(block[1], body))
            counters.clear()
        elif kind == "li":
            depth, ordered, text = int(block[1]), bool(block[2]), block[3]
            if ordered:
                counters[depth] = counters.get(depth, 0) + 1
                bullet = f"{counters[depth]}."
            else:
                bullet = "•"
            style = ParagraphStyle(
                f"li{depth}", parent=body, leftIndent=18 * depth + 12,
                bulletIndent=18 * depth, spaceAfter=3
            )
            flow.append(Paragraph(text, style, bulletText=bullet))
        elif kind == "code":
            for line in str(block[1]).split("\n"):
                flow.append(Paragraph(_escape(line) or "&nbsp;", code))
        elif kind == "quote":
            flow.append(Paragraph(block[1], quote))
        elif kind == "rule":
            flow.append(HRFlowable(width="100%", color=colors.HexColor("#d4d1ca"),
                                   spaceBefore=6, spaceAfter=10))
        elif kind == "table":
            rows = block[1]
            cell = ParagraphStyle("cell", parent=body, fontSize=9.5, leading=12, spaceAfter=0)
            head = ParagraphStyle("cellh", parent=cell, fontName="Times-Bold")
            data = [
                [Paragraph(c, head if r == 0 else cell) for c in row]
                for r, row in enumerate(rows)
            ]
            usable = PAGE[0] - 2 * MARGIN
            width = usable / max(1, max(len(r) for r in rows))
            table = Table(data, colWidths=[width] * max(len(r) for r in rows), hAlign="LEFT")
            table.setStyle(
                TableStyle(
                    [
                        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#d4d1ca")),
                        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f1efe9")),
                        ("VALIGN", (0, 0), (-1, -1), "TOP"),
                        ("LEFTPADDING", (0, 0), (-1, -1), 5),
                        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                        ("TOPPADDING", (0, 0), (-1, -1), 3),
                        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
                    ]
                )
            )
            flow.extend([Spacer(1, 4), table, Spacer(1, 10)])
    return flow


def doc_to_pdf(path: str | Path) -> pikepdf.Pdf:
    """Typeset a Markdown or Word document into an in-memory PDF.

    The file on disk is never touched — same invariant as images and sheets.
    """
    from reportlab.platypus import SimpleDocTemplate

    blocks = read_blocks(path)
    buffer = io.BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=PAGE,
        leftMargin=MARGIN,
        rightMargin=MARGIN,
        topMargin=MARGIN,
        bottomMargin=MARGIN,
        title=Path(path).stem,
        author="Workpaper Binder",
    )
    doc.build(_story(blocks, Path(path).stem))
    return pikepdf.open(io.BytesIO(buffer.getvalue()))


def probe_doc(path: str | Path) -> dict:
    """Same shape probe_image/probe_sheet return, so import treats it alike."""
    with doc_to_pdf(path) as pdf:
        n_pages = len(pdf.pages)
    return {
        "path": str(path),
        "n_pages": n_pages,
        "kind": "document",
        "pages": [
            {"index": i, "rotate": 0, "mediabox": [0, 0, PAGE[0], PAGE[1]], "cropbox": None}
            for i in range(n_pages)
        ],
        "outline": [],
    }
