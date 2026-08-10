r"""Assemble the recorded demo frames into site/demo.webp + site/poster.png.

    engine/.venv/bin/python tools/make-demo-webp.py        (macOS/Linux)
    engine\.venv\Scripts\python tools\make-demo-webp.py    (Windows)

Input is spike/out/demo_frames/ from app/scripts/record-demo.mjs: numbered
PNGs plus durations.json (a capture timestamp per frame). Real pacing is kept,
played back slightly faster; byte-identical consecutive frames are merged into
one longer frame, which is what makes the file small — most of a recording of
discrete actions is stillness.

The FIRST frame of the loop is the finished, marked-up binder. Two reasons:
browsers that decode WebP but not animation show frame one, so the fallback is
the rich state rather than an empty dropzone — and the loop reads as "here is
the result; now watch it happen", which is how a demo should open.

Poster: the same finished frame as PNG, for og:image and the <picture> fallback.
"""

import hashlib
import json
from pathlib import Path

from PIL import Image

REPO = Path(__file__).resolve().parents[1]
FRAMES = REPO / "spike" / "out" / "demo_frames"
SITE = REPO / "site"
WIDTH = 1200
SPEED = 1.5  # playback speedup over real time
HOLD_FINAL_MS = 2600  # the opening/closing hold on the finished binder


def main() -> None:
    files = sorted(FRAMES.glob("f*.png"))
    stamps = json.loads((FRAMES / "durations.json").read_text())
    assert len(files) == len(stamps), (len(files), len(stamps))

    frames: list[Image.Image] = []
    durs: list[int] = []
    last_digest = None
    for i, f in enumerate(files):
        raw = f.read_bytes()
        digest = hashlib.sha256(raw).digest()
        ms = (stamps[i + 1] - stamps[i]) if i + 1 < len(stamps) else 300
        ms = int(ms / SPEED)
        if digest == last_digest and frames:
            durs[-1] += ms  # stillness becomes duration, not bytes
            continue
        last_digest = digest
        im = Image.open(f).convert("RGB")
        im.thumbnail((WIDTH, WIDTH * 4))
        frames.append(im)
        durs.append(ms)

    # Rotate the finished binder to the front and hold it there.
    final = frames[-1]
    frames = [final] + frames
    durs = [HOLD_FINAL_MS] + durs
    durs[-1] = HOLD_FINAL_MS

    out = SITE / "demo.webp"
    frames[0].save(
        out,
        save_all=True,
        append_images=frames[1:],
        duration=durs,
        loop=0,
        quality=72,
        method=6,
    )
    final.save(SITE / "poster.png", optimize=True)
    kb = out.stat().st_size // 1024
    print(f"{len(frames)} frames -> {out} ({kb} KB), poster.png {final.size}")
    if kb > 4500:
        print("WARNING: over ~4.5 MB — consider lowering quality or WIDTH")


if __name__ == "__main__":
    main()
