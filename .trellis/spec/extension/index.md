# Chrome Extension Specs

The Manifest V3 extension under `src/extension/` is the only production path
that reads or acts on a real BOSS page. It is a constrained execution adapter;
the local service remains the owner of rules, quotas, and batch state.

## Read Before Changing the Extension

- [Protocol and lifecycle](./protocol-and-lifecycle.md)
- [BOSS DOM automation](./dom-automation.md)
- [Core batch safety](../backend/core-batch-guidelines.md) for send/result
  changes
- [Testing and build](../quality/testing-and-build.md)

## Pre-Development Checklist

- Read accepted ADR-0008, ADR-0010, ADR-0013, ADR-0014, and ADR-0015.
- Decide whether the change is a shared protocol change, service-worker command
  change, content-script/DOM change, or popup-only state presentation.
- Mark the exact irreversible boundary and list which operations may be retried
  before it.

## Quality Check

- Only one extension, page, and command can be active.
- Every command remains bound to connection ID, tab ID, expected URL, command
  ID, and deadline.
- Duplicate send commands reuse a persisted terminal result.
- No raw HTML, chat body, Cookie, login token, or recruiter profile crosses the
  protocol or enters storage.
- DOM and service-worker tests use local fixtures/stubs only.
