"""Drawn annotations: rectangle, ellipse, line, arrow, highlighter, text box.

These differ from the review marks in appearance.py in one structural way: a
mark is placed at a POINT and has a fixed size, while these are DRAGGED and take
their geometry from two corners. Everything else — hand-authored /AP streams,
rotation compensation through the form /Matrix, private /WPT_Data so the app can
reopen them — follows the same rules.

Two traps handled here, both of which produce broken PDFs rather than ugly ones:

1. **Degenerate drags.** A perfectly horizontal line has zero height. Its /BBox
   would be zero-height, the viewer's BBox->Rect fit divides by that, and the
   annotation is invalid. Every shape is padded by its stroke width, so the box
   always has real extent.

2. **Stroke overflow.** A stroke straddles the path, so a rectangle drawn on the
   BBox edge is clipped in half. The same padding gives it room.
"""

from __future__ import annotations

import pikepdf
from pikepdf import Array, Dictionary, Name, String

from . import appearance
from .appearance import _display_author, _esc, ellipse_path
from .geometry import PageGeom, appearance_matrix, visual_rect_to_user_rect

# Named colors, so the app and the engine cannot drift into different reds.
# These are annotation CONTENT (they must match on screen and in the PDF), not
# UI theme — same rule as appearance.MARK_COLORS.
SHAPE_COLORS: dict[str, tuple[float, float, float]] = {
    "red": (0.72, 0.15, 0.15),
    "green": (0.13, 0.55, 0.13),
    "blue": (0.10, 0.33, 0.60),
    "black": (0.12, 0.12, 0.14),
    "orange": (0.85, 0.45, 0.10),
    "grey": (0.48, 0.47, 0.45),
}
DEFAULT_COLOR = "red"

# Highlighter. Multiply blend so the text underneath stays readable — a highlight
# that hides the number it marks is worse than no highlight.
HIGHLIGHT_COLOR = (1.0, 0.92, 0.23)
HIGHLIGHT_ALPHA = 0.4

TEXTBOX_FONT_SIZE = 11.0
TEXTBOX_PAD = 4.0
TEXTBOX_LINE_HEIGHT = 13.0
# Helvetica's average advance. Only used to wrap text; exact metrics would mean
# embedding the font, which is a Phase 5 decision.
TEXTBOX_CHAR_W = 0.52

STROKE_DEFAULT = 1.5
# Bezier constant for approximating a quarter circle.
KAPPA = 0.5523


def _fmt(v: float) -> str:
    return f"{v:.3f}".rstrip("0").rstrip(".") or "0"



def color_of(name: str) -> tuple[float, float, float]:
    return SHAPE_COLORS.get(name, SHAPE_COLORS[DEFAULT_COLOR])


def _rgb(prefix: str, c: tuple[float, float, float]) -> str:
    r, g, b = c
    return f"{_fmt(r)} {_fmt(g)} {_fmt(b)} {prefix}"


def wrap_text(text: str, max_chars: int) -> list[str]:
    """Greedy word wrap. Long unbroken tokens are hard-split rather than left to
    overflow the box."""
    lines: list[str] = []
    for para in text.split("\n"):
        if not para:
            lines.append("")
            continue
        line = ""
        for word in para.split(" "):
            while len(word) > max_chars:
                if line:
                    lines.append(line)
                    line = ""
                lines.append(word[:max_chars])
                word = word[max_chars:]
            candidate = f"{line} {word}".strip()
            if len(candidate) <= max_chars or not line:
                line = candidate
            else:
                lines.append(line)
                line = word
        lines.append(line)
    return lines or [""]


def _ellipse_path(x0: float, y0: float, x1: float, y1: float) -> str:
    """Four Beziers approximating an ellipse inscribed in the box.

    The math lives in appearance.ellipse_path so the connector ring and this
    share one implementation; the formatter stays ours, at three decimals.
    """
    return ellipse_path(x0, y0, x1, y1, fmt=_fmt)


