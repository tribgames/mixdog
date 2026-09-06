# Computer Use reliability and authorization

## Local authorization

Extensions → Built-in → Computer Use exposes an authorization editor.
Refresh windows, select exact app windows and actions, select an expiry
(5 minutes–24 hours), then save. Saving cancels active and queued Computer Use
commands before writing the policy. It does not restart Mixdog.

The saved `computer-authorization.json` lives in the Mixdog data directory.
Exact HWND/PID pairs must still exist at save and dispatch. Reopening an app
requires a new selection. Expired or corrupt policies do not silently revert
to unrestricted access. A corrupt saved policy blocks tool operations while
leaving the settings editor available for explicit repair.
The launch policy in `MIXDOG_COMPUTER_POLICY_FILE`
remains an independent restriction; settings cannot relax it. An empty action
selection denies all tool operations except session cleanup.

Only the authenticated local renderer has these IPC methods. The tool bridge
and remote shim do not expose policy writes. Selecting `launch` also requires
an exact launch path/URL, and newly opened windows need separate approval.

## Failure bundles

Bounded failure histories are stored in `computer-failures` (20 bundles,
40 recent steps per bundle, 128 KiB each). The local authorization panel can
export them as JSON. They contain action, exact window handle, stage, duration,
execution path, error category, numeric timing and boolean recovery results.
Input text, clipboard contents, titles, app paths and screenshots are excluded.
There is no implicit screenshot collection or remote upload.

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
