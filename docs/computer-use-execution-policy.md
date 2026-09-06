# Computer Use execution boundaries

Computer Use preserves its normal local behavior when no policy is configured.
Existing input guards, observation freshness, exact targeting, and Windows UAC
consent remain mandatory. A policy can narrow this behavior, never widen it.

For unattended or restricted runs, set `MIXDOG_COMPUTER_POLICY_FILE` in the
desktop host's launch environment to an absolute JSON file path. The host loads
one immutable policy at startup; missing, invalid, or empty configuration fails
closed. Tool arguments cannot select or replace the policy.

```json
{
  "version": 1,
  "actions": ["list", "capture", "act", "verify"],
  "windows": [{ "id": "hwnd:0x1234", "pid": 5678 }],
  "launchTargets": [],
  "allowElevatedInput": false,
  "expiresAt": "2026-09-05T12:00:00Z"
}
```

Use the actual window ID, owning PID, and authorization expiry for the run.
Window-scoped calls require an authorized exact `window_id`; implicit foreground
capture, full-screen capture, and `app` shorthand are not available under a
restricted policy. A reused HWND with a different process is rejected.
Successor windows must be explicitly authorized before they may be observed or
used. Lists expose desktop window metadata only when `list` is authorized.

The action names are `list`, `capture`, `diagnose`, `act`, `window`, `menu`,
`verify`, `launch`, `clipboard_read`, and `clipboard_write`. Omitted actions,
windows, and launch targets are denied. Launch targets match exactly and must
still pass the existing shell/script/shortcut guards. An elevated action needs
both `allowElevatedInput: true` and Windows UAC consent. Cleanup and cancellation
remain available after authorization expires.

Internal Browser Use setup retains its separately validated native route; HTTP
callers cannot impersonate that internal session or supply input-injection ticks.

## Resource and cancellation behavior

The host permits at most eight resident/reserved worker processes by default,
including the warm spare and three slots for an elevated operation (launcher,
supervisor, and input worker). Retiring resident workers count until they exit.
Capacity exhaustion refuses a new operation without replaying or killing another
session. The embedding host can select `maxWorkers` from 1 to 32.

The elevated supervisor watches cancellation, its original launcher's process
identity, and a bounded execution deadline. It confirms worker termination before
issuing an authenticated receipt. An unconfirmed stop blocks subsequent backend
input; it is not reported as successful cleanup. Stop the remaining elevated
worker and restart the host before using Computer Use again in that case.
