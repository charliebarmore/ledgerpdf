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
- **The binder PDF is the document.** Saving writes the assembled pages plus the
  editable session — page order, bookmarks, reviewer names/initials, mark
  positions and notes, and calculator tape entries — stored inside the PDF at two
  anchors (`spike/CARRIER-SPIKE.md`). The session records where each page came
  from as provenance; it does not embed page images or extracted page text, and
  the binder does not need those originals present in order to open.
- While a binder is open, two hidden siblings sit beside it and are deleted on a
  clean close: `.<name>.wpt-working.pdf`, the binder with our own marks stripped
  so the app can draw its interactive layer without doubling them, and
  `.<name>.wpt-recovery.json`, the autosave that avoids rewriting a large PDF on
  a timer. They are siblings rather than files in the OS temp directory
  deliberately: a working copy of a binder is client data and belongs in the
  engagement folder the firm already governs. Both are owner-only (`0600`) on
  POSIX; Windows permissions inherit from the chosen folder. A crash can strand
  a working copy, so opening a binder overwrites any already beside it.
- **"Save a copy to send out"** produces the distribution copy: marks flattened
  into the page content and **no session inside**. An inherited session from the
  binder it was built from is stripped before writing, so the firm's editable
  working record never travels to a recipient.
- The older two-file `.wptsession.json` format still opens, once, so nothing made
  before this change is stranded. Saving converts it to a binder; the app never
  writes that format again. The MCP server still uses it as its handoff.
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
- A binder records a fingerprint of its own page geometry (page count, order, box
  sizes, rotation) and reports on open when another program has moved the pages
  underneath the marks. It deliberately excludes content-stream bytes, so a
  lossless rewrite does not raise a false alarm — and equally, it does not detect
  a rewrite that changed page *content* without moving anything. It says the
  marks may no longer line up; it does not repair them.
- There is no role-based access control, engagement lock, reviewer sign-off,
  immutable audit log, or centralized administration. The session is an
  editable local workpaper, not yet a complete firm document-management system.
- Signing/notarization establishes publisher identity and artifact integrity;
  it does not encrypt client data or make PDF parsing risk-free.
