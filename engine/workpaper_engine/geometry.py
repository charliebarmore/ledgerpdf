"""Visual <-> PDF user-space coordinate mapping.

Core rules (per the canonical spec / accepted review):
- Normalized coordinates are relative to the **CropBox** (what viewers display),
  never the MediaBox. Tax-software output with CropBox != MediaBox will offset
  every mark otherwise.
- (nx, ny) are *visual* coordinates on the DISPLAYED page: nx in [0,1]
  left->right, ny in [0,1] top->bottom — screen convention, matching what the
  future UI will produce from a click.
- Page /Rotate (0/90/180/270, clockwise on display) is fully accounted for here,
  and its inverse compensation lives in the annotation appearance /Matrix.

Derivation (display device space: origin top-left, y down; CropBox
[cx0, cy0, cx1, cy1], W = cx1-cx0, H = cy1-cy0):

  R=0:   dx = ux - cx0        dy = cy1 - uy        display W x H
  R=90:  dx = uy - cy0        dy = ux - cx0        display H x W
  R=180: dx = cx1 - ux        dy = uy - cy0        display W x H
  R=270: dx = cy1 - uy        dy = cx1 - ux        display H x W

The functions below are the inverses of those mappings.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class PageGeom:
    """Geometry of one page as viewers display it."""

    crop: tuple[float, float, float, float]  # cx0, cy0, cx1, cy1 (user space)
    rotate: int  # 0 / 90 / 180 / 270

    def __post_init__(self) -> None:
        r = self.rotate % 360
        if r not in (0, 90, 180, 270):
            raise ValueError(f"unsupported /Rotate {self.rotate}")
        object.__setattr__(self, "rotate", r)

    @property
    def crop_w(self) -> float:
        return self.crop[2] - self.crop[0]

    @property
    def crop_h(self) -> float:
        return self.crop[3] - self.crop[1]

    @property
    def display_size(self) -> tuple[float, float]:
        """(width, height) of the page as displayed, in points."""
        if self.rotate in (90, 270):
            return (self.crop_h, self.crop_w)
        return (self.crop_w, self.crop_h)


def page_geom(page_obj) -> PageGeom:
    """Geometry of one page, from its PDF dictionary.

    The single definition. Marks, page borders and extracted text all resolve
    the CropBox and /Rotate through here, so a word's coordinates and a tick's
    coordinates cannot mean different things.
    """
    media = [float(v) for v in page_obj.MediaBox]
    crop = [float(v) for v in page_obj.CropBox] if "/CropBox" in page_obj else media
    rotate = int(page_obj.get("/Rotate", 0))
    return PageGeom(crop=tuple(crop), rotate=rotate)


def visual_to_user(geom: PageGeom, nx: float, ny: float) -> tuple[float, float]:
    """Map normalized visual coords (nx right, ny down) to user-space (x, y)."""
    cx0, cy0, cx1, cy1 = geom.crop
    w, h = geom.crop_w, geom.crop_h
    r = geom.rotate
    if r == 0:
        return (cx0 + nx * w, cy1 - ny * h)
    if r == 90:
        # dx = uy - cy0 -> uy = cy0 + nx * H ; dy = ux - cx0 -> ux = cx0 + ny * W
        return (cx0 + ny * w, cy0 + nx * h)
    if r == 180:
        return (cx1 - nx * w, cy0 + ny * h)
    # r == 270
    return (cx1 - ny * w, cy1 - nx * h)


def user_to_visual(geom: PageGeom, ux: float, uy: float) -> tuple[float, float]:
    """Map user-space (x, y) back to normalized visual coords — the exact
    inverse of `visual_to_user`.

    Text extraction needs this direction: pdfium reports character boxes in raw
    user space with the MediaBox origin and **no rotation applied**, while its
    `get_size` is the rotated display size. Dividing one by the other silently
    misplaces every word on a rotated or CropBox-offset page, so the mapping
    goes through the same geometry the marks use.
    """
    cx0, cy0, cx1, cy1 = geom.crop
    w, h = geom.crop_w, geom.crop_h
    r = geom.rotate
    if r == 0:
        return ((ux - cx0) / w, (cy1 - uy) / h)
    if r == 90:
        return ((uy - cy0) / h, (ux - cx0) / w)
    if r == 180:
        return ((cx1 - ux) / w, (uy - cy0) / h)
    # r == 270
    return ((cy1 - uy) / h, (cx1 - ux) / w)


def visual_rect_to_user_rect(
    geom: PageGeom, nx: float, ny: float, visual_w: float, visual_h: float
) -> tuple[float, float, float, float]:
    """User-space /Rect for a mark centered at visual (nx, ny) with a fixed
    on-screen size of visual_w x visual_h points.

    For 90/270 pages the user-space width/height swap so the displayed mark
    keeps its intended visual dimensions.
    """
    ux, uy = visual_to_user(geom, nx, ny)
    if geom.rotate in (90, 270):
        uw, uh = visual_h, visual_w
    else:
        uw, uh = visual_w, visual_h
    return (ux - uw / 2, uy - uh / 2, ux + uw / 2, uy + uh / 2)


def appearance_matrix(rotate: int) -> list[float] | None:
    """Form-XObject /Matrix that keeps an appearance upright on a rotated page.

    Display rotates the page clockwise by /Rotate; compensate by rotating the
    appearance counter-clockwise by the same amount. Viewers fit the
    Matrix-transformed BBox to /Rect (PDF 2.0 12.5.5), so translation terms
    are irrelevant.

    Returns None for rotate == 0 (omit /Matrix).
    """
    r = rotate % 360
    if r == 0:
        return None
    if r == 90:
        return [0, 1, -1, 0, 0, 0]
    if r == 180:
        return [-1, 0, 0, -1, 0, 0]
    if r == 270:
        return [0, -1, 1, 0, 0, 0]
    raise ValueError(f"unsupported /Rotate {rotate}")
