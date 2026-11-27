# Testing

Repository mechanics for contributors and CI. Judgement on what and how to
test lives in the built-in `test-suite` skill, not here.

## Discovery and lanes

`npm test` (root and `apps/desktop`) runs `scripts/test.mjs`, which globs every
`*.test.mjs` and `*-test.mjs` under `src/` and `scripts/` of the invoking
package. A file joins the suite by existing; `package.json` lists no test
paths. The root package also discovers `packages/**` (the workspace packages,
`*.test.ts` included, run through tsx) and `apps/mixdogd-npm`, so those tests
run in the root fast and slow lanes. The lane comes from the file name:

| Name                  | Lane     | Runs                                                                                                             |
| --------------------- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| `*.test.mjs`          | fast     | `npm test`; every push in `release-gate.yml`                                                                     |
| `*.slow.test.mjs`     | slow     | `npm run test:slow`; its own gate job beside the fast one                                                        |
| `*.live.test.mjs`     | live     | `npm run test:live --prefix apps/desktop` (the root has no live test); needs a built artifact or live system     |
| `*.electron.test.mjs` | electron | `npm run test:electron` (apps/desktop); needs a real Electron and window-capture surface, never two runs at once |

A file over ~10s alone is renamed `*.slow.test.mjs`; nothing else changes. The
desktop fast lane is split three ways with `--test-shard=N/3` (forwarded to
`node --test`), one machine per shard. The root default lane is sharded the
same way by `scripts/ci/node-shards.mjs`, which sizes the count from the files
the lane discovers (one shard per 250 files, at most three; one today).

## Runner flags

- `npm test -- src/runtime/office` narrows to a path substring; `--test-*`
  flags forward to `node --test`. Every run ends with the slowest files.
- `npm test -- --changed [filter...]` runs only discovered files whose relative
  references (`import … from`, `export … from`, `import()`, `require()`,
  `new URL(…, import.meta.url)`) reach a repository change, including deletions
  and untracked files. For computed inputs, put `// @test-input ./relative/path`
  in the reader; a trailing slash declares a directory's contents. References
  can cross package boundaries, but test discovery and lanes stay local.
  Unreached changes in the current scope are listed; if none of the selected
  tests reaches a change and that list is nonempty, the command exits nonzero.
  Use a test path filter **without** `--changed` for an undeclared input.
  The full lanes still gate the push.
- `node scripts/test-direct.mjs [Node test options] <files...>` takes exact
  paths or globs with no discovery or lane filtering, the same summary and
  full-log reporting, and forwards Node options unchanged (heap limits,
  preloads). A named file or glob that matches nothing fails the run (Node
  itself exits 0 on it). An explicit `--test-concurrency` wins over the environment
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

## The Rust core's committed suite

The tests in git say what the product does, with the expectation written in the test (or derived from a stated rule). Comparisons
of the Rust core with the retired Node implementation (their recorders, the data they recorded and the tests built on it) are
not part of the repository, tracked or local: a working tree holds what git holds, and a clean checkout builds every crate and
test target and passes the `ci` nextest lane. Cargo builds every `tests/*.rs` (and `src/bin/*.rs`) file it finds in a crate, so
an untracked test file in a working tree would be built as a test target; `check-clean-checkout.mjs --build` refuses one in CI.

**Conventions for the committed tests.**

- A feature's tests live in the module of the code they test (`mod tests` of the file, or a `<feature>_tests.rs` beside it), and
  in `tests/<feature>.rs` for the crate's public surface; a test names the behaviour (`a_stopped_session_refuses_new_turns`), not
  an origin.
- Expectations are written in the test, or derived from a stated rule in a comment; they are not copied from a recording.
  Inputs are small and committed beside the test.
- Committed test code, comments and names do not refer to Node, recorders, recordings or parity.
- No tracked file declares, includes or reads an untracked file; a test that needs recorded data is not added to the tree.
- A test that needs a machine path, a prebuilt binary, a second volume or a user's data is `#[ignore]`d with its reason and run by
  the nextest profile that names it (`native/core/.config/nextest.toml`), never by `ci`.

## The Rust core's test set

The core (`native/core`) has one set of tests: every test in git (the committed suite). Each says what the product does with the
expectation written in the test. A clean checkout builds and runs all of it, and this is what CI runs.

### Running them

The tests run with `cargo nextest` from `native/core` (`cargo install cargo-nextest`; CI uses 0.9.151, the version
`.config/nextest.toml` is written for). A machine may have a wrapper that sets the build environment; the commands below are what
it runs.

```sh
cd native/core
cargo nextest run --workspace --profile ci            # the tracked feature tests, as CI runs them (no retries)
cargo nextest run -p <crate>                           # one crate, `default` profile
cargo nextest run --profile agent --workspace         # `default` without the heavy matrices
```

The commands above run exactly the tracked suite in any working tree that holds no untracked test file (see above).

The tests need no network. The tracked tests that run `node` need it on the search path, and `mixdog-office`'s
`tests/pptx_script.rs` also reads `node_modules/pptxgenjs` and `jszip` of the repository root: it returns early (a pass)
without them, so run `npm ci` at the root before a run you want to count.

### Nextest profiles

The list at the top of `native/core/.config/nextest.toml` is the one place that says where every test runs. In short:

