# Browser core integration harness

Runs a browser suite with Electron as the host role against a real `mixdogd` on an isolated profile.

```
MIXDOGD_TEST_BIN=<mixdogd built with --features test-hooks> \
  node apps/desktop/scripts/run-browser-core-integration.mjs --suite smoke [--engine core|host]
```

`MIXDOGD_BIN` (the `scripts/dev-core-install.mjs` layout) is the fallback binary. A bare `--suite` name is
`test-support/suites/<name>.suite.ts`; anything with a path separator or dot is a file. The default engine is `host`.

## What it starts

1. The runner stages an isolated profile (`scripts/rust-core/lib/core-session.mjs`: the nine isolation variables, the
   parent's `MIXDOG_*`, proxy and provider variables dropped) and starts `mixdogd serve` with `MIXDOGD_TEST_HOOKS=1`. The
   hook env is set only on this core and only for a test-hooks build; never on a packaged core.
2. It waits for `daemon.json` to say `serving` (the token is in that file), then bundles the suite with esbuild and starts
   Electron with `MIXDOG_CORE_HARNESS_RUNTIME_ROOT`.
3. In Electron (`core-harness.ts`): disposable profile and `MIXDOG_DATA_DIR`, the desktop's own protocol connection
   (`openCore`, `HOST_CAPABILITIES`), a real `BrowserHost` in a hidden window, `createDesktopHost` claimed on the core.
4. The suite runs; the whole Electron phase is limited to 90 s. The core is stopped through `/mgmt/stop` (its tree is
   ended by handle when that fails) and both profiles are removed.

## Suite API

A suite is `export default async (harness: CoreHarness) => void`.

| Member | Meaning |
| --- | --- |
| `client` | the desktop `ProtocolConnection` (`call`, `client()`, events) |
| `host` | the `createDesktopHost` result that claimed the core |
| `browserHost`, `guest` | the real `BrowserHost` and the page of the harness session |
| `uiCommand(action, input)` | `browser/command`, forwarded by the core as `host/browser/command` (session `core-harness-session`) |
| `runTool(threadId, tool, args)` | `test/browserEngine/run`; rejects with `engine hook absent` while the core has no such method |
| `stop()` | disposes host, window and connection (the runner stops the core) |

`--engine core|host` is passed to the hook as `engine` and is `harness.engine`: `host` is the forward path the host role
serves today, `core` the core's own browser engine. `smoke` navigates and snapshots through `uiCommand` and needs neither.
