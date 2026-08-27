# Design: Robust Success-Receipt Control Discovery

## Scope and Boundaries

The change remains inside the BOSS DOM adapter and its focused tests:

- `src/extension/boss-dom.ts` owns receipt discovery and continuation clicks.
- `tests/extension/boss-dom.test.ts` owns the deterministic DOM regression.
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

## Validation and Rollback

The regression must fail before the source change and pass afterward. Existing
negative page-body and search-input tests guard the widened selector. If the
change causes false positives or unrelated-field writes, revert only the new
control-discovery hunk and keep the task in diagnosis.

Final live validation requires rebuilding `dist/extension`, reloading the
unpacked extension in Chrome, refreshing the BOSS page, and running one normal
verification batch under the project's existing human-supervised rules.
