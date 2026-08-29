# Testing practices

Repository conventions that do not belong in the always-resident rule set
(`src/rules/shared/`). The judgment rule for writing a test lives there; the
mechanics below are enforced by configuration and CI instead.

## Text matching is a last resort

`assert.match` against source text pins names, spacing and constants rather
than behavior. It breaks on harmless refactors and passes on wrong behavior, so
it proves neither direction. Reserve it for artifacts with no runnable surface
— generated PowerShell programs, workflow YAML, prompt text — and say why in
the test.

A 2026-08 sweep cut these from 300 assertions to 43. `computer-host-safety`
dropped 25 of its 29 tests (1072 → 715 lines): they pinned PowerShell variable
names, `Start-Sleep` constants and brace placement, so they broke on refactors
while proving nothing about behavior. What survived is what actually runs —
window-transition and frame logic called directly, plus two tests that compile
and execute the generated PowerShell. The Office COM and PDF matchers went the
same way: `test:office:live` already executes the COM host, and `pdf-render.mjs`
already has behavioral coverage in the same file.

The remainder is the genuine exception — Electron main modules a renderer test
cannot import, asserting ordering invariants (a guard must precede its send)
rather than shape:

| File | Source-text assertions |
| --- | --- |
| `apps/desktop/src/renderer/remote-payload-limit.test.mjs` | 31 |
| `apps/desktop/src/renderer/side-surface-background-errors.test.mjs` | 4 |
| `apps/desktop/src/main/packaging.test.mjs` | 3 |
| `src/runtime/office/office-live-runtime.test.mjs` | 3 |

## One invariant, one owning test

Two suites asserting the same contract drift apart instead of reinforcing each
other. `compact-smoke.mjs` and `suite-compact-test.mjs` both covered
recall-fasttrack prior-summary handling; when the pipeline moved to rebuilding
context from Memory, only the suite was updated and the smoke stayed red for
months while asserting the opposite contract.

## Slow files run as their own script

A test file over ~5s gets its own npm script and a parallel CI job so the
default suite stays interactive.

`apps/desktop/src/main/git-cli.test.mjs` drives real `git` processes across 30
tests and takes ~240s, while the other 20 files in that suite finish in ~10s
combined. It runs as `npm run test:git --prefix apps/desktop` and as a separate
matrix leg of the `desktop-tests` job in `release-gate.yml`, which leaves
`npm run test:desktop-main` at ~3.6s.

## Published packages carry no tests

`package.json` `files` excludes `src/**/*.test.mjs`, `src/**/*.test.jsx` and
`scripts/*.test.mjs`. Test sources are excluded from the prepared-runtime cache
key in `desktop-runtime.yml` for the same reason: a test-only change used to
retire the prepared runtime of all five platforms and pay a ~7 min rebuild for
byte-identical output.

## A new test must fail when its subject is wrong

Confirm it once, then restore. `git-cli.test.mjs` documents the procedure it
uses: copy the implementation aside, undo exactly one behavior, check that the
failure names that behavior and that the other tests still run, restore.
