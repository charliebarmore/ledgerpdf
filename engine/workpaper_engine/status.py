"""Page furniture generated at export: status stamps, page borders, page numbers.

None of these are stored as annotations in the session. They are derived — from
the page's status, or from its FINAL position in the binder — and drawn afresh
each export. That is the whole point: a stored page number survives a reorder
and leaves a binder numbered 1, 2, 5, 3, 4, which is worse than no numbers
because it still looks authoritative.

Page status: the stamp and the border.

A status says what state a page is in — reviewed, open item, not applicable —
and shows it three ways at once: a stamp carrying who and when, a colored border
round the page, and a colored bookmark (that last one lives in binder.py, since
it is written into the outline rather than drawn).

Both artefacts here are GENERATED AT EXPORT from the session's status, never
stored as ordinary annotations. Change the legend or turn a part off and the
next export simply draws it differently — there is no stale artwork left behind
on a page, which is exactly what would happen if a status were just a shape.
"""

from __future__ import annotations

import json

import pikepdf
from pikepdf import Array, Dictionary, Name, String

from .appearance import _esc
from .geometry import PageGeom, appearance_matrix, visual_rect_to_user_rect
from .shapes import SHAPE_COLORS, color_of

STAMP_W = 132.0
STAMP_H = 40.0
STAMP_PAD = 5.0
STAMP_INITIALS_SIZE = 17.0
STAMP_WHEN_SIZE = 8.0
STAMP_RADIUS = 5.0
BORDER_DEFAULT = 4.0


def _fmt(v: float) -> str:
    return f"{v:.3f}".rstrip("0").rstrip(".") or "0"



def _rounded_rect(x0: float, y0: float, x1: float, y1: float, r: float) -> str:
    """A rounded rectangle path, Beziers at the corners."""
    k = r * 0.5523
    return " ".join(
        [
            f"{_fmt(x0 + r)} {_fmt(y0)} m",
            f"{_fmt(x1 - r)} {_fmt(y0)} l",
            f"{_fmt(x1 - r + k)} {_fmt(y0)} {_fmt(x1)} {_fmt(y0 + r - k)} {_fmt(x1)} {_fmt(y0 + r)} c",
            f"{_fmt(x1)} {_fmt(y1 - r)} l",
            f"{_fmt(x1)} {_fmt(y1 - r + k)} {_fmt(x1 - r + k)} {_fmt(y1)} {_fmt(x1 - r)} {_fmt(y1)} c",
            f"{_fmt(x0 + r)} {_fmt(y1)} l",
            f"{_fmt(x0 + r - k)} {_fmt(y1)} {_fmt(x0)} {_fmt(y1 - r + k)} {_fmt(x0)} {_fmt(y1 - r)} c",
            f"{_fmt(x0)} {_fmt(y0 + r)} l",
            f"{_fmt(x0)} {_fmt(y0 + r - k)} {_fmt(x0 + r - k)} {_fmt(y0)} {_fmt(x0 + r)} {_fmt(y0)} c",
            "h",
        ]
    )


