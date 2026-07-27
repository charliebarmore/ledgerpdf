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


def _build_outline_items(
    out: pikepdf.Pdf, nodes: list[dict], final_index: dict[str, int]
) -> list[OutlineItem]:
    items: list[OutlineItem] = []
    for node in nodes:
        idx = final_index[node["page"]]
        item = OutlineItem(node["title"], _fit_dest(out, idx))
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
        final_index: dict[str, int] = {}
        for i, entry in enumerate(spec["pages"]):
            src = sources[entry["source"]]
            out.pages.append(src.pages[entry["index"]])
            final_index[entry["id"]] = i

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
        n_marks = 0
        for i, a in enumerate(spec.get("annotations", [])):
            idx = final_index[a["page"]]
            page_obj = out.pages[idx].obj
            geom = _page_geom(page_obj)
            nm = f"wpt-{a['kind']}-{i:04d}"
            if a["kind"] == "tick":
                annot = appearance.make_tick(
                    out, geom, a["nx"], a["ny"], nm,
                    author=a.get("author", ""), note=a.get("note", "Tick mark"),
                    size=a.get("size", appearance.TICK_SIZE),
                )
            elif a["kind"] == "tape":
                annot = appearance.make_tape(
                    out, geom, a["nx"], a["ny"], a["lines"], a.get("tape", {}),
                    nm, author=a.get("author", ""),
                )
            else:
                raise ValueError(f"unknown annotation kind: {a['kind']}")
            _annots_array(page_obj).append(annot)
            n_marks += 1

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
        "final_index": final_index,
        "check_problems": [str(p) for p in problems],
    }
