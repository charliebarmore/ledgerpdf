"""Hand-authored PDF appearance streams for workpaper marks.

This is the load-bearing spike work: every mark is a /Stamp annotation whose
/AP /N is a Form XObject we author ourselves, so it renders identically in any
compliant viewer (no reliance on viewer-synthesized appearances).

Rules:
- Appearance colors are annotation CONTENT, not UI theme (DESIGN.md) — they
  must match on screen and in export.
- Fonts: base-14 only (Courier for tapes) — universally available, nothing to
  embed for the spike. Embedding is a Phase 5 decision.
- Rotation compensation comes from geometry.appearance_matrix(), applied as the
  form's /Matrix.
"""

from __future__ import annotations

import json
from typing import Callable

import pikepdf
from pikepdf import Array, Dictionary, Name, String

from .geometry import PageGeom, appearance_matrix, visual_rect_to_user_rect

# Visual constants (points, displayed size)
TICK_SIZE = 24.0
TICK_COLOR = (0.13, 0.55, 0.13)  # workpaper green — content, not theme

# Review-mark palette. Colors are annotation CONTENT (they must look identical
# on screen and in the exported PDF), so they live here, not in the UI theme.
MARK_COLORS: dict[str, tuple[float, float, float]] = {
    "tick": TICK_COLOR,
    "cross": (0.72, 0.15, 0.15),
    "text": (0.10, 0.33, 0.60),
    # Amber: a note asks for attention without asserting a fault the way the
    # cross does.
    "note": (0.78, 0.51, 0.10),
    # Violet, deliberately outside the green/red/blue the judgment marks use.
    # A connector asserts nothing about the figure — it says "this is the same
    # number as that one" — so it must not read as agreed or disagreed.
    # Mirrored in session.ts MARK_COLOR['conn'].
    "conn": (0.44, 0.23, 0.58),
    # A factual stamp, not a judgment — same family as lettered text marks.
    "date": (0.10, 0.33, 0.60),
}
TEXT_MARK_FONT_SIZE = 12.0
TEXT_MARK_PAD = 4.0
TEXT_MARK_CHAR_RATIO = 0.556  # Helvetica average advance
TEXT_MARK_CHAR_W = TEXT_MARK_FONT_SIZE * TEXT_MARK_CHAR_RATIO
TAPE_FONT_SIZE = 9.0
TAPE_LINE_HEIGHT = 11.0
TAPE_PAD = 6.0
TAPE_CHAR_W = TAPE_FONT_SIZE * 0.6  # Courier advance = 0.6 em
TAPE_TEXT_COLOR = (0.10, 0.10, 0.12)
# A tape sits ON the workpaper — it is not part of the statement under it, and
# it has to be findable at a glance on a page that is already dense with print.
# A white card with a hairline border disappears against white statement paper,
# so the card is tinted and the border carries real weight. Mirrored exactly in
# styles.css `.tape`: preview and export must not drift.
TAPE_BG_COLOR = (0.906, 0.898, 0.882)
TAPE_BORDER_COLOR = (0.35, 0.21, 0.08)
TAPE_BORDER_W = 1.0


def _esc(text: str) -> str:
    """Escape a string for a PDF literal string drawn by a standard-14 font.

    The old version escaped the three PDF delimiters and nothing else, and the
    content stream is written as ASCII — so the first em dash in a tape title
    crashed SAVE with a UnicodeEncodeError. A caption character must never be
    able to take down a save.

    Non-ASCII goes out as octal escapes of its WinAnsi byte — the escapes are
    ASCII, so the stream still encodes — and every font that draws user text
    declares /WinAnsiEncoding so those bytes mean what they say. A character
    WinAnsi cannot carry becomes a visible [U+XXXX], the same honest failure
    the memo typesetter uses, never a silent swap and never a crash.
    """
    out: list[str] = []
    for ch in text:
        if ch in "\\()":
            out.append("\\" + ch)
        elif " " <= ch <= "~":
            out.append(ch)
        else:
            try:
                out.append(f"\\{ch.encode('cp1252')[0]:03o}")
            except (UnicodeEncodeError, IndexError):
                out.append(f"[U+{ord(ch):04X}]")
    return "".join(out)


def _fmt(v: float) -> str:
    return f"{v:.2f}".rstrip("0").rstrip(".")


