# app — Electron shell (Phase 1: binder organizer)

Electron + React + TypeScript front end. **PDF.js renders; it never writes.**
Every byte written to disk goes through the Python engine (`../engine`) over a
JSON sidecar. See `../references/source-materials.md` for the canonical spec.

## Run it

```bash
npm install
npm run dev        # copies pdfjs assets, then launches
```

The engine venv must exist (`../engine/.venv`) — created by the Phase 0 spike:
`engine/.venv/bin/python spike/run_spike.py`.

## Verify it

```bash
npm run verify     # typecheck + model verification + GUI smoke test
```

| Script | What it proves |
|---|---|
| `typecheck` | main/preload and renderer both typecheck |
| `verify:model` | 22 checks on the pure session model, ending in a **real engine export + re-probe** (reorder, rotation, bookmark hoisting, session round-trip, version guard) |
| `smoke` | drives the **actual Electron app** headlessly: imports two fixtures → renders → exports through IPC + engine → asserts page count, nested/retargeted bookmarks, `qpdf --check`, and snapshots the window to a PNG |

Both suites use synthetic fixtures only — **never client documents**.

## Layout

```
src/main/       main process — ALL filesystem + subprocess access
src/preload/    the entire renderer API surface (contextBridge)
src/renderer/
  src/session.ts    the binder model: stable page ids, bookmarks, export spec (pure)
  src/pdf.ts        PDF.js rendering + per-canvas render cancellation
  src/App.tsx       state, undo/redo, keyboard
  src/components/   ThumbnailRail · PageView · BookmarkPanel
scripts/        asset copy, model verification, smoke test
```

## Security posture

This app holds client tax documents, so the boundaries are deliberate:

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
- The renderer can only read/probe paths the **user explicitly chose this
  session** (`allowedInputs`) and only write to a path from a **save dialog**
  (`allowedOutputs`). There is no generic "read any file" IPC.
- CSP permits no remote origin at all — no `https:` source anywhere, so the
  renderer cannot reach the network. `wasm-unsafe-eval` is present only for
  PDF.js's JBIG2/JPEG2000 decoders.
- No telemetry. Nothing leaves the machine.
- Source PDFs are opened read-only; a binder is always written to a new file.

## Keyboard

| Keys | Action |
|---|---|
| `↑` `↓` | move the cursor |
| `⌘/Ctrl ↑ ↓` | move the selected page(s) in the binder |
| `[` `]` | rotate left / right |
| `⌫` | delete (undoable — no confirmation dialog, per DESIGN.md) |
| `⌘/Ctrl Z` / `⇧⌘Z` | undo / redo |
| `⌘/Ctrl I` · `E` · `S` · `O` | add PDFs · export · save session · open session |

Click selects, `⌘/Ctrl`-click toggles, `⇧`-click selects a range. Drag thumbnails
to reorder; drop PDFs onto the window to import.

## Dev seams

Dev builds only (ignored when packaged), used by `npm run smoke`:

| Env var | Effect |
|---|---|
| `WPT_DEV_OPEN` | `path`-delimited PDFs to import at startup |
| `WPT_DEV_EXPORT` | export to this path (pre-authorized, no dialog) |
| `WPT_DEV_SHOT` | capture the window to this PNG once loaded |
| `WPT_DEV_EXIT` | quit after capturing |

## Known gaps (tracked in ../ROADMAP.md)

- Packaging is not set up (Phase 5). In particular PDF.js's WASM/cmap assets are
  loaded relative to `document.baseURI`, which works in dev; `file://` fetch
  behavior in a packaged build still needs verifying.
- No marks/tapes/links UI yet — that is Phase 2–4. The engine already supports
  them (proven in the Phase 0 spike).
- Thumbnails render eagerly as they mount; a 300-page binder needs windowing.
