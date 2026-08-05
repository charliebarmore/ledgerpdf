"""Carriers for storing an editable session *inside* the binder PDF.

Issue #3: the two-file model (`.wptsession.json` master + exported binder) is
being replaced by Acrobat parity — one file, one Save, double-click to reopen.
That requires the session to live in the PDF. The open risk is that a third-party
editor (Acrobat Pro, Preview) rewrites the binder and silently drops it.

Rather than prove no editor ever rewrites a binder — which needs software we do
not have and can never fully enumerate — this module makes the question testable:
write the same payload through several carriers of differing durability, then
measure which ones survive a rewrite. `carrier_survival.py` is the harness.

Two independent concerns, deliberately separated:

1. **Payload survival** — did the session come back byte-identical? Carriers below.
2. **Binder integrity** — did the *pages* the marks were placed against change
   underneath us? `page_geometry_fingerprint` answers that, and it is the part
   that matters for a record. macOS Preview flattened `/Rotate 90` to `0` and
   moved annotation rects (spike/README.md section 4); a payload that survives
   that rewrite is still describing geometry that no longer exists.

LICENSE GUARD: pikepdf/qpdf (MPL-2.0/Apache-2.0) only. Never MuPDF/PyMuPDF.
"""

from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path
from typing import Callable

import pikepdf
from pikepdf import Name, String

PAYLOAD_NAME = "workpaper.session.json"
PRIVATE_KEY = Name("/WPT_Session")
XMP_KEY = "pdfx:WPTSession"
SESSION_FORMAT_VERSION = 1


# ---------------------------------------------------------------- fingerprint


def page_geometry_fingerprint(pdf: pikepdf.Pdf) -> str:
    """Structural fingerprint of the page grid the marks are anchored to.

    Covers exactly what mark placement depends on: page count, page order, and
    each page's box geometry and rotation. Deliberately excludes content-stream
    bytes — a lossless rewrite recompresses those, and we do not want to cry
    wolf on a save that changed nothing a preparer would see.

    Floats are rounded to 3 decimals so that `612` and `612.00000` agree.
    """
    h = hashlib.sha256()
    for i, page in enumerate(pdf.pages):
        def box(name: str) -> list[float]:
            try:
                return [round(float(v), 3) for v in page[name]]
            except (KeyError, AttributeError):
                return []

        media = box("/MediaBox")
        crop = box("/CropBox") or media
        try:
            rotate = int(page.get("/Rotate", 0)) % 360
        except (AttributeError, TypeError, ValueError):
            rotate = 0
        h.update(
            json.dumps(
                {"i": i, "media": media, "crop": crop, "rotate": rotate},
                separators=(",", ":"),
                sort_keys=True,
            ).encode("utf-8")
        )
    return h.hexdigest()


def make_envelope(session: dict, pdf: pikepdf.Pdf, engine_version: str = "spike") -> bytes:
    """Wrap a session in the envelope that actually gets embedded.

    `payload_sha256` covers the session only, so the reader can distinguish a
    truncated/mangled payload from an intact one. `binder_fingerprint` is the
    geometry the session was written against — compared on reopen.
    """
    session_bytes = json.dumps(session, separators=(",", ":"), sort_keys=True).encode("utf-8")
    envelope = {
        "wpt_session_version": SESSION_FORMAT_VERSION,
        "written_by": f"ledgerpdf/{engine_version}",
        "payload_sha256": hashlib.sha256(session_bytes).hexdigest(),
        "binder_fingerprint": {
            "algo": "page-geometry-v1",
            "sha256": page_geometry_fingerprint(pdf),
        },
        "session": session,
    }
    return json.dumps(envelope, separators=(",", ":"), sort_keys=True).encode("utf-8")


