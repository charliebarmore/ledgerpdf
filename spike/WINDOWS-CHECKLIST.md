# Windows x64 checklist

For a real Windows machine. Nothing here needs a dev toolchain installed — CI
builds everything and hands back artifacts.

## Get a build

```bash
gh workflow run "Windows x64"        # from the Mac, or use the Actions tab
```

When it finishes, download from the run's **Artifacts**:

- `ledgerpdf-win-unpacked` — runs directly, no install, no SmartScreen.
  Use this to test **the app**.
- `ledgerpdf-win-installer-ci` — use this to test **the install experience**.
  It is an expiring CI build of the dispatched commit, not the release download;
  released installers are attached to the GitHub release.
- `windows-evidence` — the packaged-app screenshot CI captured, for comparison.

## 1. Does it run at all

CI drives these paths on a clean Windows runner, and the 2026-08-07 ThinkPad
run exercised them on physical hardware. Repeat them for the final release
candidate: this is the check for installer and OS integration that automation
cannot fully reproduce.

- [ ] `LedgerPDF.exe` from the unpacked folder starts.
- [ ] Add a PDF. If the frozen Python engine cannot be found or spawned, this is
      where it fails — the app will report the engine path it tried.
- [ ] Export a binder. The engine does the writing, so a successful export
      proves the sidecar works end to end.
- [ ] Save a session, close, reopen it. Windows path separators and the
      atomic-rename persistence path differ from macOS.

## 2. SmartScreen and the installer

The thing CI cannot answer.

SmartScreen **may** show a warning for the unsigned installer. Record whether it
does; either outcome is valid. A missing prompt is not a failed gate, and a
prompt is not evidence that Defender found malware. Verify the artifact hash
before running it in either case.

**Final-candidate gate, 2026-08-10:** the exact installer from Actions run
`31429737884`, commit `d94d0ba`, passed on a physical ThinkPad at 1366×768. Its
SHA-256 matched the recorded release hash; install was per-user without admin;
the toolbar used two complete unclipped rows; PDF import, marks, tape, save,
restart, recents and uninstall all passed. SmartScreen did not appear despite
mark-of-the-web and Defender being enabled, which is an acceptable outcome.

- [x] Run the **unsigned** installer. **Done 2026-08-07 on the ThinkPad.**
      Result: **no SmartScreen prompt at all.** The installer was copied to
      Downloads and manually stamped with mark-of-the-web, so the "came from
      the internet" path was tested honestly rather than bypassed; Defender
      real-time was on and Smart App Control off. It went straight into the
      wizard. Three pages (per-user vs all-users, location, progress), ~50
      seconds, no admin prompt, ~441 MB installed, registered as "LedgerPDF
      0.1.0" publisher **Ledger Labs LLC** with a clean uninstall entry.
- [x] Note whether it warns again on first launch of the installed app.
      **It did not.** Clean empty-binder screen, live agent access off.

**What this changes:** the docs led with the warning as a certainty. They now
say Windows *may* show it, because a tester braced for a scary prompt that never
arrives starts doubting everything else the docs claim. The explanation stays —
a stricter machine, an enterprise policy, or Smart App Control can still fire —
and now lives in `docs/INSTALL-WINDOWS.md` rather than being promised and absent.

**Also proven in the same run, which was the real packaging risk:** the frozen
Python engine works in the installed build. A PDF imported, rendered,
thumbnailed and auto-bookmarked; a tick placed and saved came back as a real
`/Stamp` with its own appearance stream; bookmarks survived; the editable
session was embedded inside the PDF; and Acrobat rendered the mark in the right
position. Zero TCP sockets held by any LedgerPDF process for the whole session.

This is the worst case, and the point of seeing it. Azure Trusted Signing
improves it but does **not** remove it immediately: SmartScreen reputation
accrues per-certificate over downloads and time, so an early tester may
still see a warning even once signing is in place. Worth knowing before someone
else sees it.

On a machine with no existing LedgerPDF executable, the install-mode page must
describe a fresh install. It must not claim that it found an existing per-user
or per-machine installation merely because a stale registry value exists.

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
- [ ] **Cold-start file association (fixed 2026-08-14, verify on hardware):**
      with LedgerPDF fully closed, right-click a binder → Open with → LedgerPDF.
      The binder must open — before the fix the app launched empty, because
      nothing read the path Explorer put in argv, and the same action with the
      app already running worked (second-instance), so casual testing passed.
      Also run `LedgerPDF.exe "C:\path\to\binder.pdf"` from a terminal with no
      instance running.
