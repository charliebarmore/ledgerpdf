# Changelog

All notable changes will be documented here. LedgerPDF follows Semantic
Versioning once a stable compatibility promise is published.

## [Unreleased]

## [0.1.3] - 2026-08-12

### Fixed

- Detect LedgerPDF copies whose marks were flattened into permanent page
  content and warn before opening them as a new binder, so a printed note icon
  is not mistaken for a broken clickable comment. Existing flattened copies are
  recognized as well as newly created ones.

## [0.1.2] - 2026-08-12

### Added

- Let `binder_export` replace its own prior export at the same canonical path
  only when the file's SHA-256 still matches the provenance recorded in this
  binder's journal. Modified, unrelated, symlinked, or mid-export replacement
  files remain protected.

## [0.1.1] - 2026-08-11

### Security

- Made the visible approved-folder list authoritative and removed environment
  overrides for it from the shipped application.
- Added cross-process binder leases and live revision checks so concurrent
  agents or a user-and-agent race fail safely instead of replacing newer work.
- Prevented standalone agents from silently overwriting unrelated existing
  binders, exports, or cover memos.

### Fixed

- Made every new/reopened window query authoritative live-agent state so the
  indicator cannot display "off" while the local socket is active.
- Clarified that the status-bar switch controls only the binder on screen and
  that approved folders grant persistent standalone read/write access.
- Made long mark and shape notes wrap in the inspector instead of clipping.
- Made OCR fall back to Tesseract when macOS Vision is installed but fails at
  runtime, while still reporting which engine produced the reading.

## [0.1.0] - 2026-08-11

Initial public alpha.

### Security

- Disabled PDF-embedded scripting and upgraded PDF.js to a patched release.
- Enforced owner-only, atomic binder working copies on POSIX.
- Enforced approved-folder boundaries on live agent pushes and bounded local
  socket messages.

### Packaging

- Made release builds clean-output-first and required the MCP server bundle.
- Added project licensing and third-party notices to packaged applications.
- Added platform-independent MCP registration and complete macOS notarization
  credential handling.

[Unreleased]: https://github.com/charliebarmore/ledgerpdf/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/charliebarmore/ledgerpdf/releases/tag/v0.1.3
[0.1.2]: https://github.com/charliebarmore/ledgerpdf/releases/tag/v0.1.2
[0.1.1]: https://github.com/charliebarmore/ledgerpdf/releases/tag/v0.1.1
[0.1.0]: https://github.com/charliebarmore/ledgerpdf/releases/tag/v0.1.0
