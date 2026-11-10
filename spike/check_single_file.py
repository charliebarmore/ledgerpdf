"""Single-file binder round trip — issue #3.

Proves the save/reopen/save-again cycle that replaces the two-file model:
the binder PDF is the document, the editable session rides inside it, and
saving a binder that was itself opened from a binder does not accumulate
duplicate marks.

Everything engine-side goes through the sidecar CLI as a subprocess, the same
way the Electron shell spawns it, so a pass here is evidence about the shipped
boundary and not just about importable Python.

Run:  engine/.venv/Scripts/python.exe spike/check_single_file.py    (Windows)
      engine/.venv/bin/python spike/check_single_file.py            (macOS)
Exit: 0 = all checks pass, 1 = at least one failure.

Fixtures are synthetic. No client data, ever.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

import pikepdf
from pikepdf import Array, Dictionary, Name, String

SPIKE = Path(__file__).resolve().parent
ROOT = SPIKE.parent
ENGINE_DIR = ROOT / "engine"
OUT_DIR = SPIKE / "out" / "single-file"

sys.path.insert(0, str(SPIKE))
from make_fixtures import main as make_fixtures  # noqa: E402

RESULTS: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    RESULTS.append((name, bool(ok), detail))


def engine_cli(command: dict) -> dict:
    """Spawn the sidecar exactly as the Electron shell would.

    PATH is inherited rather than hardcoded: the POSIX-only literal in
    run_spike.py cannot work on Windows, and this harness has to run on the
    machine the app is being tested on.
    """
    env = {"PYTHONPATH": str(ENGINE_DIR), "PATH": os.environ.get("PATH", "")}
    if "SYSTEMROOT" in os.environ:  # Windows needs this for sockets/DLL loading
        env["SYSTEMROOT"] = os.environ["SYSTEMROOT"]
    proc = subprocess.run(
        [sys.executable, "-m", "workpaper_engine.cli"],
        input=json.dumps(command).encode(),
        capture_output=True,
        cwd=ENGINE_DIR,
        env=env,
        timeout=120,
    )
    out = proc.stdout.decode().strip()
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        return {
            "ok": False,
            "error": f"non-JSON stdout: {out[:400]!r} stderr: {proc.stderr.decode()[:400]!r}",
        }


# ------------------------------------------------------------------- helpers


def count_annots(path: Path) -> tuple[int, int]:
    """(ours, theirs) — annotations carrying /WPT_Data vs everything else."""
    ours = theirs = 0
    with pikepdf.open(path) as pdf:
        for page in pdf.pages:
            for annot in page.obj.get(Name("/Annots")) or []:
                if Name("/WPT_Data") in annot:
                    ours += 1
                else:
                    theirs += 1
    return ours, theirs


def annot_names(path: Path) -> set[str]:
    names: set[str] = set()
    with pikepdf.open(path) as pdf:
        for page in pdf.pages:
            for annot in page.obj.get(Name("/Annots")) or []:
                nm = annot.get(Name("/NM"))
                if nm is not None:
                    names.add(str(nm))
    return names


def annotation_records(path: Path) -> list[str]:
    """Compare original review content and appearance without object numbers."""
    records = []
    with pikepdf.open(path) as pdf:
        for index, page in enumerate(pdf.pages):
            for annot in page.obj.get(Name.Annots) or []:
                record = {key: str(annot.get(Name(key), "")) for key in
                          ("/NM", "/Subtype", "/Contents", "/T", "/Rect", "/WPT_Data")}
                # Imported editable identifiers move to provenance keys. Only
                # normalize those keys; visual/content fields stay literal.
                if Name("/WPT_SourceName") in annot:
                    record["/NM"] = str(annot[Name("/WPT_SourceName")])
                if Name("/WPT_SourceData") in annot:
                    record["/WPT_Data"] = str(annot[Name("/WPT_SourceData")])
                record["page"] = index
                ap = annot.get(Name.AP)
                if ap is not None and isinstance(ap.get(Name.N), pikepdf.Stream):
                    record["appearance"] = hashlib.sha256(ap.N.read_bytes()).hexdigest()
                records.append(json.dumps(record, sort_keys=True))
    return sorted(records)


def legacy_strip_wpt_annotations(pdf: pikepdf.Pdf) -> int:
    """Frozen pre-fix cleanup logic: older applications know no source keys.

    Keep this independent of session_store so backward preservation cannot
    accidentally pass because the test invokes a newer cleanup implementation.
    """
    removed = 0
    for page in pdf.pages:
        annots = page.obj.get(Name("/Annots"))
        if annots is None:
            continue
        keep = []
        for annot in annots:
            try:
                is_legacy_link = (
                    annot.get(Name.Subtype, None) == Name.Link
                    and str(annot.get(Name.NM, "")).startswith("wpt-link-")
                )
                is_ours = Name("/WPT_Data") in annot or is_legacy_link
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


def check_imported_review_work(binder: Path) -> None:
    """A PDF's LedgerPDF producer does not make its marks ours to delete."""
    from workpaper_engine import session_store

    plain = OUT_DIR / "imported-review.pdf"
    with pikepdf.open(binder) as pdf:
        session_store.strip_embedded_session(pdf)
        # Older LedgerPDF links predate /WPT_Data but still belong to the
        # imported document. A URI keeps the test independent of link remapping.
        pdf.pages[0].obj.Annots.append(pdf.make_indirect(Dictionary(
            Type=Name.Annot, Subtype=Name.Link, Rect=Array([10, 10, 30, 30]),
            NM=String("wpt-link-0042"),
            A=Dictionary(S=Name.URI, URI=String("https://example.com/review")),
        )))
        pdf.save(plain)
    original = annotation_records(plain)
    source_digest = hashlib.sha256(plain.read_bytes()).hexdigest()
    info = engine_cli({"cmd": "open_binder", "path": str(plain)})
    check("marked source opens as a plain PDF", info.get("binder", {}).get("found") is False)

    pages = [{"id": f"pg{i + 1}", "source": "A", "index": i} for i in range(2)]
    empty_session = {**sample_session(["pg1", "pg2"]), "marks": []}
    first = OUT_DIR / "imported-review-first.pdf"
    spec = build_spec({"A": str(plain)}, pages, empty_session, first)
    spec["annotations"] = []
    res = engine_cli({"cmd": "export", "binder": spec})
    check("plain marked PDF saves without adding new marks", res.get("ok"), str(res.get("error", "")))
    if not res.get("ok"):
        return
    check("plain-PDF save retains every original annotation and appearance",
          annotation_records(first) == original)

    previous = first
    expected_session = empty_session
    for cycle in range(2):
        reopened = engine_cli({"cmd": "open_binder", "path": str(previous)})
        check(f"imported review cycle {cycle + 1}: editable session reopens",
              reopened.get("binder", {}).get("session") == expected_session)
        clean = OUT_DIR / f"imported-review-clean-{cycle}.pdf"
        res = engine_cli({"cmd": "clean_copy", "path": str(previous), "output": str(clean)})
        check(f"imported review cycle {cycle + 1}: clean copy preserves source marks",
              res.get("ok") and annotation_records(clean) == original)
        check(f"imported review cycle {cycle + 1}: cleanup removes only current annotations",
              res.get("result", {}).get("annotations_removed") == (0 if cycle == 0 else 2))
        saved = OUT_DIR / f"imported-review-save-{cycle}.pdf"
        spec = build_spec({"A": str(clean)}, pages, empty_session, saved)
        # Simulate newly created editable marks, then their replacement/removal
        # after reopen. Source marks must survive both operations.
        spec["annotations"] = ([{"kind": "note", "page": "pg1", "nx": 0.1,
                                 "ny": 0.2, "note": "Current editable note"}]
                               if cycle == 0 else [])
        if cycle == 0:
            spec["links"] = [{"page": "pg1", "rect_n": [0.1, 0.1, 0.2, 0.2],
                              "target_page": "pg2"}]
        expected_session = {**empty_session, "marks": [
            {**mark, "id": "current-note"} for mark in spec["annotations"]
        ], "links": ([{"id": "current-link", "page": "pg1", "target": "pg2",
                       "rect": [0.1, 0.1, 0.2, 0.2]}] if cycle == 0 else [])}
        spec["session"] = expected_session
        res = engine_cli({"cmd": "export", "binder": spec})
        records = annotation_records(saved)
        check(f"imported review cycle {cycle + 1}: only current marks are replaced",
              res.get("ok") and all(record in records for record in original)
              and len(records) == len(original) + (2 if cycle == 0 else 0))
        legacy_clean = OUT_DIR / f"imported-review-legacy-clean-{cycle}.pdf"
        with pikepdf.open(saved) as pdf:
            removed = legacy_strip_wpt_annotations(pdf)
            pdf.save(legacy_clean)
        check(f"imported review cycle {cycle + 1}: older engine preserves imported work",
              removed == (2 if cycle == 0 else 0)
              and annotation_records(legacy_clean) == original)
        previous = saved

    flat = OUT_DIR / "imported-review-flat.pdf"
    spec = build_spec({"A": str(plain)}, pages, empty_session, flat, flatten=True)
    res = engine_cli({"cmd": "export", "binder": spec})
    check("flattened export preserves imported review annotations",
          res.get("ok") and annotation_records(flat) == original)
    check("imported marked source is unchanged",
          hashlib.sha256(plain.read_bytes()).hexdigest() == source_digest)

    # Importing an entire editable binder as source pages is equally valid;
    # its embedded session must not grant ownership to the receiving binder.
    imported = OUT_DIR / "imported-editable-binder.pdf"
    spec = build_spec({"A": str(binder)}, pages, empty_session, imported)
    spec["annotations"] = []
    res = engine_cli({"cmd": "export", "binder": spec})
    check("importing a session-bearing PDF also preserves its original marks",
          res.get("ok") and annotation_records(imported) == annotation_records(binder))


