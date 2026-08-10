---
version: "alpha"
name: "workpaper-tool-design"
description: "Visual identity and functional layout rules for the LedgerPDF desktop app."
colors:
  primary: "#1D434E"
  background: "#F7F6F2"
  surface: "#FFFFFF"
  border: "#D4D1CA"
  text: "#28251D"
  text-muted: "#7A7974"
  success: "#437A22"
  warning: "#964219"
  error: "#A12C7B"
typography:
  heading:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: "1.2"
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "1.45"
  numeric:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "14px"
    fontWeight: 400
    fontVariantNumeric: "tabular-nums"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "20px"
  xl: "32px"
rounded:
  sm: "4px"
  md: "8px"
  lg: "12px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "#FFFFFF"
    rounded: "{rounded.sm}"
    padding: "8px 14px"
---

# Design System

## Overview

- **Product personality**: A fast professional instrument, not a friendly consumer app. The reference feeling is "a well-worn 10-key next to a clean desk" — dense, quiet, precise, keyboard-first.
- **Audience**: Tax preparers and reviewers who live in this tool 8 hours a day during busy season, mostly on Windows, often on 1080p non-Retina monitors.
- **Should feel**: Instant, predictable, dense-but-organized, trustworthy with client data.
- **Should not feel**: Web-app airy, gamified, animated, "AI product" glossy, or like a PDF viewer with buttons bolted on.
- **Design references**: TicTie Calculate (feature vocabulary, NOT its dated chrome), Adobe organize-pages view (thumbnail rail interactions), classic desktop utilities (Sublime/Finder-level restraint).

## Colors

Muted, low-saturation workspace so the *document* is the loudest thing on screen. One accent (primary teal) for selection and primary actions only. Semantic colors reserved for meaning: success = tie-out/valid, warning = unverified/needs attention, error = broken link/failed export. **Annotation colors (tick marks, tapes) are user-meaningful content, not UI theme** — they must stay identical on screen and in the exported PDF. The LedgerPDF brand palette uses Deep Teal `#1D434E`, Signal Orange `#E8913A`, Paper Cream `#FDFCEA`, Vellum `#F5ECD6`, Abyss `#0F2A31`, Amber Gold `#E6A532` and Ink Gray `#46565C`. The workspace stays the muted low-saturation instrument described above, and vellum/amber have no role in app chrome today. **The brand stops at the chrome.** Tick green stays `appearance.TICK_COLOR` and Ledger Green `#2D9148` is deliberately unused, because a mark means the same thing on screen and in the exported PDF and a rebrand must never restate it.

## Typography

Inter for UI. **All numbers — calculator tape, page numbers, totals — use tabular-nums in JetBrains Mono**; a tape with proportional digits is disqualifying for this audience. Playfair Display stays on marketing surfaces (ledgerpdf.com, the guide, social); a serif has no job in a dense workspace. Minimum body size 13px; this app will run on 100%-scale 1080p Windows monitors, verify legibility there, not just on Retina.

## Layout

Three-region desktop layout: left bookmark/inspector pane, center PDF canvas, right thumbnail rail. Density over whitespace — this is a utility. Native menu bar per platform (macOS menus / Windows menus), Cmd↔Ctrl parity on every shortcut. No mobile behavior; the supported minimum window is 1100×700. The toolbar is one row at the 1440px design width and wraps into no more than two complete rows at the minimum width. Resizable panels have remembered positions.

## Elevation & Depth

Flat with hairline borders. Depth only where it means something: the drag-ghost of a page being reordered, and modal dialogs. No decorative shadows on chrome.

## Shapes

Small radii (4–8px), utility-focused. Square-cornered page thumbnails — they represent paper.

## Components

- **Thumbnail rail**: drag-to-reorder with insertion indicator; multi-select (Shift/Cmd-Ctrl click); per-file grouping headers matching bookmark nesting; rotation badge; keyboard reorderable.
- **PDF canvas**: PDF.js render; zoom presets (fit-width/fit-page/100%); annotation overlay layer owns hit-testing; visible selection state on every placed mark.
- **Marks palette** (Phase 2): single-keystroke stamp selection; hover shows keybinding.
- **Calculator tape** (Phase 3): keyboard-first entry, running tape, editable prior lines; renders with `numeric` type style; identical appearance on screen and in export.
- **Buttons/forms**: native-feeling; primary action per surface = one; destructive actions (delete pages) get undo, not confirmation dialogs.
- **Alerts**: inline and quiet; reserve modals for blocking questions (encrypted-PDF password prompt).
- **Tables** (broken-links report, session list): dense rows, tabular numbers, sortable.

## Do's and Don'ts

### Do

- Make every core action keyboard-reachable; document shortcuts in-UI (hover + a shortcut sheet)
- Preserve 60fps thumbnail dragging on a 300-page binder — performance IS the design
- Show source-file provenance on hover (page came from `X.pdf` p.7)
- Respect platform conventions (menus, dialogs, title bar) per OS

### Don't

- No animation beyond functional transitions (drag ghosts, panel slide); nothing decorative
- No web-style onboarding tours, empty-state illustrations, or emoji in UI copy
- No custom-drawn chrome replacing native menus/dialogs
- Never let UI theme colors bleed into exported annotation appearance

## Design review checklist

- Does the screen match the product personality? (instrument, not app)
- Are primary actions obvious and keyboard-reachable?
- Are spacing, typography, and color usage consistent?
- Are error, empty, loading, and success states handled?
- Legible at 100% scale on 1080p Windows? (replaces mobile check — this is desktop-only)
- Does important text meet contrast requirements?
- Do exported annotations look identical to their on-screen representation?
