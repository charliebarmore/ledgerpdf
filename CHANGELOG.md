# Changelog

All notable changes will be documented here. LedgerPDF follows Semantic
Versioning once a stable compatibility promise is published.

## [Unreleased]

### Added

- Added a binder-owned compilation handoff with input hashes/dispositions,
  agent-reported checks and source references, and findings without page targets.
  These findings appear in Review, MCP queues and send-out preflight; humans can
  resolve them while retaining the preparation record. MCP records a handoff once
  in a fresh unsaved binder with `binder_record_handoff`.
- Added a reproducible synthetic engagement acceptance packet, an opt-in external
  Claude Code runner, an independent artifact verifier, and a compilation skill.

### Changed

- Session format v6 preserves filing decisions in handoff version 2, alongside
  section dividers; this build continues to read v1-v5 binders and older handoffs.
  Earlier builds refuse new editable saves.
- Compilation inputs retain filing reasons and quotes verified against their
  own pages. Missing or unverifiable support moves the input to Needs filing
  before the cover is generated and creates one unresolved input review item.
  Review exposes the proposed section and source evidence; quote verification
  does not establish the correctness of the agent's interpretation.
- Shortened compilation covers by linking to page review notes instead of
  repeating them, and tightened compilation instructions around actionable
  findings, unreadable inputs and superseded versions.
- Expanded the engagement verifier to check source hashes, dispositions,
  evidence provenance, bookmark order and actual annotation footprints.
- Advanced the embedded session format to v4 so earlier builds refuse the new
  compilation record rather than silently discarding it. v1-v3 binders remain readable.

- Added a visible Review binder entry above the document. Empty review queues
  now say "No flagged findings" and show pages without review status; Coverage
  separates AI-proposed statuses from human statuses. The review drawer receives
  keyboard focus, contains Tab navigation, and returns focus when closed.
- Recorded the engagement-compilation direction, external-agent boundary,
  binder-owned handoff, prior-year reference, and fresh-binder scope in DECISIONS.md.

### Fixed

- Inspector notes, author initials and stamp text now update the binder while
  typing, so changing selection cannot discard an edit. Each focused edit is
  one undo step; Escape cancels it without overwriting a later external update.
  Cmd/Ctrl+S also saves from a focused inspector field.
- Saving a plain PDF or importing another binder now preserves its existing
  LedgerPDF annotations. Imported ownership metadata is retained as provenance,
  so both current and older cleanup logic leave those source marks alone on
  reopen. Current editable marks still replace their prior generation, and
  deleting one does not restore it on the next save.

- Review pass 2026-10-20 (fresh-eyes review):
  - Quitting no longer deletes the autosave, drops the working copy and
    releases the binder lease *before* the unsaved-changes prompt; cleanup
    moved from `before-quit` to `will-quit`, and Cmd+Q followed by "Discard
    changes" now finishes quitting on macOS instead of leaving a windowless app.
  - A lost binder lock (sync client removing the hidden lock folder, a share
    stalling past 30 s) logs instead of raising an uncaught exception that
    showed a crash dialog in the app or killed the MCP process.
  - Live agent access start/stop is serialized, so a double-click on the
    toggle cannot orphan a socket or delete the endpoint file under a handle
    that says on. The live token is compared in constant time.
  - Rotating a page now carries its marks, tapes, shapes and link rects with
    it. Before, the page turned under the annotations and the export drew
    them over different content. Covered by five new model checks.
  - One page that fails to render shows its error in its own slot; it no
    longer blanks the whole binder until reopen. Failed document, image and
    link loads are no longer cached as permanent failures.
  - Closing a binder destroys its pdf.js document in the worker and clears
    its link hit regions, so a reopened binder no longer shows the previous
    binder's links.
  - After an undo or revert removed the active tape, Esc, Delete, arrows and
    the tool letters were swallowed; the keyboard gate now follows the tape
    that exists. Modifier shortcuts and Tab pass through a focused tape card.
    Holding Delete or `[`/`]` no longer cascades through pages.
  - MCP `binder_read_page`, `binder_find` and `binder_read_cells` now check
    the approved folders at read time, as the server header and README state;
    sources that entered a live session from outside those folders, or whose
    folder was removed later, were readable. `binder_add_cover` refuses to
    write through a symbolic link. README tool count corrected to 38.
  - Engine: `read_session` falls back to the page-level copy when the
    document-level copy is damaged, instead of reporting "no session" with an
    intact copy present. Probe tolerates null `/Annots` entries and non-JSON
    private data. CSV row and column truncation is reported, chart sheets
    are skipped with a warning instead of aborting the import, and read-only
    workbooks re-measure their own dimensions so a wrong `<dimension>` tag no
    longer drops rows. A sheet that would exceed the per-sheet page cap is
    refused loudly instead of silently truncated. A killed engine now runs
    its cleanup and removes temp files. OCR settings (`WPT_TESSERACT`,
    `WPT_OCR_ENGINE`, `TESSDATA_PREFIX`) reach the engine. Fixed an unbound
    variable when a page rendered empty for OCR.
  - A second launch with a relative path resolves it against that launch's
    working directory.

- Compilation section headings now group imported document bookmarks through
  `binder_add_section`, preserving their nested outlines and page order.
- Evidence references display the worksheet name once in Review and generated
  covers, including references already qualified with a sheet name.
- `binder_find` now reserves room for the whole mark and nearby text, using
  displayed page dimensions. It reports when no nearby position fits instead
  of clamping a mark onto the page edge. Optional `markSize` controls clearance.
- Automatic ties use 14-point marks by default, with matching link areas, so
  adjacent workpaper rows remain distinct. Callers can request another size.
- Footing stamps sit outside their calculator tapes using the tape's actual
  height; the tape no longer paints over the stamp.
- Bundle the handoff validator into Electron main so the packaged app starts
  without relying on development-only `node_modules`.
- Prevented a delayed mark-size preference response from replacing a newer
  placement size while a reviewer resizes and immediately places another mark.

### Security

- Updated Electron to 43.8.7, the MCP SDK to 1.32.2, Vite to 7.3.8 and their
  transitive dependencies within the existing version ranges; only the lockfile
  changed. `npm audit --omit=dev` reports no known vulnerabilities.

### Documentation

- Reordered the README so the architecture, verification approach and
  development model come before the professional-considerations sections, and
  added a source map. The Linux suite now also runs on `main`.

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