def make_status_stamp(pdf: pikepdf.Pdf, geom: PageGeom, spec: dict, nm: str) -> pikepdf.Object:
    """Initials over a date and time, in a rounded box the status colour.

    Text is centred by measuring it with Helvetica-Bold's average advance —
    approximate, but the box is fixed-width and the strings are short, so it
    lands square. Exact metrics would mean embedding a font, which is a Phase 5
    decision.
    """
    r, g, b = color_of(str(spec.get("color", "green")))
    initials = str(spec.get("text", "")).strip() or str(spec.get("label", "")).strip() or "OK"
    when = _format_when(str(spec.get("at", "")))

    w, h = STAMP_W, STAMP_H
    # Helvetica-Bold averages ~0.58 em; Helvetica ~0.5.
    init_w = len(initials) * STAMP_INITIALS_SIZE * 0.58
    when_w = len(when) * STAMP_WHEN_SIZE * 0.5

    parts = [
        "q",
        # A white card first, so the stamp stays legible over page content.
        "1 1 1 rg",
        f"{_rounded_rect(1, 1, w - 1, h - 1, STAMP_RADIUS)} f",
        f"{_fmt(r)} {_fmt(g)} {_fmt(b)} RG 2 w",
        f"{_rounded_rect(1, 1, w - 1, h - 1, STAMP_RADIUS)} S",
        f"{_fmt(r)} {_fmt(g)} {_fmt(b)} rg",
        "BT",
        f"/F1 {_fmt(STAMP_INITIALS_SIZE)} Tf",
        f"{_fmt((w - init_w) / 2)} {_fmt(h - STAMP_PAD - STAMP_INITIALS_SIZE)} Td",
        f"({_esc(initials)}) Tj",
        "ET",
    ]
    if when:
        parts += [
            "BT",
            f"/F2 {_fmt(STAMP_WHEN_SIZE)} Tf",
            f"{_fmt((w - when_w) / 2)} {_fmt(STAMP_PAD + 1)} Td",
            f"({_esc(when)}) Tj",
            "ET",
        ]
    parts.append("Q")

    resources = Dictionary(
        Font=Dictionary(
            F1=Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name("/Helvetica-Bold"), Encoding=Name("/WinAnsiEncoding")),
            F2=Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica, Encoding=Name("/WinAnsiEncoding")),
        )
    )
    form = pdf.make_stream(" ".join(parts).encode("ascii"))
    form.Type = Name.XObject
    form.Subtype = Name.Form
    form.BBox = Array([0, 0, w, h])
    m = appearance_matrix(geom.rotate)
    if m is not None:
        form.Matrix = Array(m)
    form.Resources = resources

    rect = visual_rect_to_user_rect(geom, float(spec["nx"]), float(spec["ny"]), w, h)
    annot = Dictionary(
        Type=Name.Annot,
        Subtype=Name.Stamp,
        Rect=Array(list(rect)),
        AP=Dictionary(N=form),
        NM=String(nm),
        T=String(str(spec.get("author", ""))),
        Contents=String(f"{spec.get('label', 'Status')}: {initials} {when}".strip()),
        F=4,
    )
    annot[Name("/WPT_Kind")] = String("statusstamp")
    obj = pdf.make_indirect(annot)
    obj[Name("/WPT_Data")] = String(json.dumps(spec, separators=(",", ":")))
    return obj


def _format_when(iso: str) -> str:
    """"2026-07-31T14:33:30Z" -> "7/31/2026 2:33:30 PM". Never raises: a status
    with an unreadable timestamp should still stamp."""
    if not iso:
        return ""
    try:
        from datetime import datetime

        dt = datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone()
        hour = dt.hour % 12 or 12
        ampm = "AM" if dt.hour < 12 else "PM"
        return f"{dt.month}/{dt.day}/{dt.year} {hour}:{dt.minute:02d}:{dt.second:02d} {ampm}"
    except Exception:  # noqa: BLE001 — cosmetic; never fail an export over it
        return iso[:19].replace("T", " ")


def make_page_border(pdf: pikepdf.Pdf, geom: PageGeom, spec: dict, nm: str) -> pikepdf.Object:
    """A colored frame just inside the page edge.

    Drawn against the CropBox — what a viewer actually shows — so a page whose
    CropBox differs from its MediaBox gets a border round the visible sheet
    rather than one floating off the edge.
    """
    r, g, b = color_of(str(spec.get("color", "green")))
    width = float(spec.get("width", BORDER_DEFAULT))
    dw, dh = geom.display_size
    inset = width / 2

    parts = [
        "q",
        f"{_fmt(r)} {_fmt(g)} {_fmt(b)} RG {_fmt(width)} w",
        f"{_fmt(inset)} {_fmt(inset)} {_fmt(dw - width)} {_fmt(dh - width)} re S",
        "Q",
    ]
    form = pdf.make_stream(" ".join(parts).encode("ascii"))
    form.Type = Name.XObject
    form.Subtype = Name.Form
    form.BBox = Array([0, 0, dw, dh])
    m = appearance_matrix(geom.rotate)
    if m is not None:
        form.Matrix = Array(m)

    rect = visual_rect_to_user_rect(geom, 0.5, 0.5, dw, dh)
    annot = Dictionary(
        Type=Name.Annot,
        Subtype=Name.Square,
        Rect=Array(list(rect)),
        AP=Dictionary(N=form),
        NM=String(nm),
        Contents=String(str(spec.get("note", "Status"))),
        F=4,
    )
    annot[Name("/WPT_Kind")] = String("pageborder")
    obj = pdf.make_indirect(annot)
    obj[Name("/WPT_Data")] = String(json.dumps(spec, separators=(",", ":")))
    return obj


