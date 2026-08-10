"""Does an embedded session survive a third-party rewrite? Measure it.

Issue #3 is blocked on one question — if the binder becomes the master file,
does the editable session inside it survive being opened and saved by Acrobat
Pro? Acrobat Pro is not installed on this machine and may not be on the next
one, so this harness does two things:

  * **Automated leg** — runs every carrier through every rewriter we *can* drive
    (qpdf in three modes, pdfium) and prints a survival matrix. Runs anywhere,
    needs no GUI, and is the regression test.

  * **Manual leg** — `--manual-kit` writes one PDF per carrier plus a baseline
    manifest. A human (any firm running Acrobat Pro) opens each, saves, and
    hands the folder back; `--manual-verify` reports which carriers survived.
    Same baseline/verify shape as acrobat-test/check-binders.ps1.

Usage:
    python spike/carrier_survival.py                       # automated matrix
    python spike/carrier_survival.py --fixtures DIR        # use other binders
    python spike/carrier_survival.py --manual-kit  DIR     # build tester folder
    python spike/carrier_survival.py --manual-verify DIR   # after Pro saved them

Fixtures are synthetic binders. No client data, ever.
"""

from __future__ import annotations

import argparse
import csv
import json
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import pikepdf  # noqa: E402

from embed_session import (  # noqa: E402
    CARRIERS,
    make_envelope,
    page_geometry_fingerprint,
    verify_envelope,
)

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
OUT = HERE / "out" / "carriers"
DEFAULT_FIXTURES = Path("C:/Work/build/acrobat-test")


# --------------------------------------------------------------- the payload


def sample_session() -> dict:
    """A session shaped the way the single-file model needs it.

    The important difference from today's `.wptsession.json`: pages reference
    the binder's *own* page indices, not external source paths. In the two-file
    model the session points outward at sources; in the single-file model the
    binder's pages are the record and the session is only the editable overlay
    on top of them. Source paths survive as provenance, not as a dependency.
    """
    return {
        "schema": "wpt.session/1",
        "binder_pages": [
            {"id": "pg1", "binder_index": 0, "provenance": {"file": "fixture_a.pdf", "index": 0}},
            {"id": "pg2", "binder_index": 1, "provenance": {"file": "fixture_b.pdf", "index": 3}},
        ],
        "annotations": [
            {
                "kind": "tick",
                "page": "pg1",
                "nx": 0.75,
                "ny": 0.25,
                "author": "CB",
                "note": "Agreed to trial balance — tied at 12/31",
            },
            {
                "kind": "tape",
                "page": "pg2",
                "nx": 0.6,
                "ny": 0.62,
                "lines": ["  1,204.00", "+ 3,196.55", "= 4,400.55"],
                "tape": {"entries": [1204.00, 3196.55], "total": 4400.55, "op": "sum"},
                "author": "CB",
            },
        ],
        "bookmarks": [{"title": "Schedule C — Vehicle expense §179", "page": "pg1", "children": []}],
        "reviewers": [{"initials": "AR", "name": "Alex Reviewer"}],
        "unicode_probe": "£ € — ü ‡ 数 ✓",
    }


# ------------------------------------------------------------- the rewriters
#
# Each takes (src, dst) and writes a rewritten copy. These stand in for "some
# other program opened this binder and saved it." None is Acrobat Pro; that is
# what the manual leg is for.


def rw_qpdf_save(src: Path, dst: Path) -> None:
    with pikepdf.open(src) as pdf:
        pdf.save(dst)


def rw_qpdf_linearize(src: Path, dst: Path) -> None:
    with pikepdf.open(src) as pdf:
        pdf.save(dst, linearize=True)


def rw_qpdf_objstm(src: Path, dst: Path) -> None:
    """Most aggressive qpdf mode: regenerate object streams, recompress content.

    Closest thing available to a full re-author of the file structure.
    """
    with pikepdf.open(src) as pdf:
        pdf.save(
            dst,
            object_stream_mode=pikepdf.ObjectStreamMode.generate,
            normalize_content=True,
            compress_streams=True,
        )


