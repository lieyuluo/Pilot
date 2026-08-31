# SQLite Storage Guidelines

## Current Persistence Model

The project uses Node 24's built-in synchronous `node:sqlite` API directly. It
does not use an ORM or separate migration tool. All storage behavior lives in
`src/storage/store.ts` behind `JobPilotStore`.

- Open databases with foreign keys, defensive mode, a busy timeout, and WAL.
- Prepare frequently used statements once inside `openJobPilotStore`.
- Keep SQL column/table names in `snake_case` and TypeScript contracts in
  `camelCase`; map them explicitly in `rowToContactOperation` and
  `rowToSnapshot`.
- Store structured configuration fields as JSON only at the persistence
  boundary; callers use typed objects.
- Boolean database values are `0`/`1` and are converted at the row boundary.

## Transactions and History

- A contact state transition updates `contact_operations` and appends to
  `contact_operation_events` in the same `BEGIN IMMEDIATE` transaction.
- Always roll back and rethrow on transaction failure.
- The append-only operation event ledger is the durable audit source. Manual
  resolution appends a new event; it does not rewrite the original result.
- Deduplication comes from terminal/dispatched contact-operation states, not
  from old position snapshots.
- On startup, recover `预占` as `明确未开始` and `命令已下发` as `结果未知` before
  running a new batch.

Evidence: `reserveContactOperation`, `appendOperationState`,
`recoverInterruptedContactOperations`, and `hasContacted` in
`src/storage/store.ts`; regression coverage in `tests/storage/store.test.ts`.

## Migrations

- Keep migrations forward-only and idempotent in `migrate`.
- New installations must receive the full current schema. Upgrades must inspect
  the existing schema before additive `ALTER TABLE` work and record the applied
  version in `schema_migrations`.
- Never solve a migration by dropping or recreating user tables.
- Add a test that constructs the previous schema, opens it through
  `openJobPilotStore`, verifies old data survives, and verifies the new field.

## Data-Minimization Rules

- Permanently store identifiers, command/operation IDs, template ID, message
  hash and length, result, and necessary timestamps; do not store message text.
- Structured diagnostics contain stage/outcome/error category/duration only and
  are deleted after 14 days.
- Do not persist raw HTML, screenshots, chat text, recruiter profiles, cookies,
  Chrome tokens, or browser profiles.
- `src/server/main.ts` backs up an existing database before opening it. Keep
  application data out of the repository and resolve it through
  `src/server/paths.ts` / `JOBPILOT_DATA_DIR`.
