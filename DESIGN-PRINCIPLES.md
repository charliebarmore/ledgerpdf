# Universal Design Principles

These principles apply to every project, even when each project has a different visual identity.

## Core standard

The interface should feel intentional, useful, and trustworthy. Avoid visual clutter, novelty for its own sake, and inconsistent component behavior.

## Accessibility baseline

- Body text should meet WCAG AA contrast.
- Interactive elements need visible focus states.
- Do not rely on color alone to communicate status.
- Use labels, helper text, and clear validation messages.
- Make forms usable with keyboard navigation.
- Provide useful empty, loading, success, and error states.

## Layout

- Use spacing to group related information.
- Use a clear visual hierarchy.
- Keep primary actions obvious.
- Avoid cramming too many decisions onto one screen.
- Make mobile behavior intentional, not accidental.

## Typography

- Use a limited type scale.
- Keep body text readable.
- Use font weight and size for hierarchy, not excessive colors.
- Avoid novelty fonts unless the product explicitly requires them.

## Color

- Use one primary accent unless the design system requires more.
- Use semantic colors consistently for success, warning, error, and information.
- Do not introduce random colors per feature.
- Check contrast for text and important UI states.

## Components

Every core component should have:

- Default state.
- Hover state where relevant.
- Focus state.
- Disabled state.
- Loading state where relevant.
- Error state where relevant.
- Empty state where relevant.

## Data displays

- Prefer clear tables, cards, filters, and direct labels.
- Avoid 3D charts and decorative chart effects.
- Use charts to answer a specific question.
- Keep numbers aligned and formatted consistently.
- Make important exceptions and risk indicators obvious.

## Agent instruction

When building UI, do not invent a new design direction if `DESIGN.md` exists. Use `DESIGN.md` for project-specific style and this file for baseline quality.
