# Testing and Build Commands

## Test Layout and Patterns

Tests mirror source ownership under `tests/core`, `tests/storage`,
`tests/server`, and `tests/extension`; dashboard scenarios live under
`tests/e2e`. Vitest runs `tests/**/*.test.ts` in the Node environment.

- Pure rule tests use table-driven `it.each` and deterministic injected time.
- Core/store tests use a real temporary SQLite database plus fake adapters.
  Track temporary directories, close the store, and remove data in `afterEach`.
- Fastify tests use `buildServer` plus `server.inject`; register cleanup in
  reverse order and close both server and store.
- Bridge tests use in-memory settings and fake sockets. Service-worker tests
  stub `chrome`/`WebSocket`, call `vi.resetModules`, and test restart/idempotence.
- DOM tests use `happy-dom` and sanitized fixtures under
  `tests/fixtures/boss/`; assert normalized output does not contain raw HTML.
- Playwright tests use semantic roles/labels, one worker, and the fake adapter.
  Their route guard aborts every non-local request.

Test descriptions state observable behavior. Follow the language already used
by the owning test file (domain-facing suites are mainly Chinese; low-level
bridge protocol tests currently use English).

## Commands

Run from the repository root:

| Purpose                       | Command                           | Notes                                           |
| ----------------------------- | --------------------------------- | ----------------------------------------------- |
| Install exactly from lockfile | `npm ci`                          | CI and clean verification                       |
| Development server + Vite     | `npm run dev`                     | Server 4317, web 5173                           |
| Strict type check             | `npm run typecheck`               | `tsc --noEmit`                                  |
| Unit/integration tests        | `npm test`                        | Vitest run mode                                 |
| Watch tests                   | `npm run test:watch`              | Local development only                          |
| Build all deliverables        | `npm run build`                   | Typecheck, `dist/web`, `dist/extension`         |
| Formatting check              | `npm run format:check`            | Non-mutating                                    |
| Install E2E browser           | `npx playwright install chromium` | First local run                                 |
| Local dashboard E2E           | `npm run test:e2e`                | Cleans `.jobpilot/e2e`, builds, then Playwright |

`npm run test:e2e` invokes `pretest:e2e` automatically and includes a full
build. CI (`.github/workflows/ci.yml`) installs Node 24 and Chromium, then runs
format check, Vitest, and E2E. There is no separate lint command.

After the initial Trellis integration, the project-wide `npm run format:check`
also scans generated `.agents/` and `.trellis/` content because those paths are
not in `.prettierignore`. At bootstrap time those generated files are not all
Prettier-clean, so the command fails outside application source even though
`.trellis/spec/` itself passes. Do not bulk-format generated Trellis files or
change `.prettierignore` as part of an unrelated application task; treat that
integration cleanup as a separate explicit change.

## Verification by Change Type

- Pure core or helper change: `npm run typecheck` and `npm test`.
- Server/storage/extension contract change: `npm run build` and `npm test`.
- UI behavior or cross-layer user flow: `npm run format:check`, `npm test`, and
  `npm run test:e2e`.
- Extension DOM selector change: focused DOM tests plus full `npm test` and
  `npm run build:extension`; never substitute a real BOSS smoke test.
