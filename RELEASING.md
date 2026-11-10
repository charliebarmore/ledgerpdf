# Releasing LedgerPDF

Release binaries must come from a clean checkout. macOS release binaries must
be signed and notarized; Windows currently follows the explicitly unsigned
release path documented below. Local `package:dir` output is for verification
only and must never be distributed.

## 1. Prepare the source release

Prepare and review product changes in the private engineering repository.
Check `git remote -v` before pushing and confirm that development PRs target
that repository. `charliebarmore/ledgerpdf` is the sanitized release mirror;
publish there only through the separate export checkout in step 3.

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

## 2. Build release artifacts

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
RELEASE_VENV="${XDG_DATA_HOME:-$HOME/.local/share}/ledgerpdf/release-venv"
uv python install 3.12
uv venv --managed-python --python 3.12 "$RELEASE_VENV"
uv pip install --python "$RELEASE_VENV/bin/python" \
  --require-hashes -r engine/requirements.lock
uv pip install --python "$RELEASE_VENV/bin/python" \
  --require-hashes -r engine/requirements-build.lock
uv pip install --python "$RELEASE_VENV/bin/python" pip
```

Two traps that cost a build each. `uv venv --python 3.12` **discovers system
interpreters first** and will hand back Anaconda's; `--managed-python` is what
forces a clean one, and the guard only reports the base prefix, so confirm it:

```bash
"$RELEASE_VENV/bin/python" \
  -c 'import sys; print(sys.base_prefix)'
```

And `uv venv` creates an environment **without pip**, which `release:metadata`
needs for `pip inspect --local` — hence the last line above. It is a build-time
tool only; PyInstaller bundles what the engine imports, so it never ships.

Then, from `app/`:

```bash
WPT_BUILD_PYTHON="$RELEASE_VENV/bin/python" \
APPLE_KEYCHAIN_PROFILE=ledgerpdf-notary \
WPT_SIGNED_RELEASE=true npm run dist
```

### Windows

Windows releases are **not signed yet and ship anyway**. Microsoft now calls
the service [Azure Artifact Signing](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart#prerequisites),
and public-trust onboarding is available to U.S. organizations. LedgerPDF has
not completed identity validation and certificate-profile setup. The
`WPT_AZURE_*` integration is already present in
`app/electron-builder.config.cjs`; once onboarding is complete, use it only in
a dedicated release build and verify the exact signed installer before
publication.

Shipping unsigned is a deliberate decision, not an oversight. The functional
blocker was mark-of-the-web, which the NSIS installer already defeats — MOTW
rides the downloaded installer, not the files it writes. What remains is one
SmartScreen publisher warning, which the README and `docs/INSTALL-WINDOWS.md`
explain as identity verification rather than a safety verdict.

Verify the exact final DMG/installer, record SHA-256 hashes, and retain the
matching source commit and generated SBOMs. Do not substitute a locally modified
artifact after signing or after final unsigned Windows verification.

## 3. Publish the sanitized source tree

Do **not** change the existing private engineering repository to public. Its old
history contains internal business and personal workflow context even though it
contains no known credentials.

After committing and verifying the release candidate, export the exact commit
to a new temporary directory:

```bash
tools/release/prepare-public-tree.sh /absolute/path/to/ledgerpdf-public-export
```

The public repository already exists. Clone it separately, replace its tracked
tree with the sanitized export while preserving only its `.git` directory, and
create a release branch from public `main`, and review the resulting incremental diff:

```bash
git clone https://github.com/charliebarmore/ledgerpdf.git \
  /absolute/path/to/ledgerpdf-public-checkout
git -C /absolute/path/to/ledgerpdf-public-checkout switch -c release/public-update
rsync -a --delete --exclude .git \
  /absolute/path/to/ledgerpdf-public-export/ \
  /absolute/path/to/ledgerpdf-public-checkout/
node /absolute/path/to/ledgerpdf-public-checkout/tools/release/check-public-tree.mjs \
  --private-terms /absolute/path/to/private-terms.json \
  /absolute/path/to/ledgerpdf-public-checkout
git -C /absolute/path/to/ledgerpdf-public-checkout diff --check
git -C /absolute/path/to/ledgerpdf-public-checkout status --short
```

Review and secret-scan the exported tree before committing it on the release
branch. In this separate reviewed export checkout, enable the publication
guard's release mode as the maintainer instructions describe.
Push only that branch and open a pull request targeting public `main`;
merge only after the required checks pass and the sanitized diff is reviewed.
Confirm that the merged public commit contains the same application source used
for the final binaries, then tag that public commit. Never push engineering
branches, backup refs, private tags, or private history to the public remote.
Never force-push or replace the public repository's existing history.

The tree validator independently enforces the approved export roots and rejects
private working directories, credential and saved-book filenames, personal paths,
private workspace/session URLs, concrete vault references, and symlinks. Run the
export regression suite before releasing; it is kept outside the public export. These checks complement secret
scanning and human review: they do not prove that arbitrary prose, binary assets,
or Git history are safe. The exporter copies a tree only; the separate public
checkout and release PR preserve the boundary around private history.

`tools/release/check-initial-public-history.mjs` is retained only for recreating
the one-time initial public root in a brand-new repository. It must not be run
for subsequent releases because it intentionally rejects incremental history.

After merging the sanitized release PR, tag the source commit matching the
binaries and attach only the verified artifacts and their checksums.
