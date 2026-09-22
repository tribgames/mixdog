# Mixdog Instructions

- Tests: `npm test -- <path or file>` scoped to the changed area; the
  unscoped root run fails on Windows (command-line length limit). Desktop:
  `cd apps/desktop && npm run typecheck && npm test -- <path>`.
- Formatting and linting: this repository has no local Biome or ESLint
  install. Both run only through the `tidy` tool, which applies the repo's
  `biome.json` with its managed Biome 2.5.13. `npx biome` here resolves to an
  unrelated npm package and must not be used.
- Load-sensitive tests, flaky under parallel load — rerun alone before
  treating a failure as real:
  `apps/desktop/src/main/computer/overlay/cursor-art.electron.test.mjs`,
  `apps/desktop/src/main/computer/backend/window-graphics-capture.electron.test.mjs`,
  `src/runtime/agent/orchestrator/session/store-transcript-cache.test.mjs`.
