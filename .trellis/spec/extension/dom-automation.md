# BOSS DOM Automation

## Ownership and Isolation

`src/extension/boss-dom.ts` owns BOSS selectors, page classification, normalized
candidate extraction, contact-state reading, and the atomic DOM send routine.
`src/extension/content-script.ts` is a thin message dispatcher. Keep business
quotas and durable decisions out of both files.

- DOM helpers accept `Document` and URL inputs instead of reading globals. This
  allows `happy-dom` fixture tests to exercise them directly.
- Use standard isolated-world DOM APIs only. Do not add `chrome.debugger`, CDP,
  main-world private APIs, anti-detection logic, CAPTCHA bypass, or remotely
  downloaded selectors.
- Normalize results into `CandidatePosition`; never return or persist raw HTML.
- Missing optional fields remain absent. Page verification/login/unsupported
  structure is not treated as an unknown candidate field.

## Page Classification and Reading

- Detect verification/risk text before login, then classify list/detail, then
  unsupported. This ordering in `inspectBossPage` prevents unsafe fallthrough.
- Keep selectors constrained to the owning helper and tolerate current known
  BOSS class variants only when backed by a local fixture/test.
- Normalize text with NFKC/whitespace rules before evidence comparison.
- A platform contact state is based on observable controls/messages, not on a
  local snapshot.

## Atomic Send Evidence

Preserve the evidence order in `sendOpeningFromDocument`:

1. Capture the outgoing-message baseline.
2. Find an available contact control; absence is `明确未开始`.
3. Click once, marking the irreversible boundary.
4. Accept either a newly added exact same-text outgoing message or a qualifying
   BOSS success dialog as success evidence.
5. If a different outgoing message appears without the success receipt, return
   `内容不符` and do not append the template.
6. After a success receipt, entering chat and appending the template is
   best-effort; its failure does not revoke success.
7. If the result cannot be proved after the click, return `结果未知`.

The success dialog must contain the exact success title within a dialog-like
container plus the known continuation/settings evidence. Similar page-body text
alone is not sufficient (ADR-0014).

### Non-semantic success-dialog actions

BOSS may render `留在此页` and `继续沟通` as nested `div`/`span` elements rather
than native buttons. Discover those controls by exact normalized text, but only
inside the smallest available dialog-like container that already contains the
exact `已向BOSS发送消息` title and known settings/action evidence. Never promote
`body`, `documentElement`, or an ordinary article containing similar prose to a
success dialog.

- Prefer a native or ARIA control before a non-semantic exact-text element.
- Prefer actions in this order: `继续沟通`, `留在此页继续沟通`, `留在此页`.
- Do not match containers whose text merely contains an action label alongside
  unrelated text; the action element itself must normalize to the exact label.
- Once the platform receipt is accepted, composer lookup, template insertion,
  clicking send, and confirmation polling are best-effort. Exceptions in these
  steps still return `沟通成功` with `boss-success-dialog` evidence.

Required tests must cover native and non-semantic actions, a page-body/article
false positive, a non-semantic dialog-like container without a known action,
the single `留在此页` compatibility path, and an exception after success receipt.

## Fixture-Driven Verification

- Put sanitized static pages under `tests/fixtures/boss/`.
- Add focused `happy-dom` tests in `tests/extension/boss-dom.test.ts` for every
  selector or success-evidence variant.
- Service-worker tests stub `chrome` and `WebSocket`, reset modules after each
  case, and assert target/deadline/idempotence behavior.
- Automated tests must never navigate to or call the real BOSS service.
