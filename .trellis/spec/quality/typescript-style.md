# TypeScript and Formatting

## Compiler Baseline

The repository is an npm-managed, single-package ESM project on Node.js 24+.
`tsconfig.json` enables `strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `isolatedModules`, and bundler resolution.

- Use `.ts`/`.tsx` on all relative imports.
- Use `import type` or inline `type` specifiers for type-only dependencies.
- Treat external JSON, WebSocket messages, Chrome messages, and caught errors as
  `unknown`; validate at the boundary before using them.
- Do not use `any`. The existing codebase contains none.
- Prefer interfaces for object/port contracts and unions for finite states or
  message variants. Use `Extract`, `Exclude`, `ReturnType`, and `Awaited` where
  they keep a contract tied to its owner.
- With exact optional properties, omit absent keys via conditional spreads
  rather than assigning `undefined`. Row mapping and protocol status builders
  in `src/storage/store.ts` and `src/extension/bridge.ts` are references.
- Use exhaustive/discriminated branches for stateful message types. Keep a
  final invalid-message error at untrusted protocol boundaries.

## Local Code Shape

- Prefer named exported factory functions (`createBatchRunner`, `buildServer`,
  `openJobPilotStore`) with explicit dependency interfaces. Classes are rare;
  use them when identity/subclass behavior matters, as with
  `HumanTakeoverRequired`.
- Use early returns for invalid states and small local helpers for normalization,
  mapping, and repeated boundary behavior.
- Constants use `UPPER_SNAKE_CASE`; functions/variables use `camelCase`;
  interfaces/types use `PascalCase`; SQLite identifiers use `snake_case`.
- Preserve Chinese domain literals and user-facing messages. Code identifiers
  remain English.
- Import groups follow the current pattern: Node built-ins, blank line,
  third-party packages, blank line, project-relative imports.

## Formatting

Prettier 3 is the only configured formatting tool; there is no ESLint/Biome
configuration or lint script. Follow the emitted style: double quotes,
semicolons, trailing commas, and Prettier-managed wrapping. `docs/adr` and the
lockfile are intentionally excluded by `.prettierignore`.

- Format changes with `npm run format` when authorized.
- Verify without modifying files with `npm run format:check`.
- Do not claim a lint gate exists unless the project adds and configures one.
