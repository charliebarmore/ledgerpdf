# Dock launcher (macOS)

A double-clickable `LedgerPDF.app` that starts the dev build, so the tool
can be pinned to the Dock and used day to day.

```bash
(cd app && npm run build:icon)   # only if icon.png is missing
tools/launcher/build.sh          # installs to /Applications
```

Then drag it from `/Applications` into the Dock. Don't right-click the *running*
icon and "Keep in Dock" — that pins Electron, not this launcher.

## What this is and isn't

**It is a shortcut.** It runs `npm run dev` in this repo, so the repo,
`app/node_modules` and `engine/.venv` all have to be present. Move or rename the
repo and it breaks — with an alert, not silently. It can't be handed to anyone
else.

**It is not a packaged app.** The release pipeline builds the real application,
bundles the frozen Python engine and PDF.js assets, and verifies `file://`
rendering. Signed distribution additionally requires the credentials and checks
documented in `../../RELEASING.md`.

## Two traps, both hit while building this

**An applet launched by LaunchServices dies silently mid-script.** If any
`do shell script` exits non-zero, AppleScript raises, and an applet with no
window shows nothing at all — no error, no log line. It looks exactly like
"clicking the icon does nothing." **Every `do shell script` in
`launcher.applescript` is wrapped in `try` for this reason. Don't remove them.**
When debugging, log first and log often; `~/Library/Logs/WorkpaperBinder.log` is
the only visibility you get.

**`pgrep -f` can match the shell running the `pgrep`.** The "already running?"
guard originally used `pgrep -f 'â€¦/node_modules/electron'`, whose own command
line contains that string. It matched itself, concluded the app was already up,
and returned without launching anything. The guard now matches the process
*name* (`pgrep -x Electron`).

A hand-rolled `.app` bundle wrapping a shell script — `Contents/MacOS/launch`
with an `Info.plist` — also proved unreliable: it ran when executed directly but
LaunchServices would not consistently start it. `osacompile` produces a bundle
with a real executable stub and works. That's why this is an applet.

## While it's running

`app.dock.setIcon()` in `app/src/main/index.ts` gives the running app the proper
Dock icon (from `app/resources/icon.png`) instead of a generic Electron diamond,
and the window title is "LedgerPDF".

**The menu bar and ⌘-Tab still say "Electron", and `app.setName()` does not
change that.** In a dev build the application-menu title comes from the *bundle*
identity — Electron.app's `CFBundleName` — not from `setName`. Forcing it would
mean hand-rolling the whole application menu via `Menu.setApplicationMenu`,
which risks regressing the standard Edit/Window shortcuts for a cosmetic gain.
Real packaging fixes it properly; leave it until then.

The launcher applet stays alive alongside the app rather than exiting straight
away — `do shell script` holds until the spawned process ends. It's LSUIElement
so it takes no Dock tile, and it exits when the app quits, so it's a 1:1
companion rather than a leak.

Startup takes a few seconds: it builds and starts a Vite dev server first.
