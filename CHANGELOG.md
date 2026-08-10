# Changelog

All notable changes will be documented here. LedgerPDF follows Semantic
Versioning once a stable compatibility promise is published.

## [Unreleased]

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

## [0.1.0] - Unreleased

- Initial public alpha.
