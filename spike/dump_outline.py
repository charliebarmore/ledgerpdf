r"""Dump a PDF's bookmark titles with every character escaped.

Diagnostic for "why didn't my page-count suffix get stripped" — invisible
characters (non-breaking spaces, zero-width joiners, odd parentheses) show up
as \\uXXXX escapes here.

Runs entirely locally through the same engine the app uses; nothing leaves the
machine, and the file is opened read-only.

    engine/.venv/bin/python spike/dump_outline.py "/path/to/file.pdf"      (macOS/Linux)
    engine\.venv\Scripts\python spike\dump_outline.py "C:\path\to\file.pdf"  (Windows)
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "engine"))

from workpaper_engine.probe import probe_pdf  # noqa: E402


def walk(nodes: list[dict], depth: int = 0) -> None:
    for n in nodes:
        title = n["title"]
        # json.dumps escapes non-ASCII, so U+00A0 prints as
        print(f"{'  ' * depth}{json.dumps(title, ensure_ascii=False)}")
        odd = sorted({c for c in title if ord(c) > 126 or (ord(c) < 32)})
        if odd:
            codes = " ".join(f"U+{ord(c):04X}" for c in odd)
            print(f"{'  ' * depth}    ^ non-ASCII: {codes}")
        walk(n.get("children", []), depth + 1)


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    target = Path(sys.argv[1]).expanduser()
    if not target.exists():
        print(f"not found: {target}")
        return 1
    try:
        result = probe_pdf(str(target))
    except Exception as exc:  # noqa: BLE001 — diagnostic tool
        print(f"could not read {target.name}: {type(exc).__name__}: {exc}")
        return 1

    print(f"{target.name} — {result['n_pages']} pages")
    outline = result["outline"]
    if not outline:
        print("(this PDF has no bookmarks of its own)")
        return 0
    walk(outline)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
