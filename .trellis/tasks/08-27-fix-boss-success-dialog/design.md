# Design: Robust Success-Receipt Control Discovery

## Scope and Boundaries

The change remains inside the BOSS DOM adapter, content-script dispatch, and
their focused tests:

- `src/extension/boss-dom.ts` owns receipt discovery and continuation clicks.
- `src/extension/content-script.ts` owns returning the atomic result to the
  service worker while the current document still exists.
- `tests/extension/boss-dom.test.ts` owns the deterministic DOM regression.
- `tests/extension/content-script.test.ts` owns response-channel timing and
  single-response regressions.
- The batch runner, extension protocol, service worker, persistence, quotas, and
  UI state model are unchanged unless the red test proves a contract gap.

Existing uncommitted edits in the two owning files are user work. The
implementation must build on them and must not revert unrelated hunks.

## Evidence Model

A success receipt is accepted only when a bounded visible ancestor contains:

1. an exact `已向BOSS发送消息` title text node;
2. either the `设置招呼语` / `设置打招呼语` help text or an exact known receipt
   action; and
3. for a non-semantic container fallback, an exact `继续沟通`, `留在此页`, or
   `留在此页继续沟通` action within that same ancestor.

`body` and `documentElement` remain ineligible candidates. Ordinary page text
without a qualifying action remains a negative case.

## Control Discovery

Current code searches only descendant `button` and `a` elements. The fix will
centralize exact-text action discovery so it can:

- prefer native/ARIA interactive ancestors (`button`, `a`, `[role="button"]`,
  button-like inputs) when the visible label is nested in a child element;
- fall back to the smallest visible exact-text `HTMLElement` when BOSS attaches
  click behavior to a `div`/`span`-style control;
- prefer exact `继续沟通` over the stay action when both are present;
- avoid selecting a container whose text merely includes extra unrelated copy.

The helper is used by receipt qualification, stay-action detection, and
continuation selection so those checks cannot drift.

## Composer Safety

The existing composer filter remains: search inputs, searchbox roles, and
elements inside search regions are excluded. A text field must be in a chat/
message/conversation context or carry a message/communication/send hint before
the template can be written.

## Retry and Result Semantics

No retry boundary changes. Once the first contact click occurs:

- exact matching outgoing message or the qualified BOSS receipt proves success;
- continuation into chat is best-effort;
- inability to find/click a continuation control after receipt recognition
  returns `沟通成功` with `boss-success-dialog` evidence;
- absence of qualifying evidence remains `结果未知` or `内容不符` under the
  existing algorithm.

## Response-Channel Ordering

The content-script response channel belongs to the current document. Clicking
“继续沟通” may perform full-page navigation, so awaiting all best-effort chat
work before calling Chrome's response callback can lose an already-conclusive
success result.

After strict receipt qualification, `sendOpeningFromDocument` synchronously
notifies the content-script dispatcher before it clicks the continuation
control. The dispatcher returns that result once and ignores the later Promise
completion. It marks the response as delivered only after the callback returns,
so a synchronous callback failure does not suppress the final confirmed-success
attempt. No extension protocol field, result union, or adapter capability
changes; therefore neither protocol nor BOSS adapter version is incremented.

## Validation and Rollback

The regression must fail before the source change and pass afterward. Existing
negative page-body and search-input tests guard the widened selector. If the
change causes false positives or unrelated-field writes, revert only the new
control-discovery hunk and keep the task in diagnosis.

Final live validation requires rebuilding `dist/extension`, reloading the
unpacked extension in Chrome, refreshing the BOSS page, and running one normal
verification batch under the project's existing human-supervised rules.

## Cross-Document Template Continuation

After receiving `boss-success-dialog`, the service worker persists the confirmed
command result and one transient continuation in `chrome.storage.session`. The
continuation contains only the command/connection/tab binding, source URL,
deadline, and opening template needed for the current command; it does not
survive a browser restart or enter the durable command-result ledger.

The new content script announces `page_loaded`. The worker resumes only when
the same connection and bound tab now point to a BOSS chat URL and the deadline
is valid. The resumed operation is composer-only: it never looks for or clicks
a contact control and retains the existing search-input filter. A same-document
append sends an explicit completion signal instead.

After the composer accepts the exact template, its bounded send control remains
the first choice. The existing control-discovery wait doubles as a short page
stabilization interval. If no control appears and the original deadline remains
valid, the adapter focuses the confirmed composer, checks the bounded region one
last time, and dispatches one `keydown` Enter event with `keyCode` 13 for legacy
handlers. It never emits both click and Enter, never uses page-wide controls,
and still requires a newly added exact matching outgoing message.

The outbound command result waits until this best-effort continuation reaches a
terminal point, preventing the next batch command from navigating away first.
Because success was persisted before the wait, lifecycle loss cannot downgrade
it. Verification batches still finish after one contact; no history/back action
is added.

The transient record moves from `pending` to `dispatching` before the resumed
content-script request. Duplicate page events share one in-memory claim; after a
worker restart, a recovered `dispatching` record is cleared rather than retried.
Cached command replay validates every stored binding and reads the current tab,
so a `page_loaded` event that arrived before `page_bound` is not required a
second time. The command result remains withheld while the composer-only request
is in flight and is released by terminal cleanup or the original deadline.
