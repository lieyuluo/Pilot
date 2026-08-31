# React Component Guidelines

## Current Component Organization

`src/web/main.tsx` only mounts `<App />` under `StrictMode` and imports the
global stylesheet. `src/web/App.tsx` currently owns:

- the application shell, navigation, sticky operation bar, and confirmation
  dialog;
- the five view functions `Overview`, `Plans`, `Templates`, `Snapshots`, and
  `SettingsView`;
- the small shared UI helpers `PageHeading`, `Field`, and `ReadinessItem`;
- local formatting and status-tone helpers.

Keep a view's state and handlers next to that view, as the existing editors do.
Use props for shared loaded data and a `reload(): Promise<void>` callback. The
project does not currently use React Router, context, a global store, custom
hooks, or a component-library abstraction; do not introduce one for a local
change.

If `App.tsx` is deliberately split later, preserve these ownership boundaries:
shell-level batch state remains in `App`, editor state remains with its view,
and shared transport behavior remains in `api.ts` rather than a component.

## Component and Handler Shape

- Use function components and explicit inline prop object types, matching
  `Overview`, `Plans`, and `PageHeading`.
- Use controlled form inputs backed by `useState`; update nested plan rules with
  immutable object spreads.
- Keep event handlers as focused async functions. Start busy state before a
  consequential request, clear the previous error, convert caught `unknown`
  with `messageOf`, and release busy state in `finally`.
- Call async handlers from JSX with `() => void handler()` so event callbacks do
  not return unhandled promises.
- Use stable domain identifiers as keys. The activity list is the existing
  exception because events have no dedicated ID and combines timestamp/index.
- Use native elements (`button`, `label`, `table`, `dialog`) before adding a
  custom interaction primitive.

Reference: `src/web/App.tsx`, especially `App`, `Plans`, `Templates`, and the
batch confirmation dialog.
