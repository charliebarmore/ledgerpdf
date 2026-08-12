# LedgerPDF data flow

This describes the current desktop beta boundary for a CPA using client tax and
accounting PDFs. It is a product disclosure, not a claim of regulatory
certification.

**Read that second sentence literally.** This document sets out what the software
does and what it does not do. It makes no assurances about any obligation you
work under, and nothing here is a compliance claim or a legal opinion. It exists
so the evaluation can be made against facts rather than adjectives, by the person
whose determination it actually is.

The shortest version, before the detail:

- **Does:** runs entirely on your machine with no network calls; keeps binders,
  working copies and recovery files in the engagement folder you chose;
  opens sources read-only and fingerprints them; attributes, journals and
  reverses agent work; publishes its source so all of this can be checked.
- **Does not:** encrypt files, enforce retention, guarantee secure erasure,
  provide access control or an audit log, decide what an agent may read, control
  what your AI client does with what it reads, or make any determination about
  any regime named below.

The regimes below are raised because a practitioner will have to think about
them, not because this software answers them. Each row is the question, not the
verdict:

| Regime | What a practitioner will want to work out | What this document gives them to work with |
|---|---|---|
| **IRC §7216 / §6713**, consent rules at Treas. Reg. §301.7216-3 | Whether any step involves a disclosure or use of return information, and what consent that calls for | Exactly what leaves the application, when, and at whose instruction |
| **FTC Safeguards Rule, 16 CFR Part 314** (Gramm-Leach-Bliley), and the written information security plan it requires | How a local tool fits an existing WISP, and which controls the firm still has to supply | Where every file lives, which are owner-only, and which controls the app does not provide. IRS Pubs 4557 and 5708 are useful references |
| **Circular 230, 31 CFR Part 10** | How machine-produced work is supervised, and how a reviewer distinguishes it | What an agent may do, and how its work is attributed, journalled and reversed |
| **AICPA Code of Professional Conduct**, Confidential Client Information Rule and its third-party service provider interpretation | Whether connecting a model provider brings a third party into the engagement, and what consent or agreement that calls for | That there is no vendor, processor, or account in the path by default, and precisely where introducing one would change that |
| State board rules and state breach-notification statutes | Everything this document does not cover, which varies by jurisdiction | The storage, retention, and deletion limits stated at the end, which the app does not enforce |

Two structural facts do most of the work in every row: **the application makes no
network calls at all**, and the only thing that can carry data off the machine is
an AI client the practitioner connects, which is a separate program under the
practitioner's control rather than a behaviour of this software. The rest of this
document is the detail behind those two facts.

```text
User-selected PDF/image ─read only─┐
                                  ├─ Electron main ─JSON/stdin─ frozen PDF engine
User-selected session ─read/write─┘                        │
          │                                                │
          ├─ previous complete recovery copy               └─ validated PDF
          └─ editable marks, tapes, bookmarks                    │
                                                                 └─ user-selected export

Optional MCP client ─local stdio─ MCP server ─same session model/engine─ approved roots
                                       │
                                       └─ live mode: local socket / named pipe,
                                          token-authenticated, to the open window
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
  POSIX; Windows permissions inherit from the chosen folder. A hidden
  cross-process lease beside the binder allows only one LedgerPDF/standalone
  agent writer at a time. A crash can strand a working copy, so after the stale
  lease is recovered, opening the binder replaces that derived copy.
- **"Save a copy to send out"** produces the distribution copy: marks flattened
  into the page content and **no session inside**. An inherited session from the
  binder it was built from is stripped before writing, so the firm's editable
  working record never travels to a recipient.
- The older two-file `.wptsession.json` format still opens, once, so nothing made
  before this change is stranded. Saving converts it to a binder; neither the
  app nor MCP writes that format again. Standalone MCP uses the same editable
  binder PDF as its handoff; in live mode it acts on the open window's own
  session and the app owns the save path.
- Export writes a temporary file beside the chosen output, validates it, then
  atomically commits it. MCP records the canonical path and SHA-256 of each
  successful export in the binder journal. It may replace that exact path only
  while the current bytes still match the recorded hash; it checks again at the
  engine's final commit point so an edit or file created during materialization
  is refused. Unrelated, modified, and symlinked destinations remain protected.
  A source file can never be the export target. The app does not maintain a
  cloud copy, recent-file database, or telemetry record.
- The renderer has no Node.js access and no generic file API. The Electron main
  process authorizes user-selected paths, denies navigation/popups/webviews and
  browser permissions, and is the only desktop component that opens files. A
  packaged renderer loads from the restricted `ledgerpdf://app` origin; its
  protocol handler can resolve only assets beneath the bundled renderer root.
