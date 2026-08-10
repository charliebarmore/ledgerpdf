"""Images as binder pages.

A PNG or a phone photo of a receipt is a workpaper page like any other, but the
binder model only understands PDFs. This module is the single point where an
image becomes one — everything downstream (ordering, marks, tapes, bookmarks,
export, flattening) then works on it unchanged.

Two rules drive the design:

1. **Source files are never touched.** Conversion happens in memory at export,
   exactly like the rest of the binder: the session keeps pointing at
   `receipt.png`, and a PDF exists only at export.

2. **A JPEG is embedded byte-for-byte wherever possible.** A workpaper is a
   record, so the receipt in the binder should be the file the client sent, not
   a recompression of it. JPEG data goes in raw as /DCTDecode and even EXIF
   rotation is honoured through the page's /Rotate rather than by re-encoding
   pixels. Only the cases PDF genuinely can't consume — mirrored EXIF
   orientations, CMYK, progressive scans — fall back to re-encoding, and
   `image_page` reports which happened.

Page geometry: fit to Letter, auto-oriented — a portrait image gets a portrait
page, a landscape one a landscape page. A binder is a document, not a photo
album; mixed sources have to print and paginate consistently.
"""

from __future__ import annotations

import io
import zlib
from dataclasses import dataclass
from pathlib import Path

import pikepdf
from PIL import Image, ImageOps
from pikepdf import Array, Name

# Page layout. MUST match the app's imageLayout() in src/renderer/src/pdf.ts —
# marks are placed in normalized page coordinates, so if the app frames the
# image differently from the engine, every mark on an image page lands wrong.
LETTER = (612.0, 792.0)
MARGIN = 18.0

IMAGE_SUFFIXES = frozenset(
    {".png", ".jpg", ".jpeg", ".jpe", ".gif", ".bmp", ".tif", ".tiff", ".webp"}
)

# EXIF orientation -> (clockwise display rotation, is it a mirror?). Mirrored
# orientations are vanishingly rare off real cameras and can't be expressed with
# /Rotate, so they take the re-encode path.
_EXIF_ORIENT = {
    1: (0, False),
    2: (0, True),
    3: (180, False),
    4: (180, True),
    5: (90, True),
    6: (90, False),
    7: (270, True),
    8: (270, False),
}


def is_image(path: str | Path) -> bool:
    return Path(path).suffix.lower() in IMAGE_SUFFIXES


@dataclass(frozen=True)
class ImagePage:
    """How one image becomes one page."""

    # MediaBox of the page BEFORE /Rotate is applied.
    box: tuple[float, float]
    # Clockwise display rotation carried on the page, from EXIF.
    rotate: int
    # Where the image sits inside that box: (x, y, w, h) in points.
    placement: tuple[float, float, float, float]
    # Pixel dimensions actually embedded.
    pixels: tuple[int, int]
    # False when the original bytes had to be re-encoded to be embeddable.
    lossless: bool
    reason: str = ""


def _orientation(img: Image.Image) -> tuple[int, bool]:
    try:
        exif = img.getexif()
        return _EXIF_ORIENT.get(int(exif.get(274, 1)), (0, False))
    except Exception:  # noqa: BLE001 — a corrupt EXIF block is not fatal
        return (0, False)


def _layout(display_w: int, display_h: int) -> tuple[tuple[float, float], tuple[float, ...]]:
    """Letter page auto-oriented to the image, image centred inside the margins.

    Returned box is the DISPLAYED page; the caller swaps it for 90/270 pages.
    """
    pw, ph = LETTER if display_h >= display_w else (LETTER[1], LETTER[0])
    scale = min((pw - 2 * MARGIN) / display_w, (ph - 2 * MARGIN) / display_h)
    dw, dh = display_w * scale, display_h * scale
    return (pw, ph), ((pw - dw) / 2, (ph - dh) / 2, dw, dh)


def image_page(path: str | Path) -> ImagePage:
    """Work out the page geometry for an image without building the PDF."""
    with Image.open(path) as img:
        sw, sh = img.size
        rotate, mirrored = _orientation(img)
        raw_ok = _can_embed_raw(img, mirrored)

    if mirrored:
        # Pixels get normalized, so there is no rotation left to carry.
        with Image.open(path) as img:
            fixed = ImageOps.exif_transpose(img)
            sw, sh = fixed.size
        rotate = 0

    # What the reader ends up seeing, after /Rotate.
    display = (sh, sw) if rotate in (90, 270) else (sw, sh)
    box, place = _layout(*display)
    # The MediaBox is stated before rotation, so a quarter-turn swaps it — and
    # the placement swaps with it, since the content stream is drawn unrotated.
    if rotate in (90, 270):
        box = (box[1], box[0])
        place = (place[1], place[0], place[3], place[2])

    return ImagePage(
        box=box,
        rotate=rotate,
        placement=place,  # type: ignore[arg-type]
        pixels=(sw, sh),
        lossless=raw_ok and not mirrored,
        reason="" if raw_ok and not mirrored else _why(path, mirrored),
    )


