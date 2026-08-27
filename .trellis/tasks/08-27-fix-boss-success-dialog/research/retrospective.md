# Bug Analysis: BOSS success receipt was downgraded to unknown

## 1. Root Cause Category

- **Category**: D/E — test coverage gap plus implicit DOM assumption.
- **Specific cause**: success-dialog actions were assumed to be semantic
  `button`/`a` controls. The live receipt can render exact action labels through
  nested non-semantic elements. After the click boundary, missing that receipt
  exhausted the polling window and produced `结果未知`.

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

## 3. Prevention Mechanisms

| Priority | Mechanism           | Specific action                                                                                             | Status |
| -------- | ------------------- | ----------------------------------------------------------------------------------------------------------- | ------ |
| P0       | Test coverage       | Keep a screenshot-text fixture with nested non-semantic actions and prove it is red before changing source. | DONE   |
| P0       | Runtime contract    | Require exact title, bounded dialog-like context, and exact action/settings evidence.                       | DONE   |
| P0       | Result monotonicity | After a platform success receipt, later append/send exceptions cannot downgrade the result.                 | DONE   |
| P1       | Negative tests      | Cover ordinary article prose and dialog-like containers without a known action.                             | DONE   |
| P1       | Live acceptance     | Reload the built extension and run one supervised BOSS batch without DevTools.                              | TODO   |

## 4. Systematic Expansion

- **Similar issues**: any extension selector that assumes semantic HTML for
  third-party controls can fail when the platform uses clickable wrappers.
- **Design improvement**: keep action discovery centralized and evidence-bound;
  do not scatter broader selectors through the send state machine.
- **Process improvement**: a selector fix must include both a positive fixture
  for the observed variant and a negative fixture containing similar page text.

## 5. Knowledge Capture

- [x] Added executable non-semantic action and monotonic-success rules to
      `.trellis/spec/extension/dom-automation.md`.
- [x] Added focused positive and negative regression tests.
- [ ] Complete the supervised live acceptance check after reloading
      `dist/extension`.

## Confidence

Local confidence is high because the public DOM entry point reproduces the
reported transition and all negative cases pass. Live confidence remains
moderate until the supervised check, because opening DevTools closes the BOSS
page and the exact production DOM could not be captured.
