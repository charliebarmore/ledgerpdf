"""Prove a failed final rename cannot damage the prior complete export."""

import hashlib
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from workpaper_engine import binder


REPO = Path(__file__).resolve().parents[1]
SOURCE = REPO / "spike" / "fixtures" / "fixture_a.pdf"


def spec(output: Path) -> dict:
    return {
        "output": str(output),
        "sources": {"src": str(SOURCE)},
        "pages": [{"id": "pg_1", "source": "src", "index": 0, "rotate": 0}],
        "bookmarks": [],
        "annotations": [],
    }


def main() -> None:
    if not SOURCE.exists():
        raise RuntimeError(f"fixture missing: {SOURCE}")
    with TemporaryDirectory(prefix="ledgerpdf-atomic-export-") as directory:
        root = Path(directory)
        output = root / "review_binder.pdf"
        binder.export_binder(spec(output))
        prior = output.read_bytes()
        prior_sha256 = hashlib.sha256(prior).hexdigest()

        guarded = spec(output)
        guarded["output_guard"] = {"sha256": "0" * 64}
        try:
            binder.export_binder(guarded)
        except ValueError as error:
            if "destination changed" not in str(error):
                raise
        else:
            raise AssertionError("a stale destination hash was accepted")
        if output.read_bytes() != prior:
            raise AssertionError("stale destination guard replaced the prior export")

        guarded = spec(output)
        guarded["output_guard"] = {"sha256": prior_sha256}

        try:
            with patch.object(
                binder.os,
                "replace",
                side_effect=OSError("simulated failure at atomic replacement"),
            ):
                binder.export_binder(guarded)
        except OSError as error:
            if "simulated failure" not in str(error):
                raise
        else:
            raise AssertionError("simulated os.replace failure did not propagate")

        if output.read_bytes() != prior:
            raise AssertionError("prior export changed after failed replacement")
        leftovers = list(root.glob(".*.tmp.pdf"))
        if leftovers:
            raise AssertionError(f"temporary export was not cleaned up: {leftovers}")

    print("atomic export replacement failure preserved the prior PDF")


if __name__ == "__main__":
    main()
