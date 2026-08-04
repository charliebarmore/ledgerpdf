"""Probe: inspect a PDF and return a JSON-friendly summary.

Used by the app (and the spike harness) to learn a source file's structure —
pages, boxes, rotation, existing annotations, outline — before building a
binder spec, and to verify exported binders.
"""

from __future__ import annotations

import json
import re
from hashlib import sha256
from pathlib import Path

import pikepdf
from pikepdf import Name

from .images import is_image, probe_image
from .documents import is_doc, probe_doc
from .sheets import is_sheet, probe_sheet


_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f-\x9f]")


def fingerprint_file(path: str) -> dict:
    """Content identity for a session source.

    A page id is meaningful only while it still points at the bytes originally
    reviewed. Size/mtime make ordinary reopen checks cheap to explain; SHA-256
    is the authority and catches a same-path replacement before export.
    """
    source = Path(path)
    before = source.stat()
    digest = sha256()
    with source.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    after = source.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise OSError(f"source changed while it was being read: {source}")
    return {
        "sha256": digest.hexdigest(),
        "size": after.st_size,
        "mtime_ns": after.st_mtime_ns,
    }


def sanitize_text(value: str) -> str:
    """Strip control characters from text decoded out of a PDF.

    Observed in the wild: tax software that ends every bookmark title with a
    NUL. Invisible, but it breaks end-of-string matching downstream and must
    never be written back into a binder.
    """
    return _CONTROL_CHARS.sub("", value).strip()


def _page_index_map(pdf: pikepdf.Pdf) -> dict[tuple[int, int], int]:
    return {pdf.pages[i].obj.objgen: i for i in range(len(pdf.pages))}


def _resolve_dest_page(dest, page_map: dict[tuple[int, int], int]) -> int | None:
    """Resolve a /Dest-style destination to a page index."""
    if dest is None:
        return None
    try:
        first = dest[0]
    except (TypeError, IndexError):
        return None
    if isinstance(first, int):
        return first
    try:
        return page_map.get(first.objgen)
    except AttributeError:
        return None


def _outline_to_dicts(items, page_map) -> list[dict]:
    result = []
    for item in items:
        dest = item.destination
        if dest is None and item.obj is not None:
            action = item.obj.get(Name("/A"), None)
            if action is not None and action.get(Name("/S"), None) == Name("/GoTo"):
                dest = action.get(Name("/D"), None)
        result.append(
            {
                "title": sanitize_text(str(item.title)),
                "dest_page": _resolve_dest_page(dest, page_map),
                "children": _outline_to_dicts(item.children, page_map),
            }
        )
    return result


def _annot_summary(annot, page_map) -> dict:
    subtype = annot.get(Name.Subtype, None)
    summary: dict = {
        "subtype": str(subtype) if subtype is not None else None,
        "rect": [float(v) for v in annot.Rect] if Name.Rect in annot else None,
        "nm": str(annot.get(Name.NM)) if Name.NM in annot else None,
        # /T is the name a viewer displays against the annotation. Exposed so
        # attribution can be checked as a reviewer would see it, rather than
        # only in our own private /WPT_Data.
        "author": sanitize_text(str(annot[Name.T])) if Name.T in annot else None,
        "has_ap": Name.AP in annot,
    }
    if Name("/WPT_Kind") in annot:
        summary["wpt_kind"] = str(annot[Name("/WPT_Kind")])
    if Name("/WPT_Data") in annot:
        summary["wpt_data"] = json.loads(str(annot[Name("/WPT_Data")]))
    if subtype == Name.Link and Name.Dest in annot:
        summary["dest_page"] = _resolve_dest_page(annot.Dest, page_map)
    return summary


def probe_pdf(path: str) -> dict:
    # An image is a page too. Dispatching here means every caller — the app's
    # import, the MCP server, the verification harness — gets one probe API and
    # never has to care which kind of file it pointed at.
    if is_doc(path):
        result = probe_doc(path)
        result["fingerprint"] = fingerprint_file(path)
        return result
    if is_sheet(path):
        result = probe_sheet(path)
        # Same integrity contract as every other source: marks placed on a
        # spreadsheet page must not silently reattach to a different workbook.
        result["fingerprint"] = fingerprint_file(path)
        return result
    if is_image(path):
        result = probe_image(path)
        result["fingerprint"] = fingerprint_file(path)
        return result

    with pikepdf.open(path) as pdf:
        page_map = _page_index_map(pdf)
        pages = []
        for i, page in enumerate(pdf.pages):
            obj = page.obj
            media = [float(v) for v in obj.MediaBox]
            crop = [float(v) for v in obj.CropBox] if Name.CropBox in obj else None
            annots = []
            if Name.Annots in obj:
                annots = [_annot_summary(a, page_map) for a in obj.Annots]
            pages.append(
                {
                    "index": i,
                    "mediabox": media,
                    "cropbox": crop,
                    "rotate": int(obj.get(Name.Rotate, 0)),
                    "annotations": annots,
                }
            )
        with pdf.open_outline() as outline:
            outline_dicts = _outline_to_dicts(outline.root, page_map)
        return {
            "path": path,
            "n_pages": len(pages),
            "pages": pages,
            "outline": outline_dicts,
            "fingerprint": fingerprint_file(path),
        }
