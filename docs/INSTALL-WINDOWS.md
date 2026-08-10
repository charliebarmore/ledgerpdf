# Installing LedgerPDF on Windows

It covers what the installer does, what Windows may say about it, and what that
actually means — because the honest answer to a security prompt is not "click
Run anyway".

**Windows builds are not code-signed yet.** Read the section on the security
prompt before you install, not after.

## What you need

- Windows 10 or 11, x64.
- About 500 MB free. The installed app is ~440 MB: it carries its own PDF
  engine, so there is no Python or other runtime to install.
- No administrator rights. It installs per-user by default.

## Getting the installer

Released installers are attached to the
[latest release](https://github.com/charliebarmore/ledgerpdf/releases). That is
the one to use unless you have a reason to build a newer one.

To build one yourself from an unreleased commit, and if you have access to the
repository, open the **Actions** tab → **Windows x64** → **Run workflow**, leave
`package` ticked, and download `ledgerpdf-win-installer-ci` when it finishes
(~7 minutes). A CI build is verified by that run alone and expires in three
days, so test with it rather than handing it on.

The installer is attached **only** to a manually dispatched run. Ordinary pushes
build and verify the package but do not upload it — a ~140 MB artifact on every
push would exhaust the storage quota. If you open the newest run and find no
installer, that is why: dispatch one.

Artifacts expire after 3 days.

## The security prompt

**Windows may show "Windows protected your PC" before it will run the
installer.** It may also not — on a first real test (2026-08-07, Windows 11,
Defender real-time on, Smart App Control off, with mark-of-the-web applied so
the download was treated as coming from the internet) the installer went
straight into the wizard with no prompt at all.

Both outcomes are normal, and the reason is worth understanding.

### What the prompt means

It means Microsoft Defender SmartScreen does not recognise this file yet. It is
a statement about **reputation**, not about safety: SmartScreen builds
confidence in a file from how many people have downloaded and run it without
trouble. A build almost nobody has downloaded has no reputation, so it is
"unrecognised".

It is not a virus warning. Windows is not saying it found anything wrong.

### Why signing does not simply remove it

A code-signing certificate is on the roadmap, and it will improve this — the
prompt names the publisher (**Ledger Labs LLC**) instead of "Unknown publisher",
and reputation then accrues to the certificate across versions rather than
resetting with every release.

It will not make the prompt disappear on day one. Per
[Microsoft's guidance](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation),
a valid certificate — OV **or** EV — still shows "app flagged as unrecognized
until reputation accumulates", and reputation needs "several weeks and hundreds
of clean installs from a wide audience". A pilot of a few firms will not produce
that, whatever we spend. Anyone who tells you a certificate removes the warning
is describing how this worked before 2024.

### What you can check instead

Rather than trusting the prompt either way:

- The source is public under GPL-3.0 — including everything the installer
  contains.
- Builds come from CI on a clean runner, not from someone's laptop, and the run
  that produced your installer is linked to the commit it was built from.
- The application makes no network calls. You can confirm it yourself: open
  Resource Monitor → Network while the app runs and watch for TCP connections
  held by a LedgerPDF process. The install test found none.

If your firm's policy is not to run unsigned software, that is a reasonable
policy and you should follow it. Wait for a signed release rather than making an
exception — and tell us, because "we cannot run this yet" is useful.

### If the prompt does appear

Click **More info**, check that it says LedgerPDF, then **Run anyway**. If you
are not satisfied with the answers above, do not — there is no harm in waiting.

## The install itself

A three-page wizard: install for just you or all users, where to put it, then
progress. About 50 seconds. No administrator prompt for a per-user install.

It creates Start-menu and desktop shortcuts, and a normal
**Settings → Apps → Installed apps** entry listing the publisher as Ledger Labs
LLC, so it uninstalls like anything else.

## First run, and one thing to watch

The app opens on an empty binder with **Live agent access: off**. That is the
correct default — agent access is opt-in.

**Check where the Save dialog points before you save a real binder.** LedgerPDF
suggests a folder, and from version 0.1.1 that is the folder you last kept a
binder in, or the folder your source documents came from. Earlier builds let
Windows choose, and Windows chooses Documents — which OneDrive often redirects
to a synced folder. If a workpaper matters, save it somewhere your firm governs,
and satisfy yourself the destination is not syncing to a personal cloud account.

That is a general point about this class of tool, not only about this one: on
Windows, "Documents" is frequently not on the machine.

## Uninstalling

**Settings → Apps → Installed apps → LedgerPDF → Uninstall.** Your binders are
ordinary PDF files and are left alone. The uninstaller removes the application,
its Installed apps entry, and its shortcuts. It deliberately retains
`%APPDATA%\LedgerPDF`, which contains preferences and the recent-binder list;
that list includes the full paths of binders you opened. This makes preferences
survive a reinstall, as most desktop applications do. Delete that folder by
hand after uninstalling if you want to remove LedgerPDF's remembered settings
and paths as well. Deleting it does not delete any binder PDFs.

## Telling us it went wrong

Please do — friction is the most useful thing a pilot produces. See
[`CONTRIBUTING.md`](../CONTRIBUTING.md), and note especially the request there
**not to attach a real client document.** Describe the shape of the file rather
than sending it.
