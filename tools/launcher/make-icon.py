"""Render app/resources/icon.png — the source of both the Dock icon and the
launcher's .icns. Brand teal from DESIGN.md, stacked sheets, a review tick.

    engine/.venv/bin/python tools/launcher/make-icon.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "app" / "resources" / "icon.png"
S = 1024


def main() -> None:
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # macOS icons sit inset in the canvas with a generous corner radius.
    m, r = 92, 200
    d.rounded_rectangle([m, m, S - m, S - m], radius=r, fill=(1, 105, 111, 255))

    def sheet(x, y, w, h, fill):
        d.rounded_rectangle([x, y, x + w, y + h], radius=18, fill=fill)

    sheet(300, 250, 380, 500, (255, 255, 255, 90))
    sheet(270, 285, 380, 500, (255, 255, 255, 160))
    sheet(240, 320, 400, 420, (255, 255, 255, 255))
    for i in range(4):
        y = 390 + i * 55
        d.rounded_rectangle(
            [292, y, 292 + (250 if i % 2 == 0 else 190), y + 16],
            radius=8,
            fill=(190, 195, 195, 255),
        )
    # The tick is the workpaper-green from appearance.MARK_COLORS.
    d.line([(430, 640), (500, 706), (640, 520)], fill=(33, 140, 33, 255), width=54, joint="curve")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    img.save(OUT)
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
