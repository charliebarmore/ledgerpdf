"""Emit installed Python distribution license texts as JSON for packaging."""

from __future__ import annotations

from importlib import metadata
import json
import os


def is_license_file(value: str) -> bool:
    parts = value.replace("\\", "/").split("/")
    name = parts[-1].lower()
    return (
        any(part.lower() == "licenses" for part in parts)
        or name.startswith(("license", "licence", "copying", "notice"))
    )


records = []
for distribution in metadata.distributions():
    name = distribution.metadata.get("Name")
    if not name:
        continue
    files = []
    for relative in distribution.files or ():
        value = str(relative)
        # Only a distribution's own metadata notices. Packages such as NumPy
        # also contain source-level third-party notices there, and they matter;
        # unrelated LICENSE-named test fixtures elsewhere in site-packages do not.
        if ".dist-info/" not in value.replace("\\", "/") or not is_license_file(value):
            continue
        target = distribution.locate_file(relative)
        try:
            if not os.path.isfile(target) or os.path.getsize(target) > 5 * 1024 * 1024:
                continue
            with open(target, "r", encoding="utf-8", errors="replace") as source:
                files.append({"path": value, "text": source.read()})
        except OSError:
            continue
    records.append(
        {
            "name": name,
            "version": distribution.version,
            "license": distribution.metadata.get("License", ""),
            "files": sorted(files, key=lambda item: item["path"]),
        }
    )

print(json.dumps(sorted(records, key=lambda item: item["name"].lower())))
