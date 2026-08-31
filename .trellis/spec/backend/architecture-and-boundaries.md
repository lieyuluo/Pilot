# Backend Architecture and Boundaries

## Runtime Shape

`src/server/main.ts` is the composition root. It resolves local paths, backs up
and opens SQLite, recovers interrupted operations, seeds first-run examples,
creates the event bus, bridge, adapters, and batch runner, then starts Fastify
on `127.0.0.1:4317`.

The main execution path is:

```text
React UI -> REST command -> Fastify route -> BatchRunner
                                      |        |
                                      |        +-> JobPilotStore (SQLite)
                                      +-> SSE <- BatchEventBus

BatchRunner -> PlatformAdapter -> fake adapter or ExtensionBridge
ExtensionBridge <-> versioned WebSocket <-> MV3 service worker -> content script -> BOSS DOM
```

Evidence: `src/server/main.ts`, `src/server/app.ts`,
`src/core/batch-runner.ts`, `src/adapters/switching-adapter.ts`, and
`src/extension/bridge.ts`.

## Directory Ownership

- `src/core/`: domain types, hard-rule evaluation, batch state and orchestration,
  and batch events. It must not read the DOM or depend on React/Fastify.
- `src/adapters/`: implementations of the `PlatformAdapter` contract. The fake
  adapter is the local/demo implementation; the BOSS adapter delegates to the
  extension bridge. Adapter selection is persisted and occurs through
  `createSwitchingAdapter`.
- `src/server/`: process startup, local API and SSE/WebSocket registration,
  filesystem paths, and retention helpers.
- `src/storage/`: the SQLite schema, migrations, prepared statements, row
  mapping, and the `JobPilotStore` interface.
- `src/extension/`: BOSS-specific page behavior and the local-service protocol;
  follow the separate extension specs.
- `src/web/`: the browser control surface; it may call the HTTP API but must not
  import server or storage implementations.

## Dependency Pattern

- Wire concrete dependencies only in `src/server/main.ts`.
- Core behavior accepts dependencies through small interfaces and factory
  options. Examples are `createBatchRunner`, `createExtensionBridge`, and
  `buildServer`; tests replace these ports with in-memory fakes.
- Use `import type` when a dependency is only a contract. This keeps the current
  type-only edge between `core/batch-runner.ts` and `storage/store.ts` from
  becoming a runtime cycle.
- Keep relative ESM imports with explicit `.ts`/`.tsx` extensions. The project
  has no path aliases or barrel modules.

## Architectural Constraints

- The local service owns batch state, quotas, rules, and irreversible-result
  classification. The extension is a bounded observer/executor, not a second
  business-logic owner (ADR-0008 and ADR-0013).
- REST carries control commands, SSE carries batch events, and the versioned
  WebSocket is reserved for extension execution (ADR-0010).
- Only one extension connection, one bound BOSS page, one page command, and one
  batch are active at a time. Preserve the guards in `src/extension/bridge.ts`,
  `src/adapters/switching-adapter.ts`, and `src/server/app.ts`.
- Do not reintroduce Playwright/CDP control of the real BOSS browser. Playwright
  is used only for the local dashboard and local fixtures.
