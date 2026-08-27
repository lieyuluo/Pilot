# Quality Specs

These rules apply across backend, web, and extension code.

- [TypeScript and formatting](./typescript-style.md)
- [Testing and build commands](./testing-and-build.md)

## Pre-Development Checklist

- Find a representative source file and its mirrored test under `tests/`.
- Decide which strict TypeScript/optional-field boundary the change crosses.
- Identify the smallest relevant test level: pure unit, store/API integration,
  DOM/protocol simulation, or local dashboard E2E.

## Quality Check

- No `any`, implicit unsafe wire cast, or explicit `undefined` for an optional
  property has been introduced.
- Prettier, strict type checking, unit/integration tests, and relevant build/E2E
  checks pass.
- Tests close stores/servers and remove temporary data.
- No automated test can contact real BOSS or another external host.
