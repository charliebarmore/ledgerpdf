"""Sidecar CLI: one JSON command on stdin -> one JSON result on stdout.

This is the process boundary the Electron shell will spawn. Keeping it to
plain JSON over stdio keeps PDF behavior identical across platforms and makes
the engine independently testable (criterion 9 of the Phase 0 spike).

Usage:
    echo '{"cmd": "probe", "path": "/abs/file.pdf"}' | python -m workpaper_engine.cli
    echo '{"cmd": "export", "binder": {...}}'         | python -m workpaper_engine.cli

Errors are reported as {"ok": false, "error": "..."} with exit code 1 —
never a traceback on stdout (stdout is the protocol channel).
"""

from __future__ import annotations

import json
import sys
import traceback

from . import __version__
from .binder import export_binder
from .probe import probe_pdf
from .text import extract_text


def handle(command: dict) -> dict:
    cmd = command.get("cmd")
    if cmd == "ping":
        return {"ok": True, "engine": "workpaper_engine", "version": __version__}
    if cmd == "probe":
        return {"ok": True, "probe": probe_pdf(command["path"])}
    if cmd == "text":
        return {"ok": True, "text": extract_text(command)}
    if cmd == "export":
        return {"ok": True, "result": export_binder(command["binder"])}
    return {"ok": False, "error": f"unknown cmd: {cmd!r}"}


def main() -> int:
    try:
        command = json.loads(sys.stdin.read())
        result = handle(command)
    except Exception as exc:  # noqa: BLE001 — protocol boundary
        result = {
            "ok": False,
            "error": f"{type(exc).__name__}: {exc}",
            "trace": traceback.format_exc(limit=8),
        }
    json.dump(result, sys.stdout)
    sys.stdout.write("\n")
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