| Profile                                                                   | Tests                                                                                | Where                    |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------ |
| `default`                                                                 | every test that is not `#[ignore]`d                                                  | locally; the merge check |
| `ci`                                                                      | `default` with no retries and a log that names slow and failing tests                | CI `core-tests-*`        |
| `agent`                                                                   | `default` without the heavy real-git and migration matrices                          | locally                  |
| `pg`                                                                      | `#[ignore]`d composed-core tests of `mixdog-app-server-daemon` (needs Postgres)      | CI `core-pg*`, locally   |
| `services-pg`                                                             | `#[ignore]`d memory tests of `mixdog-services` (needs Postgres)                      | CI `core-pg*`, locally   |
| `services-models`, `migration-corpus`, `office-throughput`, `pwsh-50-mib` | `#[ignore]`d tests that need models, a user's data, LibreOffice or a 414 MiB command | by hand only             |

### The Postgres profiles

`pg` and `services-pg` run `#[ignore]`d tests, so they take `--run-ignored only`; they need an unpacked PostgreSQL
runtime named by `MIXDOG_PG_RUNTIME` (with it unset or broken they fail, they do not skip). The runtime is the asset the
repository manifest `src/runtime/memory/data/runtime-manifest.json` names for the platform (the one the product downloads).

```sh
node scripts/ci/provision-pg-runtime.mjs <folder>                 # downloads, hash-checks and unpacks it; prints MIXDOG_PG_RUNTIME=<folder>
export MIXDOG_PG_RUNTIME=<folder>
cd native/core
cargo nextest run --profile services-pg --run-ignored only -p mixdog-services
cargo nextest run --profile pg --run-ignored only -p mixdog-app-server-daemon
```

The postmaster refuses to run as root or as an elevated user. Tests of both profiles share the `pg-cluster` group, so the tests
that start a cluster of their own run one at a time. The daemon's composed tests run their core in a child process under a budget
of 690 s and are given 720 s by an override in the config.

## Release coverage

Publication is impossible unless every tracked test file and Rust test target ran at least one case on each leg that must run it,
and every skip a runner reported is an exact reviewed exception, at the exact release commit. `coverage-gate` is a literal hard `needs` of every job that publishes (`release.yml` `publish`, the
`deploy.yml` publishing jobs, the sink workflows `mobile-android.yml` and `build-runtime.yml`, which are reachable only through
`workflow_call`). It has no `if`, and nothing reads run history to authorise a release: the gate runs for the resolved SHA on
every path. **Refresh Runtime Manifest** dispatches from the default branch and runs the full gate. By default it re-smokes
and verifies the five public runtime pairs without editing them; `force_rebuild` instead takes the gated build and publication
path. The handoff downloads the worker's manifest by artifact ID and stages the same bytes at
`src/runtime/memory/data/runtime-manifest.json` in the handoff artifact, without updating a branch.

- **Order of writes.** No release-visible effect (default branch, tags, releases, packages, stores, deploys) happens before evidence; private candidate transport refs are written and cleaned outside it. `deploy.yml`
  `native-commit` and `prepare-app` make their commits locally and push them only to `refs/mixdog-candidates/<run>/...`, a ref
  no workflow, release or feed uses as a publication source (`candidate-cleanup` deletes them after a successful release and retains
  them after failure for retries). Candidate commits and changelog dates derive from the dispatch commit, not the current clock or branch tip. Those refs are pushed before their
  SHA is gated only because the gate needs a remote ref to check out: they are transport, not release refs. The jobs that
  write any ref (the three candidate writers and the leased push) are not recognised by their commands: the plan pins each whole by
  content digest (`plan.json` `wiring.pinnedJobs`), so what they push is a reviewed change. The native workers (`runtime`, `voice`, `graph`) need the native gate and receive the gated
  SHA as `sha`: each checks out that SHA, asserts HEAD (`.github/actions/assert-sha`), and creates or verifies its tag and draft
  at it (`target_commitish` is the SHA, never the default branch). `release.yml` `push-release-refs` is the first write of the
  release: after its gate, one atomic push moves the default branch from the deploy's commit (a lease) to the gated commit and
  creates the app tag there, and it waits for the prepared-runtime join as well as the gate: no release ref is written before every
  replacement an exception promises (a case skipped in the gate and run in the Windows package job) has its evidence, and the
  wiring check requires every leased push to need every job that runs `cli.mjs join`. A release tag is never forced or moved; an
  existing tag at another commit fails the run. `publish` and `mobile-android` need `push-release-refs`. Every artifact a gate
  call produces or consumes (manifest, evidence, listings, the core-tests archive, `mixdogd-dev`) is scoped to the run and named by
  `artifacts.mjs`: kind, the caller's `gate` name and the SHA. A rerun producer replaces its own named artifact; consumers reuse
  successful producers' artifacts without merging downloads. Distinct calls in one run never share evidence. The join
  evidence has its one exact name at both ends. A hidden draft is staged from the list of releases (`release-state.mjs`): a public
  release of the tag is refused, one draft is resumed only if it targets this commit and is then used by its id, only a complete listing
  that lacks the tag creates one, and a failed lookup stops the run. The macOS notarization submission in `desktop-package.yml` runs
  before the verdict because the package under test must be notarized to be tested; it publishes nothing.
