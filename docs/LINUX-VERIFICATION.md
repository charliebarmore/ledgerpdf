# Linux verification

## Local results — 2026-09-22

Tested on Omarchy / Arch Linux, kernel 7.2.3, x64, Node 26.7.0 and Python
3.14.7. All documents were generated synthetic fixtures.

- Installed both `engine/requirements.lock` and `engine/requirements-build.lock`
  with `--require-hashes` into the repository virtual environment.
- Built an unpacked application with `npm run package:dir`.
- Passed `npm run verify:package`: all nine Electron fuse settings, renderer
  assets and license files, the frozen engine health check, mixed-document
  import/export, recent-binder reopen, and packaged MCP operations and folder
  access restrictions.
- The mixed import combined two PDFs, a receipt image, and a two-sheet workbook
  into nine pages. Reopening preserved all nine pages and their bookmarks;
  the saved binder correctly becomes one source.

The initial Linux build failed because the fuse hook looked for `LedgerPDF`,
while electron-builder used the npm package name for its Linux executable.
The build now explicitly names it `ledgerpdf`, and the hook uses the Linux
packager's executable name. The package verifier now resolves Linux output
directories rather than looking for a Windows EXE.

## Visible packaged-app walkthrough

The normal packaged application ran on the existing Wayland desktop with a
separate configuration directory. Browser automation connected to a loopback
debugging port and used the visible controls; this was an agent-driven UI
walkthrough, not an independent human acceptance test.

1. Opened a copy of the synthetic nine-page binder in a normal cold launch.
2. Selected the tick tool, clicked the PDF, and entered test initials `TST`.
3. Entered a note and clicked **Save**.
4. Clicked the trial-balance bookmark and inspected the rendered spreadsheet.
5. Closed the window, relaunched without a file argument, and clicked the binder
   in **Pick up where you left off**.
6. Confirmed nine pages and the bookmark tree, then selected the visible tick.
   Its author and complete note were intact and editable.

Screenshots and the synthetic binder were retained locally under
`app/build/desktop-walkthrough/` (gitignored). Imports were driven by the packaged
smoke harness; native file-picker interaction and desktop file associations
were not exercised by this walkthrough.

## Repeatable checks

After the README's source setup and packaging-dependency installation:

```bash
cd app
npm run package:dir
npm run verify:package
./release/linux-unpacked/ledgerpdf  # x64 output; requires a desktop display
```

Keep the entire unpacked directory together: the executable needs its sibling
resources and frozen engine. On other architectures the output directory has
an architecture suffix, such as `linux-arm64-unpacked`.

The **Linux** GitHub Actions workflow runs source checks on pull requests.
Manual dispatch with `package` enabled additionally builds and verifies the
unpacked app under Xvfb, retaining screenshot evidence for three days. Packaging
does not disable Electron's sandbox.

## Limits

This verifies a locally built directory, not a distributable Linux installer.
There is no AppImage, DEB/RPM, signing, or desktop-registration acceptance claim.
A binary built on Arch is not proven portable to older Linux distributions.
ARM builds, native file dialogs, printing, and long-running daily use still
need separate testing.