def verify_envelope(raw: bytes, pdf: pikepdf.Pdf) -> dict:
    """Read an envelope back and report what is trustworthy about it.

    Returns {ok, payload_intact, geometry_matches, session, error}. A payload can
    be intact while the geometry no longer matches — that is the interesting
    failure, and it is the one a preparer must be told about.
    """
    try:
        envelope = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        return {"ok": False, "error": f"unreadable envelope: {exc}"}

    session = envelope.get("session")
    if session is None:
        return {"ok": False, "error": "envelope has no session"}

    session_bytes = json.dumps(session, separators=(",", ":"), sort_keys=True).encode("utf-8")
    payload_intact = hashlib.sha256(session_bytes).hexdigest() == envelope.get("payload_sha256")
    recorded = (envelope.get("binder_fingerprint") or {}).get("sha256")
    geometry_matches = recorded == page_geometry_fingerprint(pdf)

    return {
        "ok": True,
        "payload_intact": payload_intact,
        "geometry_matches": geometry_matches,
        "recorded_fingerprint": recorded,
        "actual_fingerprint": page_geometry_fingerprint(pdf),
        "session": session,
    }


# ------------------------------------------------------------------- carriers
#
# Each carrier is (write, read). `read` returns None when the carrier is absent,
# and raises nothing — a dropped payload is a result, not an error.


def _write_attachment(pdf: pikepdf.Pdf, data: bytes) -> None:
    """Document-level embedded file (/Names /EmbeddedFiles).

    The durable option in principle: attachments are a user-visible PDF feature
    with UI in Acrobat, so an editor that drops them breaks its own paperclip
    pane. Also tagged /AFRelationship /Source and listed in the catalog's /AF,
    which is how PDF/A-3 and Factur-X carry machine-readable payloads.
    """
    spec = pikepdf.AttachedFileSpec(
        pdf,
        data,
        mime_type="application/json",
        description="LedgerPDF editable session",
    )
    pdf.attachments[PAYLOAD_NAME] = spec
    filespec = spec.obj
    filespec[Name("/AFRelationship")] = Name("/Source")
    filespec[Name("/UF")] = String(PAYLOAD_NAME)
    existing = pdf.Root.get(Name("/AF"))
    if existing is None:
        pdf.Root[Name("/AF")] = pdf.make_indirect(pikepdf.Array([filespec]))
    else:
        existing.append(filespec)


def _read_attachment(pdf: pikepdf.Pdf) -> bytes | None:
    try:
        if PAYLOAD_NAME not in pdf.attachments:
            return None
        return bytes(pdf.attachments[PAYLOAD_NAME].get_file().read_bytes())
    except Exception:
        return None


def _write_xmp(pdf: pikepdf.Pdf, data: bytes) -> None:
    """XMP metadata, base64 into a custom property.

    XMP is the standards-blessed metadata channel, but it is XML — binary-unsafe,
    so the JSON is base64'd, costing ~33%. Editors routinely *rewrite* XMP
    (updating ModifyDate); the question is whether they preserve foreign
    properties while doing it.
    """
    with pdf.open_metadata(set_pikepdf_as_editor=False) as meta:
        meta[XMP_KEY] = base64.b64encode(data).decode("ascii")


def _read_xmp(pdf: pikepdf.Pdf) -> bytes | None:
    try:
        meta = pdf.open_metadata()
        if XMP_KEY not in meta:
            return None
        return base64.b64decode(meta[XMP_KEY])
    except Exception:
        return None


def _write_docinfo(pdf: pikepdf.Pdf, data: bytes) -> None:
    """Custom key in the /Info dictionary, base64'd.

    /Info is deprecated in PDF 2.0 and editors feel free to regenerate it. Here
    as a control: expected to be among the first things lost.
    """
    pdf.docinfo[PRIVATE_KEY] = String(base64.b64encode(data).decode("ascii"))


def _read_docinfo(pdf: pikepdf.Pdf) -> bytes | None:
    try:
        if PRIVATE_KEY not in pdf.docinfo:
            return None
        return base64.b64decode(str(pdf.docinfo[PRIVATE_KEY]))
    except Exception:
        return None


