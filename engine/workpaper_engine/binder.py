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
  "session":  {...},   # the editable session, embedded in the binder (issue #3).
                       #   Ignored when flatten is true — see step 6.
  "output":   "/abs/path/out.pdf"
}
"""

from __future__ import annotations

import os
from contextlib import ExitStack
from pathlib import Path
from uuid import uuid4

import pikepdf
from pikepdf import Array, Name, OutlineItem

from . import appearance, documents, images, session_store, sheets, shapes, status
from .geometry import PageGeom, page_geom
from .probe import fingerprint_file, sanitize_text


def _page_geom(page_obj: pikepdf.Object) -> PageGeom:
    return page_geom(page_obj)


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
    temp_output = output.with_name(f".{output.name}.{os.getpid()}.{uuid4().hex}.tmp.pdf")

    source_paths = {Path(value).resolve() for value in spec["sources"].values()}
    if output.resolve() in source_paths:
        raise ValueError("export destination must not overwrite a source file")

    # A saved session points at external source files. Refuse to export if any
    # one of those paths now contains different bytes: silently attaching old
    # review marks to a replacement PDF is worse than failing loudly.
    expected_fingerprints = spec.get("source_fingerprints", {})
    for key, expected in expected_fingerprints.items():
        actual = fingerprint_file(spec["sources"][key])
        if actual["sha256"] != expected.get("sha256"):
            raise ValueError(
                f"source changed since import: {spec['sources'][key]} "
                f"(expected {expected.get('sha256', 'unknown')}, got {actual['sha256']})"
            )

    try:
        with ExitStack() as stack:
            # An image or spreadsheet source is turned into pages in memory here
            # and is then indistinguishable from any other source for the rest of
            # export. The file on disk is never touched.
            sources: dict[str, pikepdf.Pdf] = {
                key: stack.enter_context(
                    documents.doc_to_pdf(path)
                    if documents.is_doc(path)
                    else sheets.sheet_to_pdf(path)
                    if sheets.is_sheet(path)
                    else images.image_to_pdf(path)
                    if images.is_image(path)
                    else pikepdf.open(path)
                )
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
                # add_pages_from, not pages.append: append alone drops the
                # document-level /AcroForm, so a filled W-9 or 8879 renders
                # with blank boxes where the client's answers were. This
                # carries the form fields (renaming on collision, e.g. the
                # same source imported twice).
                out.add_pages_from(src, [entry["index"]])
                final_index[entry["id"]] = i
                delta = int(entry.get("rotate", 0)) % 360
                if delta:
                    page_obj = out.pages[i].obj
                    current = int(page_obj.get(Name.Rotate, 0))
                    page_obj.Rotate = (current + delta) % 360

            # 2a. A source may be a previously saved binder, carrying our own
            #     marks as annotations. They are re-drawn from the session in
            #     step 3, so the old generation comes off first — otherwise
            #     every save would stack another copy on top of the last.
            #     Annotations the client's original PDF arrived with have no
            #     /WPT_Data and are deliberately untouched.
            session_store.strip_wpt_annotations(out)

            #     A source binder also carries an embedded session, and the
            #     page-level copy of it rides along on the page dictionary. It
            #     must come off here or a flattened distribution copy would
            #     arrive at the client carrying the firm's editable working
            #     session inside it. Step 6 re-embeds a fresh one when the save
            #     is a working save.
            session_store.strip_embedded_session(out)

            # 2b. Normalize pre-existing annotations on imported pages: repoint /P
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
                if a["kind"] in ("tick", "cross", "text", "note", "conn", "date"):
                    annot = appearance.make_mark(out, geom, a, nm)
                elif a["kind"] in ("rect", "ellipse", "line", "arrow", "highlight", "textbox"):
                    annot = shapes.make_shape(out, geom, a, nm)
                elif a["kind"] == "statusstamp":
                    annot = status.make_status_stamp(out, geom, a, nm)
                elif a["kind"] == "pageborder":
                    annot = status.make_page_border(out, geom, a, nm)
                elif a["kind"] == "pagenumber":
                    annot = status.make_page_number(out, geom, a, nm)
                elif a["kind"] == "tape":
                    annot = appearance.make_tape(
                        out, geom, a["nx"], a["ny"], a["lines"], a.get("tape", {}),
                        nm, author=appearance._display_author(a),
                        agent=a.get("by") == "agent",
                        font=a.get("size"),
                    )
                else:
                    raise ValueError(f"unknown annotation kind: {a['kind']}")
                if flatten:
                    pending_flat.setdefault(idx, []).append(_flatten_op(page, annot))
                else:
                    _annots_array(page_obj).append(annot)
                n_marks += 1

            # Balance imported content with q/Q before painting on top of it, so
            # a dirty source graphics state cannot smear or clip our marks.
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
            # Colour/bold has to wait until the outline exists — pikepdf's
            # OutlineItem has no object until it is written.
            status.style_outline(out, spec.get("bookmarks", []))

            # 6. The editable session, stored inside the binder (issue #3).
            #    Flattening and embedding are mutually exclusive by design:
            #    flattened marks are painted into the page content and can never
            #    be lifted back out, so a flattened binder is the copy that
            #    leaves the firm, not a file anyone can reopen and edit. Writing
            #    a session into one would promise an edit that cannot happen.
            session = spec.get("session")
            session_bytes = 0
            if session is not None and not flatten:
                session_bytes = session_store.embed_session(out, session)

            # A flattened copy deliberately has no session, but the app still
            # needs to distinguish it from an ordinary source PDF. Otherwise it
            # opens the copy as a fresh binder and the permanent note icons look
            # like broken clickable comments. This boolean contains no client
            # data or source path. Older outputs are recognized by their WptM
            # appearance resources; see session_store.is_flattened_copy.
            if flatten:
                out.Root[session_store.WPT_FLATTENED] = True

            # A source that relies on /NeedAppearances ships filled values with
            # no appearance streams; generate them so the values render in
            # viewers that ignore that flag. Fields carrying their own
            # appearances are left untouched.
            if out.acroform.exists:
                out.acroform.generate_appearances_if_needed()

            out.save(temp_output)

        # 6. Validate the temporary artifact before it can replace a prior good
        #    binder. Syntax warnings are treated as export failure for a record.
        with pikepdf.open(temp_output) as reopened:
            problems = reopened.check_pdf_syntax()
            n_pages = len(reopened.pages)
        if problems:
            raise ValueError(f"export validation failed: {'; '.join(str(p) for p in problems)}")

        # Recheck identity after materialization to catch a source changed while
        # qpdf was reading it. Only then durably replace the destination.
        for key, expected in expected_fingerprints.items():
            actual = fingerprint_file(spec["sources"][key])
            if actual["sha256"] != expected.get("sha256"):
                raise ValueError(f"source changed during export: {spec['sources'][key]}")

        # MCP exports carry the destination state observed under their
        # cross-process lease. Recheck it at the last possible moment: another
        # program does not honor our lock and could save or create this path
        # while the new PDF is being materialized. The assertion turns that
        # race into a refusal rather than replacing a person's newer bytes.
        output_guard = spec.get("output_guard")
        if output_guard:
            expected_output_sha256 = output_guard.get("sha256")
            if expected_output_sha256 is not None:
                if not output.exists():
                    raise ValueError(
                        "export destination changed while the replacement was being prepared"
                    )
                actual_output_sha256 = fingerprint_file(str(output))["sha256"]
                if actual_output_sha256 != expected_output_sha256:
                    raise ValueError(
                        "export destination changed while the replacement was being prepared"
                    )
            elif output_guard.get("must_not_exist"):
                if output.exists():
                    raise ValueError(
                        "export destination appeared while the export was being prepared"
                    )
            else:
                raise ValueError("invalid export output guard")

        # Windows requires a writable handle to fsync: _commit() on a
        # read-only fd raises EBADF, where POSIX is happy to flush one.
        with temp_output.open("rb+") as handle:
            os.fsync(handle.fileno())
        os.replace(temp_output, output)
        try:
            directory_fd = os.open(output.parent, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        except OSError:
            pass
    finally:
        temp_output.unlink(missing_ok=True)

    return {
        "output": str(output),
        "pages": n_pages,
        "marks": n_marks,
        "flattened": flatten,
        "session_bytes": session_bytes,
        "final_index": final_index,
        "check_problems": [],
    }