- **Inventory.** `cli.mjs inventory` lists test _files and targets_, never cases, from `git ls-files` of the exact commit (HEAD
  must equal the SHA, tree clean). One convention decides what a test file is: a file named the way its runner discovers tests
  (Node `*.test.*`, `*.spec.*`, `*-test.mjs`, `*_test.*`; Python `test_*.py`, `*_test.py`; `*.test.sh`). The naming convention is the whole contract:
  a file named otherwise is not a test file. As a diagnostic only, a tracked JS or Python file not named so that directly imports a
  test runner (`node:test` by `import`, a side-effect `import`, `require` or `import()` of a literal, `import unittest`/`pytest`,
  also in `import os, unittest`) is reported unless classified; it removes comments with a regular expression, and it cannot see a
  runner loaded through a wrapper module, a computed load, or a global test API (`test/example.js`): such a misnamed test is not
  discovered by any run and not reported. Every Rust package of the tree is read too. A test file is assigned by a route of the plan to the legs
  that must run it, or carries a reviewed class (`plan.json` `classes`: `fixture`, `helper`, `template`, `vendor`,
  `non-test-target`, `not-run-in-ci` for a real test no hosted
  runner can run (a desktop, a real Office), `not-run-by-decision` for a test a hosted runner could run and that is not wired: it
  lists what is missing and is the owners' choice, not an impossibility, and `runs-after-packaging` for a test that checks a built
  package, whose receipt is a join slot the release's join requires before any sink); two classes matching one path are an error. The manifest names every Rust target the
  manifests declare (crate × target, never a case) of the workspace and of each standalone crate. Reconcile compares them with the
  targets each build variant's unfiltered `nextest list` shows, and a standalone run's own listing (`run-nextest.mjs --list`, kept
  in its receipt): a declared target no listing shows has vanished, a listed one no manifest declares is unexplained, an empty or
  malformed listing is an error, and a target that holds tests needs a pass of its own on its legs, whatever the other targets of
  its crate did. The comparison is per build variant and per platform of a standalone crate's
  clauses, never pooled: a target another platform shows does not satisfy one that vanished here, and a target that legitimately
  does not exist on a platform is declared in `plan.json` `rust.absent` by rule, never inferred from its absence. Each variant's
  listings are exactly its `all` listing, one per profile the plan names, and a binding of the invocation (the plan's list leg, at
  the SHA) that made them; anything else is an error. Receipt identities are validated by runner, family and kind: a case record
  carries the runner's case component, so a file-only record discharges nothing. Any other package, and any `.rs` file no target reaches through `mod`, `#[path]` or `include!`, is an error unless
  classified. Doctests are a target of their own, run by `run-doctest.mjs` (`cargo test --doc`) in the slot the plan's
  `rust.doctests` names; a file holding rustdoc blocks with neither is an error. An unassigned test file is an inventory error. A checkout that differs from its commit (a modified,
  deleted or untracked path) is refused by name before anything is read; locally, commit the intended content first.
- **Plan.** `scripts/ci/coverage/plan.json` is the reviewed contract: legs (`<os>/<job>/<n>of<m>`, with the workflow, job and
  slots that must produce a receipt; each slot names its producer, and a child slot the slot whose invocation launches it),
  routes from globs to the clauses of legs a file must run in (every clause needs one of its legs; a leg with several slots is
  named as `leg#slot`), join legs (prepared environments only `release.yml` builds), the Rust variants (list leg, test legs,
  profile legs) and owners. Legs declared and legs observed must be equal both ways; there is no pending producer.
- **Evidence.** Each leg's runner writes a receipt (`evidence.mjs`, version 2): an envelope (repository, SHA, workflow, run, attempt,
  leg, OS, slot, parent slot and parent invocation, producer), one terminal record per case the runner reported (and per suite it skipped or failed), and a trailer with
  the record count and content hash. The SHA is read from the checkout the runner starts in (`git rev-parse HEAD`), never from
  the environment. Node uses `scripts/ci/skip-reporter.mjs` through `node-runner.mjs` (the synthetic file
  event is dropped), Python `run-receipt.mjs` with `py-runner.py`, shell suites `run-shell-suite.mjs` (a case is each `ok:`
  line, failed by a `FAIL:` line of its name), Rust nextest's own JUnit through `run-nextest.mjs` and `adapters.mjs`: an
  ignored test is an ignore only where nextest itself reported it skipped in a default run, never from a listing, and under
  `--run-ignored` a skipped testcase is refused. The `upload-evidence` action uploads them; a job with declared legs and no
  upload step fails the wiring check.
- **Reconcile.** `cli.mjs reconcile` trusts an artifact only for this repository, workflow, SHA and run. A partial rerun can
  reuse a successful leg's earlier attempt, but all slots within one leg must come from a single producer attempt. It requires an intact
  file (trailer and hash), complete, exit status 0, on the platform of the leg it names, in a slot the leg declares, written by
  the producer the plan names for that slot. A child slot counts only from the children folder of its declared parent slot's
  receipt, naming that invocation; a top-level slot never from a children folder. It then fails on: a missing leg or
  slot, an undeclared leg, a reported case whose file or target the inventory does not assign, a failure (a retry is a failure),
  a report from a leg no clause of its file names, a file or target with no passing case on a leg of one of its clauses
  (`no-cases`: nothing ran there, or every report was a failure or a skip), and a skip or ignore with no exact exception for that
  platform. A leg that only skipped a file still counts when every skip is an exception whose `runs` replacement names a slot
  where that same case passed. A skipped suite has no exception form. Case names come from the runner at run time, so a computed, generated or
  macro-made name is fine; the Rust listings (`rust-lists-<os>`) only tell which targets exist per build variant and which
  ignored tests a profile leg runs.

  This does not prove a test body checks anything: a case that returns before its assertion, or a loop that registers nothing,
  passes as long as the file reported one case that ran. It proves that the leg ran the file and that nothing it reported failed
  or skipped unreviewed.
