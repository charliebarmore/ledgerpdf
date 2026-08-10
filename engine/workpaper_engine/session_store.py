"""The editable session, stored inside the binder PDF itself.

Issue #3: the two-file model (a `.wptsession.json` master plus an exported
binder) is replaced by Acrobat parity — one file, one Save, double-click to
reopen. That requires the session to travel inside the binder.

The storage choice is not arbitrary. `spike/CARRIER-SPIKE.md` measured six
candidate locations against seven rewriters and found that **every single-anchor
location has a rewriter that destroys it**: a document-level attachment is lost
when an editor rebuilds the document from its pages, and a page-level one is lost
when the user deletes that page — ordinary editing, not damage. So the session is
written **twice**, at both anchors. Neither failure mode takes out both.

Two concerns are kept separate on purpose:

* **Did the session survive?** `read_session` answers that.
* **Did the pages it describes move underneath it?** `page_geometry_fingerprint`
  answers that, and it is the one that matters for a record. macOS Preview
  flattened `/Rotate 90` to `0` and moved annotation rects (`spike/README.md`
  §4). A session that survives that rewrite intact is still describing mark
  positions that no longer render where the preparer put them — which is worse
  than losing it, because the binder reopens looking correct.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile

import pikepdf
from pikepdf import Array, Name, String

from . import __version__

PAYLOAD_NAME = "workpaper.session.json"
SESSION_ENVELOPE_VERSION = 1

#: Every annotation this application writes carries `/WPT_Data`. That is what
#: makes ours identifiable and separable from annotations a client's own PDF
#: arrived with, which must always be left alone.
WPT_DATA = Name("/WPT_Data")


# ---------------------------------------------------------------- fingerprint


def page_geometry_fingerprint(pdf: pikepdf.Pdf) -> str:
    """Structural fingerprint of the page grid that marks are anchored to.

    Covers exactly what mark placement depends on: page count, page order, and
    each page's box geometry and rotation. Deliberately excludes content-stream
    bytes — a lossless rewrite recompresses those, and a check that fires on a
    save which changed nothing a preparer would see is a check people learn to
    ignore.

    Floats are rounded to 3 decimals so `612` and `612.00000` agree.
    """
    digest = hashlib.sha256()
    for index, page in enumerate(pdf.pages):
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
        digest.update(
            json.dumps(
                {"i": index, "media": media, "crop": crop, "rotate": rotate},
                separators=(",", ":"),
                sort_keys=True,
            ).encode("utf-8")
        )
    return digest.hexdigest()


def _envelope_bytes(session: dict, pdf: pikepdf.Pdf) -> bytes:
    """Wrap a session in the envelope that is actually embedded.

    `payload_sha256` covers the session alone, so a truncated or mangled payload
    is distinguishable from an intact one. `binder_fingerprint` is the page
    geometry the session was written against, compared on reopen.
    """
    body = json.dumps(session, separators=(",", ":"), sort_keys=True).encode("utf-8")
    envelope = {
        "wpt_session_version": SESSION_ENVELOPE_VERSION,
        "written_by": f"ledgerpdf/{__version__}",
        "payload_sha256": hashlib.sha256(body).hexdigest(),
        "binder_fingerprint": {
            "algo": "page-geometry-v1",
            "sha256": page_geometry_fingerprint(pdf),
        },
        "session": session,
    }
    return json.dumps(envelope, separators=(",", ":"), sort_keys=True).encode("utf-8")


# -------------------------------------------------------------------- writing


def _new_spec(pdf: pikepdf.Pdf, data: bytes) -> pikepdf.AttachedFileSpec:
    spec = pikepdf.AttachedFileSpec(
        pdf,
        data,
        mime_type="application/json",
        description="LedgerPDF editable session",
    )
    spec.obj[Name("/AFRelationship")] = Name("/Source")
    spec.obj[Name("/UF")] = String(PAYLOAD_NAME)
    return spec


def _append_af(pdf: pikepdf.Pdf, owner: pikepdf.Object, spec_obj: pikepdf.Object) -> None:
    """Add a file spec to an owner's /AF (associated files) array."""
    existing = owner.get(Name("/AF"))
    if existing is None:
        owner[Name("/AF")] = pdf.make_indirect(Array([spec_obj]))
    else:
        existing.append(spec_obj)


def embed_session(pdf: pikepdf.Pdf, session: dict) -> int:
    """Write the session into `pdf` at both anchors. Returns the payload size.

    Called during export, before the document is saved.
    """
    data = _envelope_bytes(session, pdf)

    # Anchor 1 — document level. Visible in Acrobat's attachment pane, which is
    # why an editor that drops it breaks its own feature.
    catalog_spec = _new_spec(pdf, data)
    pdf.attachments[PAYLOAD_NAME] = catalog_spec
    _append_af(pdf, pdf.Root, pdf.attachments[PAYLOAD_NAME].obj)

    # Anchor 2 — page level. Survives an editor that rebuilds the document from
    # its pages, because the page dictionary is what gets carried along.
    _append_af(pdf, pdf.pages[0].obj, _new_spec(pdf, data).obj)

    return len(data)


# -------------------------------------------------------------------- reading


def _read_catalog_attachment(pdf: pikepdf.Pdf) -> bytes | None:
    try:
        if PAYLOAD_NAME not in pdf.attachments:
            return None
        return bytes(pdf.attachments[PAYLOAD_NAME].get_file().read_bytes())
    except Exception:
        return None


def _read_page_attachment(pdf: pikepdf.Pdf) -> bytes | None:
    try:
        for page in pdf.pages:
            for spec in page.obj.get(Name("/AF")) or []:
                name = str(spec.get(Name("/UF")) or spec.get(Name("/F")) or "")
                if name == PAYLOAD_NAME:
                    return bytes(spec[Name("/EF")][Name("/F")].read_bytes())
        return None
    except Exception:
        return None


