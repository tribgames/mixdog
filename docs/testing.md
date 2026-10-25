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
| `*.electron.test.mjs` | electron | `npm run test:electron` (apps/desktop); needs a real Electron and window-capture surface, never two runs at once; the Windows Computer Use leg of `release-gate.yml` |

`npm test -- src/runtime/memory` narrows to a path substring; `--test-*`
flags forward to `node --test`. Every run ends with the slowest files so a
slow default lane always names its cause; a file over ~10s belongs in the
slow lane (rename it). The desktop package passes its `--import` loaders
through the same entry.

`npm run gate:local` runs the desktop build/e2e leg separately, then shares
one test-worker budget across the four test lanes. The interactive default
is up to six workers in total; `MIXDOG_TEST_CONCURRENCY` sets the total
budget, or the shell's existing concurrency share is used. All lanes still
run, including when another lane fails.

The runner supplies a temporary `MIXDOG_TEST_OOXML_CACHE_DIR` for the pinned
Office schema validator. Downloads are lazy and serialized across processes,
so document tests reuse the executable without sharing their documents or
session data. A local gate shares this cache across lanes; ordinary runs
remove their cache with their scratch directory. Explicit validator paths,
disabled validation and download opt-outs keep their existing behavior.

Successful test names are omitted from the console summary; failures, warnings,
skip/todo reasons, totals and slow-file timings remain. `Full test log:` points
to an unfiltered report in a unique temporary directory.

During a change, `npm test -- --changed [filter...]` runs only the discovered
files whose relative references (`import … from`, `export … from`, `import()`,
`require()`, `new URL(…, import.meta.url)`) reach a file that differs from HEAD,
untracked files included. A changed file nothing references that way — a skill's
markdown, a source a module finds by joining a path at run time — is listed so a
path filter can add its tests; the full lanes still gate the push. The office suite, for one, runs in about 9s this way instead of 20s:
its files take 2-5s each alone, and the longer times in a full run are
LibreOffice processes contending, not slow files to move to the slow lane.

For exact file paths/globs and Node options without discovery or lane filtering,
use `node scripts/test-direct.mjs [Node test options] <files...>` instead of
`node --test`. For example:

```sh
node scripts/test-direct.mjs --test-name-pattern=parsing src/example.test.mjs
```

This entry uses the same summary and full-log reporting, forwards Node options
unchanged (including parent heap limits and preloads), and does not add force-exit
or module-mock flags. The named npm suites use this entry to share concurrency
limits and the temporary validator cache without changing their exact file/glob
selection, including slow/live files. An explicit `--test-concurrency` still wins
over the environment budget. Direct `node --test`, Cargo and arbitrary shell
commands remain unfiltered.

## Text matching is a last resort

`assert.match` against source text pins names, spacing and constants rather
than behavior. It breaks on harmless refactors and passes on wrong behavior, so
it proves neither direction. Reserve it for artifacts with no runnable surface
— generated PowerShell programs, workflow YAML, prompt text — and say why in
the test.

The genuine exception is Electron main modules a renderer test
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
finishes at the longer of the two instead of their sum. The root slow lane and
the desktop fast lane are each split in two with `--test-shard=N/2` (forwarded
by `scripts/test.mjs` to `node --test`), one machine per shard.

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
