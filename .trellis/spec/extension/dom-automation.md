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
9. When a strict receipt navigates to a new BOSS chat document, resume only the
   template append in that document. Never repeat the contact click.

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

### Composer safety

Chat-page ancestry is only positive context for composer discovery; it must
never override explicit search-field evidence. Reject `input[type="search"]`,
`[role="searchbox"]`, fields inside `[role="search"]`, and fields whose
`placeholder`, `aria-label`, or `data-placeholder` contains `搜索` or `查找`.
This includes the contact-search field rendered inside BOSS's chat-page shell.
The rejection must happen before assigning a value so a failed composer lookup
cannot leave the opening template in an unrelated field.

### Send-control safety

BOSS may render the chat composer action as nested non-semantic elements whose
exact visible text is `发送`. Discover that action only inside the composer's
nearest form/chat/message/conversation/dialog container. Prefer a native or
ARIA control, then the smallest visible exact-text descendant so a click can
bubble to the owning non-semantic control. Never fall back to page-wide `发送`
text: an unrelated control may accept the click while leaving the template
inserted but unsent.

```typescript
// Wrong: may click an unrelated page action after missing a nested chat control.
findExactTextAction(document.body, "发送");

// Correct: the exact action remains bound to the confirmed composer region.
findExactTextAction(nearestComposerContainer, "发送");
```

Supervised live verification confirms that BOSS also accepts Enter from the
focused composer when it exposes no bounded `发送` control. Keep the bounded
control path preferred. After the composer has accepted the exact template,
use the existing bounded-control wait as a short stabilization window within
the original deadline. If no control appears, recheck the deadline, focus the
confirmed composer, recheck its bounded region once, then dispatch exactly one
`keydown` Enter event (`key`/`code` `Enter`, legacy `keyCode` 13). Do not
dispatch `keypress`/`keyup`, repeat Enter, or send Enter after expiry.

The DOM regressions must prove a delayed keyboard handler receives one focused
Enter and creates the matching outgoing message, an expired continuation
receives no Enter, and a bounded send control is clicked without also receiving
Enter. They must continue to assert zero clicks on unrelated page-wide `发送`
controls; composer text alone is never completion evidence.

### Cross-document continuation

The service worker owns a single transient continuation in
`chrome.storage.session`. It is bound to the original command, connection,
tab, source URL, and deadline, and may contain the opening template only for
that live browser session. Persist the confirmed command result before waiting
for continuation. Resume only after the same bound tab reports a newly loaded
BOSS chat URL, then run a composer-only helper that retains the search-input
exclusions above. Clear the state on success, terminal inability, disconnect,
tab/connection change, deadline, or command replacement.

A same-document append reports completion to the service worker. A full-page
navigation instead relies on the new content script's `page_loaded` signal.
Neither path changes or downgrades the already-confirmed communication result.

## Scenario: Resume a template in a replacement chat document

### 1. Scope / Trigger

Use this contract only after a strict `boss-success-dialog` result has been
persisted and “继续沟通” may replace the source document. The continuation is an
internal service-worker/content-script operation, not a second platform contact
command.

### 2. Transient state and signatures

The single `chrome.storage.session` record contains only `state`
(`pending`/`dispatching`), command ID, connection ID, tab ID, source URL,
deadline, and the opening-template plaintext. The internal content request is:

```typescript
{
  type: "resume_opening_template";
  commandId: string;
  message: string;
  deadline: string;
}
```

No field crosses the extension/server wire, so this does not change the shared
protocol or BOSS adapter version.

### 3. Contracts

- Cache the confirmed command result before persisting or waiting for the
  continuation. Never retry the original contact click.
- On command replay after worker restart, compare every stored binding with the
  replayed send command and inspect `chrome.tabs.get`; recovery must not depend
  on receiving a second `page_loaded` after `page_bound`.
- Resume only in the same bound tab and connection, before the same deadline,
  when both the content-script signal and current tab identify a BOSS chat URL.
- Persist `dispatching` before the composer-only request. Concurrent page
  signals share one in-memory claim; a restarted worker clears a recovered
  `dispatching` record instead of risking a second send.
- Do not release the outbound command result until same-document completion,
  resumed completion/failure, lifecycle cleanup, or deadline cleanup resolves
  the waiter.
- After the continuation reaches a terminal state, refresh `currentUrl` from
  the bound tab before sending the final command result. If a worker restart
  replays the early persisted success, refresh and re-persist that cached
  result as well; otherwise the bridge retains the pre-navigation detail URL
  and rejects subsequent commands as a changed page.
- Clear on terminal completion/failure, expiry, disconnect/disarm/emergency
  stop, connection/tab/command replacement, corrupt storage, or a non-chat BOSS
  destination. Cleanup failure is recorded in extension state and must not
  become an unhandled rejection.

### 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Same-document template append completes | Clear the matching continuation and release the waiting result once. |
| New chat page loads before `page_bound` after restart | Cached command replay inspects the current tab and resumes without another page event. |
| Duplicate `page_loaded` / visibility events race | Dispatch the composer-only request at most once and keep the command result waiting. |
| Stored binding, deadline, or source URL is invalid | Remove the transient record without writing to the page. |
| Current destination is the source page | Keep waiting; do not write into its fields. |
| Current destination is not a BOSS chat page | Clear terminally; never probe or write an unrelated input. |
| Chat shell exposes a text field labelled `搜索` / `查找` | Treat it as non-composer evidence and leave its value unchanged. |
| Resume throws or returns incomplete | Preserve cached `沟通成功`, clear transient state, and release the command. |
| Deadline expires before composer, send click, or Enter | Do not write/click/dispatch Enter; clear and release. |
| Continuation finishes after full-page navigation | Return and cache the bound tab's chat URL, not the source detail URL. |

### 5. Good / Base / Bad Cases

- **Good**: the old document disappears, the worker restarts, a chat content
  script has already loaded, and replay resumes the template once from the
  current bound tab.
- **Base**: the original document appends the template and sends the matching
  completion signal; no cross-document request is made.
- **Bad**: replay repeats `send_opening`, trusts only a stale URL string, writes
  into a search input, releases the next command while resume is in flight, or
  retries a recovered `dispatching` record.

### 6. Tests Required

- Service-worker regression: persist strict success, restart the module, deliver
  `page_loaded` before binding, replay the cached command, and prove one resumed
  template plus delayed command completion.
- Race regression: keep resume in flight while delivering a duplicate page
  signal; assert one dispatch and no early command result.
- DOM/content-script tests: composer-only success, search-input rejection,
  search-labelled input rejection inside the chat shell,
  expired-before-write rejection, bounded-control preference, one focused Enter
  fallback after delayed handler registration, and no contact-control click.
- Final-result regression: after cross-document resume (including cached replay
  after worker restart), assert `command_result.data.currentUrl` equals the
  bound chat URL.
- Corrupt-session regression: invalid source/deadline is removed without a
  resumed request.

### 7. Wrong vs Correct

```typescript
// Wrong: best-effort template work dies with the document that clicked continue.
void continueInCurrentDocument().then(appendOpeningTemplate);

// Correct: cache success, claim one transient continuation, then resume only
// the composer step from the same command/tab in the replacement chat document,
// reject search-labelled fields, and refresh currentUrl before final delivery.
await cacheConfirmedResult(commandId);
await persistSessionContinuation({ state: "pending", commandId, tabId });
await waitForComposerOnlyContinuation(commandId);
const currentUrl = await readBoundTabUrl(tabId);
```

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
