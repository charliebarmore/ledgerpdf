"""Render the app icons from the LedgerPDF brand kit.

    npm run build:icon            (from app/, works on macOS and Windows)

Writes app/resources/icon.png (macOS) and app/resources/icon-win.png (Windows).
electron-builder points at those and bakes them into icon.icns / icon.ico.
`npm run build:icon` runs this on every package, so this file IS the icon and
the PNGs are artifacts — the reason being that a committed PNG only changes when
somebody remembers to regenerate it, and a packaged build then carries a stale
one silently.

SOURCE OF TRUTH (2026-08-08). The geometry below is a direct port of the brand
kit's own icon artwork:

    the brand kit's icons/ directory (a design asset, not in this repo):
        ledgerpdf-icon-macos.svg     -> icon.png
        ledgerpdf-icon-windows.svg   -> icon-win.png

Every number here — the corner radii, the 4 / 2.5 / 2 stroke weights, the 0.35
feint opacity, the tab rectangles — is copied from those files rather than
re-derived by eye. If the kit's artwork changes, re-port it. Brand Guidelines §01
forbids re-proportioning the mark and re-ordering or recolouring the tabs, and
this script is exactly where those rules would quietly get broken.

ONE DELIBERATE DEVIATION: the mark is drawn larger than the kit's SVGs place it,
and centred rather than positioned by their hardcoded translate. See MARK_SCALE
below for the reasoning and for why it still satisfies §01's clearspace rule.

WHY TWO FILES. The kit ships two different icons on purpose: a Vellum tile with
ink artwork for macOS, a Deep Teal tile with cream artwork for Windows. That is
not a light/dark pair — it is one icon per platform, and electron-builder takes
a separate `icon` per target, so they are built and wired separately.

MARGINS, and this REVERSES an earlier decision in this file. It previously read
"FULL BLEED, still. macOS 26 composites icons into a system container: an icon
that insets itself gets inset twice and shows a pale frame." That premise is true
of the NEW icon format — a .icon bundle authored in Icon Composer, which the
system masks and shades itself. It is not true of what electron-builder actually
produces here: a LEGACY .icns built from icon.png, which macOS draws exactly as
supplied, container and all.

The evidence was a Dock screenshot on macOS 26.5.2, in which this icon was
visibly larger than Word and Arc beside it. Those carry the traditional margin in
their artwork; ours filled its canvas, so it drew to the full tile.

So icon.png now reserves Apple's grid: an 824x824 body inside 1024x1024, 100px
transparent on every side. The brand radius lands on that grid unaided — 232 at
1024 becomes 186.7 at 824, against Apple's 185.4. The kit's inset ink outline is
still decoration drawn inside the tile, not padding, and still stays.

IF this ever ships a real .icon bundle, take the margin back out: the earlier
note becomes correct at that moment, and the icon would be inset twice.

Windows is unaffected. Its icons are full-bleed by convention, which is why
icon-win.png keeps pad=0 — the two files existed already; only the margin was
missing.

SUPERSAMPLED. PIL's ImageDraw does no anti-aliasing, which the previous icon got
away with because it was nearly all axis-aligned. This one has a rounded tile,
two ring holes and hairline rules, so it is drawn at 4x and downsampled with
LANCZOS. Still deterministic — same bytes every run — so it stays safe in a
build step and will not churn git on every package.

WHAT THIS REPLACES. The ledger-paper tile of 2026-08-07: feint rows, an orange
margin rule, the product's own green review tick, a sparkle for the agent. It
was designed before a brand existed, and argued that the tick was CONTENT and
had to stay appearance.TICK_COLOR rather than take Ledger Green. That argument
was right and is now moot: the brand's mark is the bound binder itself, which
says the same thing without borrowing the mark a preparer makes on the page.
The rendered comparisons live in the session record of 2026-08-07.
"""

from pathlib import Path

from PIL import Image, ImageDraw

REPO = Path(__file__).resolve().parents[2]
RES = REPO / "app" / "resources"

# Brand kit v2.0 — colors/ledgerpdf-colors.css.
VELLUM = (245, 236, 214, 255)        # #F5ECD6
PAPER_CREAM = (253, 252, 234, 255)   # #FDFCEA
INK = (11, 26, 31, 255)              # #0B1A1F
DEEP_TEAL = (29, 67, 78, 255)        # #1D434E
SIGNAL_ORANGE = (232, 145, 58, 255)  # #E8913A
AMBER_GOLD = (230, 165, 50, 255)     # #E6A532
LEDGER_GREEN = (45, 145, 72, 255)    # #2D9148

SS = 4        # supersample factor; see SUPERSAMPLED above
FEINT = 0.35  # the kit's opacity on the three page rules

# The one number here that is NOT the kit's. Its icon SVGs place the mark at
# scale 8.75 (macOS) and 9.38 (Windows), which put the binder at 44% and 48% of
# the tile. On a Dock or a taskbar that reads as a small drawing marooned in a
# large empty tile, and it is the artwork that has to survive being 32px, not the
# tile. 11.5 puts it at 58% of the width.
#
# This is a deviation from the kit, made deliberately, and it stays inside the
# rules the kit sets. Guide §01 forbids re-proportioning the mark, which means
# distorting it; scaling it uniformly is not that, and nothing here changes the
# geometry, the tab order, or the colours. The §01 clearspace minimum is one tab
# height on every side, 8 units: at this scale the margin is about 18 units, more
# than twice what is required. 12.5 was rendered too and rejected — the tabs
# start crowding the inset ink outline.
MARK_SCALE = 11.5