def style_outline(pdf: pikepdf.Pdf, nodes: list[dict]) -> None:
    """Apply colour and bold to outline entries, walking our spec tree and the
    written outline in step.

    pikepdf's OutlineItem has no object until the outline is saved, so styling
    has to happen afterwards — and matching by position is safe here precisely
    because we generated both trees from the same source.
    """
    root = pdf.Root.get(Name.Outlines)
    if root is None:
        return

    def walk(spec_nodes: list[dict], first) -> None:  # noqa: ANN001
        node = first
        for spec in spec_nodes:
            if node is None:
                return
            color = spec.get("color")
            if color:
                r, g, b = SHAPE_COLORS.get(color, SHAPE_COLORS["black"])
                node[Name.C] = Array([r, g, b])
            if spec.get("bold"):
                node[Name.F] = 2  # 1 = italic, 2 = bold
            kids = spec.get("children") or []
            if kids:
                walk(kids, node.get(Name.First))
            node = node.get(Name.Next)

    walk(nodes, root.get(Name.First))


NUMBER_PAD = 18.0


def make_page_number(pdf: pikepdf.Pdf, geom: PageGeom, spec: dict, nm: str) -> pikepdf.Object:
    """The binder's own page number, printed in a corner.

    Sized to the text so the annotation rect hugs it: an oversized box would
    sit over page content and be selectable far from the number itself.
    """
    text = str(spec.get("text", "")).strip()
    size = float(spec.get("size", 9.0))
    corner = str(spec.get("corner", "br"))
    if not text:
        return pdf.make_indirect(Dictionary())

    # Helvetica averages ~0.5 em; the strings here are short.
    w = max(len(text) * size * 0.52 + 6, 12.0)
    h = size + 6

    parts = [
        "q",
        "0.15 0.15 0.17 rg",
        "BT",
        f"/F1 {_fmt(size)} Tf",
        f"{_fmt(3)} {_fmt(4)} Td",
        f"({_esc(text)}) Tj",
        "ET",
        "Q",
    ]
    form = pdf.make_stream(" ".join(parts).encode("ascii"))
    form.Type = Name.XObject
    form.Subtype = Name.Form
    form.BBox = Array([0, 0, w, h])
    m = appearance_matrix(geom.rotate)
    if m is not None:
        form.Matrix = Array(m)
    form.Resources = Dictionary(
        Font=Dictionary(
            F1=Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica, Encoding=Name("/WinAnsiEncoding"))
        )
    )

    # Nudge the anchor inwards so the number never straddles the page edge.
    dw, dh = geom.display_size
    nx = float(spec["nx"])
    ny = float(spec["ny"])
    half_w = (w / 2) / dw
    half_h = (h / 2) / dh
    nx = min(1 - half_w, max(half_w, nx))
    ny = min(1 - half_h, max(half_h, ny))

    rect = visual_rect_to_user_rect(geom, nx, ny, w, h)
    annot = Dictionary(
        Type=Name.Annot,
        Subtype=Name.FreeText,
        Rect=Array(list(rect)),
        AP=Dictionary(N=form),
        NM=String(nm),
        Contents=String(text),
        # Required by the spec for FreeText; the appearance stream is what draws.
        DA=String(f"/Helv {_fmt(size)} Tf 0 g"),
        F=4,
    )
    annot[Name("/WPT_Kind")] = String("pagenumber")
    obj = pdf.make_indirect(annot)
    obj[Name("/WPT_Data")] = String(json.dumps(spec, separators=(",", ":")))
    return obj
