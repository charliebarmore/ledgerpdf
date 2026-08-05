"""Phase 0 compatibility spike — the stage-gate verification harness.

Everything engine-side goes through the sidecar CLI as a subprocess
(spawnability = criterion 9). Rendering checks use pdfium — the same PDF
engine as Chrome and Edge — so a passing pixel check here is strong evidence
for two of the four viewers in the matrix. macOS Preview is a manual check
(sips/CoreGraphics does not draw annotations, so it can't stand in for
Preview); Acrobat on Windows is deferred to the fixture corpus.

Run:  engine/.venv/bin/python spike/run_spike.py     (macOS/Linux)
      engine\\.venv\\Scripts\\python spike\\run_spike.py  (Windows)
Exit: 0 = all gating checks pass, 1 = at least one failure.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import pypdfium2 as pdfium

SPIKE = Path(__file__).resolve().parent
ROOT = SPIKE.parent
ENGINE_DIR = ROOT / "engine"
OUT_DIR = SPIKE / "out"
BINDER_PDF = OUT_DIR / "binder.pdf"

sys.path.insert(0, str(SPIKE))
from make_fixtures import main as make_fixtures  # noqa: E402

RESULTS: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    RESULTS.append((name, bool(ok), detail))


def info(name: str, detail: str) -> None:
    RESULTS.append((name, True, f"[info] {detail}"))


# ---------------------------------------------------------------- CLI driver

def engine_cli(command: dict) -> dict:
    """Spawn the sidecar exactly as the Electron shell would."""
    proc = subprocess.run(
        [sys.executable, "-m", "workpaper_engine.cli"],
        input=json.dumps(command).encode(),
        capture_output=True,
        cwd=ENGINE_DIR,
        env={"PYTHONPATH": str(ENGINE_DIR), "PATH": "/usr/bin:/bin"},
        timeout=120,
    )
    out = proc.stdout.decode().strip()
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        return {"ok": False, "error": f"non-JSON stdout: {out[:400]!r} stderr: {proc.stderr.decode()[:400]!r}"}


# ---------------------------------------------------------------- rendering

def render_page(path: Path, index: int, scale: float = 2.0) -> np.ndarray:
    doc = pdfium.PdfDocument(str(path))
    try:
        page = doc[index]
        try:
            bmp = page.render(scale=scale, draw_annots=True)
        except TypeError:
            bmp = page.render(scale=scale)
        return np.asarray(bmp.to_pil().convert("RGB")).copy()
    finally:
        doc.close()


def green_mask(img: np.ndarray) -> np.ndarray:
    r = img[:, :, 0].astype(int)
    g = img[:, :, 1].astype(int)
    b = img[:, :, 2].astype(int)
    return (g > 110) & (g > r + 35) & (g > b + 35)


def mask_stats(mask: np.ndarray) -> dict | None:
    ys, xs = np.nonzero(mask)
    if len(xs) < 20:
        return None
    h, w = mask.shape
    bbox_w = xs.max() - xs.min() + 1
    bbox_h = ys.max() - ys.min() + 1
    return {
        "cx": float(xs.mean()) / w,
        "cy": float(ys.mean()) / h,
        "aspect": bbox_w / bbox_h,
        "count": int(len(xs)),
    }


def check_tick(img: np.ndarray, where: str, exp_cx: float, exp_cy: float) -> None:
    stats = mask_stats(green_mask(img))
    if stats is None:
        check(f"tick renders ({where})", False, "no green pixels found — appearance stream not painted")
        return
    loc_ok = abs(stats["cx"] - exp_cx) < 0.03 and abs(stats["cy"] - exp_cy) < 0.03
    check(
        f"tick position ({where})", loc_ok,
        f"centroid ({stats['cx']:.3f},{stats['cy']:.3f}) vs expected ({exp_cx},{exp_cy})",
    )
    check(
        f"tick upright ({where})", stats["aspect"] > 1.05,
        f"glyph bbox aspect {stats['aspect']:.2f} (>1.05 = upright)",
    )


# ---------------------------------------------------------------- the spike

def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # 0. Fixtures (synthetic only).
    fixtures = make_fixtures()

    # C9: sidecar spawns and answers.
    pong = engine_cli({"cmd": "ping"})
    check("C9 sidecar CLI spawns (ping)", pong.get("ok", False), json.dumps(pong))

    # C1: engine opens/parses a tax-style PDF (render proven later via pdfium).
    probe_b = engine_cli({"cmd": "probe", "path": fixtures["B"]})
    check("C1 probe fixture B", probe_b.get("ok", False), probe_b.get("error", ""))
    b_outline = probe_b["probe"]["outline"] if probe_b.get("ok") else []
    check(
        "C1 fixture B outline read",
        len(b_outline) == 2 and b_outline[0]["title"] == "Schedule X"
        and len(b_outline[0]["children"]) == 1,
        json.dumps(b_outline)[:200],
    )

    # Build the binder spec — the internal model in miniature.
    b_id_by_src_index = {0: "b0", 1: "b1", 2: "b2"}

    def imported_outline(nodes: list[dict]) -> list[dict]:
        return [
            {
                "title": n["title"],
                "page": b_id_by_src_index[n["dest_page"]],
                "children": imported_outline(n["children"]),
            }
            for n in nodes
        ]

    tape_lines = ["  612.00", "+ 538.00", "--------", "1,150.00"]
    tape_struct = {
        "entries": [
            {"op": "+", "amount": "612.00", "memo": "First Natl"},
            {"op": "+", "amount": "538.00", "memo": "Credit Union"},
        ],
        "total": "1150.00",
        "schema": 1,
    }

    spec = {
        "sources": {"A": fixtures["A"], "B": fixtures["B"]},
        # Deliberately shuffled across sources: provenance must survive.
        "pages": [
            {"id": "a0", "source": "A", "index": 0},
            {"id": "b2", "source": "B", "index": 2},
            {"id": "b0", "source": "B", "index": 0},
            {"id": "a2", "source": "A", "index": 2},
            {"id": "b1", "source": "B", "index": 1},
            {"id": "a1", "source": "A", "index": 1},
        ],
        "annotations": [
            {"kind": "tick", "page": "a0", "nx": 0.75, "ny": 0.25, "author": "CB", "note": "Agreed to W-2"},
            {"kind": "tick", "page": "b1", "nx": 0.75, "ny": 0.25, "author": "CB", "note": "Agreed to 1099"},
            {"kind": "tape", "page": "b0", "nx": 0.60, "ny": 0.62, "lines": tape_lines,
             "tape": tape_struct, "author": "CB"},
            # Phase 2 review marks
            {"kind": "cross", "page": "a2", "nx": 0.30, "ny": 0.25, "author": "CB",
             "created": "2026-07-28T00:00:00Z"},
            {"kind": "text", "page": "a2", "nx": 0.60, "ny": 0.25, "text": "F",
             "author": "CB", "note": "Footed", "created": "2026-07-28T00:00:00Z"},
        ],
        "links": [
            {"page": "a0", "rect_n": [0.10, 0.86, 0.45, 0.90], "target_page": "b0"},
        ],
        "bookmarks": [
            {"title": "TaxForm-A.pdf", "page": "a0", "children": []},
            {"title": "SupportSchedules-B.pdf", "page": "b2",
             "children": imported_outline(b_outline)},
        ],
        "output": str(BINDER_PDF),
    }

    # C4/C5/C6 build + C8a validation — through the sidecar.
    export = engine_cli({"cmd": "export", "binder": spec})
    check("C4 export via sidecar", export.get("ok", False), export.get("error", "")[:300])
    if not export.get("ok"):
        return report()
    result = export["result"]
    check("C4 page count", result["pages"] == 6, f"pages={result['pages']}")
    check(
        "C8a engine syntax check clean", result["check_problems"] == [],
        json.dumps(result["check_problems"])[:300],
    )

    # C8a-full: the authentic `qpdf --check`, run harness-side via pikepdf.Job
    # (exit 0 = no errors, no warnings — strict for the stage gate).
    import pikepdf

    job = pikepdf.Job(["qpdf", "--check", str(BINDER_PDF)])
    job.run()
    check("C8a qpdf --check exit 0", job.exit_code == 0, f"exit_code={job.exit_code}")

    # Probe the exported binder for all structural criteria.
    probe_out = engine_cli({"cmd": "probe", "path": str(BINDER_PDF)})
    check("probe exported binder", probe_out.get("ok", False), probe_out.get("error", ""))
    if not probe_out.get("ok"):
        return report()
    pages = probe_out["probe"]["pages"]
    outline = probe_out["probe"]["outline"]

    # C4 provenance: unique signatures prove stable identity through reorder.
    sig = [(round(p["mediabox"][2] - p["mediabox"][0]), p["rotate"], p["cropbox"] is not None) for p in pages]
    expected_sig = [(612, 0, False), (612, 0, False), (700, 0, True), (614, 0, False), (612, 90, False), (613, 0, False)]
    # note: idx1 (b2) is 612x1008 — same width as a0; disambiguate by height.
    heights = [round(p["mediabox"][3] - p["mediabox"][1]) for p in pages]
    check(
        "C4 provenance signatures", sig == expected_sig and heights[1] == 1008 and heights[0] == 792,
        f"sig={sig} heights={heights}",
    )

    # C7 pre-existing annotations survived on the moved page (b2 -> index 1).
    legacy = [a["subtype"] for a in pages[1]["annotations"]]
    check(
        "C7 legacy annotations survive move", "/Square" in legacy and "/Text" in legacy,
        f"subtypes at idx1: {legacy}",
    )

    # C3 tape metadata round-trip.
    tapes = [a for a in pages[2]["annotations"] if a.get("wpt_kind") == "tape"]
    check(
        "C3 tape private metadata round-trip",
        len(tapes) == 1 and tapes[0].get("wpt_data") == tape_struct,
        json.dumps(tapes[0].get("wpt_data") if tapes else None)[:200],
    )

    # C6 internal link resolves to the moved target page.
    links = [a for a in pages[0]["annotations"] if a["subtype"] == "/Link"]
    check(
        "C6 internal link dest after reorder",
        len(links) == 1 and links[0].get("dest_page") == 2,
        f"links={[(l.get('dest_page')) for l in links]}",
    )

    # C5 bookmarks: nested imported outline, retargeted to final indexes.
    def flat(nodes: list[dict], depth: int = 0):
        for n in nodes:
            yield (depth, n["title"], n["dest_page"])
            yield from flat(n["children"], depth + 1)

    got = list(flat(outline))
    want = [
        (0, "TaxForm-A.pdf", 0),
        (0, "SupportSchedules-B.pdf", 1),
        (1, "Schedule X", 2),
        (2, "Detail X-1", 4),
        (1, "Schedule Y", 4),
    ]
    check("C5 bookmarks nested + retargeted", got == want, f"got={got}")

    # C2/C8b render checks (pdfium == Chrome/Edge engine).
    img0 = render_page(BINDER_PDF, 0)
    check_tick(img0, "unrotated pg", 0.75, 0.25)

    img4 = render_page(BINDER_PDF, 4)
    check(
        "C2 rotated page renders landscape", img4.shape[1] > img4.shape[0],
        f"rendered {img4.shape[1]}x{img4.shape[0]}",
    )
    check_tick(img4, "rotated pg /Rotate 90", 0.75, 0.25)

    # C2b: the Phase 2 mark kinds render and carry their metadata
    marks = [a for a in pages[3]["annotations"] if a.get("wpt_kind")]
    kinds = sorted(m["wpt_kind"] for m in marks)
    check("Phase 2 marks present", kinds == ["cross", "text"], f"kinds={kinds}")
    text_mark = next((m for m in marks if m["wpt_kind"] == "text"), None)
    check(
        "text mark keeps its structured payload",
        bool(text_mark) and text_mark["wpt_data"].get("text") == "F"
        and text_mark["wpt_data"].get("author") == "CB",
        json.dumps(text_mark["wpt_data"] if text_mark else None)[:160],
    )
    img3 = render_page(BINDER_PDF, 3)
    h3, w3 = img3.shape[:2]

    def _ink(cx, cy, half=0.06):
        y0, y1 = int((cy - half) * h3), int((cy + half) * h3)
        x0, x1 = int((cx - half) * w3), int((cx + half) * w3)
        reg = img3[y0:y1, x0:x1]
        return int(np.count_nonzero(np.all(reg < 200, axis=2)))

    check("cross mark renders", _ink(0.30, 0.25) > 40, f"ink={_ink(0.30, 0.25)}")
    check("text mark renders", _ink(0.60, 0.25) > 30, f"ink={_ink(0.60, 0.25)}")

    img2 = render_page(BINDER_PDF, 2)
    ratio = img2.shape[1] / img2.shape[0]
    check(
        "C2 CropBox honored (not MediaBox)", abs(ratio - 612 / 792) < 0.02,
        f"render aspect {ratio:.4f} vs CropBox {612/792:.4f} vs MediaBox {700/900:.4f}",
    )
    h, w = img2.shape[:2]
    y0, y1 = int(0.62 * h - 0.08 * h), int(0.62 * h + 0.08 * h)
    x0, x1 = int(0.60 * w - 0.12 * w), int(0.60 * w + 0.12 * w)
    region = img2[y0:y1, x0:x1]
    dark = np.count_nonzero(np.all(region < 120, axis=2))
    check("C3 tape appearance renders", dark > 40, f"dark px in tape region: {dark}")

    write_fingerprint()
    return report()


def write_fingerprint() -> None:
    """Record the binder's hash so downstream checks can detect external
    mutation. Learned the hard way: opening the binder in macOS Preview can
    rewrite it in place (flattens /Rotate, moves annotation /Rects, re-authors
    appearance streams) — and then every geometry assertion mysteriously fails
    against a file nobody thinks changed. See spike/README.md.
    """
    import hashlib

    digest = hashlib.sha256(BINDER_PDF.read_bytes()).hexdigest()
    (OUT_DIR / "binder.sha256").write_text(digest + "\n")


def report() -> int:
    print("\n=== Phase 0 spike results ===")
    failures = 0
    for name, ok, detail in RESULTS:
        mark = "PASS" if ok else "FAIL"
        if not ok:
            failures += 1
        print(f"[{mark}] {name}" + (f"  — {detail}" if detail else ""))
    print(f"\n{len(RESULTS) - failures}/{len(RESULTS)} checks passed")
    if failures == 0:
        print(f"\nBinder: {BINDER_PDF}")
        # check_preview.py drives the macOS Preview engine, so it is not a step
        # a Windows reader can take at all — naming it there sends them at a
        # POSIX path for a script that would refuse to run anyway.
        if sys.platform == "darwin":
            print("Next: engine/.venv/bin/python spike/check_preview.py  (macOS Preview engine)")
            print("Remaining manual: Acrobat Reader on the real Windows x64 box.")
        else:
            print("Next: Acrobat Reader on this box — open the binder above and")
            print("      confirm the marks render. (spike/check_preview.py is macOS-only.)")
        print("NOTE: do not open this binder in the Preview *app* — it rewrites the")
        print("      file in place and invalidates the fixture. See spike/README.md.")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
