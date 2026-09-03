# Testing practices

Repository conventions that do not belong in the always-resident rule set
(`src/rules/shared/`). The judgment rule for writing a test lives there; the
mechanics below are enforced by configuration and CI instead.

## Tests are discovered, not registered

`npm test` (root and `apps/desktop`) runs `scripts/test.mjs`, which globs
every `*.test.mjs` and `*-test.mjs` under `src/` and `scripts/` of the
invoking package. A file joins the suite by existing; nothing in
`package.json` lists test paths. The lane comes from the file name:

| Name | Lane | Runs |
| --- | --- | --- |
| `*.test.mjs` | fast | `npm test`; every push in `release-gate.yml` |
| `*.slow.test.mjs` | slow | `npm run test:slow`; its own gate job beside the fast one |
| `*.live.test.mjs` | live | `npm run test:live`; needs a built artifact or live system |

`npm test -- src/runtime/memory` narrows to a path substring; `--test-*`
flags forward to `node --test`. Every run ends with the slowest files so a
slow default lane always names its cause; a file over ~10s belongs in the
slow lane (rename it). The desktop package passes its `--import` loaders
through the same entry.

The 2026-09 sweep found 201 of 401 test files registered nowhere: hand-kept
path lists in `package.json` had drifted for weeks, and two of the unlisted
files were already broken (a `find` widening notice dropped in a refactor, a
renamed Computer Use host module). Discovery is the fix, not a longer list.

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
prior-summary handling; when Compact moved to one fresh-context contract, both
suites were reduced to distinct observable boundaries instead of carrying the
retired execution paths forward.

The boundary today: `suite-compact-test.mjs` owns the fresh-context layout,
legacy-setting migration, Reference manifest, and fail-closed handoff budget;
`compact-smoke.mjs` owns one short end-to-end sanity pass. Deeper Main/Agent
source behavior lives in `compact-fresh-context.test.mjs`.

## A contract suite runs in CI or it drifts

`scripts/tool-smoke.mjs` guarded the runtime tool surface for months but ran
only on the developer's machine. When the agent-session schema was unified on
2026-08-28, nothing forced the suite to follow: it kept asserting three
retired contracts and would have failed on any run. Its replacement,
`scripts/tool-contracts/`, is discovered like every other file and runs in
the `runtime` job of `release-gate.yml` on every push. A suite that asserts a
contract but runs nowhere automatic is documentation with an expiry date.

Built-artifact checks are the exception: `packaging-artifact.live.test.mjs`
reads `out/`, `.runtime/` and `dist/`, so it runs as
`verify:packaging-artifact` after the platform package is built, and
`daemon.e2e.live.test.mjs` boots the bundled daemon in the gate's desktop
build job. Source-shape packaging invariants stayed in
`packaging.test.mjs` and moved into the fast lane: a renamed browser-import
module broke them twice in one day, each time eight minutes into a Deploy
run, because the release's Windows packaging job was the only place they ran.

Scripts that are not test files (`smoke:*`, harness runners) are swept
weekly instead: `suite-health.yml` runs every `test:*`/`smoke:*` script
through the opt-out enumeration in `scripts/suite-health.mjs` (stale
exclusions fail closed, new scripts join automatically) and opens a tracked
issue on failure. Deliberate exclusions carry their reason in the runner:
lane aggregates, artifact-dependent lanes, and live COM/desktop harnesses.

## One domain, one test file

A multi-domain test file makes every change pay a whole-file search: fixing
one tool meant scanning the 3,561 lines of `tool-smoke.mjs`. Suites split by
domain instead — `scripts/tool-contracts/` keeps one file per tool domain
(search-tools, patch-edit, shell-task, …) over shared `_env.mjs` fixtures, so
a feature fix touches its own file and `node --test` runs files as parallel
processes (~6s total). Split an existing file when one change makes you
search across domains, not on line count alone.

The 2026-09 sweep split `provider-toolcall-test.mjs` (3,533 lines, 134 tests),
`session-transport-test.mjs` and `suite-shellhardening-test.mjs` the same way
into `scripts/provider-toolcall/`, `scripts/session-transport/` and
`scripts/shellhardening/`. `session-save-fault-store.slow.test.mjs` stays
whole on purpose: one stateful fixture chain (C1–C37 subtests over one live
store) covering one domain is one file, whatever its line count.

## Slow files carry the slow lane in their name

A test file over ~10s is renamed `*.slow.test.mjs`. Nothing else changes: it
is still discovered, still runs in CI, but in the `runtime-slow` job (root)
or the `slow` leg of `desktop-tests` beside the default lane, so the gate
finishes at the longer of the two instead of their sum.

`apps/desktop/src/main/git-cli.slow.test.mjs` drives real `git` processes and
takes minutes while the other ~120 desktop files finish in ~7s together. The
root lane's ten slowest files (session runtime, git command tool, shell
hardening, tool contracts) held the default run at ~57s on a 20-core machine;
moving the eight over 10s into the slow lane cut it to the length of the
longest remaining file.

## Published packages carry no tests

`package.json` `files` excludes `src/**/*.test.mjs`, `src/**/*.test.jsx` and
`scripts/*.test.mjs`. Test sources are excluded from the prepared-runtime cache
key in `desktop-runtime.yml` for the same reason: a test-only change used to
retire the prepared runtime of all five platforms and pay a ~7 min rebuild for
byte-identical output.

## A new test must fail when its subject is wrong

Confirm it once, then restore. `git-cli.slow.test.mjs` documents the procedure it
uses: copy the implementation aside, undo exactly one behavior, check that the
failure names that behavior and that the other tests still run, restore.