def _can_embed_raw(img: Image.Image, mirrored: bool) -> bool:
    """Can this file's compressed bytes go straight into the PDF?"""
    if mirrored or img.format != "JPEG":
        return False
    if img.mode not in ("L", "RGB", "YCbCr", "CMYK"):
        return False
    if img.mode == "CMYK":
        return False  # Adobe-inverted CMYK needs a /Decode dance; not worth it
    # Progressive JPEG is legal in the wild but not reliably decoded by every
    # PDF viewer as /DCTDecode data.
    return not img.info.get("progressive") and not img.info.get("progression")


def _why(path: str | Path, mirrored: bool) -> str:
    if mirrored:
        return "mirrored EXIF orientation"
    with Image.open(path) as img:
        if img.format != "JPEG":
            return f"{img.format} is not JPEG-compressed"
        if img.mode == "CMYK":
            return "CMYK JPEG"
        if img.info.get("progressive") or img.info.get("progression"):
            return "progressive JPEG"
    return "re-encoded"


def _raw_jpeg_xobject(pdf: pikepdf.Pdf, path: str | Path) -> pikepdf.Stream:
    """Embed the JPEG's own bytes — no decode, no recompression."""
    data = Path(path).read_bytes()
    with Image.open(path) as img:
        w, h = img.size
        gray = img.mode == "L"
    stream = pdf.make_stream(data)
    stream.Type = Name.XObject
    stream.Subtype = Name.Image
    stream.Width = w
    stream.Height = h
    stream.ColorSpace = Name.DeviceGray if gray else Name.DeviceRGB
    stream.BitsPerComponent = 8
    stream.Filter = Name.DCTDecode
    return stream


def _reencoded_xobject(pdf: pikepdf.Pdf, path: str | Path) -> pikepdf.Stream:
    """Decode to raw samples and Flate them — lossless, just not the original
    bytes. Alpha is composited onto white: a PDF page has no transparency to
    fall back on, and a workpaper is printed."""
    with Image.open(path) as img:
        fixed = ImageOps.exif_transpose(img) or img
        if fixed.mode in ("RGBA", "LA", "PA") or "transparency" in fixed.info:
            rgba = fixed.convert("RGBA")
            flat = Image.new("RGB", rgba.size, (255, 255, 255))
            flat.paste(rgba, mask=rgba.split()[-1])
            fixed = flat
        elif fixed.mode not in ("L", "RGB"):
            fixed = fixed.convert("RGB")
        w, h = fixed.size
        gray = fixed.mode == "L"
        samples = fixed.tobytes()

    stream = pdf.make_stream(zlib.compress(samples, 6))
    stream.Type = Name.XObject
    stream.Subtype = Name.Image
    stream.Width = w
    stream.Height = h
    stream.ColorSpace = Name.DeviceGray if gray else Name.DeviceRGB
    stream.BitsPerComponent = 8
    stream.Filter = Name.FlateDecode
    return stream


def image_to_pdf(path: str | Path) -> pikepdf.Pdf:
    """A one-page PDF holding this image, ready to append like any other source.

    Returning a real Pdf rather than a special-cased page is what keeps images
    out of the rest of the codebase: binder assembly, geometry, annotations and
    outlines all see an ordinary page.
    """
    spec = image_page(path)
    pdf = pikepdf.new()
    xobj = _raw_jpeg_xobject(pdf, path) if spec.lossless else _reencoded_xobject(pdf, path)

    x, y, w, h = spec.placement
    content = f"q {w:.4f} 0 0 {h:.4f} {x:.4f} {y:.4f} cm /Im0 Do Q".encode("ascii")
    page = pikepdf.Dictionary(
        Type=Name.Page,
        MediaBox=Array([0, 0, spec.box[0], spec.box[1]]),
        Resources=pikepdf.Dictionary(XObject=pikepdf.Dictionary(Im0=xobj)),
        Contents=pdf.make_stream(content),
    )
    if spec.rotate:
        page.Rotate = spec.rotate
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    return pdf


def probe_image(path: str | Path) -> dict:
    """Same wire shape as probe_pdf, so the app can treat both alike."""
    spec = image_page(path)
    return {
        "path": str(path),
        "kind": "image",
        "n_pages": 1,
        "pages": [
            {
                "index": 0,
                "rotate": spec.rotate,
                "mediabox": [0.0, 0.0, spec.box[0], spec.box[1]],
                "cropbox": None,
            }
        ],
        "outline": [],
        "image": {
            "pixels": list(spec.pixels),
            "lossless": spec.lossless,
            "reason": spec.reason,
            # Geometry the app must reproduce exactly in its preview, or a mark
            # placed over the picture would export somewhere else. Reported so
            # the two implementations can be checked against each other rather
            # than trusted to agree.
            "box": list(spec.box),
            "placement": list(spec.placement),
        },
    }
