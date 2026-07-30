"""Binder export: the internal model materialized to a single portable PDF.

The load-bearing design (canonical spec): the working session is JSON + the
untouched source files; a PDF exists only at export. Every page has a stable
id; bookmarks, marks, tapes, and links reference page ids — visible page
numbers are computed only here.

Binder spec (JSON-friendly dict):
{
  "sources":  {"A": "/abs/path/a.pdf", ...},
  "pages":    [{"id": "pg1", "source": "A", "index": 0}, ...]   # final order
  "annotations": [
      {"kind": "tick", "page": "pg1", "nx": 0.75, "ny": 0.25,
       "author": "CB", "note": "Agreed to source"},
      {"kind": "tape", "page": "pg3", "nx": 0.6, "ny": 0.62,
       "lines": ["  100.00", ...], "tape": {...structured...}, "author": "CB"}
  ],
  "links":    [{"page": "pg1", "rect_n": [x0,y0,x1,y1], "target_page": "pg3"}],
  "bookmarks":[{"title": "...", "page": "pg1", "children": [...]}],
  "flatten":  false,   # true = paint marks into page content, not annotations
  "output":   "/abs/path/out.pdf"
}
"""

from __future__ import annotations

from contextlib import ExitStack
from pathlib import Path

import pikepdf
from pikepdf import Array, Name, OutlineItem

from . import appearance
from .geometry import PageGeom
from .probe import sanitize_text


def _page_geom(page_obj: pikepdf.Object) -> PageGeom:
    media = [float(v) for v in page_obj.MediaBox]
    crop = (
        [float(v) for v in page_obj.CropBox]
        if Name.CropBox in page_obj
        else media
    )
    rotate = int(page_obj.get(Name.Rotate, 0))
    return PageGeom(crop=tuple(crop), rotate=rotate)


def _fit_dest(out: pikepdf.Pdf, page_index: int) -> Array:
    """Explicit /Fit destination to a page in the output document."""
    return Array([out.pages[page_index].obj, Name.Fit])


def _placement_matrix(form: pikepdf.Stream, rect: list[float]) -> tuple[float, ...]:
    """The matrix a viewer would use to fit an appearance stream into /Rect.

    This is PDF 2.0 12.5.5 (appearance streams) done by hand: transform the
    form's /BBox by its /Matrix, take the bounding box of the result, and map
    that onto /Rect. Deriving it rather than assuming identity is what keeps a
    flattened mark pixel-identical to the annotation it replaces on rotated
    pages, where /Matrix carries the rotation compensation.
    """
    a, b, c, d, e, f = (
        float(v) for v in form.get(Name.Matrix, Array([1, 0, 0, 1, 0, 0]))
    )
    bx0, by0, bx1, by1 = (float(v) for v in form.BBox)
    corners = ((bx0, by0), (bx1, by0), (bx1, by1), (bx0, by1))
    xs = [a * x + c * y + e for x, y in corners]
    ys = [b * x + d * y + f for x, y in corners]
    tx0, tx1, ty0, ty1 = min(xs), max(xs), min(ys), max(ys)

    rx0, rx1 = min(rect[0], rect[2]), max(rect[0], rect[2])
    ry0, ry1 = min(rect[1], rect[3]), max(rect[1], rect[3])
    sx = (rx1 - rx0) / (tx1 - tx0) if tx1 > tx0 else 1.0
    sy = (ry1 - ry0) / (ty1 - ty0) if ty1 > ty0 else 1.0
    return (sx, 0.0, 0.0, sy, rx0 - tx0 * sx, ry0 - ty0 * sy)


def _flatten_op(page: pikepdf.Page, annot: pikepdf.Object) -> bytes:
    """Content-stream operators that paint an annotation's normal appearance
    onto the page itself. Returns the ops; the caller appends them.

    The appearance Form XObject is reused verbatim, so a flattened mark is the
    same drawing the annotation would have shown — only now it is page content
    that no viewer can select, drag, or delete.
    """
    form = annot.AP.N
    rect = [float(v) for v in annot.Rect]
    name = page.add_resource(form, Name.XObject, prefix="WptM")
    m = " ".join(f"{v:.6f}".rstrip("0").rstrip(".") or "0" for v in _placement_matrix(form, rect))
    return f"q {m} cm {name} Do Q".encode("ascii")


def _build_outline_items(
    out: pikepdf.Pdf, nodes: list[dict], final_index: dict[str, int]
) -> list[OutlineItem]:
    items: list[OutlineItem] = []
    for node in nodes:
        idx = final_index[node["page"]]
        item = OutlineItem(sanitize_text(str(node["title"])), _fit_dest(out, idx))
        for child in _build_outline_items(out, node.get("children", []), final_index):
            item.children.append(child)
        items.append(item)
    return items


