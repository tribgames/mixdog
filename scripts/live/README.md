# Live runner

Runs the real desktop (Electron) against a real `mixdogd`, on an isolated profile, with a scripted model endpoint and
local fixture pages. Nothing touches your own app, profile or credentials: every instance lives under one isolated
root, and only processes this run started are stopped.

## Start an environment

Set `MIXDOG_LIVE_CORE_EXE` to the built mixdogd (or pass `--core=` to a runner that calls `resolveLivePaths()`), then:

```
node --input-type=module -e "import { openEnvironment } from './scripts/live/lib/env.mjs'; import { resolveLivePaths } from './scripts/live/lib/paths.mjs'; const env = await openEnvironment({ ...resolveLivePaths(), inspector: true }); console.log(env.info); await env.close()"
```

Paths come from the command line or the environment:

| Option | Environment | Meaning |
| --- | --- | --- |
| `--core=<mixdogd>` | `MIXDOG_LIVE_CORE_EXE` | built core binary (required); copied to `<iso-root>/core/`, never run in place |
| `--iso-root=<dir>` | `MIXDOG_LIVE_ISO_ROOT` | root of every instance of the run (default: `<tmp>/mixdog-live`) |
| `--electron-dist=<dir>` | `MIXDOG_LIVE_ELECTRON_DIST` | Electron dist folder to use as it is (default: this checkout's) |
| `--ort-library=<file>` | `MIXDOG_LIVE_ORT_LIBRARY` | ONNX Runtime library (default: found under `apps/desktop`) |

`openEnvironment({ coreExe, desktopDir, isoRoot, electronDist?, inspector?, configOverlay?, log })` returns
`{ info, core, main, renderer(), provider { push, route, reset, requests }, fixtures { origin, url(path) }, close(outDir) }`.
`core` is a protocol client of the instance's core (`core.request(method, params)`, `core.onServerRequest(listener)`);
`main` is a CDP connection to the Electron main (or `null`); `close(outDir)` copies history and logs out, then stops the
instance, the provider and the fixtures.

The instance is started with `apps/desktop/scripts/dev-isolated.mjs start --config-overlay --inspect-main --pass-env`.
The core identity is checked after start (daemon.json pid must be the staged core); a mismatch is logged as a warning.

CPU load readings (`lib/cpu.mjs`) use Windows CIM, Linux `/proc/stat` or macOS `top`, and are `null` when unavailable.

Test the library: `node --test scripts/live/lib/env.test.mjs`.
