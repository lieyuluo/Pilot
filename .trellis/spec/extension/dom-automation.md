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
7. If entering chat may navigate, return the conclusive receipt result through
   the current content-script response channel before clicking the continuation
   control. A delivered response is sent once; a synchronous response exception
   may retry with the same confirmed success when the best-effort work settles.
8. If the result cannot be proved after the click, return `结果未知`.

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
the single `留在此页` compatibility path, an exception after success receipt,
and content-script response-channel loss caused by continuation navigation.

## Scenario: Return a success receipt before continuation navigation

### 1. Scope / Trigger

Use this contract when a strictly qualified platform receipt is followed by an
action such as “继续沟通” that may replace the current document. Chrome's
content-script response channel belongs to that document, so the conclusive
result must cross the channel before the navigation-capable click.

### 2. Signatures

```typescript
sendOpeningFromDocument(
  document: Document,
  message: string,
  timeoutMs?: number,
  onSuccessReceipt?: (result: DomSendOpeningResult) => void,
): Promise<DomSendOpeningResult>;
```

The optional callback is invoked only after `findBossSuccessDialog` has accepted
the strict receipt evidence and before `findContinueChatControl(...).click()`.

### 3. Contracts

- The early result is `沟通成功` with `confirmation: "boss-success-dialog"`
  and the same irreversible/baseline/final-count fields as the final result.
- `content-script.ts` delivers the first successful response exactly once. The
  later Promise completion continues best-effort work but cannot replace it.
- Matched-message and composer-only flows do not use the early callback; they
  return through the normal Promise completion.
- No wire field, result union, capability, protocol version, or adapter version
  changes for this ordering fix.

### 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Strict receipt is absent | Do not call `onSuccessReceipt`; retain normal `内容不符` / `结果未知` behavior. |
| Strict receipt is accepted | Call `onSuccessReceipt` before any continuation click. |
| Response callback returns | Mark the response delivered and suppress later duplicate completion. |
| Response callback throws synchronously | Keep the response undelivered; best-effort continuation proceeds and final confirmed success may retry once. |
| Navigation destroys the document after the click | The already-delivered `沟通成功` remains authoritative. |
| Composer/send/confirmation later fails | Preserve `沟通成功` with `boss-success-dialog` evidence. |

### 5. Good / Base / Bad Cases

- **Good**: a strict receipt appears, success is returned, then “继续沟通”
  navigates and the detached best-effort work may disappear with the document.
- **Base**: an exact outgoing template message proves success without a receipt;
  the final Promise result is returned normally.
- **Bad**: code waits for chat navigation, composer discovery, or template send
  before returning the already-conclusive receipt result.

### 6. Tests Required

- Content-script integration: treat any response after the continuation click
  as channel loss; assert the observed result is still `沟通成功` and the click
  occurs afterward.
- Single delivery: allow best-effort completion to settle and assert the Chrome
  response callback ran exactly once.
- Synchronous callback exception: throw on the early response, then assert the
  final confirmed result retries and remains `boss-success-dialog` success.
- Keep the existing DOM false-positive, search-input, and post-receipt exception
  tests green.

### 7. Wrong vs Correct

```typescript
// Wrong: navigation can destroy the channel before this Promise resolves.
void sendOpeningFromDocument(document, message).then(respond);

// Correct: publish conclusive receipt evidence before navigation, once.
void sendOpeningFromDocument(document, message, undefined, respondOnce).then(
  respondOnce,
);
```

## Fixture-Driven Verification

- Put sanitized static pages under `tests/fixtures/boss/`.
- Add focused `happy-dom` tests in `tests/extension/boss-dom.test.ts` for every
  selector or success-evidence variant.
- Service-worker tests stub `chrome` and `WebSocket`, reset modules after each
  case, and assert target/deadline/idempotence behavior.
- Automated tests must never navigate to or call the real BOSS service.