def read_session(pdf: pikepdf.Pdf) -> dict:
    """Recover the session from a binder and report what is trustworthy.

    Never raises for an absent or damaged payload — a binder with no session is
    an ordinary PDF someone imported, which is a normal thing to open, not an
    error. The caller decides what to do with `found=False`.
    """
    raw = _read_catalog_attachment(pdf)
    anchor = "document"
    if raw is None:
        raw = _read_page_attachment(pdf)
        anchor = "page"
    if raw is None:
        return {"found": False, "reason": "no embedded session"}

    try:
        envelope = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        return {"found": False, "reason": f"embedded session was unreadable: {exc}"}

    session = envelope.get("session")
    if session is None:
        return {"found": False, "reason": "embedded session envelope had no session"}

    body = json.dumps(session, separators=(",", ":"), sort_keys=True).encode("utf-8")
    payload_intact = hashlib.sha256(body).hexdigest() == envelope.get("payload_sha256")
    recorded = (envelope.get("binder_fingerprint") or {}).get("sha256")
    actual = page_geometry_fingerprint(pdf)

    return {
        "found": True,
        "anchor": anchor,
        "payload_intact": payload_intact,
        "geometry_matches": recorded == actual,
        "recorded_fingerprint": recorded,
        "actual_fingerprint": actual,
        "written_by": envelope.get("written_by"),
        "session": session,
    }


# ------------------------------------------------------------------ stripping


def strip_wpt_annotations(pdf: pikepdf.Pdf) -> int:
    """Remove annotations this application wrote. Returns how many went.

    Necessary because in the single-file model a binder is re-exported from
    itself on every save. Our marks are re-drawn from the session each time, so
    the previous generation has to come off first or every save would stack
    another copy on top.

    Identified by `/WPT_Data`, which only our own annotations carry. Annotations
    that arrived on the client's original PDF have no such key and are left
    exactly where they were — the app must never quietly delete someone else's
    review notes.

    Flattened marks cannot be removed by anything, because flattening paints
    them into the page content on purpose. That is why the working file is never
    flattened; flattening is for the copy that leaves the firm.
    """
    removed = 0
    for page in pdf.pages:
        annots = page.obj.get(Name("/Annots"))
        if annots is None:
            continue
        keep = []
        for annot in annots:
            try:
                is_ours = WPT_DATA in annot
            except Exception:
                is_ours = False
            if is_ours:
                removed += 1
            else:
                keep.append(annot)
        if len(keep) == len(annots):
            continue
        if keep:
            page.obj[Name("/Annots")] = pdf.make_indirect(Array(keep))
        else:
            del page.obj[Name("/Annots")]
    return removed


def strip_embedded_session(pdf: pikepdf.Pdf) -> None:
    """Remove the embedded session from both anchors.

    Used for the flattened distribution copy: a binder that leaves the firm
    carries the marks as ink and nothing that can be reopened and edited.
    """
    def is_ours(spec: pikepdf.Object) -> bool:
        # Deleting the /Names entry first leaves the /AF array pointing at a
        # null object, so a dangling entry is also ours to remove -- and is
        # never something worth keeping regardless.
        if spec is None or getattr(spec, "is_null", False):
            return True
        try:
            name = str(spec.get(Name("/UF")) or spec.get(Name("/F")) or "")
        except AttributeError:
            return True
        return name == PAYLOAD_NAME

    def prune(owner: pikepdf.Object) -> None:
        af = owner.get(Name("/AF"))
        if af is None:
            return
        keep = [spec for spec in af if not is_ours(spec)]
        if keep:
            owner[Name("/AF")] = pdf.make_indirect(Array(keep))
        else:
            del owner[Name("/AF")]

    # Prune the references before removing the attachment itself, so nothing
    # is inspecting an object that has already been unlinked.
    prune(pdf.Root)
    for page in pdf.pages:
        prune(page.obj)

    try:
        if PAYLOAD_NAME in pdf.attachments:
            del pdf.attachments[PAYLOAD_NAME]
    except Exception:
        pass


def clean_copy(source: str, destination: str) -> dict:
    """Write `source` to `destination` with our marks and session removed.

    This is what the app renders from after opening a binder. The saved binder
    carries our marks as real PDF annotations so that any viewer displays them;
    the app draws its own interactive layer on top from the session, so it needs
    the pages *without* them or every mark would appear twice.

    Annotations from the client's original PDF are preserved and still render,
    which is the behaviour the app has always had for source files.
    """
    absolute = os.path.abspath(destination)
    directory = os.path.dirname(absolute)
    fd, temporary = tempfile.mkstemp(
        dir=directory,
        prefix=f".{os.path.basename(absolute)}.",
        suffix=".tmp",
    )
    try:
        # mkstemp is exclusive and owner-only. Saving through the already-open
        # descriptor preserves that mode and prevents a pre-planted symlink from
        # redirecting the client-data copy somewhere else.
        os.chmod(temporary, 0o600)
        with os.fdopen(fd, "w+b") as output:
            fd = -1
            with pikepdf.open(source) as pdf:
                removed = strip_wpt_annotations(pdf)
                strip_embedded_session(pdf)
                pdf.save(output)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, absolute)
        # Explicit for existing destinations and unusual umasks/filesystems.
        os.chmod(absolute, 0o600)
        try:
            directory_fd = os.open(directory, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        except OSError:
            # Windows and some network filesystems do not fsync directories.
            pass
    finally:
        if fd >= 0:
            os.close(fd)
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
    return {"path": destination, "annotations_removed": removed}
