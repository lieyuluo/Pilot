# Errors and Observability

## Error Semantics

Errors are classified by the boundary that can act on them:

- Core invariant misuse throws an `Error` or a focused subclass such as
  `HumanTakeoverRequired`.
- Route-level expected conflicts are converted to a Chinese `{ error }`
  response with an explicit status code.
- A thrown error during an already-started contact becomes `结果未知`; do not
  propagate it into an automatic retry.
- Login, verification, and unsupported-page conditions become manual takeover
  with a user-actionable reason.
- UI and popup boundaries turn unknown caught values into a stable fallback via
  a local `messageOf(error: unknown)` helper.

Keep user-visible messages direct and in the repository's Chinese domain
language. Do not expose stack traces, selector internals, secrets, or raw
platform data through API responses.

## Observability Model

The Fastify logger is intentionally disabled (`logger: false`). The only normal
console output is the startup URL in `src/server/main.ts`. Do not invent a new
logging framework as part of an unrelated change.

Use the existing structured channels instead:

- `BatchEventBus` and SSE for live batch state and human-readable progress.
- `lastSummary` for the last completed batch result.
- The append-only contact-operation event ledger for durable state history.
- `contact_operation_diagnostics` for short-lived structured stage/outcome/
  error-category/duration data.

When adding a new failure mode, decide whether it is an API conflict, batch
terminal state, manual takeover, or diagnostic category and test that exact
observable result. Never use detailed logs as a substitute for the durable
operation state.
