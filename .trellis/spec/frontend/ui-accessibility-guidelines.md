# UI and Accessibility Guidelines

## Visual System

`DESIGN.md` is the source of truth and `src/web/styles.css` is the implemented
reference. Preserve the "Quiet Dispatch Desk" character:

- Use the CSS custom properties in `:root` for OKLCH colors, radii, and motion.
- Reserve dispatch indigo for selection, the primary action, focus, and active
  state; it is not decorative background color.
- Use green for confirmed, amber for attention/manual action, and red for stop
  or failure, always paired with text, icon, or shape.
- Keep the layout flat: tonal surfaces and one-pixel dividers instead of nested
  cards and resting shadows. The confirmation dialog is the elevated exception.
- Reuse `.button` variants, `.state-*` tones, `.field`, and existing layout
  classes before creating a visually duplicate control.

Do not add gradients, glass effects, decorative AI animation, oversized vanity
metrics, or playful treatment of irreversible automation.

## Interaction and Copy

- Current batch state and normal/emergency stop controls remain in the sticky
  64px operation bar.
- Show limits, account/page readiness, uncertainty, and the consequence of a
  send before confirmation.
- Use direct Chinese domain terms from `CONTEXT.md`; do not call an uncertain
  operation a generic failure or imply it is safely retriable.
- Consequential buttons expose disabled and busy states. Errors visible to the
  whole app use the `role="alert"` banner; preparation/status regions use live
  regions where already established.

## Accessibility and Responsive Behavior

- Target WCAG 2.2 AA as required by `PRODUCT.md`.
- Prefer semantic controls and bind visible labels with `label`/`aria-label`.
- Keep `:focus-visible` clearly visible and never rely on color alone for state.
- Preserve the current breakpoints: sidebar to icon rail below 960px and
  single-column/no horizontal page overflow below 680px.
- Respect `prefers-reduced-motion: reduce` and ensure the interface works at
  200% zoom.
- E2E assertions should prefer `getByRole`, `getByLabel`, and visible user copy;
  `tests/e2e/dashboard.spec.ts` is the reference.
