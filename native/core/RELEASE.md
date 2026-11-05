# mixdogd release build notes and K1 deletion list

Owner: WP-INTEGRATE. Release version: the root `package.json` `version` (checked by
`scripts/check-release-version.mjs`).

## Release build

- `stage-core.mjs` stages prebuilt binaries and never builds them. Each target (including Linux
  for the bootstrap and the docker e2e) is built per target in CI; no cross-compiling from Windows.
- **libvpx.** `shiguredo_libvpx = "=2026.1.0"` (`mixdog-remote`, via WP-WEBRTC) downloads a
  checksum-verified prebuilt libvpx archive from GitHub at build time. Release builds must not
  depend on GitHub at build time:
  1. Workflow plan: the core release job restores a CI cache (`actions/cache`) of the archive
     directory keyed on the pinned crate version and target triple (`libvpx-2026.1.0-<target>`),
     and primes it in a separate step on cache miss. Build with `--locked`.
  2. Fallback / hermetic builds: vendor the archive (with its checksum) in the release-assets
     store and point the crate's build at that copy; do not fetch in the build step.
  3. A version bump of the pin invalidates the cache key and must re-prime it.
- **JS runtime (desktop and remote alike).** The core finds its interpreter and package through
  `js-runtime.json` next to `mixdogd` (`js_runtime::resolve_current`); only the manifest differs.
  - Desktop: `resources/core/js-runtime.json` points at the app executable in node mode
    (`electron: true`) and at `runtime.asar/node_modules/mixdog`.
  - Remote: each `server-cores/<os>-<arch>/bundle.tgz` holds `mixdogd` and `payload/`: the pinned
    Node binary (`js/node`, `js/LICENSE-node`), the production package root
    (`js/pkg/node_modules/mixdog`, with `src/skill-script-entry.mjs`, `src/ext-host/` and its
    production dependencies, including the office/PDF stack) and `js-runtime.json`
    (`{"program":"js/node","packageRoot":"js/pkg/node_modules/mixdog","electron":false}`).
    `server-ensure` publishes the binary and `payload/` as one `versions/<id>/` directory, so
    install, gc and version handling stay one path. No system Node is used or installed.
  - Pins: the Node version and per-platform sha256 are in `apps/desktop/scripts/node-pin.json`;
    the package is this repository's own `package.json` and `package-lock.json` (`npm ci
    --omit=dev --ignore-scripts` per target platform), the same sources the desktop runtime.asar
    is built from. Bumping either pin changes the build id (`manifestBuild` hashes the bundle
    content), so servers reinstall.
  - Workflow plan (WP-INTEGRATE): after the per-target `mixdogd` builds, the release job runs
    `node apps/desktop/scripts/stage-core.mjs` once on a runner with network access to
    nodejs.org and the npm registry. It downloads the pinned Node archives (cache
    `actions/cache` keyed on `node-pin.json`), runs the per-platform production install and writes
    the bundles. The four server platforms are staged on one runner: nothing from the target is
    executed.
- **0700 install directory (Linux/macOS CI).** The bootstrap creates its upload directory with
  `mkdir -m 700`; that mode is a security property. Windows Git `sh` cannot apply it, so the
  `remote-bootstrap.test.mjs` shell test asserts `drwx------` on the unpacked tree only where the
  filesystem has POSIX modes. The Linux (and macOS) test job must run that test with a real `sh`
  and not skip it; a Windows-only green run does not cover this property.
- Existing standalone native crates (`mixdog-spawn`, `-patch`, `-graph`, `-computer`) keep their
  own `cargo build --locked --manifest-path` jobs.

## Unix CI (WP-OWN)

`.github/workflows/rust-core-unix.yml`, `workflow_dispatch` only until the schedule is decided.
One job on `ubuntu-latest` and `macos-latest`, in `native/core`, as a non-root user (the job
asserts `id -u != 0`). Environment: `CARGO_BUILD_JOBS=3`, a job-unique `TMPDIR`, Node 22.19.0 on
PATH (inside `^22.19.0 || >=24.0.0`; the `node-pin.json` version).

1. Unit tests: `cargo test -p mixdog-app-server-daemon --lib -- ownership:: barrier:: verdict:: discovery::`
2. Tag tree: `fetch-depth: 0`; `git archive 69fe41b05` into `$RUNNER_TEMP/tag145`, plus that tag's
   `package-lock.json`; `npm ci --omit=dev --ignore-scripts` there. `MIXDOG_TAG_TREE` names it.
3. Tag gates 1, 2, 4, 5: `cargo test -p mixdog-app-server-daemon --lib verdict::tag_gates:: -- --ignored --test-threads=1 --skip gate_3`
   (step timeout 15 min; gate 4 suspends the core for 61 s).
4. Gates 3a and 3b: `MIXDOG_TAG_GATE_REPS=200 cargo test -p mixdog-app-server-daemon --lib verdict::tag_gates::gate_3 -- --ignored --test-threads=1 --nocapture`
5. Clippy: `cargo clippy -p mixdog-app-server-daemon --all-targets -- -D warnings`
6. linux-x64 only: WP-INSTALL's `apps/desktop/src/main/ssh/remote-trimmed-bundle.slow.test.mjs`
   (`npm run test:slow -- remote-trimmed-bundle.slow` in `apps/desktop`) under the pinned Node.

## K1 deletion list

Removed together with the Node daemon and session runtime at K1; `main` ships them until then.

- `apps/desktop/scripts/build-daemon.mjs`, `apps/desktop/scripts/remote-server-deps.mjs`, with
  their references: the `build` and `build:fast` scripts in `apps/desktop/package.json`,
  `build-daemon.test.mjs`, `daemon-bundle-electron.test.mjs`, `dev-fast-direct.mjs`,
  `dev-update-windows.ps1`, `electron.vite.config.ts`, `docs/testing.md`.
- Node phone-relay head-patch path (replaced by `thread/promptHistory/updated`):
  - `apps/desktop/src/main/state-delta.ts`: `HEAD_PATCH_FIELDS`, `headListPatch`,
    `applyHeadListPatch`, the `sl`/`lists` plumbing.
  - The `promptHistoryPatch` hello negotiation in `remote-relay-clients.ts`,
    `remote-relay-client-lifecycle.ts`, `remote-relay-session-state.ts`, `remote-view-sync.ts`,
    `renderer/remote-shim-socket.ts`.
  - Tests: `state-delta.test.mjs`, `remote-relay-transcript-paging.test.mjs`,
    `remote-view-sync.test.mjs`, `remote-relay-read-answer.test.mjs`,
    `remote-shim-socket.test.mjs`, `remote-e2ee-transport.test.mjs`.
- Originals of the helpers whose only copy after K1 is `packages/protocol-client/src/rows/*.mjs`,
  all under `src/runtime`: tool classification, result summaries, outcome code, the `restore.mjs`
  merge helpers and `roomRowItem`. Delete each with the Node session runtime. Exact file paths
  are to be listed against `packages/protocol-client/src/rows/` when K1 is cut.
