# Frontend Specs

The frontend is a React 19/Vite control surface under `src/web/`. It is a
single-page, local-only application with five in-memory views and no router,
global state library, or component framework.

## Read Before Changing the Web UI

- [React component conventions](./react-guidelines.md)
- [State and API conventions](./state-and-api-guidelines.md)
- [UI and accessibility](./ui-accessibility-guidelines.md)
- [Cross-layer changes](../guides/cross-layer-change-guide.md) when a server,
  core state, or extension contract also changes

## Pre-Development Checklist

- Read `PRODUCT.md` and `DESIGN.md` for product voice, risk presentation,
  layout, color, spacing, and accessibility constraints.
- Locate the owning view function in `src/web/App.tsx` and the corresponding API
  contract in `src/web/api.ts`.
- Check whether the change affects batch-state tones, readiness, confirmation,
  manual takeover, or irreversible-action copy.

## Quality Check

- The UI still exposes batch state and stop controls while a batch runs.
- Consequential actions have direct Chinese copy and explicit disabled/busy/
  error states.
- Keyboard use, visible focus, non-color state cues, responsive layout, 200%
  zoom, and reduced motion remain supported.
- Dashboard E2E tests use role/label-based locators and do not contact external
  hosts.
- `npm run format:check`, `npm run build`, and relevant tests pass.
