# Bug Analysis: BOSS success receipt was downgraded to unknown

## 1. Root Cause Category

- **Category**: B/D/E — cross-layer contract, integration-test gap, and an
  implicit document-lifecycle assumption.
- **Specific cause**: the DOM adapter correctly recognized the platform receipt,
  but the content script waited for the complete “continue to chat and append
  template” Promise before returning it. A full-page navigation destroyed the
  old document's Chrome response channel first, so the service worker retained
  its durable `结果未知` placeholder.

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

## 3. Prevention Mechanisms

| Priority | Mechanism           | Specific action                                                                                             | Status |
| -------- | ------------------- | ----------------------------------------------------------------------------------------------------------- | ------ |
| P0       | Test coverage       | Keep a screenshot-text fixture with nested non-semantic actions and prove it is red before changing source. | DONE   |
| P0       | Runtime contract    | Require exact title, bounded dialog-like context, and exact action/settings evidence.                       | DONE   |
| P0       | Result monotonicity | After a platform success receipt, later append/send exceptions cannot downgrade the result.                 | DONE   |
| P0       | Response ordering   | Return strict receipt success through the content-script channel before clicking a navigation-capable action. | DONE   |
| P0       | Integration test    | Model response-channel loss after the continuation click and assert early, exactly-once success delivery.    | DONE   |
| P1       | Negative tests      | Cover ordinary article prose and dialog-like containers without a known action.                             | DONE   |
| P1       | Live acceptance     | Reload the built extension and run one supervised BOSS batch without DevTools.                              | TODO   |

## 4. Systematic Expansion

- **Similar issues**: any extension selector that assumes semantic HTML for
  third-party controls can fail when the platform uses clickable wrappers; any
  content-script command that navigates before responding can also lose a
  conclusive result.
- **Design improvement**: keep action discovery centralized and evidence-bound,
  and treat domain completion plus IPC delivery as separate completion gates.
- **Process improvement**: selector fixes need positive/negative DOM fixtures;
  navigation-capable command fixes also need a content-script integration test
  that asserts response ordering across the document lifecycle.

## 5. Knowledge Capture

- [x] Added executable non-semantic action and monotonic-success rules to
      `.trellis/spec/extension/dom-automation.md`.
- [x] Added the navigation-before-response contract, error matrix, and required
      content-script integration assertions to the extension spec.
- [x] Added focused positive and negative regression tests.
- [ ] Complete the supervised live acceptance check after reloading
      `dist/extension`.

## Confidence

Local confidence is high because the content-script regression reproduces the
reported sequence—receipt recognized, continuation clicked, late response lost—
and proves success is now delivered first and only once. Live confidence remains
moderate until the supervised check, because opening DevTools closes the BOSS
page and the production navigation cannot be captured directly.
