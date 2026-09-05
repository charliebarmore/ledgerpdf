"""Independently inspect an agent-produced binder against the hidden answer key.

This checks mechanical evidence, not whether the agent selected semantically
correct figures. The manual rubric in docs/ENGAGEMENT-ACCEPTANCE.md is required.
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path

import pikepdf
import pypdfium2 as pdfium

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "engine"))
from workpaper_engine.session_store import read_session  # noqa: E402
from workpaper_engine.text import extract_text  # noqa: E402


def verify(output: Path) -> int:
    packet = ROOT / "spike/fixtures/engagement-acceptance"
    truth = json.loads((packet / "expected/answer-key.json").read_text())
    checks = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        checks.append({"name": name, "passed": bool(ok), "detail": detail})
        print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" - {detail}" if detail else ""))

    for item in truth["inputs"]:
        file = packet / "input/current-year" / item["path"]
        check(f"input unchanged: {item['path']}", hashlib.sha256(file.read_bytes()).hexdigest() == item["sha256"])
    prior = packet / "input/prior-year-master.pdf"
    check("prior-year reference unchanged", hashlib.sha256(prior.read_bytes()).hexdigest() == truth["prior_year_sha256"])
    master = output / "master.pdf"
    check("editable master exists", master.exists())
    if master.exists():
        with pikepdf.open(master) as pdf:
            record = read_session(pdf)
            session = record.get("session", {})
            page_count = len(pdf.pages)
            check("embedded session and geometry intact", record.get("found") and record.get("payload_intact") and record.get("geometry_matches"))
        with pdfium.PdfDocument(master) as doc:
            pages = []
            for page in doc:
                text = page.get_textpage()
                try:
                    pages.append(text.get_text_range())
                finally:
                    text.close()
                page.close()
        body = "\n".join(pages)
        marks = session.get("marks", [])
        narrative = body + "\n" + json.dumps(session, ensure_ascii=False)
        check("prior-year reference pages excluded", "2025 MASTER | SYNTHETIC" not in body)
        check("return included", any("Return summary" in p and "30,500.00" in p for p in pages))
        check("one receipts support copy", sum("Gross receipts support" in p and "50,000.00" in p for p in pages) == 1)
        check("corrected interest support included", any("River Bank - CORRECTED" in p and "450.00" in p for p in pages))
        check("unapproved fee versions retained", all(any(f"Fee estimate - draft {v}" in p for p in pages) for v in ["A", "B"]))
        check("wide workbook rightmost evidence retained", truth["render_check"] in body)
        for item in truth["inputs"]:
            check(f"input named in persisted handoff: {item['path']}", item["path"] in narrative)
        check("expense discrepancy recorded as an agent finding", any(
            m.get("kind") == "note" and m.get("by") == "agent" and
            "30,000.00" in m.get("note", "") and "30,500.00" in m.get("note", "") and "500.00" in m.get("note", "")
            for m in marks
        ))
        check("agent did not claim human sign-off", all(
            status.get("agent") or status.get("status") not in ["reviewed", "na"]
            for status in session.get("statuses", {}).values()
        ))
        ids = {p["id"] for p in session.get("pages", [])}
        check("marks and links reference surviving pages", all(m.get("page") in ids for m in marks) and all(
            link.get("page") in ids and link.get("target") in ids for link in session.get("links", [])
        ))
        positions = {page['id']: i for i, page in enumerate(session.get('pages', []))}
        tied = [m for m in marks if m.get('refTarget')]
        extracted = extract_text({'path': str(master), 'pages': sorted({positions[m['page']] for m in tied}), 'words': True})
        words = {page['index']: page.get('words', []) for page in extracted['pages']}
        placed = []
        for mark in tied:
            note = mark.get('note', '').lower()
            own_amount = re.search(r'this page shows ([\d,]+\.\d{2})', note)
            amount = own_amount.group(1) if own_amount else '125,000.00' if 'receipt' in note else '450.00' if 'interest' in note else None
            candidates = [w for w in words.get(positions[mark['page']], []) if amount and w['t'] == amount]
            beside = any(abs(mark['ny'] - w['ny']) < 0.018 and w['box'][0] <= mark['nx'] <= w['box'][2] + 0.06 for w in candidates)
            placed.append(beside)
        check('tie marks sit beside their actual source amounts', len(tied) >= 6 and all(placed), f'{sum(placed)}/{len(tied)} positions match source figures')
        check("structured handoff survives save", isinstance(session.get("handoff"), dict))
        print(f"Inspected {page_count} pages, {len(marks)} marks, {len(session.get('tapes', []))} tapes.")
    result = {"checks": checks, "passed": sum(c["passed"] for c in checks), "total": len(checks),
              "manual_review_required": True}
    (output / "verification.json").write_text(json.dumps(result, indent=2) + "\n")
    return 0 if result["passed"] == result["total"] else 1


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: engine/.venv/bin/python spike/verify_engagement.py RUN_DIRECTORY")
    raise SystemExit(verify(Path(sys.argv[1]).resolve()))
