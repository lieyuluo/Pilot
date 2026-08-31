# Implementation Plan

## 1. Preserve and Baseline

- Re-read the active task, relevant Trellis specs, ADR-0013/0014, and the current
  dirty diff.
- Run the existing focused split-button test and record the green baseline.
- Do not modify or revert unrelated user changes.

## 2. Establish the Red Feedback Loop

- Add one minimal `happy-dom` regression using the screenshot's exact receipt
  text and separate non-semantic `div`/`span` action elements.
- Assert the user-visible semantic failure: the current implementation returns
  `结果未知` instead of `沟通成功`.
- Run only that test and require it to fail for the expected result mismatch.
- If it does not fail, stop before editing source and revise the reproduction;
  do not rationalize a source change without a red-capable loop.

## 3. Implement the Smallest Fix

- Centralize exact-text receipt-action discovery in `boss-dom.ts`.
- Support nested native/ARIA controls and the smallest visible non-semantic
  exact-text control.
- Reuse the helper in receipt qualification and continuation selection.
- Preserve the exact-title/help/action evidence boundary and composer safety
  filters.

## 4. Green and Regression Checks

- Run the new focused test until green.
- Run all `tests/extension/boss-dom.test.ts` cases, especially:
  - sibling content/action containers;
  - split stay/continue actions;
  - best-effort template append;
  - page-body false-positive rejection;
  - job-search input protection.
- Remove any temporary diagnostic instrumentation.

## 5. Full Verification

Run:

```powershell
npm test
npm run typecheck
npm run build:extension
npx prettier --check src/extension/boss-dom.ts tests/extension/boss-dom.test.ts
```

Then perform Trellis quality review for spec compliance, cross-layer effects,
and dirty-worktree scope.

## 6. Manual Live Recheck

- Reload `dist/extension` from `chrome://extensions` and refresh the BOSS page.
- The user runs one supervised verification batch.
- Confirm the receipt becomes `沟通成功` and no longer produces
  `已完成有异常` solely because of receipt misclassification.

The task is not archived until automated checks pass and the user has the rebuilt
extension ready for this manual confirmation.

## 7. Response-Channel Timing Follow-up

- Record the live evidence that receipt detection and the “继续沟通” click both
  succeed before the batch still records `结果未知`.
- Add a content-script regression where responses made after the continuation
  click are treated as a destroyed channel.
- Notify the content script synchronously after strict receipt qualification
  and before the navigation-capable click.
- Guard the Chrome callback so a delivered success cannot be replaced by the
  later best-effort result, while a synchronous callback exception still allows
  the final confirmed-success result to retry.
- Re-run focused content-script/DOM tests and the full extension quality gate.

## 8. Cross-Document Template Continuation Follow-up

- Reproduce strict success followed by old-document destruction, worker
  restart, new chat `page_loaded`, and missing template at the
  service-worker/content-script seam.
- Persist one transient continuation in `chrome.storage.session`, bound to the
  original command, connection, tab, source page, and deadline.
- Add a composer-only content-script command and never repeat the contact click.
- Discover and click `发送` only inside the confirmed composer region, including
  nested non-semantic controls, and confirm the exact new outgoing message.
- Persist success before waiting, but delay the outbound command result until
  continuation is terminal so the next candidate cannot navigate away first.
- Clear continuation state on all terminal/lifecycle boundaries and cover
  exactly-once append plus search-input rejection.

## 9. Composer Enter Fallback Follow-up

- Capture the supervised evidence that the correct composer receives the exact
  template but no send action occurs, while manual Enter sends successfully.
- Add deterministic fake-timer DOM regressions for a delayed keyboard handler,
  expiry before Enter, and bounded-control preference without duplicate Enter.
- After the existing bounded-control stabilization wait, focus only the
  confirmed composer and dispatch one `keydown` Enter with legacy `keyCode` 13
  when no bounded control exists and the original deadline is still valid.
- Reuse the exact outgoing-message confirmation and keep contact clicks,
  page-wide controls, retries, protocol fields, and service-worker flow
  unchanged.
