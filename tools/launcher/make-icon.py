"""Render app/resources/icon.png — the single source for the Dock icon, the
packaged macOS/Windows icons (electron-builder points at this file), and the
launcher's .icns.

    engine/.venv/bin/python tools/launcher/make-icon.py

DESIGN. Three elements, and each earns its place at 32px, which is where a Dock
icon actually lives:

  - **The sheet** says workpaper.
  - **The green review tick** is the domain symbol — a preparer reads it
    instantly, and it is appearance.TICK_COLOR exactly — content, never rebranded.
    Dropping it would cost more recognition than any restyling could win back.
  - **The sparkle cluster** says an agent did it. It sits clear of the sheet in
    the corner rather than on top of it: overlapping versions merged into one
    blob at 32px, and a robot glyph would date badly and say "chatbot" rather
    than "this thing works on your binder".

Anything more — a third sparkle, text lines inside the page, a sparkle in the
document body — tested worse small. The page keeps three lines, not four, for
the same reason.
"""

from pathlib import Path

from PIL import Image, ImageDraw

REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "app" / "resources" / "icon.png"
S = 1024

# Ledger Labs brand kit — _studio/Ledger Labs Brand Kit/tokens/palette.json.
# The surface and the spark are CHROME and follow the brand.
TEAL = (29, 67, 78, 255)           # Deep Teal #1D434E — "Primary surface"
ORANGE = (232, 145, 58, 255)       # Signal Orange #E8913A — "Primary mark / accent"
PAPER = (253, 252, 234, 255)       # Paper Cream #FDFCEA
RULE = (190, 195, 195, 255)
# The tick is CONTENT and does NOT follow the brand. It is appearance.TICK_COLOR
# exactly — the green a preparer sees on the page and in the exported PDF. Ledger
# Green (#2D9148) was the obvious brand substitute and is deliberately not used:
# DESIGN.md holds annotation colours identical on screen and in the PDF, and the
# icon earns its recognition by showing the same green the marks do.
GREEN = (33, 140, 33, 255)         # == appearance.TICK_COLOR (0.13, 0.55, 0.13)


def sparkle(d: ImageDraw.ImageDraw, cx: float, cy: float, r: float, fill) -> None:
    """A four-point star with a pinched waist — the motif that currently reads
    as "AI" without borrowing a robot."""
    w = r * 0.30
    d.polygon(
        [
            (cx, cy - r), (cx + w, cy - w), (cx + r, cy), (cx + w, cy + w),
            (cx, cy + r), (cx - w, cy + w), (cx - r, cy), (cx - w, cy - w),
        ],
        fill=fill,
    )


def main() -> None:
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # macOS icons sit inset in the canvas with a generous corner radius.
    m, r = 92, 200
    d.rounded_rectangle([m, m, S - m, S - m], radius=r, fill=TEAL)

    # A second sheet behind, just enough to read as a binder rather than a page.
    d.rounded_rectangle([255, 250, 645, 770], radius=22, fill=(255, 255, 255, 150))
    d.rounded_rectangle([225, 290, 615, 760], radius=22, fill=PAPER)

    for i in range(3):
        y = 372 + i * 64
        d.rounded_rectangle([282, y, 282 + (250 if i % 2 == 0 else 180), y + 18], radius=9, fill=RULE)

    # Heavier than a UI tick: at 32px a thin stroke greys out into the page.
    d.line([(300, 620), (390, 706), (560, 500)], fill=GREEN, width=62, joint="curve")

    # Kept off the sheet and in from the corner — both were crowding at 32px.
    sparkle(d, 706, 372, 146, ORANGE)
    sparkle(d, 828, 536, 72, ORANGE)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    img.save(OUT)
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
