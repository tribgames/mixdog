# Remote whole-PC screen source

Stage 2 of the phone remote control: the paired phone sees and operates the
maintainer's whole PC screen, like a remote-desktop app, over the WebRTC
transport (`docs/remote-webrtc.md`). This page covers the `screen` source:
capture, input injection, the secure-desktop/UAC switch, and the
permission/safety model. `webrtc-pc-side` owns the peer connection, signaling
and phone UI. This source plugs into them through the
`RemoteWebrtcVideoSource` adapter described below.

The source uses the contract's `{ kind: 'screen', screenId }`. A host that
serves it advertises the same `browserWebrtc` capability. A phone lists the
displays, picks one, and streams it the same way it streams a browser page.

## Files

| File | Role |
| --- | --- |
| `apps/desktop/src/shared/remote-screen.ts` | Screen-only helpers on top of the contract: the `KeyboardEvent.code` → virtual-key/scan-code table (`remoteScreenKeyForCode`) and `openRemoteScreenCaptureTrack` (opens the sender's track from a capture plan). |
| `apps/desktop/src/main/remote-screen/screen-geometry.ts` | Display enumeration (`summarizeScreenDisplay` → the contract's `RemoteScreenDisplaySummary`), the locked video geometry (native pixels, capped and even), the video-pixel → desktop-pixel pointer map (multi-monitor, DPI), and fitting a helper frame onto that geometry. |
| `apps/desktop/src/main/remote-screen/screen-input-host.ts` | The Windows input/UAC-watcher helper process. It injects desktop input through Computer Use's own checked `SendInput` transport and watches the input desktop and `consent.exe`/`LogonUI`. It also holds the temp-file sweep. |
| `apps/desktop/src/main/remote-screen/screen-input-dispatch.ts` | A pure mapper. It turns a viewer's `RemoteScreenInput` into host commands at the acknowledged geometry generation (`screenInputCommands`) and defines each press's identity and its release (`holdKeyOf`, `isHoldDown`, `releaseCommandFor`). It keeps no state. |
| `apps/desktop/src/main/remote-screen/screen-input-router.ts` | `ScreenInputRouter`: the single serialized, cancellable path for input, backend switches and releases of one session. It tracks held presses per backend + origin + key and releases them at the session's defined points. |
| `apps/desktop/src/main/remote-screen/secure-desktop-switch.ts` | The pure decision: ordinary capture, an elevation prompt that can't take remote input, the installed helper, or a blocked secure desktop. Also builds the status pushed to the phone. |
| `apps/desktop/src/main/remote-screen/screen-permission.ts` | The permission gate: master switch on, paired E2EE, explicit grant. View and control are separate. |
| `apps/desktop/src/main/remote-screen/screen-access-settings.ts` | The master switch (off by default) and per-client grants, stored as an owner-only secret file. Every save fires `onChange`. |
| `apps/desktop/src/main/remote-screen/screen-source.ts` | `RemoteScreenSource`, one per viewer: start/stop, geometry, capture plan, frames, input, live re-authorization, the secure-desktop switch, the indicator and the log. |
| `apps/desktop/src/main/remote-screen/screen-webrtc-source.ts` | `createScreenWebrtcSource`: adapts a `RemoteScreenSource` to the WebRTC host's `RemoteWebrtcVideoSource` (`main/remote-webrtc/source.ts`). |
| `apps/desktop/src/main/remote-screen/screen-selfcheck.mjs` | A local self-check that needs no phone and doesn't touch the cursor. It runs no capture and injects nothing; input goes through a recording backend. |

## Contract fold-in

The screen wire types belong to the shared contract
`apps/desktop/src/shared/remote-webrtc.ts`, owned by `webrtc-pc-side`. This
module imports them and no longer defines its own copies:

- `RemoteScreenButton`, `RemoteScreenKey`, `RemoteScreenInput`,
  `parseRemoteScreenInput`, `MAX_REMOTE_SCREEN_TEXT`;
- `RemoteScreenHelperState`, `RemoteScreenStatus`, `RemoteScreenStopReason`;
- `RemoteScreenCapturePlan`, `remoteScreenCaptureConstraints`;
- `RemoteScreenDisplaySummary`, used by `screen-geometry.ts`;
- the data-channel messages: the `screen-input` member of
  `RemoteWebrtcChannelFromClient`, validated by
  `parseRemoteWebrtcChannelFromClient`, and the status push
  `RemoteWebrtcScreenStatusMessage`.

`remoteScreenKeyForCode` and `openRemoteScreenCaptureTrack` stay in
`shared/remote-screen.ts`. The `screen-input` control is a `RemoteScreenInput`:

- `screen-pointer`: `move`, or `down`/`up` with `left|right|middle`. x/y are in
  video pixels of the locked geometry. Multi-monitor mapping happens on the
  desktop side.
- `screen-wheel`: x/y plus WheelEvent-signed deltas in Windows wheel units.
- `screen-key`: `down`/`up` by virtual key + scan code + extended flag.
- `screen-text`: literal Unicode, bounded by `MAX_REMOTE_SCREEN_TEXT`.
- `screen-release`: lift every key and button this viewer holds.

## Capture

Chosen approach: Electron's `desktopCapturer` plus a `getUserMedia`
`chromeMediaSource: 'desktop'` MediaStream in the hidden sender renderer (owned
by the WebRTC side), opened with `openRemoteScreenCaptureTrack` from the
source's `capturePlan()`. The size is pinned to the display's native pixels.
Why:

- **Latency/CPU.** The renderer path hands a live `MediaStreamTrack` straight
  to the `RTCPeerConnection`. The encoder reads frames with no main↔renderer
  pixel copy and no JS framebuffer. A frame source fed from main costs a
  full-frame copy every frame. It is only worth it where the renderer can't
  reach, which is the secure desktop, handled by the helper below.
- **Multi-monitor.** `desktopCapturer.getSources({ types: ['screen'] })` lists
  one source per display. The phone picks by `screenId`, and the plan carries
  that display's `captureSourceId`.
- **DPI.** Geometry uses the display's physical pixels, and capture is pinned
  to them. A monitor scaled to 150 % streams and maps at its true resolution.
- **Cursor.** Chromium's desktop capturer draws the cursor into the frames.

Geometry is locked when the stream starts. A new generation is created only
when the display is removed or its native size changes. It is announced through
`onGeometry`, which the adapter forwards to the sink. A display change that
keeps the same size does not restart capture. When the chosen display is
removed, the session stops.

## Input injection

Input reuses Mixdog's existing native `SendInput` backend; there is no new
injector. On the ordinary desktop, a small resident Windows helper
(`screen-input-host.ts`) embeds the Computer Use input transport
(`InputTransport.cs` `MixNativeInput`) unchanged. That gives it the same checked
delivery, foreign-input guard and ownership receipt the agent uses. It is a
separate process with its own `dwExtraInfo` marker, kept apart from the agent's
worker pool.

- **Absolute pointer per monitor.** `mapScreenPointer` turns video pixels into
  virtual-screen desktop pixels (negative on monitors left of or above the
  primary). The helper sends them as `MOUSEEVENTF_ABSOLUTE | VIRTUALDESK`. It is
  per-monitor DPI aware.
- **Stale geometry.** Moves, presses and wheel events at a stale geometry
  generation are dropped. A button-up always maps (released in place), so a
  press made before a geometry change can still be lifted.
- **Keys.** Sent by virtual key and set-1 scan code, with
  `KEYEVENTF_EXTENDEDKEY` where needed. The phone gets both from
  `KeyboardEvent.code` via `remoteScreenKeyForCode`.
- **Unicode text.** Sent through `KEYEVENTF_UNICODE`, paced like the agent's
  text entry. Tab and line breaks are sent as real Tab/Enter keys, not Unicode
  packets. Modifiers the session holds decide how text is typed:
  - none held, or only Shift: typed as is;
  - **AltGr** (Right Alt, alone or with the Left Ctrl Windows adds beside it):
    the session's own AltGr keys are lifted, the text is typed as Unicode, and
    the keys are pressed again. The target sees plain characters and the
    phone's held state is unchanged. If the text fails, the keys are still
    pressed again. The live gate (cancel generation + authorization) is
    checked before the text and before every re-press. Once a stop, revoke or
    downgrade lands, nothing positive is sent: no text, and no modifier is
    pressed again. The keys already lifted are up and no longer held; only
    the ones not yet lifted stay held, for the release that follows. All
    AltGr keys must have been pressed on the current desktop identity, or the
    text is refused. That origin is rechecked against the backend's identity
    before every lift, before the text and before every re-press, so every
    lift, the text and every re-press land only on the session + desktop the
    keys were pressed on. Once the identity changes, nothing more is sent from
    this text command: no further lift, no text, no re-press. The keys already
    lifted are up; the ones not yet lifted are dropped and counted, like any
    release whose desktop is unreachable. (A lift already in flight when the
    identity changes was sent while it still matched; it can't be recalled.);
  - any other Ctrl, Alt or Win (for example Ctrl+Left Alt, or AltGr plus Win):
    the text is **refused**, so it can't fire a shortcut. It is not queued or
    retried; the input is acked as not applied.

### The input router

`ScreenInputRouter` is the only path any input, backend switch or release takes
to a desktop. There are two backends: `desktop` (the input host) and `secure`
(the secure-desktop helper).

- **Serialized.** Input, switches and releases run strictly in order, one at a
  time, so a release always follows the in-flight command it undoes.
- **Holds per backend, with origin.** Every press is held by the backend that
  injected it and tagged with its **origin**: the Windows session id and the
  desktop it landed on. Each backend reports this through `identity()`:
  - the input host: its session (sent in its `ready` line) plus the input
    desktop's object name, lower-cased (e.g. `default`), from its watcher;
  - the helper: the `session` and desktop kind from `server-hello` /
    `desktop-changed`.

  Presses are keyed by **backend + origin + key**. Pressing the same key
  again under a new origin (for example `winlogon`, then `locked`) creates a
  second entry. A press is only made while the identity is known, and it is
  recorded before it is sent, so a press whose delivery is uncertain still
  gets released. Its release goes back only through that backend and only
  while that backend reports the same session and desktop. It never goes
  through whichever backend is active now, and never to a helper that
  reconnected to another session or desktop. An up for a press the backend
  doesn't hold on its current desktop is skipped.

  **`locked` vs `winlogon`.** These are compared as reported. The helper's
  `locked` and `winlogon` kinds are treated as **distinct** desktops for now,
  so a press made under one is not released under the other.
  `secure-desktop-service` is checking whether both are the same Winlogon
  desktop. Once it reports the real desktop object name, the helper identity
  will use that name and the two will be normalized.
- **Release points.** `releaseAll()` releases every press of every backend.
  `switchTo(next)` first releases the old backend's presses through the old
  backend, then makes `next` active. Activating or deactivating the helper
  happens inside the same queue step (`before`/`after` hooks), so the switch is
  atomic relative to input. A press its backend can't release at that moment
  (it reports another desktop or none, or the send fails or is abandoned) is
  **dropped** and counted through `onDropped`; nothing is retried later.
- **Cancel generation.** `cancel()` bumps a generation counter. Queued input
  from an earlier generation is rejected when its turn comes. A plan with
  several commands also stops between commands when the generation changes or
  the `allowed()` gate turns false (re-read when its turn comes and before each
  command). Releases are never cancelled.
- **Idempotent.** `releaseAll()` with nothing held sends nothing.
- **Abandon.** `abandon()` fails every in-flight backend call (sends and the
  helper-activation hooks of a switch) at once, and every later one
  immediately, so the releases that follow are dropped and counted.

### Key-release guarantee

The guarantee is the standard remote-desktop level (the RustDesk approach):
presses are tracked per session and released at defined points. There is no
durable recovery across sessions or restarts.

**Released.** Everything the session holds is released, through the backend
that pressed it and only onto the session + desktop it landed on, at each of:
phone disconnect or viewer leave, demote, revoke or downgrade, a backend
switch (before the switch), stop, and app quit.

**Dropped.** If that backend or desktop is unreachable at that moment (the
input desktop changed, the helper reconnected elsewhere, the injector died or
missed the stop deadline), the release is **dropped** and its count logged
(`release-dropped`, per backend, never key identities). No debt outlives the
moment, or the session.

So keys are released at every defined exit while the injector is reachable.
If the app or the helper is killed, or the target desktop is unreachable at
that moment, a held key may stay down until the user presses it again on the
PC. This matches common remote-desktop apps.

### Shutdown

**Stop.** `stop()` does its synchronous part at once (capture off, indicator
hidden, queued input cancelled) and starts a **watchdog** in the same call,
independent of what the input queue is waiting on. The release step is queued
behind the in-flight command, so it undoes it. If the watchdog fires first,
the input host is killed and the router is abandoned, so a backend that
stopped answering can't hold the stop open; the releases not yet sent are
dropped and counted. Then the backends close.

The watchdog defaults to one command's acknowledgment deadline
(`COMMAND_TIMEOUT_MS`, below). A responsive backend completes the whole release
well within the time one command may take. `stop(reason, { deadlineMs })`
replaces that bound for one stop. A later `stop` with a shorter `deadlineMs`
moves the running stop's absolute deadline earlier and re-arms it, both
during the release step and while the host closes; it never moves it later.
The same deadline also bounds closing the host: its graceful stop gets
whatever time is left and is killed when none is. `released()` therefore
resolves within the stop's deadline.

**Command acknowledgment deadline (host).** Every command to the input host
must be acknowledged within `COMMAND_TIMEOUT_MS`, imported from
`apps/desktop/src/main/computer/backend/worker-requests.ts`. That is Computer
Use's per-command ceiling for the same PowerShell host round trip through the
same `MixNativeInput` transport; no new number is introduced. A helper that
misses it is killed: anything it did later would be out of order with the
releases that follow. Killing it fails every pending command and fires
`onExit`, which stops a live session with reason `error`.

**What a kill does to held keys.** The helper's own release-on-quit
(`ReleaseOwned` on `q` or end of stdin) runs only on a graceful exit. A killed
helper (TerminateProcess) runs nothing, and **Windows does not lift input a
killed process injected**: a key or button it pressed stays down in the system
key state until a matching up is injected (or the user presses and releases
it). So after a kill the session never assumes anything was released: every
press it held, including one whose down was cut off mid-delivery, is dropped
and counted, and may stay down until the user presses it again.

**Late key-ups: physical-key risk.** A release point's key-up can land some
time after the press it undoes, for example a release queued behind a slow
command, or a downgrade long after the press. Matching the origin only rules
out the wrong session or desktop. It does **not** prove that nobody pressed
the key on that desktop in the meantime. If the user is physically holding
the same key on the PC when the key-up arrives, that up **releases the key the
user is holding**. Nothing detects a local, physical press in between: the
Computer Use transport has a foreign-key guard (`RecordForeignKey` /
`BeginOwnershipObservation` in `InputTransport.cs`), but this host never feeds
it. Closing this needs local key observation (for example a low-level
keyboard hook that records foreign presses), and that is not implemented.

**At app quit.** `stopScreenSourcesForQuit(sessions)` stops every session at
once with `deadlineMs: SCREEN_QUIT_BUDGET_MS` (a session already stopping is
shortened to it), so quit takes at most 5000 ms however many sessions run.
That is Windows' hung-app timeout: how long Windows waits for an application
to end before it treats it as not responding
(`HKCU\Control Panel\Desktop\HungAppTimeout`, default 5000 ms;
[HungAppTimeout](https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-2000-server/cc978614(v=technet.10)).
The Restart Manager uses the same value for forced shutdown:
[RM_SHUTDOWN_TYPE](https://learn.microsoft.com/en-us/windows/win32/api/restartmanager/ne-restartmanager-rm_shutdown_type).)
`COMMAND_TIMEOUT_MS` stays the normal per-command deadline. The quit call
site is **pending integration** (see "Remaining integration steps").

### Helper channel and temp files

- **Who can command the helper.** Only the app that spawned it. The line
  protocol runs over the child's own stdin/stdout pipes. It opens no named
  pipe, socket or window, so no other process or account can reach it.
- **Greeting.** The helper writes its first `desktop` line, then
  `ready <windows session id>`. Both the desktop and the session are known when
  `start()` resolves, so the first press can carry its origin.
- **Liveness.** Every command carries the acknowledgment deadline above, and a
  helper that misses one is killed. `kill()` ends it without the
  release-on-quit; the session drops its presses and logs the count.
- **Files.** `publishProgram` writes a unique bootstrap script per process,
  `remote-screen-host-<pid>-<random>.ps1`, with mode 0o600, removed when the
  host exits. Next to it, the compiled assembly is cached per build in
  `remote-screen-cache/remote-screen-host-<build>.dll`. The directory must be
  an owner-only app-data folder (same model as the agent host). The cached
  assembly is loaded without further checks, so a folder another account can
  write to would let it plant code into the injector.
- **Sweep.** Every publish runs `sweepScreenHostFiles` first. It removes
  scripts whose process is dead, assemblies from other builds, and compile
  staging files (`...dll.<pid>.tmp`) whose process is dead. Files of live
  processes and of the current build are kept. Crashed hosts don't leave
  orphaned `remote-screen-host-*` files behind.

## Secure desktop / UAC

A parallel agent (`secure-desktop-service`) ships a LocalSystem service +
session helper with a TS client in `apps/desktop/src/main` that captures and
injects on the secure desktop. `secure-desktop-switch.ts` imports no helper
implementation. It depends only on the `SecureDesktopClient` interface and
decides the source as a pure function:

- **Secure desktop up.** The input-desktop watcher can't open the input
  desktop, or the desktop is `winlogon`. That covers UAC on the secure desktop,
  Ctrl+Alt+Del, and the lock/sign-in screen. If the helper is installed and
  attached, its frames and input take over: the router switches to `secure`.
  The old desktop's presses are released through the input host first, and
  dropped (counted) when it can no longer reach that desktop. Without the helper, the
  phone gets a `secure-desktop` state ("elevation prompt on the PC — approve
  there or install the helper"), never a frozen or black frame.
- **Elevation prompt on the ordinary desktop.** `consent.exe` is running while
  the input desktop can still be read. The live view keeps working, but the
  prompt doesn't accept remote input without the helper. Control is withheld
  and an `elevation-prompt` state is shown. A connected helper is kept warm so
  a jump to the secure desktop is seamless.
- **Helper frames.** They are fitted to the locked geometry and emitted only
  while the live permission allows viewing. Malformed frames are dropped.
- **Deactivation.** When the desktop returns, the router switches back to
  `desktop`. The helper's presses are released through the helper first, then
  it is deactivated.

Detection is based on studying how an existing secure-desktop capture tool
tracks a running consent process and input-desktop changes. No code or names
were copied.

## Permission / safety model

Whole-PC control is the most sensitive capability in the app, so it is fenced
off:

- **Off by default.** The master switch in `screen-access-settings.ts` is
  `false` until someone turns it on at the PC. While it is off, no view or
  control is possible.
- **View and control are separate grants**, per paired client. A `view` grant
  never injects input; `control` adds input. Turning the switch on grants
  nothing.
- **Only already-paired E2EE clients.** The gate requires the paired,
  end-to-end-encrypted trust the relay already authenticated. Unpaired or
  plaintext peers are refused.
- **Visible on-PC indicator** while a phone views or controls, with a one-click
  stop (`ScreenIndicator`). It shows view vs control live.
- **Logging.** Start, stop, denial, downgrade, secure-desktop transitions and
  dropped releases (as counts per backend) are logged. Input content is never
  logged.

### Live re-authorization

`ScreenViewerAuthorization` reads `enabled`/`pairedE2EE`/`grant` live and has an
`onChange` signal. The wiring connects it to the settings store's `onChange`
(master switch, per-client grant, `forget`), to unpair events, and to loss of
the E2EE channel. The source subscribes when it starts and re-decides on every
signal:

- **Revoke, unpair, lost E2EE, or master switch off.** In the same tick:
  `running()` becomes false, `capturePlan()` returns `null`, the indicator
  hides, `onStop` fires with `revoked` or `disabled` (the sender stops the
  track), status becomes `stopped`, and the stop is logged. Then the router
  cancels pending input and releases every press the viewer owns, after the
  in-flight command.
- **Downgrade from control to view.** All held input is released, the view
  continues, and status and indicator show `control: false`. A `downgrade`
  event is logged, and further input is rejected.
- **During start.** Permission is checked again after the input host's async
  start. A revoke during start fails `start()` with
  `ScreenSourceDenied('revoked')`. Nothing is logged as started and no
  indicator is shown.
- **Before every command.** Each dispatch re-reads the live permission when its
  turn comes and before each command, so a revoke between signals still blocks
  input. Releases (`screen-release`, `releaseInput`) are always honoured, even
  after a revoke, so no key stays down.

### Threat model (brief)

The phone↔PC link is already E2EE and device-paired. The main adversary is the
relay, which is untrusted for content. Others are a non-paired device on the
network, a malformed or hostile message, and another local account or process.

Mitigations:

- The relay never sees pixels or input: the peer connection is direct, with
  DTLS fingerprints bound inside the E2EE envelope per `remote-webrtc.md`.
- Every data-channel message is validated and bounded by the contract's parser
  before it reaches the injector.
- Capture and control are off by default and gated on an explicit, per-client
  grant held separately for view and control, over a paired E2EE channel. Any
  loss of that trust is enforced live.
- The injector is reachable only through its parent's pipes, and its files sit
  in an owner-only folder.
- The PC shows an unmissable indicator with a one-click stop.
- Every defined exit releases held input through the backend that pressed it,
  and only onto its origin session + desktop; what can't be reached then is
  dropped and counted (see "Key-release guarantee").

Out of scope: compromise of the paired phone itself, and the signaling/pairing
layer owned elsewhere.

## WebRTC adapter

`createScreenWebrtcSource(screen, { screenId, want, sink, onStartError })`
returns a `RemoteWebrtcVideoSource` for `{ kind: 'screen', screenId }`:

- `start()`: admits once via `screen.start(want)`, then reports the geometry to
  `sink.geometryChanged`. A refused or failed start reports `null` geometry and
  calls `onStartError`.
- `stop()`: `screen.stop('viewer-left')`.
- `page()`: `{ documentId: null, geometry }`. Geometry is `null` unless running.
- `dispatch(control)`: refuses page input. Screen input goes to
  `handleInput`, and a `'rejected'` outcome throws so the host acks it as not
  applied.
- `capturePlan()`: the source's plan; `null` unless running.
- `release()`: `screen.releaseInput()`, forwarded every time. It is idempotent
  and safe at demote and again at viewer-left.
- `onGeometry` calls `sink.geometryChanged` and then `sink.captureChanged`, so
  the sender re-opens its track. `onStop` reports `null` geometry.

### The underlying source interface

`RemoteScreenSource` (`screen-source.ts`): `listDisplays()`,
`start(want)` → `{ plan, geometry, status }`, `running()`, `geometry()`,
`capturePlan()`, `status()`, `onFrame` (helper-path BGRA frames), `onStatus`,
`onGeometry`, `onStop`, `handleInput(input, geometryGeneration)` →
`'applied' | 'rejected'`, `releaseInput()` (idempotent; valid before, during and
after stop), `stop(reason, { deadlineMs? })` (idempotent; a later call
returns the first one's promise), and `released()`. `released()`
resolves once shutdown is done: releases delivered or dropped, and backends
closed, bounded as described under "Shutdown". Its deps include an optional
`shutdownDeadlineMs`. The module also exports `stopScreenSourcesForQuit` and
`SCREEN_QUIT_BUDGET_MS`.

## Testing

Unit tests (`*.test.mjs`, run one at a time at Idle priority):

- `shared/remote-screen.test.mjs`: the key table and capture track opening.
- `remote-screen/screen-geometry.test.mjs`: video sizing, pointer mapping
  across monitors and DPI, geometry-change detection, helper-frame fitting.
- `remote-screen/screen-input-dispatch.test.mjs`: the generation gate, a stale
  button-up still lifting, press identity and release commands.
- `remote-screen/screen-input-router.test.mjs`:
  - idempotent `releaseAll`, and skipping an up for a press the backend doesn't hold;
  - on a backend switch, releases go through the old backend, before the switch;
  - a press the old backend can't release at the switch is dropped, counted,
    and never sent later;
  - cancel drops queued input, and the release runs after the in-flight command;
  - the gate is re-read between the commands of one plan;
  - text is refused under a held shortcut modifier;
  - AltGr text: keys lifted and restored, Right Alt alone counts as AltGr,
    Ctrl+Left Alt and AltGr+Win stay refused, and keys are restored even when
    the text fails;
  - abandon cuts an in-flight send, later sends and a hung switch hook; the
    releases are dropped and counted;
  - AltGr with a cancel during the lift (no text, no re-press, nothing left
    held), a revoke after the text (no re-press), and a revoke before the text
    (text not sent);
  - AltGr with the backend moving from session 1 to session 2 while the first
    modifier-up awaits its ack: no Right Alt up, text or re-press reaches
    session 2, and Right Alt is dropped and counted;
  - no key-up reaches another session, or the same session on another
    desktop: it is dropped and not sent later;
  - the same key pressed under two origins (`winlogon`, then `locked`) is
    released only on its own desktop;
  - no press is made where the landing desktop is unknown;
  - a switch to no backend releases first, then rejects input.
- `remote-screen/screen-input-host.test.mjs`: command wire form, desktop-watcher
  line parsing, bootstrap integrity, Tab/Enter as keys, and the orphan sweep.
  With a fake child process (no live PowerShell): a command never acknowledged
  fails at its deadline and the helper is killed; an acknowledged one clears
  its deadline; `kill()` fails pending commands without the graceful quit; the
  first desktop and the session are known when `start()` resolves, and the
  identity is null while the input desktop is unreadable.
- `remote-screen/secure-desktop-switch.test.mjs`: every ordinary, in-place,
  secure and helper decision, and the reported control flag.
- `remote-screen/screen-permission.test.mjs`: the gates.
- `remote-screen/screen-access-settings.test.mjs`: off by default, separate
  grants, persistence, malformed-data rejection, and the `onChange` signal.
- `remote-screen/screen-source.test.mjs`:
  - start/deny, view vs control, and stuck-key release on stop;
  - revoke after a key-down sends the key-up and stops capture; master switch off;
  - downgrade from control to view;
  - every exit path (viewer leave / phone disconnect and demote through the
    WebRTC adapter, revoke, downgrade, stop, app quit) releases held input
    through the backend that pressed it, for a session on the input host and
    one on the helper;
  - leaving the helper releases its press through the helper before the
    switch; a switch to the secure desktop drops the desktop press it can't
    reach, and no key-up is sent later;
  - a helper reconnected to another session never gets an old release (dropped);
  - stop during a pending dispatch;
  - unreachable at release time: a refused send at stop, a crashed host, a
    helper that never answers (killed by the watchdog, the press cut off in
    flight included) and a hung secure helper are all dropped and counted;
  - app quit stops every session within the 5 s budget, in parallel, even with
    hung hosts (mocked clock);
  - a host whose graceful stop hangs is killed at the stop deadline;
  - a later stop with a shorter deadline shortens one already running, in the
    release step and while the host closes, and never lengthens it;
  - revoke during start, helper frames gated by permission, and capture not
    restarted when the size is unchanged.
- `remote-screen/screen-webrtc-source.test.mjs`: start once, `capturePlan`/`page`,
  dispatch forwarding and rejection, release forwarding, sink notifications,
  and refused start.

Manual, local, phone-free:

- Dry run that doesn't touch the cursor (no capture, no injection). It is a
  script, not a test file: the test runner `scripts/test.mjs` only collects
  `*.test.mjs` / `*-test.mjs`, so it never runs it. Run it directly from
  `apps/desktop`, where `tsx` resolves:
  `node --import tsx src/main/remote-screen/screen-selfcheck.mjs`. Exit code 0
  means every check passed.
- Full on-device check (Electron): the hidden sender renderer captures one frame
  of the chosen display and reports its size. A `screen-input` move is injected
  at the centre of a window the check creates itself (always on top, over no
  user window), and the cursor position is read back. Never type into or click
  a real user window.

## Remaining integration steps

- `webrtc-pc-side` (owns `remote-webrtc.ts` and `remote-webrtc/source.ts`):
  - create the source for `kind: 'screen'` with
    `createScreenWebrtcSource(createRemoteScreenSource(...))`;
  - route `screen-input` to `dispatch`;
  - open the sender track from `capturePlan()` via `openRemoteScreenCaptureTrack`
    and re-open it on `captureChanged`; feed `onFrame` while the helper owns the
    desktop;
  - push `RemoteWebrtcScreenStatusMessage` from `onStatus`;
  - call `release` at demote and viewer-left, and `stop` on viewer leave and
    on phone disconnect;
  - add the display-list query.
  - Optional: pass the input message's `geometryGeneration` through `dispatch`.
    Today the adapter uses the current generation, relying on the host's own
    check against the acknowledged one.
- Main wiring (not owned here; **pending integration**, none of it exists in
  production yet, scheduled with `webrtc-pc-side`): build one
  `RemoteScreenSource` per viewer with:
  - a real `ScreenDisplayProvider` (Electron `screen` + `desktopCapturer`);
  - the `createScreenInputHost` factory with an owner-only app-data directory;
  - the real `SecureDesktopClient` from `secure-desktop-service`, or a no-op
    client. What this source needs from it (nothing else):
    1. `session()`: the `session` it already receives in `server-hello` /
       `desktop-changed`; null while not connected;
    2. `sendInput` delivers a release whenever the helper is attached to that
       desktop, even while capture is inactive;
    3. `sendInput` settles or rejects in bounded time (the stop deadline
       abandons a hung call, but can't cancel a down the helper applies
       later);
    4. the real desktop object name (`desktopName`, `UOI_NAME`) alongside
       `desktop` in `server-hello` / `desktop-changed`. The helper identity
       will then use the name, which normalizes `locked` vs `winlogon` if
       they share one desktop (until then they are distinct);
  - an indicator window and the remote log;
  - at app quit (to be wired; not yet called anywhere): `will-quit` with
    `preventDefault`, `await stopScreenSourcesForQuit(allSessions)` (at most
    `SCREEN_QUIT_BUDGET_MS`), then `app.exit()`. The contract has no
    `app-quit` stop reason yet, so `user` stands in until `webrtc-pc-side`
    adds one;
  - `ScreenViewerAuthorization`: `pairedE2EE` from the relay client registry,
    `onChange` wired to the settings store and to unpair/E2EE-loss events.
    Call `forget` on a client's grant when it is unpaired.
- UI (minimal, still to wire):
  - a PC settings toggle for the master switch and a per-device view/control
    grant (IPC like the existing
    `setRemoteAccessEnabled`/`getRemoteAccessSettings`);
  - the on-PC indicator window with its stop button;
  - the phone's display picker and elevation/secure-desktop status banner.
