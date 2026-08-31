# Server API Guidelines

## Fastify Boundary

`buildServer` in `src/server/app.ts` is the testable server factory. Keep process
startup, filesystem preparation, and real dependency construction in
`src/server/main.ts`; tests use `server.inject` without opening a network port.

For request-bearing routes:

- Supply Fastify generic types for `Body`/`Params` when the handler uses them.
- Define a TypeBox schema beside the server module. Use concrete bounds and
  `additionalProperties: false` for imported/configuration objects.
- Validate identity consistency at the boundary, such as matching a path ID to
  the body ID.
- Return explicit local error payloads shaped as `{ error: string }` with the
  existing status semantics: `403` for local-origin/CSRF failures, `404` for
  missing resources, `409` for state conflicts, `422` for unusable valid input,
  and `501` for an unavailable configured capability.

Reference routes and schemas: `src/server/app.ts`; integration coverage:
`tests/server/app.test.ts`.

## Local Security Contract

- Listen only on `127.0.0.1`.
- Preserve Host, Origin, and CSRF checks in the `onRequest` hook.
- Permit the fixed extension origin only for `/extension`; do not broaden normal
  web origins beyond the current local ports.
- Keep request and WebSocket payload limits (`256 KiB` for HTTP and `64 KiB` for
  extension messages).
- Configuration export contains plans and templates only. Operation export uses
  the minimal event ledger. Never export settings secrets, Chrome credentials,
  raw messages, detailed diagnostics, or page account data.

## Coordination Pattern

- Routes coordinate state and call a core/store/bridge port; they do not parse
  BOSS DOM or duplicate batch decisions.
- `batchPromise` is the server-level guard for one running batch. State-changing
  configuration and manual-resolution routes reject while a batch is active.
- Starting a batch returns `202`; completion updates `lastSummary`
  asynchronously and always clears `batchPromise` in `finally`.
- REST is used for commands and snapshots, SSE `/api/events` for batch progress,
  and WebSocket `/extension` only for the extension bridge.
- When adding a route, update the UI contract and add a `server.inject` test for
  success plus relevant security/state rejection paths.