def rw_pdfium(src: Path, dst: Path) -> None:
    """pdfium's own writer — the engine behind Chrome and Edge.

    An independent second implementation, which is the whole point: a carrier
    that only survives qpdf has only been tested against the library that wrote it.
    """
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(str(src))
    try:
        with open(dst, "wb") as handle:
            doc.save(handle)
    finally:
        doc.close()


def rw_reauthor(src: Path, dst: Path) -> None:
    """Rebuild the document by copying pages into a fresh file.

    Models the destructive class of editor — one that reconstructs a PDF from
    its pages rather than preserving the object graph. This is what our own
    `binder.export_binder` does to source files, and it is the behaviour that
    the qpdf and pdfium writers do *not* exercise: everything hanging off the
    catalog is left behind, page dictionaries come along.

    Not a claim about what Acrobat Pro does. A claim about what happens to each
    carrier if some editor does this, which is the risk being priced.
    """
    with pikepdf.open(src) as pdf, pikepdf.new() as out:
        for page in pdf.pages:
            out.pages.append(page)
        out.save(dst)


def rw_preview_sim(src: Path, dst: Path) -> None:
    """Reproduce the recorded macOS Preview damage signature.

    Preview flattened `/Rotate 90` to `0` and moved annotation rects
    (spike/README.md section 4). This applies just the rotation half — enough to
    exercise the integrity check in the negative. A carrier can survive this
    perfectly and still be describing mark positions that no longer render where
    the preparer put them, which is the failure worth catching.
    """
    with pikepdf.open(src) as pdf:
        for page in pdf.pages:
            rotate = int(page.get("/Rotate", 0)) % 360
            if rotate in (90, 270):
                x0, y0, x1, y1 = (float(v) for v in page["/MediaBox"])
                width, height = x1 - x0, y1 - y0
                page.obj["/MediaBox"] = pikepdf.Array([x0, y0, x0 + height, y0 + width])
                if "/CropBox" in page.obj:
                    del page.obj["/CropBox"]
                page.obj["/Rotate"] = 0
        pdf.save(dst)


def rw_drop_first_page(src: Path, dst: Path) -> None:
    """Delete page 1, the way a preparer would in any editor.

    Not damage — ordinary editing. It is here because it is the failure mode of
    anchoring the payload to a page, and a spike that only tests the rewriters
    kind to its favourite carrier is not a test.
    """
    with pikepdf.open(src) as pdf:
        if len(pdf.pages) > 1:
            del pdf.pages[0]
        pdf.save(dst)


REWRITERS = {
    "qpdf-save": rw_qpdf_save,
    "qpdf-linearize": rw_qpdf_linearize,
    "qpdf-objstm": rw_qpdf_objstm,
    "pdfium-save": rw_pdfium,
    "reauthor-pages": rw_reauthor,
    "preview-sim": rw_preview_sim,
    "drop-first-page": rw_drop_first_page,
}


# ------------------------------------------------------------------ measuring


def embed_into(fixture: Path, carrier: str, dst: Path, session: dict) -> tuple[int, str]:
    write, _ = CARRIERS[carrier]
    with pikepdf.open(fixture) as pdf:
        data = make_envelope(session, pdf)
        fingerprint = page_geometry_fingerprint(pdf)
        write(pdf, data)
        pdf.save(dst)
    return len(data), fingerprint


def read_back(path: Path, carrier: str, session: dict) -> dict:
    """Read one carrier out of one file and grade it."""
    _, read = CARRIERS[carrier]
    try:
        with pikepdf.open(path) as pdf:
            raw = read(pdf)
            if raw is None:
                return {"verdict": "DROPPED", "geometry": None}
            verified = verify_envelope(raw, pdf)
            if not verified.get("ok"):
                return {"verdict": "CORRUPT", "geometry": None}
            if not verified["payload_intact"]:
                return {"verdict": "MANGLED", "geometry": None}
            if verified["session"] != session:
                return {"verdict": "ALTERED", "geometry": None}
            return {
                "verdict": "SURVIVED",
                "geometry": "same" if verified["geometry_matches"] else "CHANGED",
            }
    except Exception as exc:  # a rewriter can produce a file we cannot even open
        return {"verdict": f"UNREADABLE ({type(exc).__name__})", "geometry": None}


