# Changelog

All notable changes will be documented here. LedgerPDF follows Semantic
Versioning once a stable compatibility promise is published.

## [Unreleased]

## [0.3.1] - 2026-08-17

### Added

- Added a crash-recovery choice when a newer hidden autosave is found. Review
  marks, notes, shapes, tapes, statuses, and journal work can be recovered into
  the open binder and remain dirty until the reviewer saves.

### Fixed

- Preserved recovery evidence when the reviewer cancels an open or when the
  autosave is corrupt or contains unsaved page-order, rotation, add/remove, or
  bookmark changes. Those structural changes are stopped with an explicit
  warning instead of being rebound to the wrong physical pages or discarded
  silently.

## [0.3.0] - 2026-08-15

### Added

- Remembered placement size separately for each mark and lettered stamp, as a
  per-user preference that survives reopening the app without altering binders.
- Added a placeable date stamp for people and MCP agents. It records the local
  calendar day separately from the UTC placement timestamp, exports and
  flattens like other marks, and cannot be backdated through editable text.

### Changed

- Advanced the embedded session format to v3 for the new date-mark record.
  Older v1/v2 binders remain readable; builds that only understand v2 reject a
  v3 binder explicitly instead of silently drawing a date mark as a tick.
- Bound live agent access to the exact binder window that enabled it. Closing
  that window now ends the socket rather than reopening a blank session under
  the same connection.

### Fixed

- Preserved clickable connector and binder-tie links when a saved binder is
  reopened, while removing the prior generated links from its working copy so
  repeated saves neither drop nor duplicate PDF link annotations.
- Queued live-agent calls until the renderer has registered its listener, and
  replaced the blocking unsaved-changes close dialog with an asynchronous one
  that immediately tells agents what is blocking them instead of timing out.

## [0.2.1] - 2026-08-14

### Changed

- Kept agent-proposed Reviewed and N/A statuses in the human review queue until
  a person confirms them, instead of allowing agent work to close its own
  review requirement.

### Fixed

- Preserved filled PDF form fields and generated missing appearances during
  export, and surfaced successful-engine warnings that were previously lost.
- Refused multi-page image files instead of silently importing only their first
  frame, with conversion-to-PDF guidance in the error.
- Kept live-agent run state out of desktop sessions, saves, autosaves and
  exports; reset that state when the desktop switches binders; and attributed
  agent-set page statuses explicitly rather than printing them as human work.
- Prevented a live agent from replacing the binder on screen with a new empty
  binder, and rebased asynchronous imports and legend generation onto the
  latest live session so concurrent work is not lost.
- Opened Windows and Linux file-association launches correctly when the app is
  cold, and refused macOS agent-registration commands from temporary DMG or
  translocated paths.
- Aligned the frozen engine and embedded binder provenance version with the app
  release version, with source and packaged version-match checks.
- Described structural-only agent runs as having nothing to undo instead of
  claiming they had already been reverted.

## [0.2.0] - 2026-08-13

### Added

- Added a Review Center that brings open notes and crosses, source coverage,
  page-status progress, connector integrity, and agent-run history into one
  reviewer workflow with direct page jumps and run-level undo.
- Added a send-out preflight before permanent flattened copies are created,
  separating items that need attention from advisories and requiring an
  explicit second confirmation to send with open review items.

### Changed

- Made reviewer decisions time-aware: Reviewed or N/A resolves findings that
  existed when the status was applied, while a later finding reopens the page
  without deleting the earlier review evidence.

## [0.1.4] - 2026-08-12

### Fixed

- Replaced the ambiguous `by AI` status with an `AI-created items` total and
  displayed shapes alongside marks and tapes, so every page item contributing
  to the total is visible.
- Distinguished logged agent actions from the items still present in a binder,
  and made each run's Undo count match every mark, tape, shape, link, and
  bookmark that Undo will actually remove.

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

[Unreleased]: https://github.com/charliebarmore/ledgerpdf/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/charliebarmore/ledgerpdf/releases/tag/v0.3.1
[0.3.0]: https://github.com/charliebarmore/ledgerpdf/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/charliebarmore/ledgerpdf/releases/tag/v0.2.1
[0.2.0]: https://github.com/charliebarmore/ledgerpdf/releases/tag/v0.2.0
[0.1.4]: https://github.com/charliebarmore/ledgerpdf/releases/tag/v0.1.4
[0.1.3]: https://github.com/charliebarmore/ledgerpdf/releases/tag/v0.1.3
[0.1.2]: https://github.com/charliebarmore/ledgerpdf/releases/tag/v0.1.2
[0.1.1]: https://github.com/charliebarmore/ledgerpdf/releases/tag/v0.1.1
[0.1.0]: https://github.com/charliebarmore/ledgerpdf/releases/tag/v0.1.0