def _write_page_af(pdf: pikepdf.Pdf, data: bytes) -> None:
    """Associated file hung off page 1 (/AF on the page, not the catalog).

    The same embedded-file machinery as `attachment`, anchored one level down.
    That single difference is what makes it survive an editor that rebuilds the
    document by copying pages — the page dictionary comes along, the catalog
    does not. Costs the paperclip-pane visibility that document-level
    attachments get in Acrobat.
    """
    spec = pikepdf.AttachedFileSpec(
        pdf,
        data,
        mime_type="application/json",
        description="LedgerPDF editable session",
    )
    filespec = spec.obj
    filespec[Name("/AFRelationship")] = Name("/Source")
    filespec[Name("/UF")] = String(PAYLOAD_NAME)
    page = pdf.pages[0].obj
    existing = page.get(Name("/AF"))
    if existing is None:
        page[Name("/AF")] = pdf.make_indirect(pikepdf.Array([filespec]))
    else:
        existing.append(filespec)


def _read_page_af(pdf: pikepdf.Pdf) -> bytes | None:
    try:
        for page in pdf.pages:
            for filespec in page.obj.get(Name("/AF")) or []:
                name = str(filespec.get(Name("/UF")) or filespec.get(Name("/F")) or "")
                if name == PAYLOAD_NAME:
                    return bytes(filespec[Name("/EF")][Name("/F")].read_bytes())
        return None
    except Exception:
        return None


def _write_catalog(pdf: pikepdf.Pdf, data: bytes) -> None:
    """Private stream hung off the document catalog.

    Cheapest to write, no base64 tax, and survives qpdf because qpdf preserves
    unknown objects. The control for "private key nobody else knows about" — the
    same class of storage as the existing per-annotation /WPT_Data.
    """
    pdf.Root[PRIVATE_KEY] = pdf.make_stream(data)


def _read_catalog(pdf: pikepdf.Pdf) -> bytes | None:
    try:
        if PRIVATE_KEY not in pdf.Root:
            return None
        return bytes(pdf.Root[PRIVATE_KEY].read_bytes())
    except Exception:
        return None


def _write_dual(pdf: pikepdf.Pdf, data: bytes) -> None:
    """Both embedded-file carriers at once — catalog level and page level.

    Neither anchor is sufficient alone: the catalog copy dies when an editor
    rebuilds the document from its pages, the page copy dies when someone
    deletes that page. Writing both costs a few kilobytes and removes both
    single points of failure. This is the carrier the product should ship.
    """
    _write_attachment(pdf, data)
    _write_page_af(pdf, data)


def _read_dual(pdf: pikepdf.Pdf) -> bytes | None:
    return _read_attachment(pdf) or _read_page_af(pdf)


CARRIERS: dict[str, tuple[Callable[[pikepdf.Pdf, bytes], None], Callable[[pikepdf.Pdf], bytes | None]]] = {
    "dual": (_write_dual, _read_dual),
    "attachment": (_write_attachment, _read_attachment),
    "page-af": (_write_page_af, _read_page_af),
    "xmp": (_write_xmp, _read_xmp),
    "docinfo": (_write_docinfo, _read_docinfo),
    "catalog": (_write_catalog, _read_catalog),
}


# ---------------------------------------------------------------- public API


def embed(source_pdf: Path, session: dict, output_pdf: Path, carrier: str = "attachment") -> dict:
    """Write `session` into a copy of `source_pdf` using `carrier`."""
    write, _ = CARRIERS[carrier]
    with pikepdf.open(source_pdf) as pdf:
        data = make_envelope(session, pdf)
        write(pdf, data)
        pdf.save(output_pdf)
    return {"carrier": carrier, "bytes": len(data), "output": str(output_pdf)}


def extract(pdf_path: Path, carriers: list[str] | None = None) -> dict:
    """Read a session back, trying carriers in order of durability.

    Returns the first carrier that yields a readable envelope, plus what every
    carrier did — so a partial survival is visible rather than silently masked
    by a fallback.
    """
    order = carriers or ["attachment", "page-af", "catalog", "xmp", "docinfo"]
    found: dict[str, object] = {}
    result: dict | None = None
    with pikepdf.open(pdf_path) as pdf:
        for name in order:
            _, read = CARRIERS[name]
            raw = read(pdf)
            found[name] = None if raw is None else len(raw)
            if raw is not None and result is None:
                verified = verify_envelope(raw, pdf)
                if verified.get("ok"):
                    result = {"carrier": name, **verified}
    return {"recovered": result is not None, "carriers": found, **(result or {})}
