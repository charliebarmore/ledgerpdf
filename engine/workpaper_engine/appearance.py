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
}
TEXT_MARK_FONT_SIZE = 12.0
TEXT_MARK_PAD = 4.0
TEXT_MARK_CHAR_W = TEXT_MARK_FONT_SIZE * 0.556  # Helvetica average advance
TAPE_FONT_SIZE = 9.0
TAPE_LINE_HEIGHT = 11.0
TAPE_PAD = 6.0
TAPE_CHAR_W = TAPE_FONT_SIZE * 0.6  # Courier advance = 0.6 em
TAPE_TEXT_COLOR = (0.10, 0.10, 0.12)
TAPE_BORDER_COLOR = (0.55, 0.35, 0.15)


def _esc(text: str) -> str:
    """Escape a string for a PDF literal string in a content stream."""
    return text.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")


def _fmt(v: float) -> str:
    return f"{v:.2f}".rstrip("0").rstrip(".")


def _make_form(
    pdf: pikepdf.Pdf,
    content: bytes,
    bbox: tuple[float, float, float, float],
    rotate: int,
    resources: Dictionary | None = None,
) -> pikepdf.Stream:
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
    return _make_form(pdf, content, (0, 0, size, size), rotate)


def cross_appearance(
    pdf: pikepdf.Pdf,
    rotate: int,
    size: float = TICK_SIZE,
    color: tuple[float, float, float] | None = None,
) -> pikepdf.Stream:
    """An X — "does not agree" in most review conventions."""
    r, g, b = color or MARK_COLORS["cross"]
    inset = size * 0.22
    a, z = _fmt(inset), _fmt(size - inset)
    content = (
        f"q {r} {g} {b} RG {_fmt(size * 0.11)} w 1 J "
        f"{a} {a} m {z} {z} l S {a} {z} m {z} {a} l S Q"
    ).encode("ascii")
    return _make_form(pdf, content, (0, 0, size, size), rotate)


def text_mark_size(text: str, font_size: float = TEXT_MARK_FONT_SIZE) -> tuple[float, float]:
    """Visual (w, h) for a short text mark such as "F", "TB", or initials."""
    chars = max(len(text), 1)
    w = chars * font_size * 0.556 + 2 * TEXT_MARK_PAD
    h = font_size + 2 * TEXT_MARK_PAD
    return (w, h)


def text_appearance(
    pdf: pikepdf.Pdf,
    text: str,
    rotate: int,
    font_size: float = TEXT_MARK_FONT_SIZE,
    color: tuple[float, float, float] | None = None,
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
                Type=Name.Font, Subtype=Name.Type1, BaseFont=Name("/Helvetica-Bold")
            )
        )
    )
    form = _make_form(pdf, " ".join(parts).encode("ascii"), (0, 0, w, h), rotate, resources)
    return form, w, h


def tape_size(lines: list[str]) -> tuple[float, float]:
    """Visual (w, h) in points for a tape with these lines."""
    max_chars = max((len(ln) for ln in lines), default=1)
    w = max_chars * TAPE_CHAR_W + 2 * TAPE_PAD
    h = len(lines) * TAPE_LINE_HEIGHT + 2 * TAPE_PAD
    return (w, h)


def tape_appearance(
    pdf: pikepdf.Pdf, lines: list[str], rotate: int
) -> tuple[pikepdf.Stream, float, float]:
    """Calculator-tape appearance: white card, thin border, Courier lines."""
    w, h = tape_size(lines)
    tr, tg, tb = TAPE_TEXT_COLOR
    br, bg, bb = TAPE_BORDER_COLOR
    parts = [
        "q",
        f"1 1 1 rg 0 0 {_fmt(w)} {_fmt(h)} re f",  # card background
        f"{br} {bg} {bb} RG 0.8 w 0.4 0.4 {_fmt(w - 0.8)} {_fmt(h - 0.8)} re S",
        f"{tr} {tg} {tb} rg",
        "BT",
        f"/F1 {_fmt(TAPE_FONT_SIZE)} Tf {_fmt(TAPE_LINE_HEIGHT)} TL",
        f"{_fmt(TAPE_PAD)} {_fmt(h - TAPE_PAD - TAPE_FONT_SIZE)} Td",
    ]
    for i, ln in enumerate(lines):
        if i > 0:
            parts.append("T*")
        parts.append(f"({_esc(ln)}) Tj")
    parts += ["ET", "Q"]
    resources = Dictionary(
        Font=Dictionary(
            F1=Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Courier)
        )
    )
    form = _make_form(pdf, " ".join(parts).encode("ascii"), (0, 0, w, h), rotate, resources)
    return form, w, h


def _base_annot(
    pdf: pikepdf.Pdf,
    rect: tuple[float, float, float, float],
    form: pikepdf.Stream,
    nm: str,
    author: str,
    contents: str,
    kind: str,
) -> pikepdf.Object:
    annot = Dictionary(
        Type=Name.Annot,
        Subtype=Name.Stamp,
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

        {kind: "tick"|"cross"|"text", nx, ny, size?, text?, author?, note?,
         created?}

    The full spec is embedded as private /WPT_Data so the app can reopen and
    edit the mark later — and so a future tie-out layer has structured data to
    read, rather than having to infer meaning from a glyph.
    """
    kind = spec.get("kind", "tick")
    size = float(spec.get("size", TICK_SIZE))
    author = str(spec.get("author", ""))
    color = MARK_COLORS.get(kind, TICK_COLOR)

    if kind == "text":
        text = str(spec.get("text", "")).strip() or "?"
        form, w, h = text_appearance(pdf, text, geom.rotate, size * 0.5, color)
        note = spec.get("note") or f"Mark: {text}"
    else:
        if kind == "cross":
            form = cross_appearance(pdf, geom.rotate, size, color)
            note = spec.get("note") or "Does not agree"
        else:
            form = tick_appearance(pdf, geom.rotate, size, color)
            note = spec.get("note") or "Agreed"
        w = h = size

    rect = visual_rect_to_user_rect(geom, float(spec["nx"]), float(spec["ny"]), w, h)
    annot = _base_annot(pdf, rect, form, nm, author, str(note), kind)
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
) -> pikepdf.Object:
    """Tape annotation. `lines` is the printed appearance; `tape_data` is the
    structured, editable form embedded as private metadata (/WPT_Data) so the
    app can reopen and edit while ordinary viewers just show the appearance."""
    form, w, h = tape_appearance(pdf, lines, geom.rotate)
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
    return pdf.make_indirect(annot)
