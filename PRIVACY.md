# LedgerPDF privacy and data practices

Effective August 13, 2026.

This document describes LedgerPDF’s current data behavior. It is written to be
read with [`DATA-FLOW.md`](DATA-FLOW.md), which contains the detailed technical
boundary, and [`DISCLAIMER.md`](DISCLAIMER.md).

## The short version

- LedgerPDF has no Ledger Labs account, hosted binder service, product
  analytics, advertising, telemetry, or automatic update check.
- The desktop application makes no application network calls. Opening and
  editing a binder does not send it to Ledger Labs LLC.
- Files are stored locally at paths you choose. LedgerPDF does **not** encrypt
  them; your device, folder permissions, storage, and backup controls matter.
- If you connect an MCP client, that separate program can receive document
  content. A hosted model provider may receive whatever the MCP client sends it.
- ledgerpdf.com is a static website hosted by Vercel. Official source code and
  release downloads are hosted by GitHub.

## Data on your device

LedgerPDF reads source files you select and creates binders and exports only at
paths you choose. While a binder is open, hidden working, recovery, and lock
files may exist beside it. A crash can leave recovery material there until the
binder is reopened or you remove it. These files can contain client information
and inherit the protections of the engagement folder.

The app’s per-user data directory stores preferences and a recent-binder list.
Recent entries can include complete filesystem paths, including client or
engagement names present in those paths. Clearing recents removes the list from
the app. Uninstalling the application does not delete your binders and may leave
preferences or recents until you remove the app-data directory. Platform-specific
details are in the installation documentation.

LedgerPDF does not encrypt binder, export, working, or recovery files. Use
FileVault, BitLocker, or controls approved by your firm, along with appropriate
access permissions, retention, backup, and secure-disposal procedures.

## Optional agent access

Agent access is not required to use LedgerPDF.

Live access to the open binder is off at each app launch. When enabled, it uses
a local Unix socket or Windows named pipe—not a network port—and a new random
256-bit token. Separately, folders approved under **Agent access** grant
persistent standalone read/write access inside those folders. That approval
remains in effect when live access is off and when LedgerPDF is closed, until you
withdraw it.

Within approved folders, an MCP client can receive filenames and paths, embedded
page text, OCR output, spreadsheet cell values, mark and tape metadata, and
other binder content. This can include tax identifiers and other sensitive
client information. LedgerPDF does not directly send that content across a
network, but your MCP client may send it to the AI provider you configured. A
locally run model can keep the content local; a hosted model generally cannot.
Your provider’s privacy, retention, training, security, and contract terms apply.

Removing an approved folder takes effect for subsequent requests. It cannot
recall information a client or provider already received.

## Website and downloads

ledgerpdf.com is a static site hosted by Vercel. Ledger Labs LLC has not added
accounts, forms, advertising, product analytics, tracking pixels, or third-party
web fonts to the site. Vercel may process ordinary request information needed to
serve the site under its own
[privacy policy](https://vercel.com/legal/privacy-policy).

The source repository, issue tracker, and release downloads are provided by
GitHub, whose [privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement)
applies when you use those services. Do not put client information in an issue,
discussion, pull request, security report, or other support material.

## Support, security reports, and deletion

For support and security communications, Ledger Labs LLC receives the
information you choose to send in a message or report, in addition to the
ordinary website-hosting data described above. Do not send real client files,
screenshots, filenames, tax identifiers, credentials, or extracted page text.
Use synthetic examples. Security reports should follow
[`SECURITY.md`](SECURITY.md).

You control deletion of binders, sources, exports, recovery files, and backups
from your own systems. LedgerPDF does not operate a cloud copy that Ledger Labs
can delete for you. Data already sent to an MCP client, AI provider, GitHub,
Vercel, email provider, or another third party is governed by that party and
your arrangement with it.

LedgerPDF is intended for professional use and is not directed to children.
Questions about these practices may be sent to info@ledgerlabs.co.
