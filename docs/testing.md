# Testing

Repository mechanics for contributors and CI. Judgement on what and how to
test lives in the built-in `test-suite` skill, not here.

## Discovery and lanes

`npm test` (root and `apps/desktop`) runs `scripts/test.mjs`, which globs every
`*.test.mjs` and `*-test.mjs` under `src/` and `scripts/` of the invoking
package. A file joins the suite by existing; `package.json` lists no test
paths. The lane comes from the file name:

| Name | Lane | Runs |
| --- | --- | --- |
| `*.test.mjs` | fast | `npm test`; every push in `release-gate.yml` |
| `*.slow.test.mjs` | slow | `npm run test:slow`; its own gate job beside the fast one |
| `*.live.test.mjs` | live | `npm run test:live`; needs a built artifact or live system |
| `*.electron.test.mjs` | electron | `npm run test:electron` (apps/desktop); needs a real Electron and window-capture surface, never two runs at once |

A file over ~10s alone is renamed `*.slow.test.mjs`; nothing else changes. The
root slow lane and the desktop fast lane are each split with `--test-shard=N/2`
(forwarded to `node --test`), one machine per shard.

## Runner flags

- `npm test -- src/runtime/memory` narrows to a path substring; `--test-*`
  flags forward to `node --test`. Every run ends with the slowest files.
- `npm test -- --changed [filter...]` runs only discovered files whose relative
  references (`import … from`, `export … from`, `import()`, `require()`,
  `new URL(…, import.meta.url)`) reach a file that differs from HEAD, untracked
  files included. A changed file nothing references that way (a skill's
  markdown, a path joined at run time) is listed so a path filter can add its
  tests; the full lanes still gate the push.
- `node scripts/test-direct.mjs [Node test options] <files...>` takes exact
  paths or globs with no discovery or lane filtering, the same summary and
  full-log reporting, and forwards Node options unchanged (heap limits,
  preloads). An explicit `--test-concurrency` wins over the environment
  budget. Example:
  `node scripts/test-direct.mjs --test-name-pattern=parsing src/example.test.mjs`.
- The console summary omits passing test names; failures, warnings, skip/todo
  reasons, totals and slow-file timings remain. `Full test log:` points to an
  unfiltered report in a unique temporary directory.
- The runner supplies a temporary `MIXDOG_TEST_OOXML_CACHE_DIR` for the pinned
  Office schema validator; downloads are lazy and serialized across processes.

## Local gate

`npm run gate:local` runs the desktop build/e2e leg, then shares one
test-worker budget across the four lanes: up to six workers interactively,
`MIXDOG_TEST_CONCURRENCY` sets the total. All lanes run, including after one
fails.

## CI coverage

- `release-gate.yml` runs the fast, slow, electron, packaging and
  `shipped-history` jobs on every push.
- `scripts/tool-contracts/` is the discovered contract suite for the runtime
  tool surface; it runs in the `runtime` job.
- Built-artifact checks run after their build: `verify:packaging-artifact`
  (`packaging-artifact.live.test.mjs`) and `daemon.e2e.live.test.mjs` in the
  desktop build job.
- `suite-health.yml` runs every `test:*`/`smoke:*` script weekly through the
  opt-out enumeration in `scripts/suite-health.mjs` (stale exclusions fail
  closed, new scripts join) and opens a tracked issue on failure.

## Deliberate exceptions

Source-text assertions are accepted only for Electron main modules a renderer
test cannot import, where they pin ordering invariants:
`apps/desktop/src/renderer/remote-payload-limit.test.mjs`,
`apps/desktop/src/renderer/side-surface-background-errors.test.mjs`,
`apps/desktop/src/main/packaging.test.mjs` and
`src/runtime/office/office-live-runtime.test.mjs`.

`session-save-fault-store.slow.test.mjs` stays one file on purpose: one
stateful fixture chain over one store.

## Published packages carry no tests

`package.json` `files` excludes `src/**/*.test.mjs`, `src/**/*.test.jsx` and
`scripts/*.test.mjs`; test sources are also excluded from the prepared-runtime
cache key in `desktop-runtime.yml`.