#: Bezier circle constant — 4/3 * (sqrt(2) - 1).
KAPPA = 0.5523


def ellipse_path(
    x0: float,
    y0: float,
    x1: float,
    y1: float,
    fmt: Callable[[float], str] = _fmt,
) -> str:
    """Four Beziers approximating an ellipse inscribed in the box.

    Takes its own formatter because shapes.py prints coordinates to three
    decimals and this module to two: sharing the MATH matters, and changing
    either module's precision would move geometry that pixel checks already
    pin down. One implementation, two renderings.
    """
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    rx, ry = (x1 - x0) / 2, (y1 - y0) / 2
    ox, oy = rx * KAPPA, ry * KAPPA
    return " ".join(
        [
            f"{fmt(cx - rx)} {fmt(cy)} m",
            f"{fmt(cx - rx)} {fmt(cy + oy)} {fmt(cx - ox)} {fmt(cy + ry)} {fmt(cx)} {fmt(cy + ry)} c",
            f"{fmt(cx + ox)} {fmt(cy + ry)} {fmt(cx + rx)} {fmt(cy + oy)} {fmt(cx + rx)} {fmt(cy)} c",
            f"{fmt(cx + rx)} {fmt(cy - oy)} {fmt(cx + ox)} {fmt(cy - ry)} {fmt(cx)} {fmt(cy - ry)} c",
            f"{fmt(cx - ox)} {fmt(cy - ry)} {fmt(cx - rx)} {fmt(cy - oy)} {fmt(cx - rx)} {fmt(cy)} c",
        ]
    )


#: The agent outline. Neutral grey on purpose: colour on a mark already means
#: its KIND (green tick, red cross, blue stamp, amber note), and in workpaper
#: convention often also which procedure was performed. Encoding "who placed
#: this" in the same channel would collide with both, and fails outright for a
#: colourblind reviewer. A thin box is a second channel, legible in greyscale
#: and on a photocopy.
AGENT_OUTLINE_COLOR = (0.45, 0.45, 0.47)
AGENT_OUTLINE_WIDTH = 0.5


def _agent_outline(bbox: tuple[float, float, float, float]) -> bytes:
    """A hairline box just inside `bbox`, marking a mark as machine-placed.

    Drawn INSIDE the existing box rather than around it so the annotation's
    /Rect does not have to grow — a mark whose rect changed with its
    provenance would land in a different place depending on who put it there,
    which is exactly the property the geometry tests exist to protect.
    """
    x0, y0, x1, y1 = bbox
    i = AGENT_OUTLINE_WIDTH  # inset by the stroke so nothing clips at the edge
    r, g, b = AGENT_OUTLINE_COLOR
    return (
        f"q {r} {g} {b} RG {_fmt(AGENT_OUTLINE_WIDTH)} w "
        f"{_fmt(x0 + i)} {_fmt(y0 + i)} {_fmt(x1 - x0 - 2 * i)} {_fmt(y1 - y0 - 2 * i)} re S Q "
    ).encode("ascii")


def _make_form(
    pdf: pikepdf.Pdf,
    content: bytes,
    bbox: tuple[float, float, float, float],
    rotate: int,
    resources: Dictionary | None = None,
    agent: bool = False,
) -> pikepdf.Stream:
    if agent:
        content = _agent_outline(bbox) + content
    form = pdf.make_stream(content)
    form.Type = Name.XObject
    form.Subtype = Name.Form
    form.BBox = Array(list(bbox))
    m = appearance_matrix(rotate)
    if m is not None:
        form.Matrix = Array(m)
    if resources is not None:
        form.Resources = resources
    return form


def tick_appearance(
    pdf: pikepdf.Pdf,
    rotate: int,
    size: float = TICK_SIZE,
    color: tuple[float, float, float] = TICK_COLOR,
    agent: bool = False,
) -> pikepdf.Stream:
    """A checkmark, stroked, in a size x size form space."""
    r, g, b = color
    k = size / TICK_SIZE  # the path below is authored at 24pt
    w = _fmt(2.6 * k)
    pts = " ".join(
        f"{_fmt(x * k)} {_fmt(y * k)}" for x, y in ((4, 12), (10, 5.5), (20, 19))
    ).split(" ")
    content = (
        f"q {r} {g} {b} RG {w} w 1 J 1 j "
        f"{pts[0]} {pts[1]} m {pts[2]} {pts[3]} l {pts[4]} {pts[5]} l S Q"
    ).encode("ascii")
    return _make_form(pdf, content, (0, 0, size, size), rotate, agent=agent)