- **Exceptions.** `exceptions.json` holds exact tuples: case identity (as the runner reports it), platform, kind, reason code and
  text, owner, reason and replacement. Unknown fields are rejected. An exception on Linux does not excuse Windows. A tuple whose
  skip was not reported by any leg (a deleted file, crate or method, or a skip that became a pass) is stale and fails.
  The replacement is structured and enforced: `{kind: "runs", in: [leg#slot, ...]}` needs a pass of the same case in one of
  those slots, `{kind: "parent", parents: [identity, ...]}` a pass of every test that starts it in a leg that ran the
  child's build (a partition or a profile leg of the same archive: every partition reports an ignored child, and its starter runs in one); an ignored Rust test a profile leg runs is not credited by the listing: the same case must pass on that profile leg; `{kind: "none", reason}` states
  that nothing replaces it. A replacement in a join leg is checked by `cli.mjs join` in `release.yml` `prepared-runtime-join`
  against the gate's manifest of the same commit, before `publish`.
- **Wiring.** `cli.mjs wiring` parses the workflows against closed lists, not by recognising commands: in every workflow that
  calls the gate each job is a sink in `plan.json` `sinks` (it must need the gate, and the join where the caller joins, and carry
  exactly the one reviewed `if`, or none) or a reviewed non-sink in `nonSinks` with a reason, and a job in neither is an error.
  A caller's `gate` and `joins` inputs must be literals (`release`, `true`), never expressions. No job tolerates its own failure,
  every job with legs uploads evidence after its last test step and unconditionally, or (a leg of several test steps, such as
  `core-pg-macos`) after any of them ran, whatever its tests ended. The verdict jobs (`inventory`, `complete`,
  `prepared-runtime-join`) are pinned whole: their `if`, the exact commands of their deciding steps, no condition,
  `continue-on-error` or other shell on those steps, and a digest of the job in `plan.json` `wiring.verdictJobs`, so an
  inserted, removed, reordered or edited step is a reviewed change. Every sink checks out the SHA its gate verified, and is verified
  against its own named gate job, not any ancestor. Every edge into another workflow is a listed disposition, so a new entry point
  calling a publishing workflow is an error until reviewed. Matrices are counted only in the two forms the gate uses (axes alone, an
  `include` list alone); any other form is an error. `latest-guard.yml` reports pointer drift only and writes no release.

`scripts/ci/coverage/coverage.test.mjs` exercises the adversarial cases (a file whose leg ran no case, a skipped suite, an unreviewed
skip, an unlaunched child slot, a narrowed Rust filter, a removed matrix leg, a disabled job or removed `needs`, Python skip text
with both quote styles, stale exceptions), each failing closed, and the cases of the reviewed hardening: a child slot credited
from itself, a sibling or a top-level run, a case reported by the wrong leg, missing or foreign provenance, a dirty checkout, an
unenforced replacement, and each way of switching off the verdict or moving a release ref before or around the gate.

## CI coverage

What each part of `release-gate.yml` runs, and when, and which run proves what:

| Run                                                                                                                                                                      | Rust core                                                                                                           | Other lanes                                       | Reconciliation |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | -------------- |
| Pull request                                                                                                                                                             | the crates the change can affect, built, linted and tested on Linux                                                 | by changed path                                   | no             |
| Push to main                                                                                                                                                             | the crates the change can affect, as for a pull request (every crate for a core input outside the crates), on Linux | every lane but `rustfmt`, which follows its files | no             |
| Full gate: every `workflow_call` (the release, a deploy's native assets, the mirror, the runtime refresh), the nightly `schedule` on main, a manual run with `full_gate` | every crate on Linux, macOS and Windows                                                                             | every lane                                        | yes            |

A pull request and a push prove that the crates the change can affect build and their tests pass on Linux. Only the full gate
compiles the macOS and Windows code and proves the core's tests there, and only the full gate is a release: a call is a
full run whatever the selection says (`changes.outputs.full`, pinned by `wiring.mjs`), a full run requires every job of the graph
to have succeeded, and the reconciliation then requires the evidence of every leg of `plan.json` on its system, so a gate that did
not run the three systems cannot pass a release. A macOS- or Windows-only failure is chased with a manual run with `full_gate`.

The core inputs are `scripts/ci/core-inputs.mjs` `CORE_INPUTS`: `native/core`, the native trees its workspace builds or reads, the
toolchain pin, this workflow, its actions and scripts (`scripts/ci`, `scripts/rust-core`), and every path outside `native/` a core
build script or test reads (the Node runtime and protocol packages its tests start, the manifests and shipped files it embeds, the
benchmark fixtures and the relay pages). They were found by a scan of the core's sources (`include_str!`/`include_bytes!`,
`#[path]`, the testkit's `fixture!` macros, the `..` joins and `ancestors()`/`parent()` climbs of `CARGO_MANIFEST_DIR`), and
`release-gate-wiring.test.mjs` runs the scan: a core source that reads a path outside the set fails it, and a reach to the
repository root it cannot resolve fails it until `REVIEWED` says what that code reads. A base the push cannot be compared with
selects every file, and so the core.

The `complete` job covers every other job: one whose own `if` selected it must have
succeeded, so a selected job that ends skipped fails the gate; a job that was not selected may be skipped. Each job's `if` is
repeated in `complete` and compared by `scripts/ci/release-gate-wiring.test.mjs`, so a job added without its line fails that
test. A change to `rust-toolchain.toml`, to `release-gate.yml` or to the core's `Cargo.toml`/`Cargo.lock` selects every job that
consumes it (the test runs the selection over a table of paths).

- **Rust core.** `core-build-linux`, `core-build-macos` and `core-build-windows` compile the tests once per system (Linux x64,
  macOS arm64, Windows x64) with `cargo nextest archive --timings`, upload the archive and the build's timeline
  (`core-timings-*`), and use every core of the runner; each first checks the checkout is clean (no Cargo test target git does
  not track), so no untracked test file is in the archive. The archive is one archive of the whole selection, never one per leg.
  Each system's archive is one build on one runner; the workspace crates compile with the parallel front end
  (`-Zthreads=4` through `scripts/ci/rustc-threads.rs`, the test archive only), and `core-lint` compiles the same selection on
  plain stable. A build of part of the workspace unifies the features of fewer crates, so on its own it would compile some
  crates otherwise than the whole: `mixdog-protocol` and `mixdog-app-protocol` without `codegen`, `mixdog-imaging` without
  `test-support`, `mixdog-cli` with optional dependencies the whole leaves off. So `changes` resolves a push's or a pull
  request's selection once (`scripts/ci/core-align.mjs`), and the archive and `core-lint` both take that result: it compares
  `cargo tree` of the selection with `cargo tree --workspace`, each crate in each of its roles (built for the host, as a build
  dependency or proc macro, or for the target), selects with its features each workspace crate it resolves otherwise (no list:
  the rounds find them; such a crate is compiled without its tests being run) and repeats until the selection resolves as the
  whole does, failing when a round changes nothing, as a third-party difference does. A third-party difference is closed in the workspace hack (`cargo
  hakari generate`; `tracing-log`'s default features were the one). On Windows the Rust homes
  (registry, toolchain) and, in the test legs, the temporary folder nextest unpacks the archive into are on `D:`, the runner's
  local disk where the checkout and its target folder already are; `windows-2022` cannot make a ReFS Dev Drive (`Format-Volume
  -DevDrive` needs build 22621). A crate links one integration-test binary, `tests/it/main.rs` (or its `tests/features/main.rs`), with
  `autotests = false`: each `tests/<suite>.rs` is a `#[path]` module of it, because every test binary is one more link of
  the whole dependency graph, and nextest runs each test in a process of its own whatever binary holds it. A test's name
  carries its suite (`perf_pty::first_frame_is_not_slower_than_node`), and a test that starts its own executable on
  another test names that test with the path. A new suite file is a module of the root: the inventory fails a file no
  target reaches. `mixdog-migrate`'s `tests/long_log.rs` stays a binary of its own, since its counting
  `#[global_allocator]` would become the allocator of every suite, and so do `mixdog-workspace`'s `tests/read_admission.rs`
  (it boots and fills the process-wide executors) and `tests/no_polling.rs` (it counts every lane job of its process), which
  need a process of their own under a plain `cargo test` too. The development `mixdogd` (dev controls, with the `mixdog` terminal
  program and the ssh helper) is built by `mixdogd-linux` when a slow Node lane or the entry scenarios need it, and by
  `mixdogd-windows` for the app boot in `desktop-computer`: runners of their own beside the archive builds, checking their
  checkout the same way, so `desktop-slow`, `runtime-slow` and `core-entry` start when the Linux daemon is done and
  `desktop-computer` when the Windows one is, not when the slowest system's archive or the other system's daemon is. The archive
  builds alone compile the workspace crates with rustc's parallel front end (`.github/actions/rustc-threads`,
  `scripts/ci/rustc-threads.rs`, the CI form of the local `rustc-slot` wrapper): `-Zthreads=4` with `RUSTC_BOOTSTRAP` for that
  compiler process alone, which would therefore accept a `#![feature]`; the dependencies and every build-script probe on the
  plain compiler; a compile again without the flag when the compiler crashes (exit 101), with a warning in the log and a line in
  the job summary. Nothing a release ships, nor the mixdogd `core-real` or the dev daemon jobs build, goes through it, and
  `core-lint` compiles the archive's selection, every target, on plain stable on each system the archive is built for
  (`release-gate-wiring.test.mjs` pins both). `core-lint` runs on Linux for a push and a pull request and on the three systems in
  the full gate; the format check is its own job, `rustfmt`, selected by the files it formats on every event and run in every
  full run (the other lanes' selection turns them all on for a push). The source inventory runs on
  every run; the reconciliation against it only in the full gate. A push selects against the last commit the gate passed on for
  its branch (a newer push cancels an older one's run), both sides of a rename; the Rust core's crates against the last commit
  its jobs passed on (`scripts/ci/core-base.mjs`: the newest completed push run, not cancelled, whose `changes`, core jobs and
  dev daemons all passed or were not selected, so a run that failed only in another lane counts), falling back to the gate's
  base when no run qualifies or the query fails. Core-real builds the shipping profile in every full run.
  The legs of `core-tests-linux`, `core-tests-macos` and `core-tests-windows` each need their own system's archive alone: they
  download it and run `--profile ci --partition slice:k/N` (N from `scripts/ci/core-select.mjs`: on Linux one leg per 3,000
  tests, at most six; on macOS one per 4,000 tests, at most four, whose five concurrent jobs per account the legs share with
  `core-pg-macos`; on Windows, whose partitions run about twice as long as Linux's, one per 3,000 tests and at
  most six). The listings of each archive (the unfiltered list and one per profile that runs ignored tests, with their binding,
  and on Linux the lane-filter check) are produced by `core-list-linux` on Linux, `core-list-windows` on Windows and
  `core-pg-macos` on macOS (list legs `<os>/core-list/1of1` in `plan.json` `listLegs`), beside the legs rather than on the first of
  them. The
  ignored interactive scenarios of `mixdog-entry` (`tests/node_free.rs`) drive the dev daemon, so `core-entry` (leg
  `linux/core-entry/1of1`, the Linux variant's `entry` profile) runs them from the Linux archive against the Linux daemon. A pull
  request and a push archive the changed crates and their reverse dependencies (the whole workspace for a core input outside
  the crates); the full gate archives the whole workspace. Only a build of every crate on main writes the dependency cache. The
  doctests (`cargo test --doc` of `mixdog-core-api` and `mixdog-image-egress`, `run-doctest.mjs`) are `core-doctests`, leg
  `linux/core-doctests/1of1`, beside the build on its dependency cache. The development `mixdogd`, the release `mixdogd` of
  `core-real` and the relay of `relay-rust` are kept in a store (`actions/cache`) keyed by their inputs (`core-select.mjs`
  `STORES`, `store_key_*`: the mode, object and path of every tracked core input, without the files of the crates that build does
  not compile, a crate compiled being a normal or build dependency, optional ones included, or a crate a compiled crate's source
  reaches into by the reaches `core-inputs.mjs` `reachesOf` recognises: `include_str!`/`include_bytes!`/`include!`, `#[path]`,
  the fixture macros and the `CARGO_MANIFEST_DIR` climbs, a name in a comment or a string not being one) and built only when the store has no entry for the key; main writes the entries, a pull request reads
  them. The key leaves out the runner image: a program built by an older image's linker for the same inputs is taken. `core-pg` runs
  `services-pg` and `pg` from the Linux archive with the provisioned runtime, a leg per profile, when the archive holds the
  crate; `core-pg-macos` lists the macOS archive and runs both profiles, one after the other as the slots of leg `macos/core-pg/1of1`, in the full gate. `core-lint`
  runs clippy of the daemon when the selection holds the daemon (`core_daemon`; every full run), beside the plain stable
  compile. `rustfmt` is the format check of the whole workspace (`cargo fmt --all -- --check` for `native/core` and for each
  standalone tool under `native/` that has a `Cargo.lock`, configured by `native/rustfmt.toml`; `native/core/vendor` and the
  generated tables marked `#[rustfmt::skip]` are left alone). `core-real` builds the process-tree helper and
  runs its suites and the harness suites, and on Linux and macOS also builds the release `mixdogd` and boots it: on Linux for a
  push, on the three systems in the full gate. What it boots depends on the run. On a push and in the nightly and manual full
  gates it is the release-optimised build without the thin-LTO link (`--config profile.release.lto="off"`, opt-level 3), so the
  boot smoke there proves that the release-optimised daemon boots, not the shipped binary; the LTO link was most of the macOS
  build's 25-minute tail. A call of the gate builds the shipping profile, and the release's call builds nothing: it waits for
  the `mixdogd-<target>` that `release.yml` `mixdogd` (`mixdogd-build.yml`) builds for the packages and boots that, the same
  binary `release.yml` `core-smoke` boots and the npm packages ship. It runs on a push or in the full gate whenever the core or `scripts/rust-core` and its neighbours changed (everything, in
  the full gate). On a pull request it runs only when `scripts/rust-core`, `benchmarks/token-lang`, the harness's Rust-core suites, the
  toolchain pin, the core's `Cargo.toml`/`Cargo.lock` or the workflow changed, and then it skips the release build and the boot.
- **Node.** `runtime` (the root default lane, sharded by `scripts/ci/node-shards.mjs`), `runtime-slow` and `runtime-macos`
  for the root tree; `desktop`, `desktop-tests` (three shards plus Windows) and `desktop-slow`; `relay`, `relay-rust`,
  `packages`, and the standalone native crates (`patch`, `graph`, `spawn`, `window`, `browser-import`,
  `secure-desktop`, `computer-backend`).
- **Guards.** See "What each layer guarantees" below. `--build` in the `core-build-*` jobs, `mixdogd` and `core-lint` fails a Rust build that has
  a Cargo test target (`tests/<name>.rs`, `tests/<name>/main.rs`) git does not track. `core-tests-*` installs only `pptxgenjs` and `jszip` (`scripts/ci/lock-subset.mjs`) because
  that is all the tracked Rust tests read from `node_modules`.

### What each layer guarantees

The aim: nothing in the tracked suite may depend on a file git does not hold. Three layers: two guarantee something, the
third only points.

1. **The clean checkout runs everything (guarantee).** The gate builds and runs every suite on a clean checkout. A test that reads an absent file and does not handle it fails there. This is the only layer that sees a
   path assembled at run time.
2. **Every invocation proves it ran, and skips are reviewed (guarantee, for what a runner reports as skipped or ignored).** A test
   that skips instead of failing passes without testing, and a command that never ran, ran nothing or is a leftover passes
   without testing anything. So every test invocation of the gate leaves a **receipt** (`scripts/ci/receipt.mjs`) and the job
   ends by naming its receipts to `scripts/ci/check-skips.mjs receipts <file>...`:
   - the runner creates the file _before_ it runs, with a fresh id and `complete: false`, and refuses to start when the file
     exists (one receipt per invocation, never reused); the reporter appends what each test was (ran, skipped, todo, with its
     message) and the runner closes it with the totals and the exit status. The check fails a receipt that is missing,
     unreadable, incomplete, from a run that failed, with **zero tests**, from another system, or whose id another receipt
     carries. Several commands in one step (the Windows Computer Use suites, `core-real`) have one receipt each.
   - Node lanes: `scripts/test.mjs` (`npm test`, `test:slow`, `test:electron`, the desktop and relay lanes), the direct runs
     through `scripts/ci/node-runner.mjs` (`core-real`, `packages/protocol-client`) and `apps/mobile/scripts/run-tests.mjs`
     (`npm test` and `test:e2e`), selected by `MIXDOG_RECEIPT=<file>`.
   - A runner a test starts for a suite whose result counts (today `web-push-electron-runtime.slow.test.mjs`, which runs
     `web-push.test.mjs` under Electron through `node-runner.mjs`) finds `MIXDOG_CHILD_RECEIPTS` and leaves a receipt in
     `<receipt>.children/`, which the check reads with its parent. Runners that tests start over throw-away fixtures
     (`scripts/test-runner*.slow.test.mjs`, `gate-local.test.mjs`, `node-runner.test.mjs`, `check-skips.test.mjs`) are deliberately
     synthetic: `scripts/test.mjs` drops the receipt variable from the tests' environment and only `node-runner.mjs` and the mobile
     runner look for the children folder, so a fixture's skips never reach a lane.
   - Standalone Rust (`native/mixdog-{computer,spawn,patch,graph,secure-desktop,window}`, the process-tree helper) runs through
     `scripts/ci/run-nextest.mjs`, whose receipt records nextest's own JUnit testcases and listing; the workspace partitions and
     profile legs do the same, and `run-doctest.mjs` records the doctests. The Python `unittest` suites (mobile scripts, the
     benchmark harness) run through `scripts/ci/run-receipt.mjs` and `py-runner.py`. `check-skips.mjs --strict` accepts no skip at
     all (the prepared-Windows-runtime step of `desktop-package.yml`: the suite skips without a runtime, which is the failure).

   A skipped or todo Node test, an ignored Rust test and a skipped Python test fails the job unless an exact tuple in
   `scripts/ci/coverage/exceptions.json` names it (see "Release coverage" above).

   What this does not see: a test that **returns early without reporting a skip** (`if (!existsSync(p)) return;`) counts as a
   pass and no layer here can see it; the advisory scan `scripts/ci/scan-silent-returns.mjs` points at those shapes. Lanes the gate
   does not run (the live lane except `packaging-artifact.live.test.mjs`, the `*:integration` harnesses,
   `*.electron.test.mjs` off the Windows Computer Use leg) have no receipt. The Node `platforms` of an entry for Linux and macOS
   are only checked by the gate's own runs on those systems, and a child suite that never started is a missing slot of its declared leg in the release coverage gate.
3. **A static scan points at likely readers early (advice, not a proof; it never fails the job).**
   `check-clean-checkout.mjs --readers` in `changes` (`continue-on-error`, hits are warning annotations, like the silent-return
   scan) tokenizes the tracked JS and TS files and names one that imports, requires, spawns or names a file a clean checkout of
   the change does not have (a tracked file `.gitignore` also covers, of any extension), or a file that does, followed until
   nothing new is found. Imports are resolved as Node does; comments are removed without
   dropping the code beside them. It reads source text: a path joined from pieces, taken from a variable or the environment is
   invisible to it, a read it flags may be harmless, and a read guarded by `existsSync` that returns quietly passes it and passes
   layer 2. It is advice because layer 1 is the guarantee: the same tests run on a clean checkout and fail there, or skip and are
   reviewed. `check-clean-checkout.mjs --build` (`core-build-*`, `mixdogd`, `core-lint`) is a different check: it fails a Rust build that has
   an untracked Cargo test target, by looking at the files themselves.

- `rust-core-unix.yml` is a manual Linux and macOS run of the daemon's unit tests, the `pg` profile and clippy; `release.yml`
  re-runs the `k1-lanes` filters when a critical path changed.
- Built-artifact checks run after their build: `verify:packaging-artifact`
  (`packaging-artifact.live.test.mjs`) in the desktop build job. A local run
  needs the same handoff: before packaging, ensure the lane's unpacked output
  does not exist and record `Date.now()` as `MIXDOG_PACKAGED_BUILD_STARTED_AT`.
  Set `MIXDOG_PACKAGED_OUTPUT` to the exact Electron Builder output directory
  name under `apps/desktop/dist` (for example, `win-unpacked` on Windows x64).
  The smoke rejects a missing handoff or an output created before that build.
- `npm run typecheck:packages` type-checks `packages/protocol-client` and
  `packages/protocol` (it needs `npm ci --prefix packages/protocol-client`).
- `npm run test:bench-tools` runs the two terminal-bench harness suites for
  the Rust core (`benchmarks/terminal-bench-2.1/harness/anthropic_oauth_preflight_rust.test.mjs`
  and `prebake-rust.test.mjs`); the release gate core-real job runs the same two.
- The desktop live lane is `packaging-artifact.live.test.mjs` only in CI
  (`verify:packaging-artifact`); the cursor-theme and clipboard live tests are
  manual Windows checks, and the `*:integration` desktop harnesses
  (`browser-host`, `browser-profile-import`, `remote-webrtc-sender`,
  `computer-host`) are manual with no CI owner.
- `suite-health.yml` runs every `test:*`/`smoke:*` script weekly through the
  opt-out enumeration in `scripts/suite-health.mjs` (stale exclusions fail
  closed, new scripts join) and opens a tracked issue on failure.

## Deliberate exceptions

A test reads product source text only when the code has no surface a test can
run. Each such file carries a why-comment at its source read. A new one needs a
reason below, or a different test.

**Original four** (Electron main modules a renderer test cannot import, where
they pin ordering invariants):
`apps/desktop/src/shared/remote-payload-limit.test.mjs`,
`apps/desktop/src/renderer/side-surface-background-errors.test.mjs`,
`apps/desktop/src/main/packaging.test.mjs` and
`src/runtime/office/office-live-runtime.test.mjs`.

**GitHub workflow YAML and release shell scripts** (run only on GitHub runners
or a release host):
`scripts/post-release-check.test.mjs`, `scripts/mobile-release.test.mjs`,
`scripts/release-guard.test.mjs` and `scripts/linux-verify-graph.test.mjs`.

**Native code a test cannot run** (PowerShell host, C#, Rust; needs a real
desktop or the native toolchain):
`apps/desktop/src/main/computer/host/host-source-pins.test.mjs`,
`apps/desktop/src/main/computer/host/action-coverage.test.mjs`,
`apps/desktop/src/main/computer/overlay/cursor-glide.test.mjs`,
`apps/desktop/src/main/computer/backend/shared-input-observation.slow.test.mjs`
(asserts the C# declarations it patches before compiling the source) and
`apps/desktop/src/shared/secure-desktop-grant.test.mjs`.

**Electron main, entry or build modules that cannot be imported** (`index.ts`,
`electron.vite.config.ts`, an injected script string):
`apps/desktop/src/main/remote-access-window.test.mjs`,
`apps/desktop/src/main/desktop-pet-window.test.mjs`,
`apps/desktop/src/main/ssh/remote-bootstrap.test.mjs`,
`apps/desktop/src/renderer/monaco-setup.test.mjs` (the Vite config lines),
`apps/desktop/src/main/packaging-artifact.live.test.mjs` (the built `daemon.cjs`
is checked for an `electron` import before it is loaded).

**Built documents stamped at build time:**
`apps/desktop/src/main/remote-webrtc/sender-session.test.mjs` (the sender HTML
source carries the CSP placeholder the build stamps).

**Renderer surfaces that need Monaco, xterm or bundler-only modules:**
`apps/desktop/src/renderer/editor-format-document.test.mjs`,
`apps/desktop/src/renderer/editor-top-row.test.mjs`,
`apps/desktop/src/renderer/monaco-setup.test.mjs` (the `?worker` switch),
`apps/desktop/src/renderer/terminal-local-echo.test.mjs` and
`apps/desktop/src/renderer/remote-screen-helper.test.mjs` (a private copy table
inside a pane that needs the whole remote-screen stack to mount).

**Document-to-source audits:**
`src/runtime/office/pptx-skill-kit.slow.test.mjs` (every hard rule in the skill
documents names a review code that appears in the runtime sources).

**TypeScript tables and private literals Node cannot import:**
`apps/desktop/src/renderer/transcript-tool-row-pairs.test.mjs` (guidance
sentences private to runtime tool modules).

**Office COM:** `src/runtime/office/office-runtime-com.test.mjs` (the
PowerShell COM host runs only against installed Microsoft Office).

**Cross-stylesheet invariants and rules jsdom cannot cascade** (the sheets are
parsed, not rendered):
`apps/desktop/src/renderer/appearance/theme-file.test.mjs`,
`apps/desktop/src/renderer/pane-cover-mark.test.mjs`,
`apps/desktop/src/renderer/pane-dock-chrome.test.mjs`,
`apps/desktop/src/renderer/side-panel-position.test.mjs`,
`apps/desktop/src/renderer/skin-transparency.slow.test.mjs`,
`apps/desktop/src/renderer/skin-companion.slow.test.mjs`,
`apps/desktop/src/renderer/mobile-surface.test.mjs` (the phone pill height is a
custom property that jsdom leaves as an unresolved `var()`),
`apps/desktop/src/renderer/connect-copy.test.mjs` (one rule text shared by
three surfaces), `apps/desktop/src/renderer/edge-swipe.test.mjs` (jsdom does
not expose `touch-action`, so the absence of a blanket rule is read from the
sheet) and `apps/desktop/src/renderer/mobile-chrome-layout.test.mjs` (the
address-field `min-width` sits inside `@media (max-width: 640px)`, which jsdom's
`getComputedStyle` does not evaluate).

## Published packages carry no tests

`package.json` `files` excludes `src/**/*.test.mjs`, `src/**/*.test.jsx` and
`scripts/*.test.mjs`; test sources are also excluded from the prepared-runtime
cache key in `desktop-runtime.yml`.
