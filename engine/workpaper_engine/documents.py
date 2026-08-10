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
  - **Times-Roman body, 1-inch margins** — a conventional professional memo
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

#: Hyperlink ink. Deliberately NOT a brand token: per DESIGN.md the brand stops
#: at the chrome, and this is body text on a document somebody files. A muted
#: document blue is what Word puts on a hyperlink, so a rendered memo still sits
#: beside a Word deliverable without looking foreign.
LINK_COLOR = "#1A4F8A"

#: Schemes that survive as a real PDF link. A relative path or a `#anchor` has
#: no meaning once the page is inside a binder — the file it pointed at is not
#: there, and a link annotation that goes nowhere is worse than none, so those
#: keep rendering as plain text (the link TEXT is still drawn either way).
_LINK_SCHEMES = ("http://", "https://", "mailto:")


def is_doc(path: str | Path) -> bool:
    return Path(path).suffix.lower() in DOC_SUFFIXES


# ------------------------------------------------------------------- parsing
# Both formats reduce to the same short list of blocks, so there is one
# renderer rather than one per input format.
#   ("h", level, text) ("p", text) ("li", level, ordered, text)
#   ("code", text) ("quote", text) ("rule",) ("table", rows)


# ------------------------------------------------------------ glyph safety
#
# reportlab's base-14 fonts route any character they cannot draw to
# ZapfDingbats 'n', which is a SOLID BLACK SQUARE. On a workpaper that is
# worse than a dropped character, because it is not visibly a failure: on an
# open-items list `☑` (cleared) and `☐` (outstanding) both arrive as `■`, so a
# reviewer cannot tell a closed item from an open one — and neither can an
# agent, since the substitution happens in the text layer too, not just in the
# rendering. The distinction the checkbox existed to carry is simply gone, on
# a document somebody signs.
#
# So: substitute where the intent is unambiguous, and make anything else
# visibly wrong rather than quietly square.

#: Private-use codepoint — guaranteed to have no glyph in any real font, so
#: measuring it tells us the width reportlab uses for "cannot draw this".
#: Calibrated rather than hard-coded: 9.132pt today, but that is reportlab's
#: business, not ours.
_NOTDEF_PROBE = ""

#: Characters an accountant reasonably types whose meaning survives a swap for
#: something the base-14 fonts can actually draw. Deliberately short: every
#: entry is a case where the replacement means the SAME thing, not merely
#: something similar. A `☑` is a tick; a `▪` is not any particular thing, so it
#: is not in here.
_GLYPH_SUBS = {
    "☑": "✔",  # ☑ ballot with check -> ✔ heavy check
    "✅": "✔",  # ✅ white heavy check -> ✔
    "☒": "✘",  # ☒ ballot with X     -> ✘ heavy X
    "❎": "✘",  # ❎ cross mark button -> ✘
    "☐": "❑",  # ☐ empty ballot      -> ❑ lower-right shadowed box
    "□": "❑",  # □ white square      -> ❑
}


def _notdef_width(font: str) -> float:
    from reportlab.pdfbase.pdfmetrics import stringWidth

    return stringWidth(_NOTDEF_PROBE, font, 12)


def _renderable(ch: str, font: str) -> bool:
    from reportlab.pdfbase.pdfmetrics import stringWidth

    return stringWidth(ch, font, 12) != _notdef_width(font)


def _safe_text(text: str, font: str = "Times-Roman") -> str:
    """Substitute what we can, and flag what we cannot.

    An unmapped character that still will not draw becomes `[U+XXXX]`. That is
    ugly on purpose — it is unmistakably a tooling failure, where a black
    square reads as deliberate content.
    """
    out: list[str] = []
    for ch in text:
        if ch in _GLYPH_SUBS:
            ch = _GLYPH_SUBS[ch]
        # ASCII always draws; skip the metrics lookup for the common case.
        if ch < "\x80" or ch in "\r\n\t" or _renderable(ch, font):
            out.append(ch)
        else:
            out.append(f"[U+{ord(ch):04X}]")
    return "".join(out)


