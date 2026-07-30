"""Generate synthetic tax-style fixture PDFs for the Phase 0 spike.

NO client data — everything here is fabricated. Fixture design is deliberate:

fixture_a.pdf ("TaxForm-A") — 3 portrait pages, Rotate 0.
  Page sizes 612x792 / 613x792 / 614x792: unique MediaBox widths give every
  page a provenance signature we can assert after merge/reorder.

fixture_b.pdf ("SupportSchedules-B") — 3 pages, the hostile cases:
  B0: MediaBox 700x900 with CropBox [44,50,656,842]  -> CropBox != MediaBox
      (the coordinate-normalization trap named in the review).
  B1: 612x792 with /Rotate 90                        -> rotated-scan case.
  B2: 612x1008 (legal) carrying EXISTING annotations (Square + Text note)
      -> must survive merge/reorder (review pushback #2).
  Document outline: "Schedule X" -> B0 (child "Detail X-1" -> B1),
      "Schedule Y" -> B1 — imported-outline nesting/retargeting test.
"""

from __future__ import annotations

from pathlib import Path

import pikepdf
from pikepdf import Array, Dictionary, Name, String

FIXTURES = Path(__file__).parent / "fixtures"


def _esc(text: str) -> str:
    return text.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")


def _text_content(lines: list[tuple[float, float, float, str]]) -> bytes:
    """lines: (x, y, size, text) drawn in Helvetica."""
    parts = ["q 0.1 0.1 0.12 rg"]
    for x, y, size, text in lines:
        parts.append(f"BT /F1 {size:g} Tf {x:g} {y:g} Td ({_esc(text)}) Tj ET")
    parts.append("Q")
    return " ".join(parts).encode("ascii")


def _font_resources() -> Dictionary:
    return Dictionary(
        Font=Dictionary(
            F1=Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica)
        )
    )


def _add_page(
    pdf: pikepdf.Pdf,
    w: float,
    h: float,
    label: str,
    body: list[tuple[float, float, float, str]],
    rotate: int = 0,
    cropbox: list[float] | None = None,
) -> pikepdf.Page:
    page = pdf.add_blank_page(page_size=(w, h))
    lines = [(36.0, h - 60.0, 22.0, label)] + body
    page.obj.Contents = pdf.make_stream(_text_content(lines))
    page.obj.Resources = _font_resources()
    if rotate:
        page.obj.Rotate = rotate
    if cropbox:
        page.obj.CropBox = Array(cropbox)
    return page


def _tax_lines(x: float, y0: float, rows: list[tuple[str, str]]) -> list:
    out = []
    y = y0
    for label, amount in rows:
        out.append((x, y, 10.0, label))
        out.append((x + 340, y, 10.0, amount))
        y -= 16
    return out


def make_fixture_a(path: Path) -> None:
    with pikepdf.new() as pdf:
        _add_page(
            pdf, 612, 792, "TaxForm-A  p.A-1",
            _tax_lines(72, 690, [
                ("1  Wages, salaries, tips", "84,200.00"),
                ("2b Taxable interest", "1,150.00"),
                ("8  Other income (Sch 1)", "3,400.00"),
                ("11 Adjusted gross income", "88,750.00"),
            ]),
        )
        _add_page(
            pdf, 613, 792, "TaxForm-A  p.A-2",
            _tax_lines(72, 690, [
                ("12 Standard deduction", "14,600.00"),
                ("15 Taxable income", "74,150.00"),
                ("16 Tax", "11,807.00"),
            ]),
        )
        _add_page(
            pdf, 614, 792, "TaxForm-A  p.A-3",
            _tax_lines(72, 690, [
                ("25 Federal withholding", "12,400.00"),
                ("33 Total payments", "12,400.00"),
                ("34 Overpayment", "593.00"),
            ]),
        )
        pdf.save(path)