def _arrow_head(x0: float, y0: float, x1: float, y1: float, size: float) -> str:
    """A filled triangle at (x1, y1), pointing away from (x0, y0)."""
    import math

    ang = math.atan2(y1 - y0, x1 - x0)
    spread = math.radians(24)
    ax = x1 - size * math.cos(ang - spread)
    ay = y1 - size * math.sin(ang - spread)
    bx = x1 - size * math.cos(ang + spread)
    by = y1 - size * math.sin(ang + spread)
    return (
        f"{_fmt(x1)} {_fmt(y1)} m {_fmt(ax)} {_fmt(ay)} l {_fmt(bx)} {_fmt(by)} l h f"
    )


def shape_geometry(
    geom: PageGeom, spec: dict
) -> tuple[float, float, float, float, float, float, float]:
    """Work out the drawn box in points.

    Returns (pad, box_w, box_h, cx, cy, local_x_of_start, local_y_of_start) where
    the local coords place the drag's FIRST corner inside the form's box. y is
    flipped: the app measures ny downward, PDF form space measures upward.
    """
    dw, dh = geom.display_size
    n1x, n1y = float(spec["nx"]), float(spec["ny"])
    n2x, n2y = float(spec["nx2"]), float(spec["ny2"])
    stroke = float(spec.get("width", STROKE_DEFAULT))

    vw = abs(n2x - n1x) * dw
    vh = abs(n2y - n1y) * dh
    pad = max(stroke, 1.0)
    box_w = vw + 2 * pad
    box_h = vh + 2 * pad
    cx = (n1x + n2x) / 2
    cy = (n1y + n2y) / 2

    # Where the FIRST dragged corner sits inside the padded box.
    sx = pad if n1x <= n2x else pad + vw
    sy = pad + vh if n1y <= n2y else pad  # flip: ny grows downward
    return pad, box_w, box_h, cx, cy, sx, sy


def _make_form(
    pdf: pikepdf.Pdf,
    content: bytes,
    box: tuple[float, float],
    rotate: int,
    resources: Dictionary | None = None,
    agent: bool = False,
) -> pikepdf.Stream:
    if agent:
        content = appearance._agent_outline((0.0, 0.0, box[0], box[1])) + content
    form = pdf.make_stream(content)
    form.Type = Name.XObject
    form.Subtype = Name.Form
    form.BBox = Array([0, 0, box[0], box[1]])
    m = appearance_matrix(rotate)
    if m is not None:
        form.Matrix = Array(m)
    if resources is not None:
        form.Resources = resources
    return form


