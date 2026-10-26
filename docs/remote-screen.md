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
| `apps/desktop/src/main/remote-screen/screen-source.ts` | `RemoteScreenSource`, one per viewer: start/stop, geometry, capture plan, frames, input, live re-authorization, the secure-desktop switch, the indicator and the log. |
| `apps/desktop/src/main/remote-screen/screen-webrtc-source.ts` | `createScreenWebrtcSource`: adapts a `RemoteScreenSource` to the WebRTC host's `RemoteWebrtcVideoSource` (`main/remote-webrtc/source.ts`). |
| `apps/desktop/src/main/remote-screen/screen-webrtc-sources.ts` | The window process's screen sessions for the WebRTC host: per-connection access, resolve, close (see "Main wiring"). |
| `apps/desktop/src/main/remote-screen/screen-access-publisher.ts` | Service side: sends each relay connection's access (grant / deny) to the window. |
| `apps/desktop/src/main/remote-screen/screen-electron.ts` | Electron pieces: displays with capture ids, the input host factory, the on-PC indicator (the remote-control pill). |
| `apps/desktop/src/main/remote-screen/secure-desktop-adapter.ts` | Adapts the real secure-desktop client (`main/secure-desktop/`, protocol v3) to the switch's `SecureDesktopClient` interface. |
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
  `parseRemoteWebrtcChannelFromClient`, and the desktop pushes
  (`RemoteWebrtcChannelPush`): the status `RemoteWebrtcScreenStatusMessage`
  and the cursor `RemoteWebrtcScreenCursorMessage`, read on the phone by
  `readRemoteWebrtcScreenStatus` and `readRemoteWebrtcScreenCursor`.

`remoteScreenKeyForCode` and `openRemoteScreenCaptureTrack` stay in
`shared/remote-screen.ts`. The `screen-input` control is a `RemoteScreenInput`:

- `screen-pointer`: `move`, or `down`/`up` with `left|right|middle`. x/y are in
  video pixels of the locked geometry. Multi-monitor mapping happens on the
  desktop side.
- `screen-wheel`: x/y plus WheelEvent-signed deltas in Windows wheel units.
- `screen-key`: `down`/`up` by virtual key + scan code + extended flag.
- `screen-keys`: `{ keys: RemoteScreenKey[] }`, an atomic combo: 1 to
  `MAX_REMOTE_SCREEN_COMBO_KEYS` (8) distinct keys, pressed in order and
  released in reverse as one router step (`ScreenInputRouter.dispatchKeys`).
  The same control check gates each press and the same press tracking
  applies: a release point between steps still finds them. Whatever the
  combo pressed is released even if it stops early (control lost, a cancel,
  a failed send); a key the session already holds (a modifier the phone
  keeps down) is neither pressed nor released. A combo types no text, so the
  AltGr text rule doesn't apply to it; a combo that includes AltGr's keys
  presses them like any others. Acked `applied` only when every key went
  down and up.
- `screen-text`: literal Unicode, bounded by `MAX_REMOTE_SCREEN_TEXT`.
- `screen-release`: lift every key and button this viewer holds.

Desktop → phone on the same channel (not input-acked, not epoch-bound):