def cross_appearance(
    pdf: pikepdf.Pdf,
    rotate: int,
    size: float = TICK_SIZE,
    color: tuple[float, float, float] | None = None,
    agent: bool = False,
) -> pikepdf.Stream:
    """An X — "does not agree" in most review conventions."""
    r, g, b = color or MARK_COLORS["cross"]
    inset = size * 0.22
    a, z = _fmt(inset), _fmt(size - inset)
    content = (
        f"q {r} {g} {b} RG {_fmt(size * 0.11)} w 1 J "
        f"{a} {a} m {z} {z} l S {a} {z} m {z} {a} l S Q"
    ).encode("ascii")
    return _make_form(pdf, content, (0, 0, size, size), rotate, agent=agent)


#: Ring stroke as a fraction of the connector's size, and how far the ring is
#: inset from the annotation box so the stroke cannot clip at the edge. A stroke
#: straddles its path — the same trap the shape module pads for.
CONN_STROKE_RATIO = 0.075
CONN_INSET_RATIO = 0.06


def conn_font_size(size: float, label: str) -> float:
    """Point size for a connector's label so it stays inside its ring.

    Duplicated by `connectorFontSize` in session.ts, and verify:model compares
    the two directly. If they drift, a connector reading "12" on screen exports
    with its digits crossing the ring and nothing else would catch it.
    """
    n = max(1, len(label.strip()))
    return size * (0.55 if n <= 1 else 0.42 if n == 2 else 0.3)


def conn_appearance(
    pdf: pikepdf.Pdf,
    label: str,
    rotate: int,
    size: float = TICK_SIZE,
    color: tuple[float, float, float] | None = None,
    agent: bool = False,
) -> pikepdf.Stream:
    """A circled number or letter — one end of a cross-reference.

    Filled white before the label is drawn: a connector lands ON a figure in a
    dense table, and an unfilled ring leaves the printed digits underneath
    tangled with the label. White fill is what makes it legible on paper, which
    is where a workpaper gets signed.
    """
    r, g, b = color or MARK_COLORS["conn"]
    inset = size * CONN_INSET_RATIO
    stroke = size * CONN_STROKE_RATIO
    ring = ellipse_path(inset, inset, size - inset, size - inset)
    font = conn_font_size(size, label)
    text = _esc(label.strip() or "?")
    # Helvetica-Bold advance is ~0.556 em for digits and caps; centring on the
    # measured width is what keeps "1" and "12" both on the ring's centre.
    width = len(label.strip() or "?") * font * 0.556
    tx = (size - width) / 2
    ty = (size - font * 0.72) / 2
    content = (
        f"q 1 1 1 rg {r} {g} {b} RG {_fmt(stroke)} w "
        f"{ring} h B Q "
        f"q {r} {g} {b} rg BT /F1 {_fmt(font)} Tf "
        f"{_fmt(tx)} {_fmt(ty)} Td ({text}) Tj ET Q"
    ).encode("ascii")
    resources = Dictionary(
        Font=Dictionary(
            F1=Dictionary(
                Type=Name.Font,
                Subtype=Name.Type1,
                BaseFont=Name("/Helvetica-Bold"),
                Encoding=Name("/WinAnsiEncoding"),
            )
        )
    )
    return _make_form(pdf, content, (0, 0, size, size), rotate, resources, agent=agent)


def text_mark_size(text: str, font_size: float = TEXT_MARK_FONT_SIZE) -> tuple[float, float]:
    """Visual (w, h) for a short text mark such as "F", "TB", or initials."""
    chars = max(len(text), 1)
    w = chars * font_size * TEXT_MARK_CHAR_RATIO + 2 * TEXT_MARK_PAD
    h = font_size + 2 * TEXT_MARK_PAD
    return (w, h)