def make_shape(pdf: pikepdf.Pdf, geom: PageGeom, spec: dict, nm: str) -> pikepdf.Object:
    """One drawn annotation. `spec` mirrors the app's Shape model:

        {kind: "rect"|"ellipse"|"line"|"arrow"|"highlight"|"textbox",
         nx, ny, nx2, ny2, color?, width?, text?, author?, note?, created?}
    """
    kind = spec.get("kind", "rect")
    stroke = float(spec.get("width", STROKE_DEFAULT))
    color = color_of(str(spec.get("color", DEFAULT_COLOR)))
    pad, box_w, box_h, cx, cy, sx, sy = shape_geometry(geom, spec)

    x0, y0 = pad, pad
    x1, y1 = box_w - pad, box_h - pad
    resources: Dictionary | None = None
    parts: list[str] = ["q"]

    if kind == "highlight":
        # Transparency lives in an ExtGState; blend Multiply keeps the content
        # underneath legible.
        gs = Dictionary(
            Type=Name.ExtGState, ca=HIGHLIGHT_ALPHA, CA=HIGHLIGHT_ALPHA, BM=Name.Multiply
        )
        resources = Dictionary(ExtGState=Dictionary(GS0=gs))
        parts += [
            "/GS0 gs",
            _rgb("rg", HIGHLIGHT_COLOR),
            f"{_fmt(x0)} {_fmt(y0)} {_fmt(x1 - x0)} {_fmt(y1 - y0)} re f",
        ]
    elif kind == "textbox":
        text = str(spec.get("text", "")).strip()
        inner = max(box_w - 2 * (pad + TEXTBOX_PAD), 1.0)
        max_chars = max(int(inner / (TEXTBOX_FONT_SIZE * TEXTBOX_CHAR_W)), 1)
        lines = wrap_text(text, max_chars) if text else [""]
        resources = Dictionary(
            Font=Dictionary(
                F1=Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica, Encoding=Name("/WinAnsiEncoding"))
            )
        )
        parts += [
            "1 1 1 rg",
            f"{_fmt(x0)} {_fmt(y0)} {_fmt(x1 - x0)} {_fmt(y1 - y0)} re f",
            _rgb("RG", color),
            f"{_fmt(stroke)} w",
            f"{_fmt(x0)} {_fmt(y0)} {_fmt(x1 - x0)} {_fmt(y1 - y0)} re S",
            _rgb("rg", color),
            "BT",
            f"/F1 {_fmt(TEXTBOX_FONT_SIZE)} Tf {_fmt(TEXTBOX_LINE_HEIGHT)} TL",
            f"{_fmt(x0 + TEXTBOX_PAD)} {_fmt(y1 - TEXTBOX_PAD - TEXTBOX_FONT_SIZE)} Td",
        ]
        for i, line in enumerate(lines):
            if i > 0:
                parts.append("T*")
            parts.append(f"({_esc(line)}) Tj")
        parts += ["ET"]
    else:
        parts += [_rgb("RG", color), f"{_fmt(stroke)} w", "1 J 1 j"]
        if kind == "rect":
            parts.append(f"{_fmt(x0)} {_fmt(y0)} {_fmt(x1 - x0)} {_fmt(y1 - y0)} re S")
        elif kind == "ellipse":
            parts.append(f"{_ellipse_path(x0, y0, x1, y1)} S")
        else:
            # line / arrow run corner-to-corner in the direction actually dragged
            ex = box_w - sx
            ey = box_h - sy
            parts.append(f"{_fmt(sx)} {_fmt(sy)} m {_fmt(ex)} {_fmt(ey)} l S")
            if kind == "arrow":
                head = max(stroke * 4.0, 6.0)
                parts.append(_rgb("rg", color))
                parts.append(_arrow_head(sx, sy, ex, ey, head))

    parts.append("Q")
    # Only the textbox. A rectangle or a highlight says "look here" and asserts
    # nothing, so marking who drew it would be noise on an already dense page —
    # its provenance still rides in the data for revert and file review. A
    # textbox carries WORDS: it is a comment with a border, and a comment is an
    # assertion, so it is outlined with the notes and ticks rather than with
    # the shapes it is filed under.
    form = _make_form(
        pdf, " ".join(parts).encode("ascii"), (box_w, box_h), geom.rotate, resources,
        agent=(kind == "textbox" and spec.get("by") == "agent"),
    )

    rect = visual_rect_to_user_rect(geom, cx, cy, box_w, box_h)
    annot = Dictionary(
        Type=Name.Annot,
        Subtype=Name.Square if kind in ("rect", "highlight", "textbox") else Name.Line,
        Rect=Array(list(rect)),
        AP=Dictionary(N=form),
        NM=String(nm),
        T=String(_display_author(spec)),
        Contents=String(str(spec.get("note", "") or _default_note(kind, spec))),
        F=4,  # print flag — drawn annotations are part of the record
    )
    annot[Name("/WPT_Kind")] = String(kind)
    obj = pdf.make_indirect(annot)
    import json

    obj[Name("/WPT_Data")] = String(json.dumps(spec, separators=(",", ":")))
    return obj


def _default_note(kind: str, spec: dict) -> str:
    if kind == "textbox":
        return str(spec.get("text", "")) or "Note"
    return {
        "rect": "Rectangle",
        "ellipse": "Ellipse",
        "line": "Line",
        "arrow": "Arrow",
        "highlight": "Highlight",
    }.get(kind, kind)
