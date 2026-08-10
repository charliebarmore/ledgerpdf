"""Sidecar CLI: one JSON command on stdin -> one JSON result on stdout.

This is the process boundary the Electron shell will spawn. Keeping it to
plain JSON over stdio keeps PDF behavior identical across platforms and makes
the engine independently testable (criterion 9 of the Phase 0 spike).

Usage:
    echo '{"cmd": "probe", "path": "/abs/file.pdf"}' | python -m workpaper_engine.cli
    echo '{"cmd": "export", "binder": {...}}'         | python -m workpaper_engine.cli

Errors are reported as {"ok": false, "error": "..."} with exit code 1 —
never a traceback on stdout (stdout is the protocol channel).

**The protocol is UTF-8 in both directions, explicitly, on every platform.**
Not the locale encoding — see `_read_command`. A preparer's em dash, curly
quote or accented client name has to survive this boundary unchanged, and on
Windows the default did not carry them.
"""

from __future__ import annotations

import json
import sys
import traceback

import pikepdf

from . import __version__, session_store
from .binder import export_binder
from .probe import probe_pdf
from .sheets import read_cells
from .sources import materialize_source
from .text import extract_text


def _open_binder(path: str) -> dict:
    """Read a saved binder: recover the session and report page integrity.

    A PDF with no embedded session is not an error — it is an ordinary file
    someone is importing, which is the normal case. The caller decides.
    """
    with pikepdf.open(path) as pdf:
        return session_store.read_session(pdf)


def handle(command: dict) -> dict:
    cmd = command.get("cmd")
    if cmd == "ping":
        return {"ok": True, "engine": "workpaper_engine", "version": __version__}
    if cmd == "probe":
        return {"ok": True, "probe": probe_pdf(command["path"])}
    if cmd == "text":
        return {"ok": True, "text": extract_text(command)}
    if cmd == "cells":
        # A spreadsheet as DATA. The rendered page loses which column a figure
        # sits in, which on a trial balance is the whole meaning.
        return {"ok": True, "cells": read_cells(command["path"])}
    if cmd == "materialize":
        # The pages a non-PDF source BECOMES, as PDF bytes. The renderer shows a
        # spreadsheet by displaying exactly the pages that will be exported,
        # rather than a separate preview that could drift from the binder.
        return {"ok": True, "pdf_base64": materialize_source(command["path"])}
    if cmd == "export":
        return {"ok": True, "result": export_binder(command["binder"])}
    if cmd == "open_binder":
        return {"ok": True, "binder": _open_binder(command["path"])}
    if cmd == "clean_copy":
        return {
            "ok": True,
            "result": session_store.clean_copy(command["path"], command["output"]),
        }
    return {"ok": False, "error": f"unknown cmd: {cmd!r}"}


def _read_command() -> dict:
    """Read the JSON command as UTF-8, whatever the platform locale says.

    `sys.stdin.read()` decodes using the locale encoding. On macOS and Linux
    that is UTF-8 and everything worked; on Windows it is the ANSI codepage —
    cp1252 on an en-US machine — while the Electron shell on the other end of
    the pipe always writes UTF-8. So every non-ASCII character a preparer typed
    was silently corrupted crossing the process boundary: an em dash arrived as
    "â€"", and a client named Peña arrived as PeÃ±a.

    It surfaced as a tape title exporting mojibake, but the tape was incidental
    — the same corruption reached status labels, stamps, text boxes, bookmark
    titles and file paths, and it reached them before any of the escaping in
    appearance.py could see them. That escaping was already correct; it was
    faithfully encoding characters that had been wrong since they were read.

    Reading the byte stream and decoding it here makes the protocol UTF-8 on
    both platforms, which is what the shell has always sent.
    """
    raw = getattr(sys.stdin, "buffer", None)
    if raw is None:  # pragma: no cover — a frozen build without a byte stream
        return json.loads(sys.stdin.read())
    return json.loads(raw.read().decode("utf-8"))


def _write_result(result: dict) -> None:
    """Write the JSON reply as UTF-8, for the same reason.

    `json.dumps` escapes non-ASCII to \\uXXXX by default, so today this side of
    the protocol is pure ASCII and cannot be corrupted by the locale. Writing
    bytes anyway means that guarantee lives here, next to the read, instead of
    resting on a keyword argument nobody passes and a future change could flip.
    """
    payload = (json.dumps(result) + "\n").encode("utf-8")
    out = getattr(sys.stdout, "buffer", None)
    if out is None:  # pragma: no cover — as above
        sys.stdout.write(payload.decode("utf-8"))
        return
    out.write(payload)
    out.flush()


def main() -> int:
    try:
        command = _read_command()
        result = handle(command)
    except Exception as exc:  # noqa: BLE001 — protocol boundary
        result = {
            "ok": False,
            "error": f"{type(exc).__name__}: {exc}",
            "trace": traceback.format_exc(limit=8),
        }
    _write_result(result)
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
