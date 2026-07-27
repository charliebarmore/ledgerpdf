# workpaper-tool

**Tier 1 — MVP / prototype**

Created from the `ai-software-build-os` kit on 2026-07-27.

> **Project-specific context:** Cross-platform (Mac + Windows) Electron desktop app for tax workpaper binders — an Adobe/TicTie Calculate replacement. Committed scope is **Phase 0 (compatibility spike) + Phase 1 (binder organizer) only**, part-time; Phases 2+ are gated on both the technical vertical slice AND Charlie's August revenue picture (see ROADMAP.md). Canonical spec + accepted technical review live in `references/source-materials.md` — read it before architecture work. Design partners: 2–3 TCR members (recruited via the community). This tool will eventually touch client PII locally; local-only/no-telemetry is a hard product requirement (§7216/FTC Safeguards positioning), not a nice-to-have. Re-bootstrap at Tier 2 before any firm-ready beta ships to design partners.

## What this project is

A working MVP or prototype. Real users may use it, but it's not a production-grade product yet. The doc set is intentionally thin — just enough to keep agents from drifting.

## Files in this project

- `PROJECT.md` — what the product is, who it's for, MVP scope, what's out of scope. Fill in before significant code is written.
- `DESIGN.md` — visual identity for *this* project. Tokens, type, layout decisions.
- `DESIGN-PRINCIPLES.md` — universal quality bar; inherited from the kit, do not edit.
- `ROADMAP.md` — Now / Next / Later. Keep ideas out of code by parking them here.
- `references/` — drop design inspiration, screenshots, sample data, anything the agent should reference before working.

## Read order before working

1. This file
2. `PROJECT.md` — must be filled in
3. `DESIGN.md` — for any UI work
4. `references/` — if anything's been dropped in there

## Operating rules for this tier

- **Scope control first.** Most MVPs die from feature creep. If a useful idea surfaces while building, add it to `ROADMAP.md` under Next or Later — don't implement it.
- **Build incrementally.** Small testable changes; one feature at a time.
- **Real users → security mindset starts now.** If the MVP collects emails, names, financial info, or any PII, treat it as Tier 2 for that surface area (auth, storage, logging).
- **Don't optimize for production-grade.** No premature scaling, no clever abstractions, no exotic dependencies. Boring is good.
- **Documentation updates required when**: scope changes, new dependency, new integration, auth or permissions change.

## Global resources available

These load automatically from `~/.claude/`:

- Global `CLAUDE.md` — Charlie's identity and preferences
- `feature-build` skill — invoke when implementing a feature from a ticket
- `design-review` skill — for UI work
- `qa-smoke-test` skill — before calling work done
- `data-security-review` skill — if the MVP starts touching real user data

## Orchestration & model delegation

The main session (Fable) is the tech lead: plan, decompose, make the hard calls, synthesize, review. Keep its context lean by delegating:

- **`deep-explorer` (Opus)** — broad, context-heavy dives: mapping a subsystem, tracing behavior across many files, digesting long logs/docs, researching a library. It reads everything and returns one decision-ready conclusion, so file dumps never hit the main context.
- **`fast-worker` (Sonnet)** — mechanical, well-specified work: boilerplate, tests, repetitive edits, formatting, config, renames. Make the spec unambiguous before delegating; it will not make judgment calls.
- **Hard reasoning stays in the main session.** Architecture decisions, subtle debugging conclusions, and design trade-offs are Fable's job — delegate the reading and the typing, not the thinking.
- For high-stakes decisions, task two independent takes in parallel and synthesize the best of both, without showing either the other's answer.
- **External AI tools** (e.g., a Codex plugin, if installed): usable as a fresh-perspective peer on *this project's code only*. Never invoke external AI tools on anything containing client, engagement, or taxpayer data.

## Definition of done

For any individual feature:
- Acceptance criteria met
- Happy path verified
- One failure path verified
- Relevant docs updated
- Follow-ups parked in `ROADMAP.md`
