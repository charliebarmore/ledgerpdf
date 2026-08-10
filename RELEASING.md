# Releasing LedgerPDF

Release binaries must come from a clean checkout and must be signed. Local
`package:dir` output is for verification only and must never be distributed.

## 1. Prepare the source release

1. Update the version in `app/package.json`, its lockfile, and `CHANGELOG.md`.
2. Regenerate Python locks with `uv pip compile --universal --python-version 3.12
   --generate-hashes` for both requirement input files.
3. Install from the lockfiles and run `npm ci`.
4. Run `npm audit --omit=dev`, a Python dependency audit, and secret scanning.
5. Run `npm run verify`, `npm run verify:viewers`, `npm run package:dir`, and
   `npm run verify:package` from `app/`.

The packaged verifier reads the actual binary's complete Electron fuse wire,
requires the renderer to load from `ledgerpdf://app`, checks that the MCP server
and legal/SBOM resources are present, and rejects stale test bundles.

## 2. Build signed artifacts

`npm run dist` refuses unsigned distribution. On macOS, provide a Developer ID
identity plus one complete notarization credential path:

- `APPLE_KEYCHAIN_PROFILE` (preferred), or
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`, or
- `APPLE_API_KEY`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`.

`WPT_SIGNED_RELEASE` is compared against the literal string `true`. Any other
value — `1` included — silently produces a build that is not a signed release
while looking like one.

### The packaging Python must not be Conda-derived

`build:engine` refuses a signed release whose Python has a Conda base prefix,
so the frozen runtime inside a signed binary has controlled provenance. A
development venv created from Anaconda builds fine day to day and fails only
here, which is the intended split.

Keep a release-only environment and point `WPT_BUILD_PYTHON` at it, rather than
rebuilding the development venv:

```bash
uv python install 3.12
uv venv --managed-python --python 3.12 ~/.local/share/ledgerpdf/release-venv
uv pip install --python ~/.local/share/ledgerpdf/release-venv/bin/python \
  --require-hashes -r engine/requirements.lock
uv pip install --python ~/.local/share/ledgerpdf/release-venv/bin/python \
  --require-hashes -r engine/requirements-build.lock
uv pip install --python ~/.local/share/ledgerpdf/release-venv/bin/python pip
```

Two traps that cost a build each. `uv venv --python 3.12` **discovers system
interpreters first** and will hand back Anaconda's; `--managed-python` is what
forces a clean one, and the guard only reports the base prefix, so confirm it:

```bash
~/.local/share/ledgerpdf/release-venv/bin/python \
  -c 'import sys; print(sys.base_prefix)'
```

And `uv venv` creates an environment **without pip**, which `release:metadata`
needs for `pip inspect --local` — hence the last line above. It is a build-time
tool only; PyInstaller bundles what the engine imports, so it never ships.

Then, from `app/`:

```bash
WPT_BUILD_PYTHON=~/.local/share/ledgerpdf/release-venv/bin/python \
APPLE_KEYCHAIN_PROFILE=ledgerpdf-notary \
WPT_SIGNED_RELEASE=true npm run dist
```

### Windows

Windows releases are **not signed yet and ship anyway**. Azure Trusted Signing
requires three years of verifiable business history and Ledger Labs LLC was
formed in June 2025, so `WPT_AZURE_*` (documented in
`app/electron-builder.config.cjs`) cannot be satisfied until 2028. An interim
OV certificate is in progress; when it lands, sign in the tag-triggered release
workflow only.

Shipping unsigned is a deliberate decision, not an oversight. The functional
blocker was mark-of-the-web, which the NSIS installer already defeats — MOTW
rides the downloaded installer, not the files it writes. What remains is one
SmartScreen publisher warning, which the README and `docs/INSTALL-WINDOWS.md`
explain as identity verification rather than a safety verdict.

Verify the exact final DMG/installer, record SHA-256 hashes, and retain the
matching source commit and generated SBOMs. Do not substitute a locally modified
artifact after signing.

## 3. Publish from a clean public history

Do **not** change the existing private engineering repository to public. Its old
history contains internal business and personal workflow context even though it
contains no known credentials.

After committing and verifying the release candidate, run:

```bash
tools/release/prepare-public-tree.sh /absolute/path/to/new-ledgerpdf-public
```

Review and secret-scan that exported tree, initialize a new Git repository in
it, and make a single clean root commit. Before pushing, run the launch-only
history check from the engineering repository:

```bash
node tools/release/check-initial-public-history.mjs \
  /absolute/path/to/new-ledgerpdf-public
```

It requires one untagged `main` root named exactly `Initial public release`, a
clean worktree, and only the project's GitHub noreply author/committer identity.
This prevents session links, co-author trailers, personal email addresses, or
incremental pre-launch history from escaping through commit metadata after the
tree itself has passed review. It is deliberately an initial-publication check,
not a rule for normal open-source development after launch.

Push that new history to the public repository, tag the source commit matching
the binaries, and attach only the signed artifacts and their checksums.
