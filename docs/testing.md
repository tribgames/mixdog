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

A test reads product source text only when the code has no surface a test can
run. Each such file carries a why-comment at its source read. A new one needs a
reason below, or a different test.

**Original four** (Electron main modules a renderer test cannot import, where
they pin ordering invariants):
`apps/desktop/src/renderer/remote-payload-limit.test.mjs`,
`apps/desktop/src/renderer/side-surface-background-errors.test.mjs`,
`apps/desktop/src/main/packaging.test.mjs` and
`src/runtime/office/office-live-runtime.test.mjs`.

**GitHub workflow YAML and release shell scripts** (run only on GitHub runners
or a release host):
`scripts/release-gate-test.mjs`, `scripts/post-release-check.test.mjs`,
`scripts/embed-google-oauth-client.test.mjs`, `scripts/mobile-release.test.mjs`,
`scripts/release-guard.test.mjs` and `scripts/linux-verify-graph.test.mjs`.

**Native code a test cannot run** (PowerShell host, C#, Rust; needs a real
desktop or the native toolchain):
`apps/desktop/src/main/computer/host/host-source-pins.test.mjs`,
`apps/desktop/src/main/computer/host/action-coverage.test.mjs`,
`apps/desktop/src/main/computer/overlay/cursor-glide.test.mjs`,
`apps/desktop/src/main/computer/backend/shared-input-observation.slow.test.mjs`
(asserts the C# declarations it patches before compiling the source),
`src/runtime/bridge-clients.test.mjs` (the "host handler" test matches the
action names against the TypeScript and PowerShell host sources) and
`apps/desktop/src/shared/secure-desktop-grant.test.mjs`.

**Electron main, entry or build modules that cannot be imported** (`index.ts`,
`build-daemon.mjs`, `electron.vite.config.ts`, `src/cli.mjs`, an injected script
string):
`apps/desktop/src/main/remote-access-window.test.mjs`,
`apps/desktop/src/main/desktop-pet-window.test.mjs`,
`apps/desktop/src/main/jitter-probe-switch.test.mjs`,
`apps/desktop/src/main/ssh/remote-bootstrap.test.mjs`,
`apps/desktop/src/renderer/monaco-setup.test.mjs` (the Vite config lines),
`apps/desktop/src/main/packaging-artifact.live.test.mjs` (the built `daemon.cjs`
is checked for an `electron` import before it is loaded) and
`scripts/shellhardening/guardians-background.slow.test.mjs` (`windowsHide` on
spawned children keeps console windows from flashing; no seam injects a
spawner).

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

**TUI JSX, module-graph and document-to-source audits:**
`src/tui/app/panel-epoch.test.mjs` (`App.jsx`, and the raw-sink-name audit),
`src/session-runtime/lead-route-writers.test.mjs` (a tripwire over every module
that writes the Lead preset) and `src/runtime/office/pptx-skill-kit.slow.test.mjs`
(every hard rule in the skill documents names a review code that appears in the
runtime sources).

**TypeScript tables and private literals Node cannot import:**
`src/session-runtime/setup-tool/setup-tool.test.mjs` (Desktop slash and section
tables) and `apps/desktop/src/renderer/transcript-tool-row-pairs.test.mjs`
(guidance sentences private to runtime tool modules).

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

`session-save-fault-store.slow.test.mjs` stays one file on purpose: one
stateful fixture chain over one store.

## Published packages carry no tests

`package.json` `files` excludes `src/**/*.test.mjs`, `src/**/*.test.jsx` and
`scripts/*.test.mjs`; test sources are also excluded from the prepared-runtime
cache key in `desktop-runtime.yml`.
