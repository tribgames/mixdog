# Computer Use reliability and authorization

## Authorization

Computer Use runs unrestricted by default; the standing guards (input guards,
observation freshness, exact targeting, launch-path checks, Windows UAC
consent, user takeover, observe-only mode, environment guard) always apply.
There is no authorization editor in the app: the settings surface that wrote
`computer-authorization.json` was removed because a saved restriction could
only expire into a lock-out, and the window-scoped policy is an unattended /
managed-run tool rather than a user setting.

Narrowing comes from two in-process sources only:

- The launch policy in `MIXDOG_COMPUTER_POLICY_FILE` (see
  `computer-use-execution-policy.md`), loaded once at host start.
- `host.updateAuthorization(...)` on the embedding host (used by the
  reliability harness). It can tighten, never relax, the launch policy; exact
  HWND/PID pairs must exist at save and dispatch; saving cancels active and
  queued commands; the expiry is at most 24 hours. Nothing is persisted — a
  fresh host starts with the launch policy alone.

Neither path is reachable from the renderer, the tool bridge or the remote
shim. Selecting `launch` also requires an exact launch path/URL, and newly
opened windows need separate authorization.

## Failure bundles

Bounded failure histories are stored as JSON in `computer-failures` under the
Mixdog data directory (20 bundles, 40 recent steps per bundle, 128 KiB each);
there is no in-app export — read the files directly when supporting a user,
or `host.readFailureDiagnostics()` from the embedding host. They contain
action, exact window handle, stage, duration, execution path, error category,
numeric timing and boolean recovery results. Input text, clipboard contents,
titles, app paths and screenshots are excluded. There is no implicit
screenshot collection or remote upload.

## Isolated checks

From `apps/desktop`:

```powershell
node ../../scripts/test.mjs --import ./scripts/test-env.mjs --import tsx --lane slow src/main/computer/host/reliability.slow.test.mjs
node scripts/run-computer-reliability.mjs
```

The first check injects desktop-loss and geometry events without locking the
actual screen or changing monitor settings. It exercises queued cancellation
and simulated held-key cleanup, plus 1,000 acknowledged mutations and 25 real
child-process exits through the production worker transport. This is bounded
repetition, not an hours-long native input soak.

`--only=Native observation soak` runs five minutes of actual native observation
against the harness's own Electron window, checking exact target identity and
stable worker count, and sampling private memory every 15 seconds.
`MIXDOG_RELIABILITY_SOAK_MS` accepts 10 seconds–10 minutes for CI.
Memory samples are evidence for review, not an arbitrary pass threshold.

The live runner creates only dedicated Electron, Win32, WPF and Excel fixtures.
Excel uses a new application object and disposable unsaved workbook. It never
attaches to an existing Office document. Input effects are read back from the
fixture, not inferred from successful transport. Reports and isolated profiles
remain under `artifacts/computer-use/reliability-*`.

For WinUI3, build the dedicated fixture, then pass its exact executable:

```powershell
dotnet build scripts/computer-winui-fixture/ComputerWinUiFixture.csproj -c Release
$env:MIXDOG_WINUI3_FIXTURE = (Resolve-Path scripts/computer-winui-fixture/bin/Release/net8.0-windows10.0.19041.0/win-x64/ComputerWinUiFixture.exe).Path
node scripts/run-computer-reliability.mjs
```

Without that executable the WinUI3 scenario is explicitly skipped. Its build
requires .NET 8 and Windows App SDK dependencies. Missing Office or an app
failure is reported as a failed scenario, never a pass.

Production desktop lock/suspend and display geometry/DPI changes yield control,
cancel affected work and invalidate observations. Unlocking does not
automatically resume input; cleanup and explicit user resumption are required.
Physical display hotplug, a real secure desktop, administrator prompts and
hours-long usage remain separate manual validation conditions.

The Office fixture first exposed an unconfirmed foreground recovery result;
that is not counted as successful keyboard input. The bounded matrix also
checks background editing when Excel exposes a writable accessibility value.
WinUI3 builds additionally require the Windows application packaging/PRI build
tools; a compiled C# assembly alone is not a successful runnable fixture.
