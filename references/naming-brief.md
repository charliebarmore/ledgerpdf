# Naming brief — workpaper-tool

**For a naming agent with no prior context. Everything needed is in this file.**
Written 2026-08-05. Working name is "Workpaper Binder"; `workpaper-tool` is the repo.

---

## What you are naming

A **cross-platform desktop app (macOS + Windows) for building tax workpaper binders**,
where a human and an AI agent work on **the same binder at the same time**.

A preparer drags in what they have — PDFs from tax software, client documents, Excel
trial balances, scans, phone photos of receipts. The app assembles them into one
ordered, bookmarked PDF binder. They place **tick marks** (the review symbols
accountants have used for a century), drop **calculator tapes** that show their
addends, and link a figure to the page that supports it.

The output is a single portable PDF. Every mark renders as a standard annotation in
Acrobat, Edge, Chrome, and macOS Preview. The binder PDF **is** the document — saving
overwrites it, and an editable session rides inside the file itself.

The agent half is not a chat box bolted on. The agent reads the actual pages —
embedded text, exact spreadsheet cell values, OCR for scans — finds a figure by name,
gets coordinates back, and marks the same binder the human has open. Everything it
does is **attributed to the AI and reversible**, because a workpaper is evidence and
no CPA can sign a file they cannot audit.

Runs **entirely locally. No telemetry, nothing leaves the machine.** That is a hard
product requirement driven by IRC §7216 and the FTC Safeguards Rule, not a
preference.

## The positioning insight worth naming around

**The agent is a first-year staff accountant. The user is the reviewer.**

Every accountant knows that relationship in their bones: juniors prep the binder,
seniors review and sign. The product is not "AI for accountants" — it is a binder
where the prep work is already done and your job is to review it. A name that lands
on binding, evidence, review, or that preparer/reviewer ritual will age better than
one that lands on the technology.

## Who buys it

Small-firm **CPAs, EAs and bookkeepers** in the US. Conservative, trust-sensitive,
**mostly on Windows**. They are being sold a lot of AI right now and are rightly
suspicious of where their clients' data goes. First users are 2–3 design-partner
firms from a private community; the author is himself a practising CPA, which is the
credibility the product trades on.

It replaces **Adobe Acrobat (~$240/user/yr) + TicTie Calculate (~$150/user/yr)** —
two subscriptions, ~$400/seat/year, and TicTie *requires* Acrobat to run.

## Publisher and family

Ships under **Ledger Labs LLC**, the author's software studio (ledgerlabs.co) —
not his CPA firm. The name should sit comfortably as a Ledger Labs product.

## What the name has to do

1. **Mean something to a CPA in under a second.** It is a trade tool; being opaque to
   outsiders is fine, being opaque to preparers is not.
2. **Survive the AI hype cycle.** In three years "agent" may read the way "e-" and
   "cyber" read now. The product will still be a binder.
3. **Be ownable.** Descriptive names cannot be protected — anyone can call their
   product an agent binder. Arbitrary or suggestive names are far stronger.
4. **Carry trust.** This holds client tax data. It should sound like a tool of record,
   not a startup toy. No cutesy misspellings, no dropped vowels.
5. **Work as a verb or a noun in a sentence a preparer would actually say.**

## Hard constraints

- **`.app` single dictionary words are all gone.** Every one tested was registered
  (quire, vouch, sheaf, bindery, tickmark, foolscap, columnar, workpaper, tenkey,
  greenbar, foots). Assume compounds, coinages, or alternate TLDs.
- **The bundle identifier is permanent in practice.** Currently
  `com.charliebarmore.workpaperbinder`. It is baked into installed builds; changing it
  after release makes the next update install a *second* app rather than upgrade the
  first. Nobody has installed it yet, so it is free to change right now.
- The code-signing certificate is **not** name-bound — it carries the publisher's
  identity, not the product's. Signing is not blocked by this decision; *publishing*
  is.

## Already rejected — do not re-propose

| Name | Why it is out |
| --- | --- |
| **Tickmark** | Three companies in the exact field: Tickmark Inc (audit documentation software), Tickmark Inc (parent of Taxfyle, a CPA marketplace), Tickmarks Inc (virtual accounting). Highest-risk name considered. |
| **Quire** | quire.io — established paid project-management SaaS since 2014. Same class of goods. |
| **Crossfoot** | Author dislikes it. (Accounting term for verifying totals tie.) |
| **Columnar, Foolscap** | `.app` and `.com` both taken. |
| **AgentBinder** | *Not* rejected — current front-runner, domain already owned. But: "agent" marks are extremely crowded (AGENTIS, AGENT SOFTWARE, AGENTK, and a documented 2025–26 rush to trademark AI agent names), HomeBinder is an adjacent agent-facing document-binder product, and descriptive-generic is hard to own. The author is unconvinced. Beat it or confirm it. |
| **Bindery** | *Not* rejected — cleanest trademark field found (all existing marks are physical book-binding; the one Class 9 software mark was cancelled in 2003). Weakness is domains: `.app`, `.com`, `.co` all taken. |

## Vocabulary worth mining

Terms a preparer actually uses, offered as raw material rather than suggestions:
tick mark, tie out, foot / crossfoot, vouch, trace, agree, support, basis, lead sheet,
trial balance, workpaper, binder, index, schedule, sign-off, review note, preparer,
reviewer, ten-key, columnar pad, greenbar, working papers.

Bookbinding and paper terms, since the artefact is a bound document: quire, sheaf,
folio, signature, gathering, codex, ream, tab, index, casebound.

## What to deliver

**8–12 candidates**, and for each:

1. The name, and the one-line reason it fits *this* product.
2. Domain reality — check `.app`, `.com`, `.co` and note what is actually gettable.
   A "no NS record" result means unconfigured, **not necessarily available**; verify at
   a registrar before claiming it is free.
3. A knock-out trademark screen — is anyone using it in software, accounting, tax, or
   audit? Name them. This is a screen, not clearance; flag anything close.
4. Honest downside. Every name has one; a candidate presented without a weakness has
   not been thought about.

Rank them, recommend one, and say plainly what it would cost to beat the incumbent
(AgentBinder, domain already owned). **A confident "keep AgentBinder" backed by
reasoning is an acceptable and useful answer** — the point is to stop the decision
stalling, not to force a change.
