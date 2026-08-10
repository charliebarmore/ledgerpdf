r"""Build the viewer-conformance binder.

Every annotation kind this tool authors, placed at KNOWN normalized coordinates,
across the page geometries that actually break things:

  page 1  normal 612x792
  page 2  CropBox != MediaBox   (the coordinate trap named in the Phase 0 review)
  page 3  /Rotate 90            (rotation compensation in the appearance /Matrix)
  page 4  legal size, carrying pre-existing annotations from the source
  page 5  page status: stamp + coloured border
  page 6  the SAME assertions as page 1, but flattened into page content

Everything here is hand-authored appearance streams. That is the whole risk:
a viewer that synthesises its own appearances, or reads /Matrix or /BBox
differently, would put a reviewer's tick somewhere other than where it was
placed — and a tick pointing at the wrong number is worse than no tick.

    engine/.venv/bin/python spike/make_conformance.py        (macOS/Linux)
    engine\.venv\Scripts\python spike\make_conformance.py    (Windows)

Writes spike/out/conformance.pdf and prints the expected positions as JSON so
the checker and a human are reading from the same source of truth.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "engine"))

from workpaper_engine.binder import export_binder  # noqa: E402
from workpaper_engine.probe import probe_pdf  # noqa: E402

FIX = REPO / "spike" / "fixtures"
OUT = REPO / "spike" / "out" / "conformance.pdf"

# (colour, nx, ny) triples the renderers must find. Only ONE object of a given
# colour per page, or the centroid would average two things and prove nothing.
EXPECTED: dict[int, list[tuple[str, float, float]]] = {
    0: [("green", 0.25, 0.25), ("blue", 0.75, 0.25), ("red", 0.40, 0.70)],
    1: [("green", 0.30, 0.30), ("red", 0.70, 0.70)],
    2: [("green", 0.25, 0.75), ("red", 0.65, 0.35)],
    3: [("brown", 0.30, 0.30)],
    5: [("green", 0.25, 0.25), ("blue", 0.75, 0.25), ("red", 0.40, 0.70)],
}


def build() -> dict:
    a = probe_pdf(str(FIX / "fixture_a.pdf"))
    b = probe_pdf(str(FIX / "fixture_b.pdf"))
    assert a["n_pages"] >= 1 and b["n_pages"] >= 3, "regenerate fixtures first"

    pages = [
        {"id": "p1", "source": "A", "index": 0, "rotate": 0},  # normal
        {"id": "p2", "source": "B", "index": 0, "rotate": 0},  # CropBox != MediaBox
        {"id": "p3", "source": "B", "index": 1, "rotate": 0},  # /Rotate 90
        {"id": "p4", "source": "B", "index": 2, "rotate": 0},  # legal + annots
        {"id": "p5", "source": "A", "index": 1, "rotate": 0},  # status
        {"id": "p6", "source": "A", "index": 0, "rotate": 0},  # flatten twin
    ]

    def marks(page: str) -> list[dict]:
        """The page-1 assertion set, reused for the flattened twin."""
        return [
            {"kind": "tick", "page": page, "nx": 0.25, "ny": 0.25, "size": 26},
            {"kind": "text", "page": page, "nx": 0.75, "ny": 0.25, "size": 26, "text": "F"},
            {
                "kind": "rect", "page": page,
                "nx": 0.20, "ny": 0.60, "nx2": 0.60, "ny2": 0.80,
                "color": "red", "width": 3,
            },
        ]

    annotations: list[dict] = [
        *marks("p1"),
        # CropBox page: the tick must sit against the VISIBLE sheet, not the media box.
        {"kind": "tick", "page": "p2", "nx": 0.30, "ny": 0.30, "size": 26},
        {
            "kind": "ellipse", "page": "p2",
            "nx": 0.50, "ny": 0.60, "nx2": 0.90, "ny2": 0.80,
            "color": "red", "width": 3,
        },
        # Rotated page: everything must appear upright in the displayed frame.
        {"kind": "tick", "page": "p3", "nx": 0.25, "ny": 0.75, "size": 26},
        {
            "kind": "rect", "page": "p3",
            "nx": 0.50, "ny": 0.25, "nx2": 0.80, "ny2": 0.45,
            "color": "red", "width": 3,
        },
        # Legal page that already carries annotations from its source.
        {
            "kind": "tape", "page": "p4", "nx": 0.30, "ny": 0.30,
            "lines": ["1 - 0 |         |          |  ",
                      "1 - 1 |         | 1,200.00 | +",
                      "1 - T | Total   | 1,200.00 | *"],
            "tape": {"entries": [{"value": 1200, "op": "+"}], "total": 1200},
            "author": "ABC",
        },
        # Blue, not orange: orange satisfies the brown mask and would average
        # with the tape's border, making the page-4 centroid meaningless. One
        # asserted colour per page is a rule of the harness, not a preference.
        {"kind": "arrow", "page": "p4", "nx": 0.60, "ny": 0.60, "nx2": 0.85, "ny2": 0.45,
         "color": "blue", "width": 3},
        {"kind": "highlight", "page": "p4", "nx": 0.15, "ny": 0.85, "nx2": 0.60, "ny2": 0.89},
        {"kind": "textbox", "page": "p4", "nx": 0.15, "ny": 0.60, "nx2": 0.50, "ny2": 0.72,
         "color": "black", "width": 1.5, "text": "Agreed to the general ledger."},
        # Status furniture.
        {"kind": "statusstamp", "page": "p5", "nx": 0.80, "ny": 0.08, "color": "green",
         "text": "ABC", "label": "Reviewed", "at": "2026-07-31T14:33:30Z"},
        {"kind": "pageborder", "page": "p5", "color": "green", "width": 4},
        *marks("p6"),
    ]
    # Page numbers on every page — they must stay upright on the rotated one.
    annotations += [
        {"kind": "pagenumber", "page": p["id"], "nx": 0.93, "ny": 0.955,
         "text": f"WP-{i + 1:04d}", "size": 9, "corner": "br"}
        for i, p in enumerate(pages)
    ]

    bookmarks = [
        {"title": "Normal page", "page": "p1", "children": [], "color": "green", "bold": True},
        {"title": "CropBox page", "page": "p2", "children": []},
        {"title": "Rotated page", "page": "p3", "children": [], "color": "red", "bold": True},
        {"title": "Legal page", "page": "p4", "children": []},
        {"title": "Status page", "page": "p5", "children": []},
        {"title": "Flattened twin", "page": "p6", "children": []},
    ]

    spec = {
        "sources": {"A": str(FIX / "fixture_a.pdf"), "B": str(FIX / "fixture_b.pdf")},
        "pages": pages,
        "annotations": annotations,
        "bookmarks": bookmarks,
        "output": str(OUT),
    }
    result = export_binder(spec)

    # The flattened twin: same geometry, burned into content. Exported
    # separately because flatten is whole-document, then page 6 is what matters.
    flat_out = OUT.with_name("conformance_flat.pdf")
    flat = export_binder({**spec, "flatten": True, "output": str(flat_out)})

    return {
        "output": str(OUT),
        "flat_output": str(flat_out),
        "pages": result["pages"],
        "problems": result["check_problems"] + flat["check_problems"],
        "expected": {str(k): v for k, v in EXPECTED.items()},
    }


if __name__ == "__main__":
    print(json.dumps(build(), indent=2))