def text_appearance(
    pdf: pikepdf.Pdf,
    text: str,
    rotate: int,
    font_size: float = TEXT_MARK_FONT_SIZE,
    color: tuple[float, float, float] | None = None,
    agent: bool = False,
) -> tuple[pikepdf.Stream, float, float]:
    """A short lettered mark (F = footed, T = tied, initials, ...)."""
    r, g, b = color or MARK_COLORS["text"]
    w, h = text_mark_size(text, font_size)
    parts = [
        "q",
        f"{r} {g} {b} rg",
        "BT",
        f"/F1 {_fmt(font_size)} Tf",
        f"{_fmt(TEXT_MARK_PAD)} {_fmt(TEXT_MARK_PAD + font_size * 0.18)} Td",
        f"({_esc(text)}) Tj",
        "ET",
        "Q",
    ]
    resources = Dictionary(
        Font=Dictionary(
            F1=Dictionary(
                Type=Name.Font, Subtype=Name.Type1, BaseFont=Name("/Helvetica-Bold"), Encoding=Name("/WinAnsiEncoding")
            )
        )
    )
    form = _make_form(
        pdf, " ".join(parts).encode("ascii"), (0, 0, w, h), rotate, resources, agent=agent
    )
    return form, w, h


#: A tape is sized by its FONT, and everything else follows proportionally —
#: character advance, line height, padding. One number so a preparer scaling a
#: tape cannot end up with tight text in a roomy card, and so the preview and
#: the export cannot drift: both derive every dimension from this one input.
#: The border stays a hairline at any size, because that is what a hairline is.
TAPE_SIZE_MIN = 6.0
TAPE_SIZE_MAX = 18.0


def tape_metrics(font: float | None = None) -> tuple[float, float, float]:
    """(char advance, line height, padding) for a tape set at `font` points."""
    size = TAPE_FONT_SIZE if font is None else max(TAPE_SIZE_MIN, min(TAPE_SIZE_MAX, float(font)))
    k = size / TAPE_FONT_SIZE
    return (size * 0.6, TAPE_LINE_HEIGHT * k, TAPE_PAD * k)


def tape_size(lines: list[str], font: float | None = None) -> tuple[float, float]:
    """Visual (w, h) in points for a tape with these lines."""
    char_w, line_h, pad = tape_metrics(font)
    max_chars = max((len(ln) for ln in lines), default=1)
    w = max_chars * char_w + 2 * pad
    h = len(lines) * line_h + 2 * pad
    return (w, h)


def tape_appearance(
    pdf: pikepdf.Pdf,
    lines: list[str],
    rotate: int,
    agent: bool = False,
    font: float | None = None,
) -> tuple[pikepdf.Stream, float, float]:
    """Calculator-tape appearance: tinted card, bordered, Courier lines."""
    size, line_h, pad = (tape_metrics(font)[0] / 0.6, *tape_metrics(font)[1:])
    w, h = tape_size(lines, font)
    tr, tg, tb = TAPE_TEXT_COLOR
    br, bg, bb = TAPE_BORDER_COLOR
    kr, kg, kb = TAPE_BG_COLOR
    inset = TAPE_BORDER_W / 2  # stroke straddles the path; keep it inside the BBox
    parts = [
        "q",
        f"{kr} {kg} {kb} rg 0 0 {_fmt(w)} {_fmt(h)} re f",  # card background
        f"{br} {bg} {bb} RG {_fmt(TAPE_BORDER_W)} w "
        f"{_fmt(inset)} {_fmt(inset)} {_fmt(w - TAPE_BORDER_W)} {_fmt(h - TAPE_BORDER_W)} re S",
        f"{tr} {tg} {tb} rg",
        "BT",
        f"/F1 {_fmt(size)} Tf {_fmt(line_h)} TL",
        f"{_fmt(pad)} {_fmt(h - pad - size)} Td",
    ]
    for i, ln in enumerate(lines):
        if i > 0:
            parts.append("T*")
        parts.append(f"({_esc(ln)}) Tj")
    parts += ["ET", "Q"]
    resources = Dictionary(
        Font=Dictionary(
            F1=Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Courier, Encoding=Name("/WinAnsiEncoding"))
        )
    )
    form = _make_form(
        pdf, " ".join(parts).encode("ascii"), (0, 0, w, h), rotate, resources, agent=agent
    )
    return form, w, h


def _display_author(spec: dict) -> str:
    """The name a viewer shows against an annotation.

    An agent placing marks under the reviewer's initials would show up in
    Acrobat as the reviewer — a person's signature on work they did not do,
    which is precisely what a file review must be able to tell apart. The raw
    initials stay in /WPT_Data; only the visible author is qualified.
    """
    author = str(spec.get("author", ""))
    if spec.get("by") == "agent":
        return f"{author} (AI)" if author else "AI"
    return author