def run_matrix(fixtures: list[Path]) -> list[dict]:
    session = sample_session()
    OUT.mkdir(parents=True, exist_ok=True)
    rows: list[dict] = []

    for fixture in fixtures:
        for carrier in CARRIERS:
            embedded = OUT / f"{fixture.stem}__{carrier}.pdf"
            try:
                size, _ = embed_into(fixture, carrier, embedded, session)
            except Exception as exc:
                rows.append(
                    {
                        "fixture": fixture.name,
                        "carrier": carrier,
                        "rewriter": "(embed)",
                        "verdict": f"EMBED FAILED ({type(exc).__name__}: {exc})",
                        "geometry": "",
                        "payload_bytes": "",
                    }
                )
                continue

            baseline = read_back(embedded, carrier, session)
            rows.append(
                {
                    "fixture": fixture.name,
                    "carrier": carrier,
                    "rewriter": "(none)",
                    "verdict": baseline["verdict"],
                    "geometry": baseline["geometry"] or "",
                    "payload_bytes": size,
                }
            )

            for rw_name, rewrite in REWRITERS.items():
                rewritten = OUT / f"{fixture.stem}__{carrier}__{rw_name}.pdf"
                try:
                    rewrite(embedded, rewritten)
                except Exception as exc:
                    rows.append(
                        {
                            "fixture": fixture.name,
                            "carrier": carrier,
                            "rewriter": rw_name,
                            "verdict": f"REWRITE FAILED ({type(exc).__name__})",
                            "geometry": "",
                            "payload_bytes": "",
                        }
                    )
                    continue
                graded = read_back(rewritten, carrier, session)
                rows.append(
                    {
                        "fixture": fixture.name,
                        "carrier": carrier,
                        "rewriter": rw_name,
                        "verdict": graded["verdict"],
                        "geometry": graded["geometry"] or "",
                        "payload_bytes": rewritten.stat().st_size,
                    }
                )
    return rows


# -------------------------------------------------------------- presentation