- Packaged Electron binaries disable Node options/inspector arguments, require
  app code from the integrity-checked ASAR, and remove `file://`'s extra
  privileges. Run-as-Node stays enabled only for the installed MCP command and
  is exercised by the package verifier.
- PDF parsing and writing run in a bounded child process with a minimal
  environment, a five-minute deadline, and a 16 MB protocol-output limit. In a
  packaged build that child is a sealed, platform-native executable; ambient
  Python is never invoked.
- The desktop app makes no application network requests. Its content security
  policy allows no remote renderer origin.

## Optional MCP/agent path

MCP is a separate, opt-in local process; it is not required for the desktop
app. File operations are disabled until the practitioner approves one or more
engagement folders — in the app, under **Agent access** in the status bar, chosen
through a folder dialog. This is persistent standalone **read/write** access,
not the live-binder switch: it remains in effect when that switch is off and
when the desktop app is closed. The approved list is stored per user,
owner-only, outside the binder and is authoritative in normal use. Canonical-path
checks reject access and symlink escapes outside those roots, and the list is read
on every request, so withdrawing a folder takes effect immediately rather than at
the next restart.

An MCP client can receive file paths and names, page counts/order/rotation,
bookmark titles, and mark/tape metadata.

**It can also receive the page content itself.** `binder_read_page` returns a
page's embedded text, `binder_read_cells` returns a spreadsheet page's parsed
cell values, and `binder_find` locates a figure and reports its coordinates.
Both of the first two accept `ocr: true`, which reads a scan or photograph
on-device and returns that text labelled as a machine reading with per-word
confidence. Nothing here is a metadata-only surface: on a return, this is
wages, balances, and — on a 1040 — the taxpayer's SSN.

That is a deliberate capability, not an oversight; an agent that cannot read the
documents cannot tie anything out. But it makes pointing an MCP client at real
client documents a decision about *content*, not merely about file names, and it
is the one place in this whole boundary where several of the regimes above
converge at once:

- **§7216 / §6713.** Whether sending return information to a hosted model is a
  disclosure requiring consent under Treas. Reg. §301.7216-3, and whether any
  exception reaches the particular arrangement.
- **Safeguards Rule.** Whether a model provider reached this way is a service
  provider for the firm's WISP, and what oversight or contract terms that would
  call for.
- **AICPA Confidential Client Information Rule.** Whether the same act is a
  disclosure to a third-party service provider, and what consent or
  confidentiality agreement would need to be in place first.
- **Circular 230.** How the practitioner supervises what the agent produces. The
  journal and agent attribution exist so a reviewer can tell what was
  machine-produced; what that obliges is the practitioner's to judge.

LedgerPDF makes none of these determinations. Reads are refused until a
practitioner approves a folder, nothing is approved by default, and the choice is
made in a folder dialog rather than in a configuration file — so the capability is
inert until somebody deliberately arms it, and what has been armed can be seen and
withdrawn in one place.
Whether the client sends what it reads to a hosted model depends on that client
and provider, not on LedgerPDF; a locally-run model keeps it on the machine. Do
not enable MCP on client engagements until the firm's own §7216, privacy, vendor,
consent, and WISP analysis allows it.

### Live access to the open binder

Since 2026-08-04 an MCP client can also edit the binder already open in the
desktop app, rather than handing a saved file back and forth. `binder_status`
reports which mode is in effect.

The channel is a **unix socket (POSIX) or named pipe (Windows) — never a TCP
port**, so nothing is reachable from another machine. It is off by default and
armed per launch from the app. A client must present a 32-byte token, minted
fresh each launch, as the first line it sends; unauthenticated connections are
refused. The endpoint file naming the socket is owner-only (`0600`) on POSIX;
on Windows it sits beneath the per-user `%APPDATA%` ACL. Node's machine-wide
named-pipe access options are explicitly disabled; the random pipe name and
256-bit token are still the authentication control on Windows rather than a
claim that its default pipe ACL is POSIX-equivalent.

Live mode does not widen what an agent may read. The approved folders still gate
file access, and the disclosure surface above is unchanged.

## Storage, retention, and deletion

LedgerPDF does not encrypt files itself or enforce a retention schedule.
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
