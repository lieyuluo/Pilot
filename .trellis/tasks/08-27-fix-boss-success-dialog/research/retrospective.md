# Bug Analysis: BOSS receipt navigation lost result and template continuation

## 1. Root Cause Category

- **Category**: B/D/E — cross-layer contract, integration-test gap, and an
  implicit document-lifecycle assumption.
- **Specific cause**: the implementation treated one document-local Promise as
  both the domain result and the owner of post-receipt template work. Full-page
  “继续沟通” navigation first destroyed the Chrome response channel, then—after
  response ordering was fixed—still destroyed the old content script before it
  could append the configured template. The service worker had no command-bound
  continuation for the replacement chat document.

## 2. Why Earlier Fixes Failed

1. Supporting the `设置打招呼语` wording repaired one evidence variant but did
   not model split, non-semantic action elements.
2. Supporting separate native buttons repaired the screenshot layout in a
   semantic fixture, but that fixture still passed before the live failure was
   explained.
3. The first generalized fallback introduced three review gaps: ordinary prose
   could resemble a receipt, the legacy single-stay action was skipped, and an
   exception during best-effort template append could revoke established
   success.
4. The corrected DOM-level tests proved receipt recognition and monotonic return
   values, but stopped below the content-script/service-worker boundary. They did
   not prove that the value crossed Chrome's response channel before navigation.
5. Returning success before the navigation repaired the batch result, but left
   best-effort template append in the same disposable document. The next live run
   correctly ended as `已完成` while revealing that the template never reached the
   new chat document.
6. The first cross-document implementation covered the happy path but needed
   final-review hardening for early `page_loaded`, duplicate signals, waiter
   cleanup, corrupt session state, and expiry during DOM discovery.
7. The hardened continuation still treated any text input under a `chat-*`
   ancestor as a composer, so BOSS's contact-search field accepted the template
   before send-button discovery failed. It also returned the early persisted
   detail URL after the chat-page continuation, leaving the bridge's next
   `expectedUrl` stale and producing repeated page-change failures.

## 3. Prevention Mechanisms

| Priority | Mechanism           | Specific action                                                                                             | Status |
| -------- | ------------------- | ----------------------------------------------------------------------------------------------------------- | ------ |
| P0       | Test coverage       | Keep a screenshot-text fixture with nested non-semantic actions and prove it is red before changing source. | DONE   |
| P0       | Runtime contract    | Require exact title, bounded dialog-like context, and exact action/settings evidence.                       | DONE   |
| P0       | Result monotonicity | After a platform success receipt, later append/send exceptions cannot downgrade the result.                 | DONE   |
| P0       | Response ordering   | Return strict receipt success through the content-script channel before clicking a navigation-capable action. | DONE   |
| P0       | Integration test    | Model response-channel loss after the continuation click and assert early, exactly-once success delivery.    | DONE   |
| P0       | Lifecycle ownership | Persist one session-only, command-bound continuation and resume composer-only work in the replacement chat document. | DONE   |
| P0       | At-most-once claim  | Persist `pending`/`dispatching`, bind every field, and never retry a recovered dispatching record.            | DONE   |
| P0       | Restart/race tests  | Cover early page load, cached replay, duplicate signals, expiry, corrupt state, and waiter cleanup.           | DONE   |
| P0       | Negative composer evidence | Reject search-labelled fields even inside a chat-page container, before mutating their value.          | DONE   |
| P0       | Final URL contract  | Refresh and persist the bound tab URL after continuation terminal state, including cached replay.             | DONE   |
| P1       | Negative tests      | Cover ordinary article prose and dialog-like containers without a known action.                             | DONE   |
| P1       | Live acceptance     | Reload the built extension and run one supervised BOSS batch without DevTools.                              | TODO   |

## 4. Systematic Expansion

- **Similar issues**: any extension selector that assumes semantic HTML for
  third-party controls can fail when the platform uses clickable wrappers; any
  content-script command that navigates can lose both its response and unfinished
  page work unless lifecycle ownership moves to the service worker. A broad
  positive ancestor such as `chat-page` can also swallow a stronger negative
  signal on a descendant control unless rejection rules run first.
- **Design improvement**: keep action discovery centralized and evidence-bound,
  and treat domain completion, IPC delivery, and cross-document best-effort work
  as three separate completion gates.
- **Process improvement**: selector fixes need positive/negative DOM fixtures;
  navigation-capable command fixes also need service-worker/content-script tests
  covering document replacement, worker restart, duplicate events, and cleanup.

## 5. Knowledge Capture

- [x] Added executable non-semantic action and monotonic-success rules to
      `.trellis/spec/extension/dom-automation.md`.
- [x] Added the navigation-before-response contract, error matrix, and required
      content-script integration assertions to the extension spec.
- [x] Added the session continuation state machine, validation/error matrix,
      good/base/bad cases, and wrong/correct implementation example.
- [x] Added focused positive and negative regression tests.
- [x] Added the chat-shell contact-search rejection and post-continuation final
      URL contract to `.trellis/spec/extension/dom-automation.md`.
- [x] Added regressions for wrong-field mutation and stale cached `currentUrl`.
- [ ] Complete the supervised live acceptance check after reloading
      `dist/extension`.

## Confidence

Local confidence is high because the integration regression reproduces the full
reported sequence—strict receipt, old-document loss, worker restart, early new
page signal, cached replay, and exactly one composer-only append—and all race and
negative cases pass. Live confidence remains moderate until the supervised check,
because opening DevTools closes the BOSS page and the production navigation
cannot be captured directly.