def note_appearance(
    pdf: pikepdf.Pdf, rotate: int, size: float, agent: bool = False
) -> pikepdf.Stream:
    """A small sheet with a folded corner and two rules — a note.

    pdfium and several other renderers draw nothing for a /Text annotation with
    no appearance stream, so a note left by an agent would be invisible in our
    own page view and thumbnails. Providing one costs nothing and makes the note
    render identically everywhere.
    """
    r, g, b = MARK_COLORS["note"]
    w = h = size
    fold = size * 0.28
    ops = [
        f"{r:.4f} {g:.4f} {b:.4f} rg",
        # Body with the top-right corner cut away.
        f"0 0 m {w:.3f} 0 l {w:.3f} {h - fold:.3f} l {w - fold:.3f} {h:.3f} l 0 {h:.3f} l f",
        # The fold itself, lighter so it reads as a turned corner.
        "1 1 1 rg",
        f"{w - fold:.3f} {h:.3f} m {w:.3f} {h - fold:.3f} l {w - fold:.3f} {h - fold:.3f} l f",
        # Two rules, so it reads as writing rather than a blank tile.
        "1 1 1 RG",
        f"{size * 0.09:.3f} w",
        f"{size * 0.18:.3f} {h * 0.38:.3f} m {w - size * 0.18:.3f} {h * 0.38:.3f} l S",
        f"{size * 0.18:.3f} {h * 0.60:.3f} m {w - size * 0.45:.3f} {h * 0.60:.3f} l S",
    ]
    form = pdf.make_stream(" ".join(ops).encode("ascii"))
    form[Name("/Type")] = Name.XObject
    form[Name("/Subtype")] = Name.Form
    form[Name("/BBox")] = Array([0, 0, w, h])
    matrix = appearance_matrix(rotate)
    if matrix:
        form[Name("/Matrix")] = Array(matrix)
    return form


def _base_annot(
    pdf: pikepdf.Pdf,
    rect: tuple[float, float, float, float],
    form: pikepdf.Stream,
    nm: str,
    author: str,
    contents: str,
    kind: str,
    subtype=Name.Stamp,
) -> pikepdf.Object:
    annot = Dictionary(
        Type=Name.Annot,
        Subtype=subtype,
        Rect=Array(list(rect)),
        AP=Dictionary(N=form),
        NM=String(nm),
        T=String(author),
        Contents=String(contents),
        F=4,  # Print flag — marks are part of the workpaper record
    )
    annot[Name("/WPT_Kind")] = String(kind)
    return pdf.make_indirect(annot)


def make_tick(
    pdf: pikepdf.Pdf,
    geom: PageGeom,
    nx: float,
    ny: float,
    nm: str,
    author: str = "",
    note: str = "Tick mark",
    size: float = TICK_SIZE,
) -> pikepdf.Object:
    rect = visual_rect_to_user_rect(geom, nx, ny, size, size)
    form = tick_appearance(pdf, geom.rotate, size)
    return _base_annot(pdf, rect, form, nm, author, note, "tick")