def sample_session(pages: list[str]) -> dict:
    """A session shaped for the single-file model: marks reference the binder's
    own pages, and source paths are provenance rather than a dependency."""
    return {
        "formatVersion": 1,
        "binder_pages": [{"id": pid, "binder_index": i} for i, pid in enumerate(pages)],
        "marks": [
            {"id": "m1", "page": pages[0], "nx": 0.75, "ny": 0.25, "kind": "tick", "author": "CB"},
            {"id": "m2", "page": pages[1], "nx": 0.40, "ny": 0.60, "kind": "cross", "author": "CB"},
        ],
        "reviewer": "CB",
        "stamps": ["TB", "PY"],
        "unicode_probe": "£ € — ü 数 ✓",
    }


def build_spec(sources: dict[str, str], pages: list[dict], session: dict | None,
               output: Path, flatten: bool = False) -> dict:
    spec: dict = {
        "sources": sources,
        "pages": pages,
        "bookmarks": [],
        "annotations": [
            {"kind": "tick", "page": pages[0]["id"], "nx": 0.75, "ny": 0.25, "author": "CB"},
            {"kind": "cross", "page": pages[1]["id"], "nx": 0.40, "ny": 0.60, "author": "CB"},
        ],
        "output": str(output),
    }
    if session is not None:
        spec["session"] = session
    if flatten:
        spec["flatten"] = True
    return spec


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    fixtures = make_fixtures()
    a, b = Path(fixtures["A"]), Path(fixtures["B"])

    # Fixture B page 2 carries pre-existing annotations (a Square and a Text
    # note). Every check below that says "the client's own annotations survive"
    # depends on those being here.
    with pikepdf.open(b) as pdf:
        legacy_total = len(pdf.pages[2].obj.get(Name("/Annots")) or [])
    check("fixture B page 3 carries pre-existing annotations", legacy_total >= 2,
          f"{legacy_total} found")

    # Fixture B's pre-existing annotations live on its third page (index 2).
    pages = [
        {"id": "pg1", "source": "A", "index": 0, "rotate": 0},
        {"id": "pg2", "source": "B", "index": 2, "rotate": 0},
    ]
    session = sample_session(["pg1", "pg2"])

    # ---------------------------------------------------------------- 1. save
    binder = OUT_DIR / "binder.pdf"
    res = engine_cli({"cmd": "export", "binder": build_spec(
        {"A": str(a), "B": str(b)}, pages, session, binder)})
    check("save writes a binder", res.get("ok"), str(res.get("error", ""))[:200])
    if not res.get("ok"):
        return report()
    check("save embedded a session", res["result"].get("session_bytes", 0) > 0,
          f"{res['result'].get('session_bytes')} bytes")

    ours, theirs = count_annots(binder)
    check("saved binder carries our 2 marks", ours == 2, f"ours={ours}")
    check("saved binder kept the client's annotations", theirs >= 2, f"theirs={theirs}")

    # -------------------------------------------------------------- 2. reopen
    res = engine_cli({"cmd": "open_binder", "path": str(binder)})
    check("reopen reads the binder", res.get("ok"), str(res.get("error", ""))[:200])
    info = res.get("binder", {})
    check("reopen finds the session", info.get("found") is True, json.dumps(info)[:200])
    check("session payload is intact", info.get("payload_intact") is True)
    check("page geometry matches what was saved", info.get("geometry_matches") is True)
    check("session round-trips unchanged", info.get("session") == session)
    check("recovered from the document-level anchor", info.get("anchor") == "document",
          str(info.get("anchor")))

    # ---------------------------------------------------------- 3. clean copy
    clean = OUT_DIR / "clean.pdf"
    res = engine_cli({"cmd": "clean_copy", "path": str(binder), "output": str(clean)})
    check("clean copy is written", res.get("ok"), str(res.get("error", ""))[:200])
    ours, theirs = count_annots(clean)
    check("clean copy has none of our marks", ours == 0, f"ours={ours}")
    check("clean copy keeps the client's annotations", theirs >= 2, f"theirs={theirs}")
    names = annot_names(clean)
    check("the client's specific annotations survived by name",
          {"legacy-square-1", "legacy-note-1"} <= names, str(sorted(names))[:200])
    with pikepdf.open(clean) as pdf:
        from workpaper_engine import session_store  # noqa: PLC0415 — check-local
        still = session_store.read_session(pdf)
    check("clean copy carries no session", still.get("found") is False)

    # ------------------------------------------- 4. save again, from the binder
    # The real cycle: the app reopened a binder and the user pressed Save. The
    # app/MCP clean_copy removes the previous editable generation before
    # rebindToBinder uses it as the source. Export must preserve source marks.
    again = OUT_DIR / "binder-again.pdf"
    binder_pages = [
        {"id": "pg1", "source": "A", "index": 0, "rotate": 0},
        {"id": "pg2", "source": "A", "index": 1, "rotate": 0},
    ]
    res = engine_cli({"cmd": "export", "binder": build_spec(
        {"A": str(clean)}, binder_pages, session, again)})
    check("saving a reopened binder succeeds", res.get("ok"), str(res.get("error", ""))[:200])
    ours, theirs = count_annots(again)
    check("marks did NOT double on the second save", ours == 2, f"ours={ours} (expected 2)")
    check("the client's annotations still survived", theirs >= 2, f"theirs={theirs}")

    # A third save, because an off-by-one in the strip would show up as 2 -> 2 -> 3
    third = OUT_DIR / "binder-third.pdf"
    again_clean = OUT_DIR / "binder-again-clean.pdf"
    res = engine_cli({"cmd": "clean_copy", "path": str(again), "output": str(again_clean)})
    check("second editable reopen removes only its previous generation", res.get("ok")
          and res.get("result", {}).get("annotations_removed") == 2)
    res = engine_cli({"cmd": "export", "binder": build_spec(
        {"A": str(again_clean)}, binder_pages, session, third)})
    ours, _ = count_annots(third)
    check("marks stay put across a third save", ours == 2, f"ours={ours} (expected 2)")

    # ------------------------------------------------- 5. the distribution copy
    flat = OUT_DIR / "binder-flat.pdf"
    res = engine_cli({"cmd": "export", "binder": build_spec(
        {"A": str(clean)}, binder_pages, session, flat, flatten=True)})
    check("flattened copy is written", res.get("ok"), str(res.get("error", ""))[:200])
    check("flattened copy embeds NO session",
          res.get("result", {}).get("session_bytes") == 0,
          f"{res.get('result', {}).get('session_bytes')} bytes")
    res = engine_cli({"cmd": "open_binder", "path": str(flat)})
    check("flattened copy cannot be reopened as editable",
          res.get("binder", {}).get("found") is False)
    check("flattened copy identifies itself to the app",
          res.get("binder", {}).get("flattened") is True,
          str(res.get("binder", {}).get("reason", ""))[:160])
    with pikepdf.open(flat) as pdf:
        check("new flattened copies carry the explicit non-sensitive marker",
              bool(pdf.Root.get(Name("/WPT_Flattened"), False)))
    ours, theirs = count_annots(flat)
    check("flattened copy has our marks as ink, not annotations", ours == 0, f"ours={ours}")
    check("flattened copy still keeps the client's annotations", theirs >= 2, f"theirs={theirs}")

    # Files produced before the explicit catalog marker shipped still carry the
    # WptM appearance-resource signature. The warning has to work on those too:
    # the user's already-created distribution copy is the bug that prompted it.
    legacy_flat = OUT_DIR / "binder-flat-before-marker.pdf"
    with pikepdf.open(flat) as pdf:
        if Name("/WPT_Flattened") in pdf.Root:
            del pdf.Root[Name("/WPT_Flattened")]
        pdf.save(legacy_flat)
    res = engine_cli({"cmd": "open_binder", "path": str(legacy_flat)})
    check("an older flattened copy is recognized by its page resources",
          res.get("binder", {}).get("flattened") is True,
          str(res.get("binder", {}).get("reason", ""))[:160])

    # ------------------------------------- 6. the integrity check must fire
    # Someone opened the binder elsewhere and rotated a page. The session is
    # untouched and will read back perfectly -- and every mark on that page is
    # now in the wrong place. This is the failure the fingerprint exists for.
    moved = OUT_DIR / "binder-moved.pdf"
    with pikepdf.open(binder) as pdf:
        pdf.pages[0].obj[Name("/Rotate")] = 90
        pdf.save(moved)
    res = engine_cli({"cmd": "open_binder", "path": str(moved)})
    info = res.get("binder", {})
    check("a page moved: session still recovers", info.get("found") is True)
    check("a page moved: payload still intact", info.get("payload_intact") is True)
    check("a page moved: geometry check FIRES", info.get("geometry_matches") is False,
          "this is the whole point of the second axis")

    # ------------------------------------- 7. an ordinary PDF is not an error
    res = engine_cli({"cmd": "open_binder", "path": str(a)})
    check("opening a plain PDF is not an error", res.get("ok") is True)
    check("plain PDF reports no session, quietly",
          res.get("binder", {}).get("found") is False,
          str(res.get("binder", {}).get("reason", ""))[:120])
    check("an ordinary PDF is not mislabeled as a flattened LedgerPDF copy",
          res.get("binder", {}).get("flattened") is False)

    check_imported_review_work(binder)
    return report()


def report() -> int:
    width = max(len(name) for name, _, _ in RESULTS)
    failures = 0
    print()
    for name, ok, detail in RESULTS:
        mark = "PASS" if ok else "FAIL"
        if not ok:
            failures += 1
        print(f"  [{mark}] {name:<{width}}  {detail}")
    print(f"\n{len(RESULTS) - failures}/{len(RESULTS)} checks passed")
    if failures:
        print(f"{failures} FAILED")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