def summarize(rows: list[dict]) -> None:
    carriers = list(CARRIERS)
    stages = ["(none)"] + list(REWRITERS)

    print("\nSURVIVAL MATRIX - payload recovered after each rewrite")
    print("(rows = carrier, cols = what rewrote the file; ! = page geometry changed)\n")
    width = max(len(s) for s in stages) + 2
    print(f"{'carrier':<14}" + "".join(f"{s:<{width}}" for s in stages))
    for carrier in carriers:
        cells = []
        for stage in stages:
            hits = [r for r in rows if r["carrier"] == carrier and r["rewriter"] == stage]
            if not hits:
                cells.append("-")
                continue
            verdicts = {r["verdict"] for r in hits}
            geoms = {r["geometry"] for r in hits}
            cell = "PASS" if verdicts == {"SURVIVED"} else sorted(verdicts)[0]
            if "CHANGED" in geoms:
                cell += "!"
            cells.append(cell)
        print(f"{carrier:<14}" + "".join(f"{c:<{width}}" for c in cells))

    changed = [r for r in rows if r["geometry"] == "CHANGED"]
    if changed:
        movers = sorted({r["rewriter"] for r in changed})
        print(f"\nPage geometry changed under: {', '.join(movers)}")
        print("The integrity check fires - marks placed before that save may no longer line up.")
    else:
        print("\nNo rewriter altered page geometry. The integrity check stayed quiet, correctly.")

    csv_path = HERE / "out" / "carrier-survival.csv"
    with open(csv_path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(
            handle, fieldnames=["fixture", "carrier", "rewriter", "verdict", "geometry", "payload_bytes"]
        )
        writer.writeheader()
        writer.writerows(rows)
    print(f"\n{len(rows)} results -> {csv_path}")


# ------------------------------------------------------------ the manual leg


def manual_kit(fixtures: list[Path], dest: Path) -> None:
    """Build a folder a human with Acrobat Pro can process without instructions
    from us beyond one README. This is the part we cannot automate."""
    dest.mkdir(parents=True, exist_ok=True)
    session = sample_session()
    manifest = []
    fixture = fixtures[0]
    for carrier in CARRIERS:
        target = dest / f"binder__{carrier}.pdf"
        size, fingerprint = embed_into(fixture, carrier, target, session)
        manifest.append(
            {
                "file": target.name,
                "carrier": carrier,
                "payload_bytes": size,
                "geometry_fingerprint": fingerprint,
            }
        )
    (dest / "manifest.json").write_text(
        json.dumps({"fixture": fixture.name, "files": manifest}, indent=2), encoding="utf-8"
    )
    (dest / "README.txt").write_text(
        "LedgerPDF — Acrobat Pro compatibility check\n"
        "==================================================\n\n"
        "These are synthetic test PDFs. They contain no client or taxpayer data.\n\n"
        "For each PDF in this folder:\n"
        "  1. Open it in Adobe Acrobat Pro.\n"
        "  2. Make no changes. Press Ctrl+S (or File > Save).\n"
        "     If Acrobat says there is nothing to save, add and delete a comment\n"
        "     first so that a real save happens, then save.\n"
        "  3. Close it.\n\n"
        "Then zip the whole folder and send it back. Nothing else is needed.\n"
        "Please also note your Acrobat version (Help > About).\n",
        encoding="utf-8",
    )
    shutil.copy2(fixture, dest / f"_original__{fixture.name}")
    print(f"Manual kit written to {dest}")
    for entry in manifest:
        print(f"  {entry['file']:<28} {entry['carrier']:<12} {entry['payload_bytes']} bytes")
    print("\nSend the folder to a tester with Acrobat Pro. When it comes back:")
    print(f"  python spike/carrier_survival.py --manual-verify {dest}")


def manual_verify(dest: Path) -> None:
    manifest_path = dest / "manifest.json"
    if not manifest_path.exists():
        print(f"No manifest.json in {dest} — is this a folder built by --manual-kit?")
        return
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    session = sample_session()

    print(f"\nAcrobat Pro results - fixture {manifest['fixture']}\n")
    print(f"{'carrier':<14}{'verdict':<14}{'geometry':<12}{'file'}")
    for entry in manifest["files"]:
        path = dest / entry["file"]
        if not path.exists():
            print(f"{entry['carrier']:<14}{'MISSING':<14}{'':<12}{entry['file']}")
            continue
        graded = read_back(path, entry["carrier"], session)
        print(
            f"{entry['carrier']:<14}{graded['verdict']:<14}"
            f"{(graded['geometry'] or '-'):<12}{entry['file']}"
        )
    print(
        "\nSURVIVED + geometry 'same' = that carrier is safe to build the "
        "single-file model on.\ngeometry 'CHANGED' = Acrobat Pro rewrites binders, "
        "and the integrity check is mandatory."
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixtures", type=Path, default=DEFAULT_FIXTURES)
    parser.add_argument("--manual-kit", type=Path, metavar="DIR")
    parser.add_argument("--manual-verify", type=Path, metavar="DIR")
    args = parser.parse_args()

    if args.manual_verify:
        manual_verify(args.manual_verify)
        return 0

    fixtures = sorted(p for p in args.fixtures.glob("*.pdf"))
    if not fixtures:
        print(f"No PDFs in {args.fixtures}")
        return 1

    if args.manual_kit:
        manual_kit(fixtures, args.manual_kit)
        return 0

    print(f"Fixtures: {len(fixtures)} from {args.fixtures}")
    print(f"Carriers: {', '.join(CARRIERS)}")
    print(f"Rewriters: {', '.join(REWRITERS)}")
    rows = run_matrix(fixtures)
    summarize(rows)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