def draw_mark(opaque, overlay, tx, ty, scale, stroke):
    """The mark in its own 64x64 space — a port of ledgerpdf-mark.svg.

    The feint rules go on a transparent overlay so their 0.35 alpha actually
    blends. ImageDraw writes pixels rather than compositing them, so drawing
    them straight onto the tile would paint flat grey and lose the wash.
    """

    def X(v):
        return tx + v * scale

    def Y(v):
        return ty + v * scale

    def w(v):
        return max(1, round(v * scale))

    # The page: a ruled frame with a spine and two ring holes.
    #
    # The box is grown by half the stroke on every side because SVG and PIL
    # disagree about where a stroke goes: SVG centres it on the path, PIL draws
    # it entirely INSIDE the box it is given. Ported literally, the frame came
    # out 4 units narrow and its right edge landed at 46 instead of 48 — flush
    # with the tabs, which start at 46, so the tabs fused into the frame and the
    # right edge read as one heavy bar. Grown, the path spans 6..52 either way.
    opaque.rectangle([X(8 - 2), Y(9 - 2), X(50 + 2), Y(56 + 2)], outline=stroke, width=w(4))
    opaque.line([(X(18), Y(9)), (X(18), Y(56))], fill=stroke, width=w(2.5))
    for cy in (18, 47):
        r = 1.8 * scale
        opaque.ellipse([X(18) - r, Y(cy) - r, X(18) + r, Y(cy) + r], fill=stroke)

    # Three lines of writing, at the kit's feint opacity.
    feint = (*stroke[:3], round(255 * FEINT))
    for y in (24, 31, 38):
        overlay.line([(X(24), Y(y)), (X(45), Y(y))], fill=feint, width=w(2))

    # The three index tabs breaking the right edge. Order and colour are fixed
    # by Brand Guidelines §01 — Signal Orange, Amber Gold, Ledger Green.
    for y, colour in ((14, SIGNAL_ORANGE), (28, AMBER_GOLD), (42, LEDGER_GREEN)):
        opaque.rectangle([X(46), Y(y), X(58), Y(y + 8)], fill=colour)


# The mark's own extents in its 64x64 space, stroke included: the frame path
# spans 6..52 once its 4-wide centred stroke is counted, the tabs reach 58, and
# vertically it runs 7..58. Everything below positions the mark from these, so
# changing SCALE re-centres it instead of drifting off-centre.
MARK_X0, MARK_X1 = 6.0, 58.0
MARK_Y0, MARK_Y1 = 7.0, 58.0


def render(size, radius, tile, stroke, outline, scale, pad=0):
    """`pad` is transparent margin, in final pixels, on every side.

    macOS reserves it. Apple's Big Sur icon grid puts the rounded-rect body at
    824x824 inside a 1024x1024 canvas — about 80% — and the system draws every
    app icon to the same tile, so an icon that fills its canvas renders LARGER
    than its neighbours in the Dock. Ours did exactly that, and visual review
    spotted it beside Word and Arc.

    Windows has no such convention: its icons are full-bleed, which is why
    icon-win.png keeps pad=0. The two files existed already; only the margin was
    missing.

    Applied by scaling the finished artwork rather than by insetting every
    coordinate, so proportions are untouched. The brand radius lands on Apple's
    grid on its own: 232 at 1024 becomes 186.7 at 824, against Apple's 185.4.
    """
    s = size * SS
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    wash = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # Centre the mark on the tile rather than trusting a hardcoded translate.
    # The kit's SVGs carry a translate that suits their own scale and nothing
    # else, so raising the scale with it fixed pushes the mark down and right.
    tx = size / 2 - (MARK_X0 + MARK_X1) / 2 * scale
    ty = size / 2 - (MARK_Y0 + MARK_Y1) / 2 * scale

    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=radius * SS, fill=tile)
    if outline:
        # Same centred-vs-inside stroke correction as draw_mark below.
        inset, r, width = outline
        grow = width / 2
        d.rounded_rectangle(
            [
                (inset - grow) * SS,
                (inset - grow) * SS,
                (size - inset + grow) * SS,
                (size - inset + grow) * SS,
            ],
            radius=r * SS,
            outline=stroke,
            width=max(1, round(width * SS)),
        )

    draw_mark(d, ImageDraw.Draw(wash), tx * SS, ty * SS, scale * SS, stroke)
    body = size - 2 * pad
    art = Image.alpha_composite(img, wash).resize((body, body), Image.LANCZOS)
    if not pad:
        return art
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(art, (pad, pad))
    return canvas


# The icons, as data rather than as two calls inside main().
#
# check-icon.py re-renders from this same dict and compares the result to what
# is committed. If the specs lived as literals in main(), the checker would need
# its own copy of every number, and a copy that drifts is the exact bug the
# checker exists to catch. One definition, two consumers.
ICONS = {
    # ledgerpdf-icon-macos.svg, at its native 1024.
    "icon.png": dict(
        size=1024,
        radius=232,
        tile=VELLUM,
        stroke=INK,
        outline=(46, 200, 7),
        scale=MARK_SCALE,
        # 100 a side leaves an 824x824 body: Apple's macOS icon grid exactly.
        pad=100,
    ),
    # ledgerpdf-icon-windows.svg, drawn at 1024 rather than the kit's 512:
    # electron-builder wants at least 256 for a .ico and takes the extra
    # resolution for free. Every dimension is the SVG's, doubled.
    "icon-win.png": dict(
        size=1024,
        radius=180,
        tile=DEEP_TEAL,
        stroke=PAPER_CREAM,
        outline=None,
        scale=MARK_SCALE,
    ),
}


def main() -> None:
    RES.mkdir(parents=True, exist_ok=True)
    for name, spec in ICONS.items():
        render(**spec).save(RES / name)
        print(f"wrote {RES / name}")


if __name__ == "__main__":
    main()
