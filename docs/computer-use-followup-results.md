# Computer Use follow-up — 2026-09-05

## Delivered

- Local authorization editor in Extensions → Built-in → Computer Use:
  exact HWND/PID selection, action and launch-target lists, elevation opt-in,
  expiry, atomic persistence and dispatch-time enforcement.
- Saving cancels current/queued work. Host launch restrictions remain binding.
  Corrupt saved policies block execution without preventing settings repair.
- Privacy-filtered failure bundles and local JSON export; no input text,
  clipboard contents, app paths, titles or screenshots.
- Desktop lock/suspend and display geometry/DPI invalidation, with cancellation
  and no automatic resume.
- Dedicated app fixtures, event-injection checks, real child transport
  repetition and a duration-bounded native observation soak.

## Evidence

| Check | Result |
| --- | --- |
| Focused regression and new tests | 16 distinct tests passed across targeted runs |
| Win32 and WPF background edits | Actual value readback passed |
| Electron background edit | Renderer value readback passed |
| Live authorization | Allowed capture and denied input verified without restart |
| Real child transport | 1,000 unique acknowledgements, 25 interrupted generations, no replay or resident accumulation |
| Injected desktop/display events | Cancellation, simulated held-key cleanup, explicit resume and 1,000 geometry events passed |
| Native observation soak | 443 captures in 300,305 ms; three workers throughout |
| Type checks | Renderer passed; main passed with unused-declaration checks excluded |

Soak private memory ranged from 218,076 to 283,108 KiB and finished at
227,412 KiB. Repeated drops were observed; this short run does not establish
absence of long-term leaks. These are host private-memory samples, not native
worker memory measurements.

The strict main check initially reported unused declarations in the concurrently
changing capture module. They were not removed by this follow-up. The successful
main check preserved strict typing but excluded those unused-declaration checks.

## Unresolved coverage

- Excel foreground typing returned `input_recovery_unconfirmed` /
  `user_input_active`; safe cursor/focus recovery was not confirmed. No further
  key was sent on that result. The separate background attempt found no writable
  accessibility value for the fixture cell. Office input is **not passed**.
- The WinUI3 fixture C# compiled, but runnable output could not be built because
  Windows application packaging/PRI tasks were absent. WinUI3 is **not passed**.
- Real lock/secure-desktop transitions, physical monitor changes, administrator
  prompts, real held-key cleanup and hours-long native input are not validated
  by injected events or a five-minute read-only observation run.

## Local artifacts

- `artifacts/computer-use/reliability-UNWLJM/report.json`: Win32/WPF.
- `artifacts/computer-use/reliability-FRDFux/report.json`: Electron and failed
  foreground Excel attempt. This older fixture report contains accessibility
  metadata from the disposable Office window; it is not a privacy-filtered
  product diagnostic bundle.
- `artifacts/computer-use/reliability-qw4eTI/report.json`: Excel background
  failure and live authorization.
- `artifacts/computer-use/reliability-nWxwpU/report.json`: five-minute soak.

Fixture error reporting now uses the same metadata allowlist instead of dumping
complete action/capture payloads. Earlier local reports were preserved.

No deployment, installed-app restart, commit or user-document modification was
performed. The new features are source changes, not an update to the running app.