def export_binder(spec: dict) -> dict:
    """Materialize a binder spec to a single PDF. Returns a result summary.

    Source files are opened read-only and never modified.
    """
    output = Path(spec["output"])
    output.parent.mkdir(parents=True, exist_ok=True)

    with ExitStack() as stack:
        sources: dict[str, pikepdf.Pdf] = {
            key: stack.enter_context(pikepdf.open(path))
            for key, path in spec["sources"].items()
        }
        out = stack.enter_context(pikepdf.new())

        # 1. Assemble pages in final order; record page_id -> final index.
        #    `rotate` is the user's DELTA on top of the source page's own
        #    /Rotate, applied here so annotation geometry (step 3) sees the
        #    final displayed orientation.
        final_index: dict[str, int] = {}
        for i, entry in enumerate(spec["pages"]):
            src = sources[entry["source"]]
            out.pages.append(src.pages[entry["index"]])
            final_index[entry["id"]] = i
            delta = int(entry.get("rotate", 0)) % 360
            if delta:
                page_obj = out.pages[i].obj
                current = int(page_obj.get(Name.Rotate, 0))
                page_obj.Rotate = (current + delta) % 360

        # 2. Normalize pre-existing annotations on imported pages: repoint /P
        #    at the new page so no annotation references its old document.
        for page in out.pages:
            if Name.Annots in page.obj:
                for annot in page.obj.Annots:
                    if isinstance(annot, pikepdf.Dictionary) or (
                        isinstance(annot, pikepdf.Object)
                        and annot.get(Name.Type, None) == Name.Annot
                    ):
                        annot[Name("/P")] = page.obj

        def _annots_array(page_obj: pikepdf.Object) -> pikepdf.Object:
            if Name.Annots not in page_obj:
                page_obj.Annots = out.make_indirect(Array([]))
            return page_obj.Annots

        # 3. Our annotations (ticks, tapes).
        #    With flatten=True the very same appearance is painted into the page
        #    content instead of being attached as an annotation — the binder
        #    leaves the building as a flat record. The trade is deliberate and
        #    one-way: flattened marks carry no /WPT_Data, so that PDF can no
        #    longer be re-edited. The session file remains the editable master.
        flatten = bool(spec.get("flatten"))
        n_marks = 0
        pending_flat: dict[int, list[bytes]] = {}
        for i, a in enumerate(spec.get("annotations", [])):
            idx = final_index[a["page"]]
            page = out.pages[idx]
            page_obj = page.obj
            geom = _page_geom(page_obj)
            nm = f"wpt-{a['kind']}-{i:04d}"
            if a["kind"] in ("tick", "cross", "text"):
                annot = appearance.make_mark(out, geom, a, nm)
            elif a["kind"] == "tape":
                annot = appearance.make_tape(
                    out, geom, a["nx"], a["ny"], a["lines"], a.get("tape", {}),
                    nm, author=a.get("author", ""),
                )
            else:
                raise ValueError(f"unknown annotation kind: {a['kind']}")
            if flatten:
                pending_flat.setdefault(idx, []).append(_flatten_op(page, annot))
            else:
                _annots_array(page_obj).append(annot)
            n_marks += 1

        # Balance the imported content with q/Q before painting on top of it, so
        # a source page that leaves the graphics state dirty can't smear its
        # colors or clip onto our marks.
        for idx, ops in pending_flat.items():
            page = out.pages[idx]
            page.contents_add(b"q\n", prepend=True)
            page.contents_add(b"\nQ\n" + b"\n".join(ops) + b"\n")

        # 4. Internal links.
        for i, ln in enumerate(spec.get("links", [])):
            idx = final_index[ln["page"]]
            page_obj = out.pages[idx].obj
            geom = _page_geom(page_obj)
            dest = _fit_dest(out, final_index[ln["target_page"]])
            annot = appearance.make_link(
                out, geom, tuple(ln["rect_n"]), dest, nm=f"wpt-link-{i:04d}"
            )
            _annots_array(page_obj).append(annot)

        # 5. Bookmarks (file-level + nested imported outlines, retargeted).
        with out.open_outline() as outline:
            for item in _build_outline_items(out, spec.get("bookmarks", []), final_index):
                outline.root.append(item)

        out.save(output)

    # 6. Validate: reopen fresh and run qpdf's syntax checks (silent API —
    #    pikepdf.Job's --check would print to stdout, which is the sidecar's
    #    JSON protocol channel; the spike harness runs the full `qpdf --check`
    #    independently on its side).
    with pikepdf.open(output) as reopened:
        problems = reopened.check_pdf_syntax()
        n_pages = len(reopened.pages)

    return {
        "output": str(output),
        "pages": n_pages,
        "marks": n_marks,
        "flattened": flatten,
        "final_index": final_index,
        "check_problems": [str(p) for p in problems],
    }