def make_fixture_b(path: Path) -> None:
    with pikepdf.new() as pdf:
        # B0 — CropBox != MediaBox. Content only in the TOP third of the crop
        # area so the spike's tape-region pixel check (lower area) stays clean.
        _add_page(
            pdf, 700, 900, "SupportSchedules-B  p.B-1",
            _tax_lines(80, 780, [
                ("Interest - First Natl", "612.00"),
                ("Interest - Credit Union", "538.00"),
                ("Total interest", "1,150.00"),
            ]),
            cropbox=[44, 50, 656, 842],
        )
        # B1 — rotated scan.
        _add_page(
            pdf, 612, 792, "SupportSchedules-B  p.B-2 (rotated scan)",
            _tax_lines(72, 640, [
                ("1099-MISC box 3", "3,400.00"),
                ("Agrees to Form line 8", ""),
            ]),
            rotate=90,
        )
        # B2 — carries pre-existing annotations.
        page3 = _add_page(
            pdf, 612, 1008, "SupportSchedules-B  p.B-3 (prior-year marked)",
            _tax_lines(72, 900, [
                ("Carryforward schedule", ""),
                ("Prior-year overpayment applied", "0.00"),
            ]),
        )
        square = pdf.make_indirect(Dictionary(
            Type=Name.Annot, Subtype=Name.Square,
            Rect=Array([100, 850, 220, 910]),
            C=Array([1, 0, 0]), F=4,
            NM=String("legacy-square-1"),
            Contents=String("Prior-year highlight"),
        ))
        note = pdf.make_indirect(Dictionary(
            Type=Name.Annot, Subtype=Name.Text,
            Rect=Array([240, 880, 262, 902]),
            Name=Name.Comment, F=4,
            NM=String("legacy-note-1"),
            Contents=String("Reviewed last year - agreed to bank stmt"),
        ))
        page3.obj.Annots = pdf.make_indirect(Array([square, note]))

        # B's own outline (imported-outline nesting test).
        from pikepdf import OutlineItem

        def fit(i: int) -> Array:
            return Array([pdf.pages[i].obj, Name.Fit])

        with pdf.open_outline() as outline:
            sched_x = OutlineItem("Schedule X", fit(0))
            sched_x.children.append(OutlineItem("Detail X-1", fit(1)))
            sched_y = OutlineItem("Schedule Y", fit(1))
            outline.root.append(sched_x)
            outline.root.append(sched_y)
        pdf.save(path)


def make_image_fixtures(landscape: Path, rotated: Path, png: Path) -> None:
    """Image sources — the receipt-photo and screenshot cases.

    Each carries a red block in its TOP-LEFT corner, which is what makes
    orientation assertable after export: if EXIF handling or the page /Rotate is
    wrong, the block lands on the wrong side of the sheet.

      receipt.jpg      400x300 landscape, no EXIF   -> landscape Letter page
      receipt_rot.jpg  same pixels, EXIF orient 6   -> portrait page via /Rotate,
                                                       embedded losslessly
      screenshot.png   200x500 portrait, has alpha  -> portrait page, re-encoded
                                                       (PNG isn't DCT) and
                                                       flattened onto white
    """
    from PIL import Image

    photo = Image.new("RGB", (400, 300), (255, 255, 255))
    for x in range(120):
        for y in range(80):
            photo.putpixel((x, y), (220, 30, 30))
    photo.save(landscape, quality=92)

    exif = photo.getexif()
    exif[274] = 6  # rotate 90 CW on display — a phone held portrait
    photo.save(rotated, quality=92, exif=exif)

    shot = Image.new("RGBA", (200, 500), (0, 0, 255, 255))
    for x in range(60):
        for y in range(60):
            shot.putpixel((x, y), (220, 30, 30, 255))
    shot.save(png)


def main() -> dict[str, str]:
    FIXTURES.mkdir(parents=True, exist_ok=True)
    a = FIXTURES / "fixture_a.pdf"
    b = FIXTURES / "fixture_b.pdf"
    make_fixture_a(a)
    make_fixture_b(b)
    img = FIXTURES / "receipt.jpg"
    img_rot = FIXTURES / "receipt_rot.jpg"
    shot = FIXTURES / "screenshot.png"
    make_image_fixtures(img, img_rot, shot)
    return {"A": str(a), "B": str(b), "IMG": str(img), "IMG_ROT": str(img_rot), "PNG": str(shot)}


if __name__ == "__main__":
    print(main())
