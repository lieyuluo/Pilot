# Core Batch Guidelines

## Domain Language Is Code

Use `CONTEXT.md` as the vocabulary source. Public state unions in
`src/core/batch-runner.ts` and `src/storage/store.ts` deliberately use the
Chinese domain terms shown to the job seeker, such as `结果未知`, `明确未开始`,
`内容不符`, and `人工接管`. Do not replace them with generic success/failure
labels that erase the safety distinction.

When product behavior changes, check the accepted ADRs first. In particular:

- Unknown rule fields pass unless there is clear, parseable evidence for an
  exclusion (`src/core/rules.ts`).
- A contact result that becomes uncertain after the irreversible step is
  `结果未知`; it is never automatically retried.
- `明确未开始` returns the reserved credit but is not retried in the same batch;
  three consecutive occurrences cause manual takeover.
- `内容不符` and `结果未知` allow the queue to continue but make the final state
  `已完成有异常` (ADR-0011).
- A confirmed BOSS success receipt remains success even if best-effort template
  continuation later fails (ADR-0014).

## Core Code Shape

- Put pure evaluation in standalone functions. `evaluateCandidate` returns all
  exclusion reasons and accepts `now` as an option so time behavior is
  deterministic in tests.
- Define adapter behavior at the core boundary through `PlatformAdapter`.
  Platform-specific selectors, navigation, and authentication do not belong in
  the batch runner.
- Build stateful services with factory functions and injected dependencies.
  `createBatchRunner` owns one run at a time and reports state through `onEvent`.
- Keep limits explicit in the request (`maxContacts`, `maxCandidates`) and let
  `src/server/app.ts` choose verification/full/demo values.
- Use stable identities from `positionIdentity`. Real BOSS sends require a
  platform ID or normalized URL; only demo data may fall back to a fingerprint.

## Durable Before External

For each contact, preserve the order in `createBatchRunner`:

1. Re-inspect and re-evaluate the candidate.
2. Render the fixed template and compute its SHA-256 digest.
3. Reserve the durable operation and credit in SQLite.
4. Mark the command dispatched.
5. Invoke one atomic adapter command.
6. Persist the terminal operation event, diagnostic, and snapshot.

Do not move the first external click ahead of the reservation or split one
contact across multiple retriable commands. See ADR-0013 and
`tests/core/batch-runner.test.ts`.

## Tests That Define the Contract

- `tests/core/rules.test.ts`: explicit exclusions, normalization, and unknown
  value pass-through.
- `tests/core/batch-runner.test.ts`: quota accounting, durable deduplication,
  unknown results, consecutive clear failures, and post-success takeover.
- `tests/storage/store.test.ts`: restart recovery and append-only state history.
