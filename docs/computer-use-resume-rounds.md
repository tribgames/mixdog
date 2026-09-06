# Computer Use interruption/resume review — 2026-09-05

## Scope and evidence

The installed `computer` tool typed a new Notepad test tab and opened Save As.
It then returned `input_recovery_unconfirmed`; even `list` was blocked by
`computer_user_control_active`. A later explicit “continue” did not clear the
host latch. The test document is still unsaved; existing document contents
were not edited. Calculator and Excel live checks remain pending.

These rounds change source, not the installed app. No deployment, restart,
shell input automation or direct bridge bypass was used.

## Local reference comparison

- `C:\Project\refs\hermes-agent\tools\computer_use\cua_backend_session.py`
  distinguishes lost/unknown mutation outcomes from replay-safe discovery.
  `cua_backend.py` invalidates targets on transport replacement.
- `C:\Project\refs\cua\libs\cua-driver\rust\crates\cua-driver-sdk\src\service_session.rs`
  binds reconnection to trusted resume credentials and preserves interrupted
  action outcomes. Transport reconnection is not treated as human consent.
- `C:\Project\refs\cua\blog\human-in-the-loop.md` describes explicit human
  handoff. Its confidence-based fallback is not adopted.
- The Windows input implementation under
  `C:\Project\refs\cua\libs\cua-driver\rust\crates\platform-windows\src\input\inject.rs`
  documents cursor/focus side effects. Repeated foreground restoration and
  app-name-specific routing are not borrowed.

Only local references were needed. No source was copied.

## Round 1 — usable, guarded resume

- Added separate Resume and Stop controls to the local overlay.
- Retained paused session identities after worker/activity cleanup so the
  resume control cannot disappear while the host is still paused.
- Exposed cleanup readiness; unconfirmed cleanup never enables Resume.
- Bound user requests to a takeover generation. Wait for cleanup and old
  command completion, then discard any late old observations before resuming.
- Discovery and diagnostics remain available during user control; capture,
  clipboard and input do not bypass the pause or authorization policy.
- The overlay shows only Mixdog using, User controlling or Confirmation needed.

The first focused round passed 16 tests.

## Round 2 — input provenance and recovery

- Removed the ±80 ms synthetic-input timing assumption.
- Added low-level input-event metadata with a host-random tag and monotonically
  increasing external-input sequence. No keys, text or coordinates are logged.
- Preserved intervention evidence even when a later synthetic event arrives.
  Missing/replaced observation is unknown, not proof of user intervention.
- Keyboard-opened owned dialogs retain focus for the next explicit action.
- Recovery revalidates its input generation/sequence and cannot restore over a
  newer external event. Native failures are unwrapped without losing safety
  error categories.

The second focused round passed 18 tests, including PowerShell parsing and
C# compilation, plus the main TypeScript check.

## Round 3 — races and cleanup

- Delayed/duplicate resume requests and older UI rendering cannot clear or
  replace a newer interruption. Pointer/key activation retains its generation.
- Uncertain input/recovery stops further input and automatic capture, starts
  cleanup and asks for confirmation without replaying the interrupted command.
- Grouped/escaped/repeated key streams now use the tagged path too. Validate the
  complete stream before key dispatch, block Alt+F4 even inside groups and
  attempt every held-modifier release if another release fails.
- All native foreground dispatches, including drag, share the intervention
  scope. Nested input helpers cannot reset the original sequence.
- Session release during user control skips stale native focus restoration.
- Updated tool recovery guidance: use the local Resume control, then capture
  fresh state. Chat text alone is not a host-unlock mechanism.

The final regression set passed 33 tests and the bridge semantic-error test.
A further targeted check passed four cases: native parsing/compilation, the
foreground intervention scope, late-observation invalidation and paused session
release. Full main TypeScript checking passed.

## Acceptance limit

Pure/native-metadata tests, fake input sinks and DOM tests do not validate
Windows hook delivery, real cursor positioning, secure desktops, installed
overlay interaction or UAC across privilege levels. Those require an explicitly
approved deployment/restart and real `computer` tool testing afterwards.
The installed Notepad Save As flow has **not** been declared fixed or passed.
