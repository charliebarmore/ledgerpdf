# Copyright and licensing

LedgerPDF — a local-first tax workpaper binder for humans and agents.

Copyright © 2026 Ledger Labs LLC.

This program is free software: you can redistribute it and/or modify it under
the terms of the **GNU General Public License, version 3 or any later version**,
as published by the Free Software Foundation. The full text is in
[`LICENSE`](LICENSE).

This program is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
PARTICULAR PURPOSE. See the GNU General Public License for more details.

## Why GPL-3.0

LedgerPDF's central claim is that **the application makes no network calls** —
no telemetry, no cloud, no account. (An MCP client you connect is a separate
program, and what it sends to a model is your configuration choice, stated
plainly in `DATA-FLOW.md`.) For a tool holding client tax records under IRC
§7216 and the FTC Safeguards Rule, that claim is only worth what it can be
checked against.
A public repository under a copyleft licence means a firm's own IT reviewer can
verify it rather than take our word, and that anyone shipping a modified LedgerPDF
has to publish their changes too.

Selling signed builds is expressly permitted by the GPL and is not in tension
with any of the above.

## Relicensing

Ledger Labs LLC holds the copyright to this work in full, and may therefore
license it on other terms at any time — a commercial licence alongside the GPL,
for instance. **That stays true only while the copyright is undivided.** Once
outside contributions are merged, their authors hold copyright in their
contributions and relicensing needs their agreement. If contributions are ever
accepted, either take a contributor licence agreement first or accept that GPL-3.0
becomes permanent.

## Dependency licences

Every runtime dependency is GPL-3.0 compatible. Checked 2026-08-05:

| Dependency | Licence | Note |
| --- | --- | --- |
| pikepdf | MPL-2.0 | §3.3 expressly permits distribution under the GPL |
| qpdf (bundled by pikepdf) | Apache-2.0 | compatible with GPL-3.0 (one-way) |
| pypdfium2 / pdfium | BSD-3 / Apache-2.0 | |
| Pillow | HPND | permissive |
| openpyxl, markdown-it-py, python-docx, pyobjc | MIT | |
| reportlab, numpy | BSD-3 | |
| pdf.js | Apache-2.0 | compatible with GPL-3.0 (one-way) |
| Electron, React, zod, MCP SDK | MIT | |

**Apache-2.0 and MPL-2.0 are compatible with GPL-3.0 in one direction only** —
their code may be combined into this work, but not the reverse. Adding a
dependency under GPL-incompatible terms would force this project off the GPL, so
check the licence before adding one.

**The standing guard in `engine/requirements.txt` still holds and matters more
now:** never add MuPDF, mutool, or PyMuPDF. They are AGPL, and combining them
would subject the whole work to the AGPL's §13 network clause — a materially
different obligation from the one chosen here.
