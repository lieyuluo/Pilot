# Backend Specs

JobPilot is a single-package Node.js 24 application. The backend owns the
platform-neutral batch rules, process composition, local Fastify API, adapters,
and SQLite persistence.

## Read Before Changing Backend Code

- [Architecture and boundaries](./architecture-and-boundaries.md)
- [Core batch rules](./core-batch-guidelines.md)
- [Server API](./server-api-guidelines.md)
- [SQLite storage](./storage-guidelines.md)
- [Errors and observability](./error-and-observability.md)

## Pre-Development Checklist

- Identify whether the change belongs to `core`, `server`, `storage`, or an
  adapter; keep page-specific behavior in `src/extension/`.
- Read the relevant accepted ADR under `docs/adr/`. Later accepted ADRs replace
  conflicting earlier decisions.
- Use the domain terms in `CONTEXT.md`, especially around irreversible actions,
  unknown results, manual takeover, and send authorization.
- For a cross-layer contract change, also read
  `../guides/cross-layer-change-guide.md`.

## Quality Check

- Platform-independent decisions remain in `src/core/`.
- HTTP input has a TypeBox schema and an explicit response/status contract.
- Durable contact-operation transitions are transactional and append an event.
- No credential, message body, raw HTML, or recruiter personal data is newly
  persisted or exported.
- Relevant Vitest tests and the commands in `../quality/testing-and-build.md`
  pass.
