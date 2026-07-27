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


def tick_appearance(pdf: pikepdf.Pdf, rotate: int) -> pikepdf.Stream:
    """A checkmark, stroked, 24x24 form space."""
    r, g, b = TICK_COLOR
    content = (
        f"q {r} {g} {b} RG 2.6 w 1 J 1 j "
        f"4 12 m 10 5.5 l 20 19 l S Q"
    ).encode("ascii")
    return _make_form(pdf, content, (0, 0, TICK_SIZE, TICK_SIZE), rotate)


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
    form = tick_appearance(pdf, geom.rotate)
    return _base_annot(pdf, rect, form, nm, author, note, "tick")


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
