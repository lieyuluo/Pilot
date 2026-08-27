# Fix BOSS Success Dialog Handling

## Goal

When BOSS has already shown an explicit “已向BOSS发送消息” receipt, JobPilot
must recognize the contact as successful instead of recording “结果未知”, while
preserving the existing best-effort continuation behavior and batch safety
limits.

## Background and Confirmed Facts

- The reported receipt visibly contains the title “已向BOSS发送消息”, the
  platform greeting, the “设置打招呼语” help text, and two separate actions:
  “留在此页” and “继续沟通”.
- The current user-visible failure is “消息结果未知，已阻止该职位重发并继续批次”,
  followed by “已完成有异常” when the one-contact verification quota is reached.
- `src/extension/boss-dom.ts` is the owner of success-receipt detection and
  best-effort continuation. The batch runner already treats a returned
  `沟通成功` correctly; no batch-loop redesign is requested.
- The working tree already contains an uncommitted attempt in
  `src/extension/boss-dom.ts` and `tests/extension/boss-dom.test.ts`. It must be
  preserved and audited rather than overwritten.
- A screenshot-derived minimal DOM with the same visible text and split buttons
  currently passes the focused test, so the screenshot alone is not a
  red-capable reproduction of the live failure.

## Requirements

1. Build a deterministic local reproduction that exercises the real failing
   dialog structure and returns `结果未知` before the fix.
2. Recognize the explicit BOSS success receipt even when its title, help text,
   and actions are split across the live dialog's actual nested containers.
3. Prefer the “继续沟通” action when it is the control that enters chat; do not
   click “留在此页” when a separate continuation control is present.
4. After receipt recognition, entering chat and appending the configured opening
   template remains best-effort. Failure in that continuation must not revoke
   the already-established `沟通成功` result.
5. Do not treat similar text in ordinary page content as a success receipt.
6. Do not write the opening template into a job-search input or another
   unrelated text field.
7. Keep automated verification local: sanitized DOM fixtures/stubs only, with no
   request or automated action against real BOSS.

## Acceptance Criteria

- [ ] A focused regression test reproduces the user's exact `结果未知` symptom
      against a sanitized dialog model with the screenshot text and
      non-semantic action elements before the fix.
- [ ] The same test returns `沟通成功` after the fix.
- [ ] With separate “留在此页” and “继续沟通” controls, only the continuation
      action is selected for best-effort template append.
- [ ] If the composer or append step cannot be completed after the receipt, the
      result remains `沟通成功` with `boss-success-dialog` evidence.
- [ ] Ordinary page-body text containing the same phrases is not accepted as a
      receipt.
- [ ] Search inputs and unrelated text fields remain unchanged.
- [ ] Focused extension tests, full Vitest, TypeScript typecheck, and extension
      build pass.
- [ ] The rebuilt extension behavior is manually rechecked after Chrome reload;
      the verification batch no longer ends as `已完成有异常` for this receipt.

## Out of Scope

- Changing verification/full-batch quotas or batch completion rules.
- Retrying an irreversible contact command.
- Adding remote selectors, CDP/debugger access, anti-detection behavior, or a
  real-BOSS automated test.
- Refactoring the complete DOM adapter beyond what the reproduced receipt needs.

## Technical Constraint

BOSS closes the page when DevTools opens, and no connected Chrome tab is
available for read-only inspection. The implementation therefore cannot depend
on a captured live DOM. It will model the remaining high-probability structural
gap—exact-text actions rendered as non-`button`/`a` elements—while retaining
strict receipt evidence and requiring a manual Chrome reload/recheck for final
live confirmation.