def make_mark(
    pdf: pikepdf.Pdf,
    geom: PageGeom,
    spec: dict,
    nm: str,
) -> pikepdf.Object:
    """Place one review mark. `spec` mirrors the app's Mark model:

        {kind: "tick"|"cross"|"text"|"date", nx, ny, size?, text?,
         date_text?, author?, note?, created?}

    The full spec is embedded as private /WPT_Data so the app can reopen and
    edit the mark later — and so a future tie-out layer has structured data to
    read, rather than having to infer meaning from a glyph.
    """
    kind = spec.get("kind", "tick")
    size = float(spec.get("size", TICK_SIZE))
    author = _display_author(spec)
    color = MARK_COLORS.get(kind, TICK_COLOR)
    # The outline is the at-a-glance half of attribution. The author field says
    # "(AI)" in a comments pane a reviewer has to open; this says it on the page.
    agent = spec.get("by") == "agent"

    if kind == "text":
        text = str(spec.get("text", "")).strip() or "?"
        form, w, h = text_appearance(pdf, text, geom.rotate, size * 0.5, color, agent=agent)
        note = spec.get("note") or f"Mark: {text}"
    elif kind == "date":
        text = str(spec.get("date_text", "")).strip()
        if not text:
            raise ValueError("date mark needs its stored calendar date")
        form, w, h = text_appearance(pdf, text, geom.rotate, size * 0.5, color, agent=agent)
        note = spec.get("note") or f"Date stamped: {text}"
    elif kind == "note":
        form = note_appearance(pdf, geom.rotate, size, agent=agent)
        note = spec.get("note") or ""
        w = h = size
    elif kind == "conn":
        label = str(spec.get("text", "")).strip() or "?"
        form = conn_appearance(pdf, label, geom.rotate, size, color, agent=agent)
        # The default says what the mark IS to anyone reading the Comments pane
        # in Acrobat, where the ring is just a picture. `binder.py` overwrites
        # this with the resolved page number when the connector has a twin.
        note = spec.get("note") or f"Reference {label}"
        w = h = size
    elif kind == "cross":
        form = cross_appearance(pdf, geom.rotate, size, color, agent=agent)
        note = spec.get("note") or "Does not agree"
        w = h = size
    elif kind == "tick":
        form = tick_appearance(pdf, geom.rotate, size, color, agent=agent)
        note = spec.get("note") or "Agreed"
        w = h = size
    else:
        raise ValueError(f"unknown mark kind: {kind}")

    rect = visual_rect_to_user_rect(geom, float(spec["nx"]), float(spec["ny"]), w, h)
    # /Text, not /Stamp, for a note: that is the subtype Acrobat collects into
    # its Comments pane, which is where a reviewer looks for review comments and
    # how they survive to anyone who opens the exported binder.
    annot = _base_annot(
        pdf, rect, form, nm, author, str(note), kind,
        subtype=Name.Text if kind == "note" else Name.Stamp,
    )
    if kind == "note":
        annot[Name("/Name")] = Name("/Comment")
        annot[Name("/Open")] = False
    payload = {k: v for k, v in spec.items() if k not in ("nx", "ny")}
    payload.update({"nx": spec["nx"], "ny": spec["ny"]})
    annot[Name("/WPT_Data")] = String(json.dumps(payload, separators=(",", ":")))
    return annot


def make_tape(
    pdf: pikepdf.Pdf,
    geom: PageGeom,
    nx: float,
    ny: float,
    lines: list[str],
    tape_data: dict,
    nm: str,
    author: str = "",
    agent: bool = False,
    font: float | None = None,
) -> pikepdf.Object:
    """Tape annotation. `lines` is the printed appearance; `tape_data` is the
    structured, editable form embedded as private metadata (/WPT_Data) so the
    app can reopen and edit while ordinary viewers just show the appearance."""
    form, w, h = tape_appearance(pdf, lines, geom.rotate, agent=agent, font=font)
    rect = visual_rect_to_user_rect(geom, nx, ny, w, h)
    contents = "Calculator tape: " + (lines[-1].strip() if lines else "")
    annot = _base_annot(pdf, rect, form, nm, author, contents, "tape")
    annot[Name("/WPT_Data")] = String(json.dumps(tape_data, separators=(",", ":")))
    return annot


def make_link(
    pdf: pikepdf.Pdf,
    geom: PageGeom,
    rect_n: tuple[float, float, float, float],
    dest: Array,
    nm: str,
) -> pikepdf.Object:
    """Internal link annotation over a visual rect (nx0, ny0, nx1, ny1)."""
    nx0, ny0, nx1, ny1 = rect_n
    cx = (nx0 + nx1) / 2
    cy = (ny0 + ny1) / 2
    dw, dh = geom.display_size
    vw = abs(nx1 - nx0) * dw
    vh = abs(ny1 - ny0) * dh
    rect = visual_rect_to_user_rect(geom, cx, cy, vw, vh)
    annot = Dictionary(
        Type=Name.Annot,
        Subtype=Name.Link,
        Rect=Array(list(rect)),
        Border=Array([0, 0, 0]),
        H=Name.I,
        NM=String(nm),
        Dest=dest,
    )
    # Links are regenerated from the embedded session just like visible marks.
    # Carry the same ownership marker so clean_copy can remove the previous
    # generation without touching links that arrived on a client's source PDF.
    annot[Name("/WPT_Kind")] = String("link")
    annot[Name("/WPT_Data")] = String('{"kind":"link"}')
    return pdf.make_indirect(annot)
