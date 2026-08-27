# Cross-Layer Change Guide

JobPilot has a few intentional contracts that cross source directories. Trace
the complete path before editing one occurrence.

## Batch State or Contact Result

Owners and consumers:

- Domain state and transitions: `src/core/batch-runner.ts`
- Durable states and event history: `src/storage/store.ts`
- Server summaries/status: `src/server/app.ts`
- Frontend projection and display tone/copy: `src/web/api.ts` and
  `src/web/App.tsx`
- Adapter/extension execution result: `src/extension/protocol.ts`,
  `src/extension/service-worker.ts`, and `src/extension/boss-dom.ts`

When adding or changing a state, update every relevant union, transition,
schema/validator, row/event mapping, summary counter, UI label/tone, and test.
Do not let the UI infer a second meaning for a persisted state.

## HTTP Contract

Trace:

```text
TypeBox/Fastify route in src/server/app.ts
  -> response projection in src/web/api.ts
  -> load/mutation and rendering in src/web/App.tsx
  -> server.inject test in tests/server/app.test.ts
  -> user flow in tests/e2e/dashboard.spec.ts when visible
```

Keep CSRF behavior in the shared `api` helper and local-origin enforcement in
the Fastify hook. Do not hand-roll either in an individual view or route.

## Extension Protocol Contract

Trace:

```text
src/extension/protocol.ts
  -> server parser/command result guard in bridge.ts
  -> worker parser/dispatcher in service-worker.ts
  -> content-script request and boss-dom result when applicable
  -> bridge/service-worker/DOM tests
```

For breaking changes, decide whether to increment the protocol version, BOSS
adapter version, or both. Keep capability negotiation, size bounds, command
target fields, and persisted command-result idempotence aligned.

## Persistent Data or Migration

Trace:

```text
domain/store interface
  -> SQL table/statement
  -> row interface and mapper
  -> migration path for existing databases
  -> export/read model if intentionally exposed
  -> store migration and round-trip tests
```

Additive schema changes must preserve existing user data. A new diagnostic or
export field must also pass the ADR-0009/ADR-0013 data-minimization boundary.

## BOSS DOM or Page-Readiness Change

Update the selector/algorithm in `boss-dom.ts`, its sanitized fixture/test, the
service-worker readiness behavior if navigation timing changes, and the bridge
preparation state if user-visible stages change. Never validate by adding a
real-platform automated test.

## Architecture and Decision Records

If a change intentionally reverses an accepted safety, browser-control,
authorization, protocol, retry, or retention decision, add a new ADR instead of
silently making source and existing ADRs disagree. `CONTEXT.md` remains the
canonical domain vocabulary and `DESIGN.md` remains the UI system source.
