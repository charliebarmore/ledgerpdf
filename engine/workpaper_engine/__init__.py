"""workpaper_engine — local PDF engine for the workpaper binder app.

Sidecar boundary: this package is driven by JSON commands (see cli.py).
It owns all PDF reading/writing via pikepdf/qpdf. The UI (later, Electron +
PDF.js) is a renderer only — never the source of truth.

License guard: pikepdf (MPL-2.0) + qpdf (Apache-2.0) only. Never MuPDF (AGPL).
"""

__version__ = "0.3.1"
