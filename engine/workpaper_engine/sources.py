"""Turning a non-PDF source into the pages it becomes.

The app's renderer speaks PDF: PDF.js is handed the source bytes and draws
them. A spreadsheet's bytes are a ZIP, so it drew "Invalid PDF structure" —
the import, the text and the export all worked, and only the thing a person
actually looks at did not.

Materializing here means the window shows EXACTLY the pages that will be
exported, rather than a separate preview that could drift from the binder.
"""

from __future__ import annotations

import base64
import io

from . import documents, images, sheets


def materialize_source(path: str) -> str:
    """Base64 PDF bytes for a source that is not already a PDF."""
    if documents.is_doc(path):
        made = documents.doc_to_pdf(path)
    elif sheets.is_sheet(path):
        made = sheets.sheet_to_pdf(path)
    elif images.is_image(path):
        made = images.image_to_pdf(path)
    else:
        raise ValueError(f"already a PDF, read it directly: {path}")
    buffer = io.BytesIO()
    with made as pdf:
        pdf.save(buffer)
    return base64.b64encode(buffer.getvalue()).decode("ascii")
