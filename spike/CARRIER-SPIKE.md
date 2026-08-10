# Embedded-session carrier spike — issue #3

**2026-08-01 · 288 automated results · RECOMMENDATION: `dual` carrier + geometry integrity check**

Issue #3 replaces the two-file model (`.wptsession.json` master + exported binder)
with Acrobat parity: one file, one Save, double-click to reopen. That requires the
editable session to live inside the binder PDF, and the open risk was that a
third-party editor silently drops it on save.

The question was framed as *"does Acrobat Pro rewrite an exported binder in place?"* —
which needs software this machine does not have. **The framing was wrong.** Proving no
editor ever rewrites a binder is unbounded: it needs every editor, every version,
forever. The tractable question is *which carrier survives a rewrite, and can we detect
when the pages moved underneath it.* Both are answerable today.

## What was run

`carrier_survival.py` writes the same session payload through six carriers, pushes each
through seven rewriters, and reads it back. Every cell is graded on two independent
axes: did the payload come back byte-identical, and did the page geometry it describes
still match.

```
engine/.venv/Scripts/python.exe spike/carrier_survival.py
```

Fixtures are the six synthetic binders in `C:\Work\build\acrobat-test\` — 1 to 7 pages,
`/Rotate` values of 0/90/180, pre-existing annotations on most. No client data.

## The matrix

`PASS` = session recovered byte-identical · `!` = page geometry changed

| carrier | (none) | qpdf-save | qpdf-linearize | qpdf-objstm | pdfium-save | reauthor-pages | preview-sim | drop-first-page |
|---|---|---|---|---|---|---|---|---|
| **dual** | PASS | PASS | PASS | PASS | PASS | **PASS** | PASS! | **PASS!** |
| attachment | PASS | PASS | PASS | PASS | PASS | **DROPPED** | PASS! | PASS! |
| page-af | PASS | PASS | PASS | PASS | PASS | PASS | PASS! | **DROPPED** |
| xmp | PASS | PASS | PASS | PASS | PASS | **DROPPED** | PASS! | PASS! |
| docinfo | PASS | PASS | PASS | PASS | PASS | **DROPPED** | PASS! | PASS! |
| catalog | PASS | PASS | PASS | PASS | PASS | **DROPPED** | PASS! | PASS! |

**The first run of this harness was all PASS in every cell** — qpdf and pdfium both
preserve the object graph, so nothing could ever drop. A matrix with no failures is not
evidence; it is an untested harness. `reauthor-pages` and `drop-first-page` were added
to make it discriminate, and they are what produced the result below.

### Carriers

| carrier | where the payload lives | fails when |
|---|---|---|
| `attachment` | document-level `/Names /EmbeddedFiles`, `/AFRelationship /Source` | an editor rebuilds the document from its pages |
| `page-af` | `/AF` associated file on page 1 | that page is deleted |
| `dual` | **both of the above** | neither failure alone is enough |
| `xmp` | XMP custom property, base64 | rebuild; also +33% size tax |
| `docinfo` | `/Info /WPT_Session`, base64 | rebuild; `/Info` is deprecated in PDF 2.0 |
| `catalog` | private stream on the catalog | rebuild |

### Rewriters

`qpdf-save` / `-linearize` / `-objstm` and `pdfium-save` are real writers from two
independent engines (qpdf, and the pdfium that Chrome and Edge use). `reauthor-pages`
rebuilds the document by copying pages into a fresh file — the destructive class, and
exactly what our own `binder.export_binder` does to source files. `preview-sim`
reproduces the recorded macOS Preview damage signature (`/Rotate 90` → `0`).
`drop-first-page` is ordinary editing, included because it is the failure mode of the
carrier the rest of the data favours.

## Findings

**1. Every single-anchor carrier has a rewriter that kills it. `dual` has none.**
Document-level attachments die on rebuild; page-level ones die when the page is deleted.
Writing both costs a few kilobytes and removes both single points of failure. Read order
is document-level first, page-level as fallback.

**2. Payload survival is not the same as correctness, and conflating them is the trap.**
Under `preview-sim` every carrier returns the session byte-identical — and every one of
them is then describing mark positions that no longer render where the preparer put them.
A carrier that survives a destructive save while the pages moved is *worse* than one that
drops, because it reopens looking fine. Hence the second axis.

**3. The integrity check works and stays quiet when it should.** `page_geometry_fingerprint`
hashes page count, order, and each page's box geometry and rotation — deliberately not
content-stream bytes, so a lossless recompress does not cry wolf. It stayed silent across
all four real writers and fired on both mutating rewriters. That is the binder integrity
check the memory called a prerequisite; it exists now and does not depend on Acrobat.

**4. Size and speed are non-issues.** A 400-page binder with 2,000 marks and 150 tapes
is a 254 KB session; stored twice and deflate-compressed it adds **22.6 KB** to the PDF.
Embed 63 ms, extract 127 ms.

**5. The session shape has to change with the model.** Today's session points outward at
source files and their fingerprints. In the single-file model the binder's own pages *are*
the record, marks reference binder page indices, and source paths demote from dependency
to provenance. `sample_session()` in the harness shows the shape.

## Still unknown — and now portable

Nothing here is a claim about Acrobat Pro. It is a claim about what happens to each
carrier *if* an editor rebuilds a document, which is the risk being priced.

`--manual-kit` builds a folder any tester with Acrobat Pro can process — six PDFs, a
manifest, and a README that asks for one thing: open, save, close, send it back.
`--manual-verify` grades the returned folder on both axes.

```
python spike/carrier_survival.py --manual-kit  spike/out/acrobat-pro-kit
python spike/carrier_survival.py --manual-verify spike/out/acrobat-pro-kit
```

The kit contains synthetic fixtures only, so it can go to an external Acrobat tester
with no §7216 or confidentiality question attached. That turns the Acrobat Pro
answer from a blocker into a data point — and if Pro turns out to be destructive, the
recommendation does not change, because `dual` already survives the destructive case and
the integrity check already catches the geometry damage.

## Re-running

```
engine/.venv/Scripts/python.exe spike/carrier_survival.py                 # matrix + CSV
engine/.venv/Scripts/python.exe spike/carrier_survival.py --fixtures DIR  # other binders
```

Results land in `spike/out/carrier-survival.csv`, rewritten artifacts in
`spike/out/carriers/`. The engine venv is not in the repo — `python -m venv engine/.venv`
then `pip install -r engine/requirements.txt`.
