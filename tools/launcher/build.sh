#!/bin/bash
#
# Build "LedgerPDF.app" — a Dock launcher for the dev build.
#
#   tools/launcher/build.sh            -> /Applications
#   tools/launcher/build.sh ~/Applications
#
# This is a SHORTCUT, not a packaged app. It starts the dev build out of this
# repo, so the repo, app/node_modules and engine/.venv must all be present on
# the machine. Real packaging is handled by the release pipeline in RELEASING.md.
#
# The AppleScript source contains a placeholder; this script writes the current
# checkout path into the compiled applet. If you move the repo, rebuild.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEST="${1:-/Applications}"
APP="$DEST/LedgerPDF.app"
ICON_PNG="$REPO/app/resources/icon.png"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

[ -f "$ICON_PNG" ] || {
  echo "missing $ICON_PNG — run: engine/.venv/bin/python tools/launcher/make-icon.py" >&2
  exit 1
}

# 1. PNG -> .icns via an iconset of the sizes macOS asks for.
mkdir -p "$WORK/icon.iconset"
for sz in 16 32 128 256 512; do
  sips -z $sz $sz "$ICON_PNG" --out "$WORK/icon.iconset/icon_${sz}x${sz}.png" >/dev/null
  sips -z $((sz * 2)) $((sz * 2)) "$ICON_PNG" \
    --out "$WORK/icon.iconset/icon_${sz}x${sz}@2x.png" >/dev/null
done
iconutil -c icns "$WORK/icon.iconset" -o "$WORK/AppIcon.icns"

# 2. Compile the applet. osacompile produces a proper bundle with a real
#    executable stub — a hand-rolled bundle wrapping a shell script is NOT
#    launched reliably by LaunchServices.
rm -rf "$APP"
ESCAPED_REPO="${REPO//|/\\|}"
sed "s|__LEDGERPDF_REPO__|$ESCAPED_REPO|g" \
  "$REPO/tools/launcher/launcher.applescript" > "$WORK/launcher.applescript"
osacompile -o "$APP" "$WORK/launcher.applescript"

# 3. Icon + identity.
cp "$WORK/AppIcon.icns" "$APP/Contents/Resources/applet.icns"
/usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string 'LedgerPDF'" \
  "$APP/Contents/Info.plist" >/dev/null 2>&1 || true
/usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string co.ledgerlabs.ledgerpdf-launcher" \
  "$APP/Contents/Info.plist" >/dev/null 2>&1 || true
# The launcher must never claim its own Dock tile — the running app is Electron,
# and two tiles for one app is just confusing. Pinning this bundle still works.
/usr/libexec/PlistBuddy -c "Add :LSUIElement bool true" \
  "$APP/Contents/Info.plist" >/dev/null 2>&1 || true
touch "$APP"

# 4. Tell LaunchServices about it, or Finder may ignore the new bundle.
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
  -f "$APP" 2>/dev/null || true

echo "built $APP"
echo "Drag it from $DEST into the Dock to pin it."
