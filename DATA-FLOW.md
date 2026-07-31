# Workpaper Binder data flow

This describes the current desktop beta boundary for a CPA using client tax and
accounting PDFs. It is a product disclosure, not a claim of regulatory
certification.

```text
User-selected PDF/image ─read only─┐
                                  ├─ Electron main ─JSON/stdin─ frozen PDF engine
User-selected session ─read/write─┘                        │
          │                                                │
          ├─ previous complete recovery copy               └─ validated PDF
          └─ editable marks, tapes, bookmarks                    │
                                                                 └─ user-selected export

Optional MCP client ─local stdio─ MCP server ─same session model/engine─ approved roots
```

## Desktop application

- Source PDFs and images stay at the paths the user selected and are opened
  read-only. Their SHA-256 fingerprints are stored in the session and checked
  on reopen and before and after export.
- A `.wptsession.json` stores source paths and fingerprints, page order,
  bookmarks, reviewer names/initials, mark positions and notes, and calculator
  tape entries. It does not embed page images or extracted page text.
- After the first manual save, the session autosaves to that same location. A
  sibling `*.recovery.wptsession.json` retains one previous complete generation.
  Both are owner-only (`0600`) on POSIX; Windows permissions inherit from the
  chosen folder.
- Export writes a temporary file beside the chosen output, validates it, then
  atomically replaces the destination. A source file can never be the export
  target. The app does not maintain a cloud copy, recent-file database, or
  telemetry record.
- The renderer has no Node.js access and no generic file API. The Electron main
  process authorizes user-selected paths, denies navigation/popups/webviews and
  browser permissions, and is the only desktop component that opens files.
- PDF parsing and writing run in a bounded child process with a minimal
  environment, a five-minute deadline, and a 16 MB protocol-output limit. In a
  packaged build that child is a sealed, platform-native executable; ambient
  Python is never invoked.
- The desktop app makes no application network requests. Its content security
  policy allows no remote renderer origin.

## Optional MCP/agent path

MCP is a separate, opt-in local process; it is not required for the desktop
app. File operations are disabled unless `WPT_MCP_ROOTS` names approved
engagement folders. Canonical-path checks reject access and symlink escapes
outside those roots.

An MCP client can receive file paths and names, page counts/order/rotation,
bookmark titles, and mark/tape metadata. It cannot request extracted page text
through the current tools. That is still a disclosure surface: paths, bookmark
titles, reviewer notes, and tape amounts can identify a taxpayer or reveal tax
information. Whether the MCP client sends that data to a hosted model depends
on that client and provider, not Workpaper Binder. Do not enable MCP on client
engagements until the firm's IRC §7216, privacy, vendor, and consent analysis
allows it.

## Storage, retention, and deletion

Workpaper Binder does not encrypt files itself or enforce a retention schedule.
Use an approved engagement folder on a FileVault/BitLocker-encrypted device
with firm-managed backup, access control, retention, and secure-disposal
policies. Deleting an engagement means deleting the sources, session, recovery
copy, and exports from every backup/location governed by those policies; the
app cannot promise forensic secure erase on SSDs or synced storage.

## Important limits

- Application path controls are not an operating-system sandbox around the PDF
  engine. A successful exploit in a native PDF dependency would run with the
  signed-in user's OS permissions. Keep pikepdf/qpdf and Pillow patched and
  treat parser sandboxing as a security-hardening item before broad deployment.
- The app does not yet detect a previously exported binder modified by another
  program. The session/source fingerprints protect inputs, not distributed
  output copies.
- There is no role-based access control, engagement lock, reviewer sign-off,
  immutable audit log, or centralized administration. The session is an
  editable local workpaper, not yet a complete firm document-management system.
- Signing/notarization establishes publisher identity and artifact integrity;
  it does not encrypt client data or make PDF parsing risk-free.