- `screen-status`: `{ v, kind: 'screen-status', status: RemoteScreenStatus }`,
  pushed on every status change (from the source's `onStatus`), including the
  final `stopped`.
- `screen-cursor`: `{ v, kind: 'screen-cursor', x, y, generation }`, the PC
  cursor in whole video pixels of geometry `generation`. The cursor stays
  baked into the video; this only anchors trackpad mode. It is sampled
  through the input host's cursor read-back (physical desktop pixels, the
  pointer mapping's space) once per capture frame interval,
  `1000 / maxFrameRate` ms (30 fps → 34 ms): the video shows at most
  `maxFrameRate` pictures a second, so a position sampled more often can't
  match a frame the phone shows, and one per frame keeps the anchor at most
  a frame behind. It is pushed only when it changed, only while the cursor
  is on the viewed display, and not while the helper serves the secure
  desktop (the host can't read the cursor there, and a normal-desktop
  position doesn't match the helper's picture). The switch to the helper
  clears the cached position, a read still in flight across that switch
  (or across a new geometry) is dropped when it completes, and the
  promotion snapshot carries no cursor while the helper serves.
- `screen-video`: `{ v, kind: 'screen-video', epoch, path }`, `epoch` a
  positive integer increasing per session, `path` `'capture' | 'helper'`: video
  run `epoch` of that path is on the track from now on (see "Video runs and
  control"). Read with `readRemoteWebrtcScreenVideo`.
- All of them go only to a channel that is up (`promoting` or `webrtc`); a
  viewer's channel gets the current status, the current video run (once
  announced) and the last cursor once when it is promoted
  (`RemoteWebrtcVideoSource.channelState`), so nothing sent before is missed.

Phone → desktop, not input (never acked, never gated by the input epoch):

- `screen-frame-seen`: `{ v, kind: 'screen-frame-seen', epoch }`, validated by
  `parseRemoteWebrtcChannelFromClient`. The phone sends it once per run: for
  the first frame it presents (`requestVideoFrameCallback`) whose
  `metadata.receiveTime` is later than the arrival of that run's
  `screen-video`. A phone whose frame metadata has no `receiveTime` does not
  send it (no control on the helper path, the safe default). On a browser
  source it is a contract violation. The receipt identifies the announced
  run, not the provenance of the presented pixels (see "Video runs and
  control" for the accepted limits).

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
    checked before the text and before every re-press. Once a stop, unpair or
    disconnect lands, nothing positive is sent: no text, and no modifier is
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
phone disconnect or viewer leave, demote, unpair, a backend switch (before
the switch), stop, and app quit.

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
command, or a demote long after the press. Matching the origin only rules
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
site is `disposeDesktopResources` in `apps/desktop/src/main/index.ts`: it
calls `browserHost.stopRemoteScreens()` (→ `stopScreenSourcesForQuit`) first
and waits for it beside the rest of the teardown, so the 4 s teardown bound
doesn't cut the 5 s release budget short. Disposing the browser host (its
window closing) stops the sessions the same way. Either call first latches
the screen sources closed for good (see "Main wiring"), so no session opens
during or after the quit.

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

A LocalSystem service + session helper (`native/mixdog-secure-desktop/`)
captures and injects on the secure desktop; its TS client is
`apps/desktop/src/main/secure-desktop/`. `secure-desktop-switch.ts` imports no
helper implementation. It depends only on the `SecureDesktopClient` interface
and decides the source as a pure function. `secure-desktop-adapter.ts` adapts
the real client to that interface (`index.ts` plugs it in):

- **Not installed:** the adapter is `NO_SECURE_DESKTOP` (not installed), so a
  secure desktop stays blocked. Installing is not built here.
- **Connection:** dialled on the first `setActive(true)` (not awaited, so the
  input queue never waits on it); a wanted activation is sent once the
  handshake completes. While activation is wanted, a lost or refused
  connection is dialled again after 1 s, doubling to 30 s, reset by a
  success. Connect, desktop change and disconnect all fire
  `onDesktopChanged`, which re-runs the decision.
- **Identity:** `session()` and `desktop()` come from the client's
  `session()` object (`{protocol, version, session, desktop}`), current
  through `desktop-changed`.
- **Input:** host commands become the protocol's `InputEvent` in the same
  desktop pixels. A button without a position uses the last one sent (the
  helper releases in place). The cursor read-back has no helper counterpart
  and is refused. `sendInput` settles within the client's own deadline.
- **Dispose:** the screen sources own the adapter and call `dispose()` when
  they close (browser host dispose or app quit), once every session
  released, since those releases may go through the helper. It cancels the
  reconnect, detaches its listeners from the client and closes the
  connection, also one still in its handshake; a connect that succeeds
  anyway is closed when it does. Nothing dials after it.

The decision:

- **Secure desktop up.** The input-desktop watcher can't open the input
  desktop, or the desktop is `winlogon`. That covers UAC on the secure desktop,
  Ctrl+Alt+Del, and the lock/sign-in screen. If the helper is installed and
  attached, its frames and input take over: the router switches to `secure`.
  The old desktop's presses are released through the input host first, and
  dropped (counted) when it can no longer reach that desktop.
  **No blind control:** on the helper path control waits until the helper's
  video actually reaches the viewer. The sender reports it through
  `setHelperVideo(true)`; until then the status is `secure-desktop` with
  `control: false` (the phone shows its blocked state) and the router
  refuses every positive input. `setHelperVideo(false)` withdraws control at
  once and releases what the viewer holds through the helper. Leaving the
  helper path clears the report, so each helper period needs its own, and a
  report outside it counts for nothing. Releases always go through. The
  screen's WebRTC adapter reports it once the current video run was both
  delivered into the track and seen by the phone (see "Video runs and
  control" below). Without the helper, the
  phone gets a `secure-desktop` state ("elevation prompt on the PC — approve
  there or install the helper"), never a frozen or black frame.
- **Elevation prompt on the ordinary desktop.** `consent.exe` is running while
  the input desktop can still be read. The live view keeps working, but the
  prompt doesn't accept remote input without the helper. Control is withheld
  and an `elevation-prompt` state is shown. A connected helper is kept warm so
  a jump to the secure desktop is seamless.
- **Helper frames.** They are fitted to the locked geometry and emitted only
  while the live permission allows viewing. Malformed frames are dropped.
  The helper captures the whole virtual screen with GDI at most every 66 ms,
  and only once its previous frame was written out (`CAPTURE_INTERVAL` in
  `native/mixdog-secure-desktop/src/helper.rs`; ipc-spec "Capture approach").
- **Deactivation.** When the desktop returns, the router switches back to
  `desktop`. The helper's presses are released through the helper first, then
  it is deactivated.

### Helper video

While the helper serves, the phone sees its frames instead of the desktop
capture (which shows the last ordinary frame there). The source reports the
switch as `videoPath()` / `onVideoPath` (`capture` | `helper`, from the
decision), and the screen's WebRTC adapter (`screen-webrtc-source.ts`) drives
the sender:

- **Mechanism: the same peer connection, another track.** On `helper` the
  adapter calls `sink.drawnTrack(key, true)`; the host sends `source-draw` and
  the sender replaces the source's capture track with a canvas-drawn one
  (`captureStream(0)`, a frame per drawn picture) on every connection with
  `RTCRtpSender.replaceTrack`. No renegotiation: the connection, its
  channel, its codec and the phone's geometry stay as they are. Each helper
  frame goes through the host's picture feed (newest only, one in flight per
  source, superseded ones dropped) as raw rows (`image/x-bgrx`).
- **No pixel work in main.** `screenFrameRegion` only locates the display in
  the helper frame (which covers the whole virtual screen): the rows that
  cover it (a view of the helper's buffer, so the rows above and below are
  never forwarded), the source rectangle within them, and where it lands in
  the locked picture. A frame superseded in the queue costs nothing; only
  the picture actually sent is copied into an array of its own (a memcpy of
  those rows, since the IPC would otherwise serialize the view's whole
  buffer). The sender wraps the rows in a WebCodecs `VideoFrame`
  (`format: 'BGRX'`, the helper's own byte order, with its stride), fills
  the canvas black and draws the source rectangle onto the target one
  (`drawImage`, high-quality smoothing): crop, scale and colour conversion
  all run in Chromium. Why raw rows rather than an encoded image: the
  helper already hands over raw BGRA, and an encode in main would cost the
  window process's main thread per frame.
- **Rate.** No byte-rate budget is derived: there is no measured figure for
  Electron's main → renderer IPC throughput to derive one from. The rate is
  capped by the stream's own frame rate instead: at most one helper picture
  per `1000 / maxFrameRate` ms (30 fps: 33.3 ms) is handed over. The helper
  is slower still (one frame per 66 ms at most, and only once its previous
  one was written out), and the host keeps one picture in flight per
  source, so at most one frame's rows cross the IPC at a time.
- **Geometry.** The target is the locked geometry's pixel size, so the track
  keeps its resolution and the generation does not change. Desktop area the
  frame doesn't cover stays black. A display change while the helper serves
  locks a new geometry as always (new generation, the frames follow it);
  the capture plan's reopen waits until the capture is back.

#### Video runs and control

Every path change, every pipeline stall and every loss of the viewer's
channel (demote, viewer left: `release`) starts a new **video run**: its
`epoch` increases, everything of the old run stops counting, and control on
the helper path is withdrawn (held input released) until the new run earns
it. The phone hears each run as `screen-video` (see "Contract fold-in"); a
capture run at once, a helper run only once its first frame is in the track,
so frames sent after the announcement belong to the new run.
`channelState()` carries the current run once it was announced.

Control on the helper path needs, for the current run, both:

- **Local delivery** (`delivered(epoch)`). Each picture carries its run's
  epoch. The sender answers it with `frame-done`; `ok` means it was drawn
  into the source's current track after that track was on every sender
  (`installed`), and the host passes the picture's epoch on. A switch of the
  track (`drawnTrack`) drops the picture in flight, so its late
  acknowledgement matches nothing; a delivery of another run is ignored.
  This is evidence about this PC's pipeline only.
- **Receipt** (`frameSeen(epoch)`): the phone's `screen-frame-seen` for the
  run, routed by the viewer from the channel (not input: never gated by the
  input epoch, never acked). A seen of another run, or one before the run
  was announced, is ignored. The phone side is built separately; until it
  sends it, there is no control on the helper path, which is the safe
  default.

**Pipeline watchdog** (`helperVideoStallMs`): with no delivery of the run
for `max(3 × average, average + 150 ms)`, the average over its last 30
delivery intervals (216 ms at the helper's nominal 66 ms before there are
two), the run ends. The threshold borrows the shape of the webrtc-stats
freeze rule (`freezeCount`) but applies it to local deliveries: it watches
main → the sender's track, not the network or the phone's renderer, which
the receipt covers once per run.

**Accepted limits** (standard remote-desktop-app level, by product
decision): the receipt identifies the announced run, not the provenance of
the presented pixels, so a delayed or retransmitted old frame may satisfy
the `receiveTime` check. One receipt suffices per run; later receiver or
network stalls do not withdraw control while local deliveries continue. The
pipeline watchdog still withdraws control and releases held keys when local
delivery stalls.

- **Back.** On `capture` the adapter starts a capture run (announced at once)
  and calls `sink.drawnTrack(key, false)`: the host drops the helper
  pictures waiting and in flight and sends `source-capture` with the current
  plan, which replaces the drawn track on every connection like a display
  change does.
- **Track setup per sender renderer.** The host records which track the
  running sender was asked to give each source (`none`, `capture`, `drawn`)
  apart from the selected path (`drawn`). A source's first connection there
  sets up the selected path first (`source-draw` or `source-capture`). When
  the sender renderer goes (a crash), every source's track goes back to
  `none`, so the next connection sets up the selected path again, drawn or
  captured, before it opens.

Detection is based on studying how an existing secure-desktop capture tool
tracks a running consent process and input-desktop changes. No code or names
were copied.

## Permission / safety model

**Pairing is the approval.** There is no master switch and no per-device
grant: a phone that is paired, has an established E2EE channel and is still
connected may view **and** control the whole screen. Everything else is
refused.

- **Only paired, connected E2EE clients.** The service decides it per relay
  connection, for the connection that delivered the signal
  (`ScreenAccessPublisher.allowed`): the client id must still name that
  connection, its E2EE channel must be established, the connection must not
  be revoked, and its credential must have no unpair in force (see "Unpair"
  below). The same check runs where the signal is
  authorized (`screenAuthorized` in `remote-relay.ts`) and in the access it
  pushes to the window. Unpaired or plaintext peers are refused.
- **Visible on-PC indicator** while a phone views or controls, with a
  one-click stop (`ScreenIndicator`): the remote-control pill
  (`screen-indicator.ts`), shown on the viewed display. One pill covers every
  phone, and its Stop ends each session. It names the phone in its tooltip
  and doesn't distinguish viewing from controlling.
- **Logging.** Start, stop, denial, secure-desktop transitions and dropped
  releases (as counts per backend) are logged. Input content is never logged.

### Live re-authorization

`ScreenViewerAuthorization` reads `paired()` live and has an `onChange`
signal, fed by the access the service pushes for the session's own relay
connection (see "Main wiring"). The source subscribes when it starts and
re-decides on every signal:

- **Disconnect, unpair, or the client id taken by another connection.** In the
  same tick: `running()` becomes false, `capturePlan()` returns `null`, the
  indicator hides, `onStop` fires with `revoked` (the sender stops the track),
  status becomes `stopped`, and the stop is logged. Then the router cancels
  pending input and releases every press the viewer holds, after the
  in-flight command.
- **During start.** Pairing is checked again after the input host's async
  start. A disconnect during start fails `start()` with
  `ScreenSourceDenied('revoked')`. Nothing is logged as started and no
  indicator is shown. An input host that can't start fails the start and
  stops the session (`error`): the injector is also the UAC / lock detector.
- **Before every command.** Each dispatch re-reads `paired()` when its turn
  comes and before each command, so a disconnect between signals still blocks
  input. Releases (`screen-release`, `releaseInput`) are always honoured, even
  after a disconnect, so no key stays down.

### Threat model (brief)

The phone↔PC link is already E2EE and device-paired. The main adversary is the
relay, which is untrusted for content. Others are a non-paired device on the
network, a malformed or hostile message, and another local account or process.

Mitigations:

- The relay never sees pixels or input: the peer connection goes direct when
  ICE finds a direct pair and through this deployment's TURN server otherwise
  (`remote-webrtc.md`, "Path: direct first, TURN as the fallback"); either way
  it is DTLS-SRTP end to end, with the DTLS fingerprints bound inside the E2EE
  envelope, so TURN only forwards ciphertext.
- A paired phone learns the PC's ICE candidates (its public address, and its
  local addresses unless they are mDNS names) and the PC the phone's; both
  travel only inside the E2EE channel. See `remote-webrtc.md` for why that is
  accepted for paired devices.
- Every data-channel message is validated and bounded by the contract's parser
  before it reaches the injector.
- Capture and control are open only to a paired client over an established
  E2EE channel that is still connected, bound to that relay connection. A
  disconnect or unpair is enforced live; a reused client id never inherits
  another connection's access.
- The injector is reachable only through its parent's pipes, and its files sit
  in an owner-only folder.
- The PC shows an unmissable indicator with a one-click stop.
- Every defined exit releases held input through the backend that pressed it,
  and only onto its origin session + desktop; what can't be reached then is
  dropped and counted (see "Key-release guarantee").

Out of scope: compromise of the paired phone itself, and the signaling/pairing
layer owned elsewhere.

## WebRTC adapter

`createScreenWebrtcSource(screen, { screenId, sink, onStartError })`
returns a `RemoteWebrtcVideoSource` for `{ kind: 'screen', screenId }`:

- `start()`: admits once via `screen.start()`, then reports the geometry to
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
- `onStatus` and `onCursor` call `sink.channelPush` with a `screen-status` /
  `screen-cursor` message; the host sends it to each viewer of the source
  whose channel is up. `channelState()` returns the current status and the
  last cursor, which the host sends when a viewer is promoted.
- `onVideoPath` starts a run and switches the track (`sink.drawnTrack`),
  `onFrame` hands helper frames to `sink.frame` as raw rows tagged with the
  run, `delivered(epoch)` (the host, per drawn picture) and
  `frameSeen(epoch)` (the viewer, per `screen-frame-seen`) decide
  `setHelperVideo`, and `release()` starts a new run; see "Video runs and
  control".

### Main wiring

`createRemoteScreenSources` (`screen-webrtc-sources.ts`) is the window
process's set of screen sessions for the WebRTC host
(`apps/desktop/src/main/browser/host.ts` resolves `kind: 'screen'` through
it; Windows only):

- **Access.** The service (`remote-relay.ts`) owns the relay connections. Its
  publisher (`screen-access-publisher.ts`) sends a client's
  `RemoteScreenAccess` (`epoch`, `revision`, `connection`, `paired`, `label`)
  over the window request `screenAccess`. Every decision is synchronous and
  reads nothing: access is only "this connection is paired, E2EE-established
  and still connected".
  - **Bound to a connection.** `connection` is minted per relay connection
    object, so a client id the relay reuses for a new connection carries a
    different one.
  - **A signal keeps its connection.** The decode site passes the connection
    object a screen signal arrived on (`origin`) to
    `RemoteWebrtcRelay.forward` (and the display list). Authorization before
    and after ICE resolution, the grant push and the forward all check that
    the client id still names `origin`; on a mismatch the signal is refused.
    When a connection leaves the registry, its screen `ready`s still
    resolving are cancelled (`connectionRemoved`) and never forwarded.
  - **Grant, before a screen `ready`.** Sent only for `origin`, if it is
    allowed; nothing is sent otherwise. If a deny for that client follows
    while it is delivered, the client id no longer names `origin`, or its
    credential was unpaired meanwhile, the `ready` is refused. Nothing is
    awaited between that last check and the `webrtcSignal` request, and the
    window handles the service's requests in order, so the session is bound
    to `origin`'s access.
  - **Deny, at once.** A connection leaving the relay client registry by any
    path (leg closed, replaced under the same id, cleared, parked: the
    registry's `onRemoved`) is denied synchronously.
  - **Unpair.** Unpairing does not remove anything on the desktop's E2EE
    side: a phone authenticates with this PC's pairing secret, and only the
    relay's per-device credential tells devices apart. So the unpair is kept
    as a record on the PC until the relay confirms it:
    - **The record.** The device service queues the unpair in the client
      cache (`pendingRevokes` in `remote-clients.json`, the same record
      revocations made while remote access is off use) before it asks the
      relay. It is in force from that moment, persisted, so it also holds
      across a restart, and the revoke is retried each time the PC's relay
      leg (re)connects.
      It clears only when the relay confirms the revoke (`client-revoked`
      with `ok`), when the user approves that same device again (a claim
      for that credential: an explicit re-pair), or when the pairing is
      reset or rotated (every credential is replaced). A failed or
      unanswered revoke leaves it in force. If the write itself fails, the
      record is kept in memory only: it holds for the rest of this run and
      is lost at a restart.
    - **Retries and acknowledgements.** Each queued entry has an instance
      (`revocation`, a new one each time the device is queued anew; this
      run only). The retry checks right before each send that the entry is
      still queued, so one withdrawn meanwhile (re-paired) is not sent, and
      an acknowledgement clears only the instance it was sent for: an old
      one can't clear a newer removal request for the same device.
    - **While it is in force** (`unpairPending` → the publisher's
      `unpaired`), screen authorization and the grant push refuse every
      connection of that credential, and a connection entering the relay
      registry with it is revoked as it is admitted (`onAdded`), not when
      it is first used.
    - **At the unpair**, before anything is awaited, every live connection
      of that credential, whether or not it asked for a screen, is revoked
      and, if it may hold access, denied.
    - A revoked connection is refused for that connection object's
      lifetime, even after the record clears. After it clears, only a new
      connection with that credential (one the relay authenticated after a
      re-pair) gets access again.
  - **Why a revision remains.** The decisions can no longer change
    asynchronously, but each message still crosses an asynchronous hop to the
    window. `epoch` is one random id per publisher (service instance) and
    `revision` is monotonic within it. The window applies a message only if
    its revision is newer than the last one applied for that client in the
    current epoch and rejects a stale one; the last revision is kept after a
    deny, so a grant can't land after the deny that followed it, whatever the
    delivery order. A new epoch retires the previous one for good and
    withdraws all its access.
  - **In the window.** The message is validated (a grant must name its
    connection). A session is bound to the connection its access was decided
    for and reads it live as its `ScreenViewerAuthorization`: a deny, or
    another connection's access under the same client id, stops it at once.
  - **Not covered.** Ordering holds per service instance; the window assumes
    one service sends at a time (a second, interleaving instance would retire
    the first). Delivery itself is not retried. The window receives no
    connection id with the `ready` itself; the binding relies on the
    service's requests reaching it in order. The unpair record covers screen
    access only: other remote features of a device whose revoke the relay
    has not confirmed are unchanged by it.
- **Resolve.** The WebRTC resolver now gets the viewer (`clientId` and the
  signal type). Only a `ready` creates a session, for a display nobody holds.
  It is started at once: the viewer's offer waits for the geometry the start
  locks. Later signals of that client reach the same
  session; another client's are refused while it lives. One session per
  display.
- **Exits.** Viewer leave, a failed connection (the host stops the source when
  no viewer wants it), demote (`release`), unpair, disconnect and quit all
  reach the session's release points.
- **Close.** `stopForQuit` and `dispose` latch the set closed synchronously,
  before taking the snapshot of sessions to stop, and the latch is permanent.
  Every session still running or releasing is stopped under
  `SCREEN_QUIT_BUDGET_MS`. The cached access is cleared, and from then on
  every resolve is refused and every access update throws. Once every
  session released, the secure-desktop client is disposed (once).
- **Electron pieces** (`screen-electron.ts`): displays from Electron `screen`
  with each display's `desktopCapturer` source id (refreshed on display
  events and before each screen `ready`); the input host in the app-data
  folder Computer Use's host uses; the indicator as the remote-control pill
  (`createPillScreenIndicator` over `showRemoteScreenIndicator`, given the
  viewed display's Electron id). The secure-desktop client is the real one
  through `createSecureDesktopAdapter`.

### The underlying source interface

`RemoteScreenSource` (`screen-source.ts`): `listDisplays()`,
`start()` → `{ plan, geometry, status }`, `running()`, `geometry()`,
`capturePlan()`, `status()`, `onFrame` (helper-path BGRA frames), `onStatus`,
`cursor()` / `onCursor` (with `sampleCursor`), `onGeometry`, `onStop`, `handleInput(input, geometryGeneration)` →
`'applied' | 'rejected'`, `releaseInput()` (idempotent; valid before, during and
after stop), `setHelperVideo(delivering)` (see "No blind control"),
`videoPath()` / `onVideoPath` (see "Helper video"),
`stop(reason, { deadlineMs? })` (idempotent; a later call
returns the first one's promise), and `released()`. `released()`
resolves once shutdown is done: releases delivered or dropped, and backends
closed, bounded as described under "Shutdown". Its deps include an optional
`shutdownDeadlineMs`. The module also exports `stopScreenSourcesForQuit` and
`SCREEN_QUIT_BUDGET_MS`.

## Testing

Unit tests (`*.test.mjs`, run one at a time at Idle priority). Run them from
`apps/desktop`, where `tsx` and the test environment load the TypeScript
sources (Node's own type stripping can't, e.g. parameter properties):
`node ../../scripts/test.mjs --import ./scripts/test-env.mjs --import tsx --rerun-failed 0 remote-screen/screen-source.test`
(the last argument filters by path).

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
- `remote-screen/screen-source.test.mjs`:
  - start denied unless paired and connected; an input host that can't start
    fails the start; stuck-key release on stop;
  - an unpair after a key-down sends the key-up and stops capture at once;
  - a demote releases held input and release stays idempotent;
  - every exit path (viewer leave / phone disconnect and demote through the
    WebRTC adapter, unpair / disconnect, stop, app quit) releases held input
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
  - a disconnect during start, helper frames gated by the live pairing, and
    capture not restarted when the size is unchanged.
- `remote-screen/screen-webrtc-source.test.mjs`: start once, `capturePlan`/`page`,
  dispatch forwarding and rejection, release forwarding, sink notifications,
  and refused start.
- `remote-screen/screen-webrtc-sources.test.mjs` (with the real WebRTC host):
  a paired client's `ready` locks geometry, then opens with the capture plan;
  no session without access, from a non-ready signal, or for a second client;
  disconnect and app quit release the held key and close the source; the
  access message is validated. Regressions: a grant delivered after the deny
  that followed it is rejected (also during a live session); a client id
  reused by a new connection never inherits the old one's access, and the old
  session stops; a new epoch retires the previous one; after `dispose` a
  paired `ready` is refused and starts no input host; close latches before
  the shutdown and stays closed.
- `remote-screen/screen-access-publisher.test.mjs` (service side, deliveries
  held by the test): access is bound to epoch, revision and connection; none
  before the E2EE channel; a disconnect is denied synchronously and a grant
  still in delivery refuses the `ready`; a client id reused by another
  device's connection (with or without a removal) never gets the old access;
  a `ready` from a connection the id no longer names sends no grant; an
  unpair denies its connections synchronously, and a connection still
  present after an unpair is never granted again; revisions only grow.
  Regressions: a connection admitted while an unpair is in force and first
  used after the relay confirmed it is refused; after a failed revoke a
  fresh reconnect of that credential is refused; once the record clears
  (confirmed or re-paired) only connections admitted after that get access.
- `remote-relay-client-lifecycle.test.mjs`: an admitted connection is
  announced at once with its credential; an approval announces the re-pair
  before the approval is sent, and a denial or conflict announces none.
- `remote-client-cache.test.mjs`: a re-pair withdraws only that queued
  revocation, in effect before the write lands and after a reload.
- `remote-revocation-reset.test.mjs` (the device service over a fake relay):
  an unpair the relay refuses stays queued across a restart, the next
  launch's relay leg retries it, and a confirmed revoke clears it; approving
  that device again withdraws it.
- `remote-webrtc/relay.test.mjs` (screen parts): a screen `ready` and the
  display list need access; out-of-order checks forward only the newer
  `ready`. Regression: a `ready` whose connection leaves during ICE while
  another connection takes the id is cancelled, a mismatch alone refuses
  it, and the new connection's own `ready` is forwarded with it as origin.

- Combos, pushes, cursor, adapter: `screen-input-router.test.mjs` (a combo
  in order then reverse as one step; a held modifier stays held; control
  lost, a cancel or a desktop change mid-combo releases or drops what it
  pressed), `screen-source.test.mjs` (combo through the source and refused
  without control; status pushed on change and to a promoted channel; cursor
  sampled per frame interval, mapped to video pixels, pushed only on change
  and on this display, ending with the session; a read in flight across a
  switch to the helper dropped and no cursor offered while it serves; the
  indicator gets the display; on the helper path no control without helper
  video, control once it reaches the viewer, withdrawn with held keys
  released when it stops, cleared when the helper path ends),
  `secure-desktop-switch.test.mjs` (helper control needs helper video),
  `remote-webrtc/viewer.test.mjs` (pushes only while the channel is
  up, one promotion notice), `shared/remote-webrtc.test.mjs` (`screen-keys`
  and `screen-cursor` validation), `secure-desktop-adapter.test.mjs` (not
  installed is `NO_SECURE_DESKTOP`; on-demand dial, activation and session;
  backoff while wanted; input mapping; frames; dispose while a connect is
  pending closes the late success and leaves no listener or timer; dispose
  cancels a reconnect and closes a live connection),
  `screen-webrtc-sources.test.mjs` (close disposes the client once, after
  the sessions released).
- Helper video: `screen-source.test.mjs` (the lock screen switches the track
  to the drawn one; a helper frame goes as the helper's own rows with source
  and target rectangles; one per frame interval; the capture run announced
  at once, a helper run only after its first delivery; neither a delivery
  alone, a seen before the announcement nor one of another run grants
  control; delivery plus this run's seen does; the watchdog at 216 ms starts
  a new run, withdraws control and releases the key through the helper, and
  the old run's late delivery and seen count for nothing; a lost channel
  starts a new run; leaving announces a capture run; the reviewer's probe:
  a frame of run 2 acknowledged after capture and back never announces or
  grants run 4), `screen-geometry.test.mjs` (`screenFrameRegion`: rows,
  rectangles, scaling, partial and no coverage, malformed frames),
  `remote-webrtc/host.test.mjs` (`source-draw` set up before the first
  connection while drawn, raw `frame` commands with their rows and
  rectangles, only a view copied, `delivered` with the picture's epoch per
  picture in flight, no capture reopen while drawn, the probe: a frame in
  flight across capture and back delivers nothing; a sender crash sets up
  the selected path, captured or drawn, again before the next connection),
  `remote-webrtc/viewer.test.mjs` (`screen-frame-seen` reaches the source
  while promoting, unacked; a violation on a browser source),
  `shared/remote-webrtc.test.mjs` (`screen-video`, `screen-frame-seen`),
  `renderer/remote-webrtc-sender/source-capture.test.mjs` (`draw` moves
  every sender onto the drawn track and stops the capture only after;
  `installed` waits for every sender; a capture replaces it again; a draw
  abandons a capture still opening).

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

The main wiring is done (see "Main wiring"). Still open:

- WebRTC host:
  - verify helper video on a PC with the service installed (UAC, lock and
    sign-in): it is driven by mocks here;
  - optional: pass the input message's `geometryGeneration` through
    `dispatch`. Today the adapter uses the current generation, relying on the
    host's own check against the acknowledged one;
  - an `app-quit` stop reason (`user` stands in).
- Secure desktop: the helper's install flow (not built here).
- Phone: send `screen-frame-seen` per `screen-video` run (no control on the
  helper path until it does).
- Phone: consume `screen-cursor` (trackpad anchor) and send `screen-keys`
  for shortcuts.
