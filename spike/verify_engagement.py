"""Independently inspect an agent-produced binder against the hidden answer key.

This checks mechanical evidence, not whether the agent selected semantically
correct figures. The manual rubric in docs/ENGAGEMENT-ACCEPTANCE.md is required.
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
import unicodedata
from decimal import Decimal, InvalidOperation
from pathlib import Path

import pikepdf
import pypdfium2 as pdfium

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "engine"))
from workpaper_engine.session_store import read_session  # noqa: E402
from workpaper_engine.text import extract_text  # noqa: E402


def amount(value: str) -> Decimal | None:
    try:
        return Decimal(value.strip().replace(',', '').replace('$', ''))
    except InvalidOperation:
        return None


def verify_handoff(session: dict, truth: dict, check, bookmarks=(), page_text=None) -> None:
    """Validate saved records against the fixture, independently of agent prose."""
    h = session.get('handoff')
    check('structured handoff survives save', isinstance(h, dict))
    if not isinstance(h, dict):
        return
    inputs = h.get('inputs', [])
    manifest = {Path(item['path']).name: item for item in inputs}
    expected = {item['path']: item['sha256'] for item in truth['inputs']}
    allowed = set(expected) | {'prior-year-master.pdf'}
    check('manifest accounts for every input exactly once', len(inputs) == len(manifest) and set(expected) <= set(manifest) <= allowed)
    check('all manifest hashes match the independent source hashes', all(manifest.get(name, {}).get('sha256') == sha for name, sha in expected.items()))
    if 'prior-year-master.pdf' in manifest:
        reference = manifest['prior-year-master.pdf']
        check('optional prior-year disposition is a hashed excluded reference', reference.get('disposition') == 'excluded' and not reference.get('pageIds') and reference.get('sha256') == truth['prior_year_sha256'])
    pages = {p['id']: p for p in session.get('pages', [])}
    sources = {s['id']: s for s in session.get('sources', [])}
    names = {pid: sources[p['source']]['name'] for pid, p in pages.items()}
    for name, disposition in truth['excluded'].items():
        if disposition == 'superseded':
            item = manifest.get(name, {})
            positions = {i for i, p in enumerate(session.get('pages', [])) if names[p['id']] == name}
            marked = all(any(position == i and 'superseded' in title.lower() for title, position in bookmarks) for i in positions)
            excluded = item.get('disposition') == 'excluded' and not positions
            retained = item.get('disposition') == 'included' and bool(positions) and marked and 'supersed' in item.get('reason', '').lower()
            check(f'{name} is excluded or visibly identified as superseded', excluded or retained)
            check(f'{name} is not used as current-year check evidence', all(e.get('sourceName') != name for c in h.get('checks', []) for e in c.get('evidence', [])))
        else:
            check(f'{name} has the expected disposition', manifest.get(name, {}).get('disposition') == disposition)
            check(f'{name} has no included pages', name not in names.values())
    check('manifest page coverage matches the saved binder', all(
        set(item.get('pageIds', [])) == {pid for pid, name in names.items() if name == Path(item['path']).name}
        for item in inputs
    ))
    for name in truth['required_included']:
        check(f'required input included: {name}', bool(manifest.get(name, {}).get('pageIds')))
    duplicate = [manifest.get(name, {}) for name in truth['duplicate_group']]
    check('duplicate group has one included and one excluded disposition',
          sum(bool(item.get('pageIds')) for item in duplicate) == 1 and sum(item.get('disposition') == 'excluded' for item in duplicate) == 1)
    check('compilation record is attributed to the agent without human resolutions', h.get('by') == 'agent' and bool(h.get('run')) and not h.get('resolutions'))
    evidence = [e for c in h.get('checks', []) for e in c.get('evidence', [])]
    check('check evidence references the original source and surviving page', bool(evidence) and all(
        e.get('pageId') in pages and e.get('sourceName') == names[e['pageId']] and
        e.get('sourcePage') == pages[e['pageId']]['index'] + 1 and
        e.get('sourceSha256') == expected.get(e.get('sourceName'))
        for e in evidence
    ))
    checks = h.get('checks', [])
    # Outcomes need the right source pair. Semantic figure/period selection is
    # checked visually; matching a label or a number in free prose is not proof.
    pairs = [
        ('gross receipts', 'agrees', {'z-return-summary.pdf', 'client-sales.pdf'}),
        ('interest', 'agrees', {'z-return-summary.pdf', 'bank-corrected.pdf'}),
        ('expense tie', 'discrepancy', {'z-return-summary.pdf', 'workpapers.xlsx'})
    ]
    for label, outcome, required in pairs:
        check(f'{label} outcome has evidence from both required sources', any(
            c.get('outcome') == outcome and required <= {e.get('sourceName', '').replace('client-sales-copy.pdf', 'client-sales.pdf') for e in c.get('evidence', [])}
            for c in checks
        ))
    check('expense footing records worksheet and cell evidence', any(
        c.get('outcome') == 'agrees' and any(e.get('sourceName') == 'workpapers.xlsx' and e.get('sheet') == 'Expenses' and e.get('cells') for e in c.get('evidence', []))
        for c in checks
    ))
    check('missing lease is an unresolved finding without a page', any(
        'lease' in (f.get('label', '') + ' ' + f.get('detail', '')).lower() and not f.get('pageIds')
        for f in h.get('findings', [])
    ))
    check('retired debt requirement does not create an open finding', not any(
        re.search(r'\b(debt|maple)\b', f.get('label', ''), re.I) for f in h.get('findings', [])
    ))
    receipt = manifest.get('receipt-photo.png', {})
    receipt_pages = set(receipt.get('pageIds', []))
    receipt_linked = receipt.get('disposition') == 'needs-decision' or any(
        receipt_pages & set(f.get('pageIds', [])) for f in h.get('findings', [])
    ) or any(c.get('outcome') == 'unchecked' and receipt_pages & {e.get('pageId') for e in c.get('evidence', [])} for c in checks)
    check('unreadable receipt has an actionable handoff item linked to its page', bool(receipt_pages) and receipt_linked)
    check('filing decisions use the persisted v2 handoff', h.get('version') == 2)
    retained = [item for item in inputs if item.get('pageIds')]
    readable = [item for item in retained if Path(item['path']).name != 'receipt-photo.png']
    check('readable inputs retain supported filing decisions', bool(readable) and all(
        item.get('filing', {}).get('status') == 'supported' and item['filing'].get('reason') and item['filing'].get('evidence')
        for item in readable
    ))
    normalized = lambda text: ' '.join(unicodedata.normalize('NFKC', text).lower().split())
    filing_evidence = [(item, e) for item in retained for e in item.get('filing', {}).get('evidence', [])]
    check('filing quotes match extracted text on their own source pages and independent hashes', bool(filing_evidence) and all(
        e.get('pageId') in item['pageIds'] and e.get('sourceName') == Path(item['path']).name and
        e.get('sourceSha256') == expected.get(e.get('sourceName')) and
        e.get('sourcePage') == pages[e['pageId']]['index'] + 1 and e.get('method') == 'text' and
        len(normalized(e.get('quote', ''))) >= 12 and normalized(e.get('quote', '')) in normalized((page_text or {}).get(e.get('pageId'), ''))
        for item, e in filing_evidence
    ))
    check('unreadable receipt classification remains explicitly Needs filing',
          receipt.get('filing', {}).get('status') == 'needs-decision' and receipt['filing'].get('section') == 'Needs filing')


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
            foot_notes = {m.get('note') for m in session.get('marks', []) if m.get('text') == 'F'}
            visible_footing = []
            for page in pdf.pages:
                annotations = page.get('/Annots', [])
                tapes = [list(a['/Rect']) for a in annotations if str(a.get('/Contents', '')).startswith('Calculator tape:')]
                for a in annotations:
                    if str(a.get('/Contents', '')) not in foot_notes:
                        continue
                    rect = list(a['/Rect'])
                    visible_footing.append(not any(rect[0] < t[2] and rect[2] > t[0] and rect[1] < t[3] and rect[3] > t[1] for t in tapes))
            check('footing stamp is present and not covered by its tape', bool(visible_footing) and all(visible_footing))
            with pdf.open_outline() as outline:
                titles = [item.title for item in outline.root]
                page_objects = {page.obj.objgen: i for i, page in enumerate(pdf.pages)}
                def bookmark_items(items):
                    for item in items:
                        yield item
                        yield from bookmark_items(item.children)
                bookmarks = [(item.title, page_objects.get(item.destination[0].objgen)) for item in bookmark_items(outline.root) if isinstance(item.destination, pikepdf.Array)]
                section_roots = [(item.title, page_objects.get(item.destination[0].objgen), bool(item.children)) for item in outline.root if isinstance(item.destination, pikepdf.Array)]
            sections = truth['required_sections_in_order']
            def section_heading(title, section):
                return bool(re.search(r'^(?:\d+[ .:-]*)?' + re.escape(section) + r'\b', title, re.I))
            section_positions = [next((i for i, title in enumerate(titles) if section_heading(title, section)), -1) for section in sections]
            check('prior-year sections appear in the saved bookmark order', all(i >= 0 for i in section_positions) and section_positions == sorted(section_positions), ' | '.join(titles))
            check('section headings contain document bookmarks', all(
                any(section_heading(title, section) and children for title, _, children in section_roots)
                for section in sections
            ))
            # This fixture's semantic filing expectations are independent of
            # filenames chosen by the agent for its section headings. An image
            # whose purpose could not be read may remain explicitly unfiled.
            expected_section = {
                'notes-from-preparer.md': r'Administration',
                'fee-estimate-a.pdf': r'Administration', 'fee-estimate-b.pdf': r'Administration',
                'z-return-summary.pdf': r'Return',
                'client-sales.pdf': r'Income', 'client-sales-copy.pdf': r'Income',
                'bank-corrected.pdf': r'Income', 'workpapers.xlsx': r'Expenses',
                'receipt-photo.png': r'Expenses|Needs filing'
            }
            source_names_by_id = {s['id']: s['name'] for s in session.get('sources', [])}
            filing = []
            for i, page in enumerate(session.get('pages', [])):
                name = source_names_by_id.get(page['source'])
                if name not in expected_section:
                    continue
                preceding = [(title, position) for title, position, _ in section_roots if position is not None and position <= i and
                             any(section_heading(title, section) for section in sections + ['Needs filing'])]
                owner = max(preceding, key=lambda entry: entry[1])[0] if preceding else ''
                filing.append(bool(re.search(r'\b(?:' + expected_section[name] + r')\b', owner, re.I)))
            check('documents are filed in their business section or explicitly await filing', bool(filing) and all(filing), f'{sum(filing)}/{len(filing)} source pages correctly filed')
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
        sources = {s['id']: s for s in session.get('sources', [])}
        source_names = {p['id']: sources[p['source']]['name'].replace('client-sales-copy.pdf', 'client-sales.pdf') for p in session.get('pages', [])}
        tied = [m for m in marks if m.get('refTarget')]
        # Quotes are readings of positioned text. Raw PDF character-stream order
        # can interleave a title's short hyphen differently from its other words.
        # Re-extract the saved artifact's positioned lines, without trusting the
        # agent transcript, rather than treating character order as reading order.
        extracted = extract_text({'path': str(master), 'pages': list(range(len(session['pages']))), 'words': True})
        words = {page['index']: page.get('words', []) for page in extracted['pages']}
        placed = []
        unobscured = []
        mark_boxes = []
        for mark in tied:
            own_source = source_names.get(mark['page'])
            pair = {own_source, source_names.get(mark['refTarget'])}
            expected_amount = (Decimal(125000) if pair == {'z-return-summary.pdf', 'client-sales.pdf'} else
                               Decimal(450) if pair == {'z-return-summary.pdf', 'bank-corrected.pdf'} else
                               Decimal(30500 if own_source == 'z-return-summary.pdf' else 30000) if pair == {'z-return-summary.pdf', 'workpapers.xlsx'} else None)
            candidates = [w for w in words.get(positions.get(mark['page']), []) if expected_amount is not None and amount(w['t']) == expected_amount]
            beside = any(abs(mark['ny'] - w['ny']) < 0.018 and w['box'][0] <= mark['nx'] <= w['box'][2] + 0.06 for w in candidates)
            placed.append(beside)
            physical = session['pages'][positions[mark['page']]]
            width, height = physical.get('w', 612), physical.get('h', 792)
            if physical.get('rotate', 0) % 180: width, height = height, width
            hx, hy = mark.get('size', 24) / (2 * width), mark.get('size', 24) / (2 * height)
            rect = [mark['nx'] - hx, mark['ny'] - hy, mark['nx'] + hx, mark['ny'] + hy]
            mark_boxes.append((mark['page'], rect))
            overlaps = any(w['box'][0] < rect[2] and w['box'][2] > rect[0] and w['box'][1] < rect[3] and w['box'][3] > rect[1] for w in words.get(positions[mark['page']], []))
            unobscured.append(not overlaps and min(rect) >= 0 and max(rect) <= 1)
        check('tie marks sit beside their actual source amounts', len(tied) >= 6 and all(placed), f'{sum(placed)}/{len(tied)} positions match source figures')
        check('whole tie marks stay clear of source text and page edges', len(tied) >= 6 and all(unobscured), f'{sum(unobscured)}/{len(tied)} mark footprints clear')
        check('tie marks do not overlap each other on neighboring rows', not any(
            pa == pb and a[0] < b[2] and a[2] > b[0] and a[1] < b[3] and a[3] > b[1]
            for i, (pa, a) in enumerate(mark_boxes) for pb, b in mark_boxes[i + 1:]
        ))
        verify_handoff(session, truth, check, bookmarks, {session['pages'][p['index']]['id']: p['text'] for p in extracted['pages']})
        print(f"Inspected {page_count} pages, {len(marks)} marks, {len(session.get('tapes', []))} tapes.")
    result = {"verifier_version": 4, "checks": checks, "passed": sum(c["passed"] for c in checks), "total": len(checks),
              "manual_review_required": True}
    (output / "verification.json").write_text(json.dumps(result, indent=2) + "\n")
    return 0 if result["passed"] == result["total"] else 1


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: engine/.venv/bin/python spike/verify_engagement.py RUN_DIRECTORY")
    raise SystemExit(verify(Path(sys.argv[1]).resolve()))
