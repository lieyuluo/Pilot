# Extension Protocol and Lifecycle

## Shared Contract

`src/extension/protocol.ts` is the protocol owner. Keep messages as
discriminated unions keyed by `type`; keep command/result interfaces and page
status types there rather than duplicating shapes inside bridge or worker code.

- `EXTENSION_PROTOCOL_VERSION` and `BOSS_ADAPTER_VERSION` gate compatibility.
  A breaking wire or selector-behavior change must update the appropriate
  version and compatibility tests.
- Preserve the 64 KiB message limit and fixed extension origin.
- Every command contains a unique command ID, connection ID, expected tab ID,
  expected URL, and deadline. A send command also carries the durable operation
  ID and message digest.
- Validate parsed `unknown` input before casting. The bridge and service worker
  use `isRecord`, bounded string/integer checks, and command-specific result
  guards; extend those validators when a union changes.

Reference: `src/extension/protocol.ts`, `parseClientMessage` in
`src/extension/bridge.ts`, and `parseServerMessage` in
`src/extension/service-worker.ts`.

## Connection and Page Lifecycle

- The server bridge accepts one socket, challenges it, authenticates the paired
  extension, and binds one user-selected BOSS tab.
- Page readiness is one user-initiated sequence: authorize, bind, calibrate, and
  best-effort return. It does not establish the process send session or start a
  batch (ADR-0015).
- Heartbeats maintain the connection; timeout, tab closure, leaving BOSS,
  account change, emergency stop, or explicit disconnect invalidates the bound
  page and read-only calibration.
- `waitUntilPageReady` waits only while the same bound connection remains valid.
  The next irreversible action requires the page to be active and visible.
- Page commands are serialized with `pendingCommands`; connection/tab changes
  reject the in-flight command.

## Command Idempotence and Retry Boundary

- `src/extension/service-worker.ts` caches completed command results in memory
  and `chrome.storage.local`. A repeated command ID returns that result and does
  not touch the page again.
- Keep persisted command-result retention at 14 days unless the data-retention
  decision changes explicitly.
- Connection, navigation, content-script readiness, and DOM reads may use the
  existing bounded retries before the first irreversible action.
- Once `sendOpeningFromDocument` reports `irreversibleStarted`, timeout,
  disconnect, emergency stop, or unprovable completion becomes `结果未知`; never
  rerun the send command.
- A strict success receipt may create one transient, session-storage template
  continuation. Persist the success result first; bind continuation to the same
  command, connection, tab, source URL, and deadline; and resume only from the
  newly loaded BOSS chat content script. This is not a second send command and
  must never repeat the irreversible contact click.

Tests: `tests/extension/bridge.test.ts`,
`tests/extension/service-worker.test.ts`, and `tests/server/app.test.ts`.