def _escape(text: str, font: str = "Times-Roman") -> str:
    text = _safe_text(text, font)
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _escape_attr(text: str) -> str:
    """Escape for an attribute value, quotes included.

    No glyph substitution: a URL is addressed, not drawn, so `_safe_text` would
    corrupt a perfectly good link to make a character it never has to render.
    """
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


#: Ink for a target that is printed rather than linked. Muted, and set in
#: Courier at a smaller size, so it reads as a citation beside the sentence
#: rather than as prose — and so it can never be mistaken for a live link,
#: which is blue and underlined.
TARGET_COLOR = "#6B6B70"
TARGET_SIZE = 9


def _strip_tags(markup: str) -> str:
    import re

    return re.sub(r"<[^>]+>", "", markup)


def _link_target_text(href: str, inner_markup: str = "") -> str:
    """How a target that cannot become a PDF link is printed beside its text.

    A relative path or an `#anchor` has no meaning once the page is inside a
    binder, so it cannot be a working link — but on a workpaper the reference
    is part of the evidence trail. "See the memo" that does not say WHICH memo
    supports nothing a reviewer can follow.
    """
    if not href:
        return ""
    # `[../x.md](../x.md)` is common in working notes; printing it twice helps
    # nobody and makes the line harder to read than leaving it alone.
    if _strip_tags(inner_markup).strip() == href:
        return ""
    return (
        f' <font face="Courier" size="{TARGET_SIZE}" color="{TARGET_COLOR}">'
        f'({_escape(href, "Courier")})</font>'
    )


def _inline(tokens) -> str:
    """markdown-it inline tokens -> the mini-markup reportlab paragraphs take."""
    out: list[str] = []
    # One entry per open link, True if we actually emitted an <a> for it. A link
    # we declined to linkify still arrives with a link_close, and closing a tag
    # that was never opened is what corrupts the rest of the paragraph.
    links: list[bool] = []
    for t in tokens:
        if t.type == "text":
            out.append(_escape(t.content))
        elif t.type == "code_inline":
            # Courier, not Times — a character can draw in one and not the
            # other, and a code span is measured against the font it is set in.
            out.append(f'<font face="Courier">{_escape(t.content, "Courier")}</font>')
        elif t.type in ("strong_open",):
            out.append("<b>")
        elif t.type in ("strong_close",):
            out.append("</b>")
        elif t.type in ("em_open",):
            out.append("<i>")
        elif t.type in ("em_close",):
            out.append("</i>")
        elif t.type == "softbreak":
            # A wrapped source line. Dropping the token welded the words either
            # side of it together — "and the\nregs." rendered as "and theregs",
            # and a figure wrapped away from its label came out as one unfindable
            # token. Most hand-written markdown wraps, so this hit most memos.
            out.append(" ")
        elif t.type == "hardbreak":
            out.append("<br/>")
        elif t.type == "s_open":
            # The parser has strikethrough enabled, so without this the tokens
            # arrive and vanish: `~~cleared~~` renders as ordinary text and an
            # item struck off an open-items list reads as still open. Same
            # failure as the checkbox above — wrong, and not visibly wrong.
            out.append("<strike>")
        elif t.type == "s_close":
            out.append("</strike>")
        elif t.type == "link_open":
            href = (t.attrGet("href") or "").strip()
            live = href.lower().startswith(_LINK_SCHEMES)
            if live:
                # Underlined as well as coloured. Colour alone is invisible on a
                # greyscale print, and a printed binder is how these get signed.
                out.append(f'<a href="{_escape_attr(href)}" color="{LINK_COLOR}"><u>')
            links.append((live, href, len(out)))
        elif t.type == "link_close":
            was_live, href, start = links.pop() if links else (False, "", len(out))
            if was_live:
                out.append("</u></a>")
            elif href:
                # A relative path or an #anchor cannot become a working PDF link
                # — the file it names is not in this document. Dropping it was
                # the old behaviour and it is the wrong trade on a workpaper: the
                # REFERENCE is part of the evidence trail, and "see the memo"
                # with no memo named supports nothing. So print the target beside
                # the text, in a way that cannot be mistaken for a live link.
                shown = _link_target_text(href, "".join(out[start:]))
                if shown:
                    out.append(shown)
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
                flow.append(Paragraph(_escape(line, "Courier") or "&nbsp;", code))
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
        author="LedgerPDF",
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
