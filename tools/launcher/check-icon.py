"""Assert the committed icons still match what make-icon.py renders.

    npm run verify:icon        (from app/, and part of `npm run verify`)

Invoked that way on purpose, here and in every message this file prints: it
resolves the venv interpreter through scripts/lib/build-python.mjs, so it works
on both platforms. A venv is `bin/python` on POSIX and `Scripts\\python.exe` on
Windows, and Windows is where this check does its most valuable work, so a
hardcoded POSIX path in a failure message hands the developer most likely to see
it a command that cannot run.

`build:icon` exists so the shipped icon cannot drift from the script that draws
it. It only runs on the packaging hooks, and the Windows CI job invokes
electron-builder directly rather than through them, so on the one platform CI
actually runs, packaging uses whatever PNG is committed and nothing checks it.
Edit make-icon.py, forget to regenerate, and macOS packaging silently corrects
the file while Windows ships the stale artwork. This closes that.

WHY PIXELS AND NOT BYTES
------------------------
The obvious version of this check is `git diff --exit-code app/resources` after
a regenerate. It is wrong, and in a way that would do real damage.

make-icon.py saves with a bare `.save(path)`: no `compress_level`, no
`optimize`. The bytes therefore come from Pillow's default zlib settings, and
the zlib linked into the Windows Pillow wheel is not the one in the macOS wheel.
Byte-identical PNG output across platforms was never established here; it is
exactly the thing that has not been verified. So a byte check can go red on a
perfectly correct icon.

That is worse than an ordinary false alarm, because both instinctive responses
to it are wrong. Delete the check, and the silent-drift bug it guards comes
back. Commit the Windows-rendered PNG to make it pass, and the same check now
fails on macOS, where packaging quietly regenerates and ships different artwork
than the repository holds. A check that fails for a non-defect teaches people to
route around it, and this one is guarding a bug you cannot see.

So the assertion is on the decoded image: identical mode, identical size,
identical `tobytes()`. That is the property actually worth protecting — the
artwork matches the script — and it is immune to encoder differences.

The bonus is the thing byte-comparison cannot give you. A byte difference says
nothing about whether the IMAGE differs, so it can never serve as proof that the
render is deterministic across platforms. Pixel equality can, and it is the
check that cannot be run on one machine: when this passes on the Windows runner,
Windows Pillow has been shown to draw the same icon as macOS Pillow.

Byte drift is still worth knowing about, so it is printed as a note. It is not a
failure.
"""

import importlib.util
import io
from pathlib import Path

import PIL
from PIL import Image

# make-icon.py is not an importable module name because of the hyphen, so it is
# loaded by path rather than renaming a file that the README, the npm script and
# build-icon.mjs all refer to by name.
_spec = importlib.util.spec_from_file_location(
    "make_icon", Path(__file__).resolve().parent / "make-icon.py"
)
make_icon = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(make_icon)


def main() -> int:
    failures = []
    notes = []

    for name, spec in make_icon.ICONS.items():
        committed_path = make_icon.RES / name

        if not committed_path.exists():
            failures.append(f"{name}: not committed. Run: npm run build:icon (from app/)")
            continue

        fresh = make_icon.render(**spec)
        with Image.open(committed_path) as opened:
            committed = opened.copy()

        if committed.mode != fresh.mode:
            failures.append(f"{name}: mode {committed.mode} committed, {fresh.mode} rendered")
            continue
        if committed.size != fresh.size:
            failures.append(f"{name}: size {committed.size} committed, {fresh.size} rendered")
            continue

        if committed.tobytes() != fresh.tobytes():
            # Say HOW different, so a reader can tell an anti-aliasing hair from
            # a genuine redesign without opening both in an image editor.
            a, b = committed.tobytes(), fresh.tobytes()
            changed = sum(1 for i in range(0, len(a), 4) if a[i : i + 4] != b[i : i + 4])
            pct = 100 * changed / (fresh.size[0] * fresh.size[1])
            failures.append(
                f"{name}: {changed} "
                f"{'pixel differs' if changed == 1 else 'pixels differ'} ({pct:.2f}%). "
                f"The committed icon is not what make-icon.py draws. "
                f"Regenerate with: npm run build:icon (from app/)"
            )
            continue

        # Pixels agree. Encoder bytes are a separate question, and only a note.
        buf = io.BytesIO()
        fresh.save(buf, format="PNG")
        if buf.getvalue() != committed_path.read_bytes():
            notes.append(
                f"{name}: identical pixels, different PNG bytes "
                f"({len(committed_path.read_bytes())} committed vs {len(buf.getvalue())} "
                f"re-encoded). Expected across platforms, because zlib differs between "
                f"Pillow wheels. Not a failure."
            )
        # ASCII only. An em dash here rendered as a replacement character in the
        # Windows CI log, because the runner's console is cp1252 and Python
        # encodes stdout to it. Mojibake in the log of the platform this project
        # actually ships on is not worth a nicer dash.
        print(f"[PASS] {name} matches make-icon.py: {fresh.size[0]}x{fresh.size[1]} {fresh.mode}")

    for note in notes:
        print(f"[NOTE] {note}")
    for failure in failures:
        print(f"[FAIL] {failure}")

    if failures:
        # Name the Pillow version on the way out. engine/requirements.txt pins
        # `pillow>=10`, deliberately, so this assertion is coupled to whichever
        # release the runner installed: a change to rounded_rectangle's
        # anti-aliasing or to LANCZOS turns this red with no code change at all.
        # That is the intended behaviour, since the artwork really would have
        # moved, but the first question anyone asks is "what changed?" and the
        # answer is usually here rather than in the diff.
        print(
            f"\n{len(failures)} icon(s) do not match the script. "
            f"Rendered with Pillow {PIL.__version__}; if nothing in "
            f"make-icon.py changed, compare that against the version that "
            f"produced the committed PNGs."
        )
        return 1
    print(f"\n{len(make_icon.ICONS)}/{len(make_icon.ICONS)} icons match the script")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
