# Windows x64 checklist

For a real Windows machine. Nothing here needs a dev toolchain installed — CI
builds everything and hands back artifacts.

## Get a build

```bash
gh workflow run "Windows x64"        # from the Mac, or use the Actions tab
```

When it finishes, download from the run's **Artifacts**:

- `workpaper-binder-win-unpacked` — runs directly, no install, no SmartScreen.
  Use this to test **the app**.
- `workpaper-binder-win-installer-UNSIGNED` — use this to test **the install
  experience**. It is unsigned on purpose; do not give it to anyone.
- `windows-evidence` — the packaged-app screenshot CI captured, for comparison.

## 1. Does it run at all

This is the part that has never been tested anywhere. Roughly ten `win32`
branches — engine path resolution, `workpaper-engine.exe`, the electron-builder
invocation, a persistence branch — execute for the first time on this machine.

- [ ] `Workpaper Binder.exe` from the unpacked folder starts.
- [ ] Add a PDF. If the frozen Python engine cannot be found or spawned, this is
      where it fails — the app will report the engine path it tried.
- [ ] Export a binder. The engine does the writing, so a successful export
      proves the sidecar works end to end.
- [ ] Save a session, close, reopen it. Windows path separators and the
      atomic-rename persistence path differ from macOS.

## 2. SmartScreen and the installer

The thing CI cannot answer.

- [ ] Run the **unsigned** installer. Expect "Windows protected your PC" — note
      the exact wording and how many clicks it takes to proceed.
- [ ] Note whether it warns again on first launch of the installed app.

This is the worst case, and the point of seeing it. Azure Trusted Signing
improves it but does **not** remove it immediately: SmartScreen reputation
accrues per-certificate over downloads and time, so an early design partner may
still see a warning even once signing is in place. Worth knowing before someone
else sees it.

## 3. Acrobat on Windows

Install Adobe Acrobat Reader (free), then work through
`spike/ACROBAT-CHECKLIST.md` against `spike/out/conformance.pdf` — build it with
`engine\.venv\Scripts\python spike\make_conformance.py`, or take the copy from
the `windows-evidence` artifact.

Acrobat's renderer is the same codebase across platforms, so this is a
confirmation rather than a new risk. Pages 2 (CropBox ≠ MediaBox) and 3
(`/Rotate 90`) are the ones that would expose a `/Matrix` bug.

## 4. Worth doing while you have the machine

- [ ] Open an **exported binder** in Windows Acrobat, close it, and check the
      file is unchanged. macOS Preview rewrote an exported binder in place —
      flattening `/Rotate` and moving annotation rects — and it is still unknown
      whether Acrobat on Windows does anything similar. A binder is a record.
- [ ] Try a real multi-hundred-page file if one is handy: the continuous
      scroller windows its rendering, and Windows is where that will be slowest.
