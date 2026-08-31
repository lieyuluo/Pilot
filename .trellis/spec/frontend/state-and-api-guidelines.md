# Frontend State and API Guidelines

## State Ownership

`App` owns server-backed collections, application status, selected plan IDs,
the current view, the global error banner, and the batch confirmation dialog.
Individual editor views own draft/editing state. This is ordinary React state;
there is no external state manager.

- `load`, wrapped in `useCallback`, fetches plans, templates, snapshots,
  settings, batch status, and extension status concurrently with `Promise.all`.
- Batch events arrive through `EventSource('/api/events')`, immediately update
  the visible state, retain the latest 12 events, and trigger a full reload on a
  terminal batch state.
- Extension preparation is polled every two seconds because the popup/service
  worker lifecycle is independent. The effect uses a `mounted` guard and clears
  its timer on cleanup.
- Mutations use the shared `api` helper, then reload authoritative server state
  instead of maintaining a second client-side model.

Follow these mechanisms for adjacent behavior; do not add a second polling loop
or ad hoc CSRF implementation.

## API Client Contract

`src/web/api.ts` owns frontend projections of JSON responses and the `api<T>`
helper.

- All JSON requests go through `api<T>`.
- The helper lazily obtains and caches `/api/session` CSRF data for mutating
  methods, adds JSON content type when a body exists, handles `204`, and converts
  `{ error }` responses to `Error`.
- Response interfaces use the JSON field names emitted by `src/server/app.ts`.
  They are intentionally frontend-facing projections and may omit server-only
  fields.
- Because TypeScript uses `exactOptionalPropertyTypes`, do not assign
  `undefined` to optional response fields. Omit them or declare an explicit
  `| undefined` only where that is the established wire shape.

When an API payload changes, update the TypeBox/server contract, the frontend
projection, the consuming component, and the integration/E2E coverage together.
See `../guides/cross-layer-change-guide.md`.
