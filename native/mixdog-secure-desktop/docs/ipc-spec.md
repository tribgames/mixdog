# Mixdog Secure-Desktop IPC Contract

Version: **protocol 3**, state schema **1**.

Changelog:

- Protocol 3: `desktop` (in `server-hello`, `desktop-changed`, and the frame
  header) is the input desktop's **real object name** (`Default`, `Winlogon`,
  …) instead of the `default` / `winlogon` / `locked` kinds. The lock and
  sign-in screens render on the same `Winlogon` desktop as UAC consent, so
  `locked` named a distinction the helper never observed (it was never sent).
  While control is inactive, a release of a button or key the connection
  itself pressed and still holds is applied in place (no movement); every
  other inactive input is dropped.
- Protocol 2 replaced protocol 1's `hello { secret }` with a mutual HMAC-SHA256
  challenge-response (`client-hello` / `server-auth` / `client-auth`); the
  secret no longer crosses the pipe.

Peers of an older protocol are rejected with `protocol_mismatch`.

This document is the authoritative, versioned contract between the Mixdog
desktop app (main process) and the secure-desktop **helper**. The Rust
implementation (`src/protocol.rs`) and the TypeScript client
(`apps/desktop/src/main/secure-desktop/protocol.ts`) both implement exactly
what is written here; a breaking change bumps `PROTOCOL_VERSION` in both and in
this heading. The app and helper ship together, so the handshake rejects a
version mismatch outright.

## Purpose and boundaries

The helper lets the app **see** the current input desktop — including the
secure desktop (`Winlogon`: UAC consent, Ctrl+Alt+Del, lock and sign-in
screens) — and **drive** it with pointer and keyboard input. It is one piece of
the upcoming remote-desktop feature. The transport that carries frames to a
phone over WebRTC and relays input back is a **separate effort** and is not part
of this component; the WebRTC code imports the TypeScript client and treats this
contract as its source of frames and its input sink.

## Transport

- A single Windows **named pipe**: `\\.\pipe\mixdog-secure-desktop`.
- Byte-stream mode, `PIPE_REJECT_REMOTE_CLIENTS`. There is **no network
  listener** anywhere in the service or helper; the pipe is purely local IPC.
- The helper is the server and creates the pipe with
  `FILE_FLAG_FIRST_PIPE_INSTANCE`, so once the SYSTEM helper owns the name no
  other process can create a second instance of it. The app is the client.
- The pipe's security descriptor grants only the installing user and
  SYSTEM/Administrators, and carries a **Medium-integrity mandatory label**
  (`S:(ML;;NWNRNX;;;ME)`) so a low-integrity or AppContainer process cannot open
  it at all. A fixed name is safe because access is gated three ways: the
  mandatory label, the DACL, and proof of the per-install secret (below).
- **Server authentication (anti-squat).** While the helper is down, another
  local account could create a pipe with the same name. Every client — Node and
  native — therefore authenticates the server *before revealing anything*: the
  server must prove it knows the secret first ([Handshake](#handshake)). A
  squatter receives one random client nonce and nothing else. The native client
  additionally checks that the server process is SYSTEM
  (`GetNamedPipeServerProcessId` → token user SID) as defence in depth.
- Exactly one client is served at a time. If the console session changes, the
  service relaunches the helper and the app reconnects.
- **No pipe operation blocks the helper on its peer.** The server end is opened
  for overlapped I/O. Accepting a client also waits on the shutdown stop event;
  reads take only bytes already buffered; writes are queued and issued as
  overlapped `WriteFile`s that the helper's loop polls. There is **no
  `FlushFileBuffers`** per frame (it blocks until the peer has read
  everything). A new video frame is captured only once the previous output's
  writes have completed, so a slow reader receives fewer frames rather than a
  growing backlog. A client that stops reading therefore cannot stall the
  helper's other deadlines, its desktop tracking, its input release, or its
  shutdown.
- **Pipe buffers.** The server's outbound buffer is deliberately small,
  **4 KiB**; its inbound buffer is 64 KiB (drained every loop pass). Windows
  treats these sizes as advisory and may round them up to an allocation
  boundary; the outbound one stays far smaller than any video frame either way.

## Frame deadline

Each frame has a **frame deadline** of 10 s — the same human-scale ceiling, and
reasoning, as the handshake deadline — measured **in total**, never as an
inactivity timer (trickling one byte at a time cannot extend it):

- **Inbound** (app → helper): from the frame's *first* byte until it is
  dispatched. The check runs when the frame is taken for dispatch, before it
  is validated or acted on, so a frame that completes (or would be dispatched)
  past its deadline drops the client and is **never executed**. A frame still
  incomplete past its deadline drops the client too.
- **Outbound** (helper → app): from when the frame is *queued* until its write
  **completes**. Completion means the bytes reached the outbound pipe buffer,
  not that the client read them — the protocol has **no frame
  acknowledgements**. This deadline therefore bounds **backpressure**: a client
  that stops reading leaves the 4 KiB buffer full, the next write (every video
  frame is larger than the buffer) cannot complete, and after 10 s the client
  is dropped.

Either way the client is dropped (its held input released first, as on every
disconnect).

## Shutdown (service ↔ helper)

The service never kills a responsive helper:

1. Before each launch the service creates a fresh pair of named, manual-reset
   events, `Global\MixdogSecureDesktop-stop-<token>` and
   `…-ack-<token>`, from a fresh 128-bit hex token passed as the helper's only
   argument (`helper <token>`). Both carry a protected SYSTEM-only DACL
   (`D:P(A;;GA;;;SY)`) and the service refuses names that already exist, so no
   user process can forge a stop, spoof an acknowledgement, or squat the pair.
2. To stop the helper — on service stop, on revoke (the console moved to a
   session that is not permitted), or before relaunching into a new console
   session — the service signals **stop**.
3. The helper wakes at once (its accept and every sleep also wait on stop),
   ends the client, **releases every pointer button and key it holds**, signals
   **ack**, and exits.
4. The service waits for the ack and then for the process to exit, bounded by
   the helper's **shutdown deadline**, which *is* the frame deadline (10 s): no
   step of the helper's loop blocks on its peer for longer, so a helper silent
   past it is wedged. Only then is it force-killed (`TerminateProcess`), and
   the log records whether it had acknowledged. While the service itself is
   stopping it reports `SERVICE_STOP_PENDING` with that deadline as its wait
   hint and advances the checkpoint every poll interval (1 s), so the
   uninstaller sees progress.

The helper releases held input on **every exit path it controls**: the
injector releases on deactivate, desktop switch, session change, disconnect,
and stop, and also whenever it is dropped, so even an early return cannot
strand a press.

## Session policy

The helper exposes the **console** session only, and only to its rightful user,
so fast user switching can never let the installer see or drive another
account's desktop:

- The **service** launches/keeps the helper only while the active console
  session (`WTSGetActiveConsoleSessionId`) is permitted: either it has no
  interactive user (the logon / sign-in screen — a valid target that exposes no
  user's private desktop) or its user SID equals the installing user's. On a
  switch to any other account the helper is **stopped** (gracefully, see
  [Shutdown](#shutdown-service--helper)), revoking capture and input.
- The **helper** additionally verifies each connecting client: its pipe session
  id must equal the serviced console session, and its token user (obtained by
  briefly impersonating the client) must be the installing user. A client that
  fails either check is disconnected with no error frame.

## Framing

Every message is a length-prefixed frame:

```
u32 LE  bodyLen        number of bytes that follow (kind + payload)
u8      kind           1 = control (JSON), 2 = video frame (binary)
u8[bodyLen-1] payload
```

- **Control** (`kind = 1`): payload is UTF-8 JSON — one [message](#control-messages).
- **Video** (`kind = 2`): payload is

  ```
  u32 LE headerLen
  u8[headerLen] header     UTF-8 JSON (frame header)
  u8[..]        pixels     raw BGRA, length == stride * height
  ```

Size caps (refused before allocation): control ≤ 1 MiB, any frame ≤ 192 MiB.

**Schema validation.** Valid JSON is not enough: both peers validate every
decoded message against this spec before acting on it — the `type`/`kind`
discriminant must be known, every field present with the documented type, and
integers within their wire type's range (`vk`/`scan` u16, coordinates i32,
`session`/`protocol` u32). Video headers additionally require `format: "bgra"`,
`width`/`height` ≥ 1, `stride` ≥ `width × 4`, `stride × height` ≤ the frame cap,
and well-formed `dirty` rects. Anything invalid (e.g. a `null` control payload)
is a protocol error: the receiver surfaces it and closes the connection without
dispatching the message. The helper gets this from serde's typed decoding; the
Node client from `validateControl` / `validateHeader` in `protocol.ts`.

## Control messages

JSON objects discriminated by `type`. Direction is noted per message.

| `type`            | Direction      | Fields |
|-------------------|----------------|--------|
| `client-hello`    | app → helper   | `protocol:number`, `clientNonce:string` |
| `server-auth`     | helper → app   | `protocol:number`, `serverNonce:string`, `mac:string` |
| `client-auth`     | app → helper   | `mac:string` |
| `server-hello`    | helper → app   | `protocol:number`, `version:string`, `session:number`, `desktop` |
| `desktop-changed` | helper → app   | `desktop`, `session:number` |
| `input`           | app → helper   | `event:` [InputEvent](#input-events) |
| `control`         | app → helper   | `active:boolean` |
| `error`           | helper → app   | `code:string`, `message:string` |

`desktop` is the input desktop's object name exactly as Windows reports it: a
non-empty string of at most 256 UTF-16 units (the helper reads it through a
256-unit `UOI_NAME` buffer). In practice `"Default"` (the ordinary desktop) or
`"Winlogon"` (the secure desktop: UAC consent, Ctrl+Alt+Del, and the lock and
sign-in screens all render here), occasionally another such as
`"Screen-saver"`. Compare case-insensitively.

### Handshake

0. Before any bytes are read, the helper verifies the client's session and user
   (see [Session policy](#session-policy)); a client that fails is dropped.
1. **Mutual challenge-response.** Let `K` be the 32 raw bytes of the
   per-install secret (the state file stores them base64). Nonces are 16 random
   bytes, base64 on the wire; a nonce of any other decoded length is rejected.
   All MACs are base64 `HMAC-SHA256(K, …)`, compared in constant time; the
   labels are the literal ASCII bytes `server` / `client`.
   1. app → `client-hello { protocol: 2, clientNonce: Nc }`.
   2. helper checks `protocol`, picks a fresh `Ns`, and sends
      `server-auth { protocol: 2, serverNonce: Ns, mac: HMAC(K, "server" ‖ Nc ‖ Ns) }`.
   3. The app verifies that MAC. **If it fails, the app closes the pipe
      without sending anything else** — the peer learned only `Nc`.
      Otherwise it sends `client-auth { mac: HMAC(K, "client" ‖ Ns ‖ Nc) }`.
   4. The helper verifies the client MAC; on success it sends `server-hello`.
      Nothing is streamed and no input is accepted before this point; the app
      likewise sends nothing but handshake messages until `server-hello`.

   Properties: the secret never crosses the wire; the server proves first, so a
   squatter without `K` cannot obtain a client MAC; each MAC is bound to both
   fresh nonces, so a recorded MAC cannot be replayed on a new connection; and
   the distinct labels and nonce order mean a server MAC can never be reflected
   back as a client MAC. Interoperability is pinned by a known-answer vector
   asserted in both the Rust and TypeScript tests (`K` = bytes `00..1f`,
   `Nc` = 16×`aa`, `Ns` = 16×`bb` → server MAC
   `dEuYYaY1byiY4cjlZ7augOQsK58KQpWFOJEHJbvkvPI=`, client MAC
   `u6+CvqeI2faMMsAAXKRZ0rlEFHvLJi8d+7lKZq13vYQ=`).

   The whole exchange must complete within the **handshake deadline** (10 s — a
   human-scale ceiling on a local round-trip that normally completes in under a
   millisecond); a client that stalls is dropped so it cannot pin the single
   pipe instance.
2. On any failure the helper sends `error` (`code` `protocol_mismatch` or
   `unauthorized`) and closes; an out-of-order or malformed handshake message
   closes without an error frame.
3. The app sends `control { active: true }` to begin a remote-control session.
   Until then, the helper captures nothing and injects no new input.
   **The only exception is a release of this connection's own press:** while
   control is inactive, a `pointer-button` or `key` event with `down: false` is
   applied only if this connection pressed that button/key and still holds it,
   and it is applied **in place** — a bare button-up / key-up with no pointer
   movement; the event's `x`/`y` are ignored. Anything else — movement, wheel,
   text, presses, and releases of input this connection does not hold — is
   dropped. (Since deactivation already releases everything the connection
   holds, this is a safety net rather than a common path.)

   Releases are per-connection in every state: even while active, a release of
   a button or key this connection did not press (and still hold) is ignored,
   so a client can never release input it did not press, such as a key held on
   the physical keyboard. An active button release of a held button is sent at
   its `x`/`y`, ending a drag where the client released it.
4. `control { active: false }` (or disconnect) stops capture and injection, and
   **releases any pointer button or key the app left pressed** so nothing is
   stranded down on the (possibly secure) desktop. The same release happens on
   disconnect, before each desktop switch, on a session change, and at helper
   shutdown.

Inbound bytes are parsed **incrementally and non-blockingly**: the helper only
reads what the pipe reports as available and assembles frames from it, so a
length prefix that arrives without its body can never block capture or the
desktop monitor. A frame not dispatched within the [frame deadline](#frame-deadline)
(10 s, total from its first byte) drops the client unexecuted. Declared frame sizes are
bounds-checked (control ≤ 1 MiB, any frame ≤ 192 MiB, `stride*height` computed
with overflow checks) before any allocation.

A handshake rejection that sends an `error` frame lingers (bounded by the frame
deadline, or until the client closes its end or stop is requested) before
disconnecting, because a disconnect discards any pipe data the client has not
read yet.

### Client API (TypeScript)

- `connect()` resolves with the server hello once mutually authenticated.
- `session()` returns the authenticated session — `protocol`, helper
  `version`, console `session`, and the current input `desktop` (kept current by
  `desktop-changed`) — or `undefined` when not connected.
- `sendInput(event)` **settles in bounded time**: it resolves once the frame is
  handed to the pipe, and rejects immediately when not authenticated, as soon
  as the connection ends, or after the frame deadline (10 s, past which the
  helper would drop the connection itself). The `pointer*` / `key` / `text`
  convenience methods are fire-and-forget wrappers over it.

### Input events

`input.event` is a JSON object discriminated by `kind`. Coordinates are in
**desktop pixels** on the virtual screen (the top-left of the primary monitor is
the origin; negative values are valid on multi-monitor layouts).

| `kind`           | Fields |
|------------------|--------|
| `pointer-move`   | `x`, `y` |
| `pointer-button` | `button` (`left`\|`right`\|`middle`), `down:boolean`, `x`, `y` |
| `pointer-wheel`  | `x`, `y`, `dx`, `dy` (notches; +dy up, +dx right) |
| `key`            | `down:boolean`, `vk:number`, `scan:number`, `extended:boolean` |
| `text`           | `text:string` (injected as Unicode key events) |

The injector prefers `scan` when non-zero (correct across layouts and on the
secure desktop) and falls back to `vk`.

### Frame header

```jsonc
{
  "seq": 42,              // monotonic per connection
  "width": 1920,
  "height": 1080,
  "stride": 7680,         // bytes per row; stride*height == pixels.length
  "format": "bgra",       // always BGRA (protocols 1–2)
  "timestampMs": 1700000000000,
  "originX": 0,           // virtual-screen coordinate of pixel (0,0)
  "originY": 0,
  "desktop": "Winlogon",  // real input desktop name
  "dirty": []             // changed rects; empty == full frame (see below)
}
```

## Capture approach and the DXGI-vs-GDI decision

The helper captures with **GDI** (`CreateDCW("DISPLAY")` → `BitBlt` →
`GetDIBits`), not DXGI Desktop Duplication. Evidence and reasoning:

- **DXGI Desktop Duplication** (`IDXGIOutputDuplication`) is GPU-accelerated and
  reports dirty rectangles, but a duplication object is bound to the desktop it
  was created on. When the session switches to the secure desktop, the next
  `AcquireNextFrame` returns `DXGI_ERROR_ACCESS_LOST`, and a duplication cannot
  be (re)created against the `Winlogon` desktop. So DXGI **cannot capture the
  UAC / lock / sign-in screen at all** — exactly the surface this component
  exists for. This matches the well-documented behavior of remote-desktop tools,
  which fall back to GDI whenever the duplication loses access (UAC, secure
  desktop, display-mode changes).
- **GDI `BitBlt`** from a `CreateDCW("DISPLAY")` device context follows the
  **calling thread's attached desktop**. Once the (SYSTEM) helper thread is
  attached to the input desktop, the same code captures `Default` and `Winlogon`
  identically. It is CPU-bound and offers no cheap dirty-region data, so every
  frame is a full-frame update (`dirty: []`).

Decision: **GDI is the mandatory, verified path** because it is the only method
that works on both the ordinary and the secure desktop. The WebRTC effort may
add DXGI as a performance optimization **for the `Default` desktop only**, using
the `desktop-changed` signal to switch back to GDI before/while on `Winlogon`.

What is proven here vs. what needs the manual test: the framing, security, and
GDI/`SendInput` code compile and are unit-tested, and GDI capture + `SendInput`
on the ordinary desktop are standard, well-understood APIs. Capturing and
injecting on the **secure desktop** can only be confirmed on a machine with the
service installed (it requires SYSTEM in the console session attached to
`Winlogon`); see the crate README's manual test steps.

## Injection approach

Input is injected with `SendInput`, which posts to the input queue of the
desktop the calling thread is attached to. With the helper thread attached to
the input desktop, the same calls drive `Default` and `Winlogon`. Pointer
coordinates are normalized to the `0..65535` absolute range across the whole
virtual desktop (`MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK`).

## Threat model

Assets: the ability to view and control the most privileged UI on the machine
(the secure desktop). This is the most sensitive component in the product, so
the defaults are restrictive.

- **Off by default.** Nothing is installed or started until the user explicitly
  opts in. Install is a single elevated step (one UAC prompt); uninstall removes
  everything and leaves nothing running.
- **No network.** Neither the service nor the helper opens a socket. The only
  IPC is the local named pipe, which rejects remote clients.
- **Trusted binary path.** The installer copies the executable into a protected
  machine directory (`%ProgramData%\Mixdog\SecureDesktop\bin`) that is created
  atomically with an owner-Administrators, SYSTEM/Administrators-only DACL
  (`P`-protected, so no inherited user-write ACE applies); the installing user
  gets read+execute only. The copied binary and **every ancestor directory** are
  verified — not a reparse point, owned by a trusted SID, and granting modify
  rights only to trusted SIDs — before the service is registered against the
  quoted path. This stops the user who installed from replacing the file the
  service runs as SYSTEM (an EoP), and stops symlink/junction redirection.
- **Secret written into an already-protected directory.** The state directory is
  created with its protected DACL in the same call that creates it, before the
  256-bit secret is ever written; an existing directory is accepted only after
  it verifies as a trusted, non-reparse path.
- **Three gates on the pipe.** A Medium mandatory label denies low-integrity /
  AppContainer clients; the DACL admits only the installing user and
  `SYSTEM`/`Administrators`; and both peers must prove knowledge of the 256-bit
  per-install secret through the mutual HMAC challenge-response, server first,
  without the secret ever crossing the pipe. The secret's state file grants read
  only to the installing user and SYSTEM. A client additionally proves it is the
  installing user in the serviced console session (session + impersonated token
  SID). A pipe-name squatter (another local account, while the helper is down)
  sees only one random nonce: the client aborts before sending its own MAC.
- **Session-scoped to the rightful console user.** The helper serves only the
  console session, and only when its user is the installing user or it is the
  logon/lock screen; a fast user switch to another account stops the helper.
  Within a session, the helper streams frames and injects new input **only**
  while `control { active: true }` (the sole exception: an in-place release of
  a button/key the same connection pressed and still holds), never releases
  input the connection did not press, and acts only in response to
  messages on the authenticated pipe. Stopping the session, disconnecting,
  switching desktop, a session change, or shutdown halts streaming, revokes
  control, and **releases every held pointer button and key**.
- **Graceful, authenticated shutdown.** The service stops the helper through a
  SYSTEM-only stop/ack event pair with unguessable per-launch names; the helper
  releases all held input before acknowledging, and is force-killed only after
  its documented 10 s shutdown deadline.
- **Bounded, non-blocking I/O.** Frames are assembled incrementally from only
  the bytes available, so a dribbled or truncated frame cannot stall capture;
  writes are overlapped and polled, never flushed; the handshake deadline and
  the *total* per-frame deadline (both directions) drop a stuck peer; all
  declared sizes are bounds- and overflow-checked before allocation.
- **Least privilege for service control.** The install grants the user
  start/stop/query on the service — never change-config or delete — so the
  feature can be toggled without re-elevation but its configuration cannot be
  altered except by an administrator.
- **Least exposure of the secret.** The secret is never logged; handshake
  rejections log the reason, not the value. The `error` message text is for logs
  only; the app shows its own copy. **No frame pixels are ever logged.**
- **Auditability.** Install, uninstall (including unclean-stop and cleanup
  warnings), service start/stop, helper launch, client acceptance/rejection,
  desktop changes, and capture errors are appended to an ACL-protected log
  beside the state.
- **Clean uninstall.** Uninstall distinguishes "not installed" from a real
  failure, waits for `SERVICE_STOPPED` via `QueryServiceStatusEx` bounded by the
  service's own wait hint (no fixed sleep), deletes the service, removes all
  state, and reports any cleanup it could not complete.
- **Residual risks (documented, out of scope here).** Anyone who is already the
  installing user or an administrator on the box can use the feature — that is
  the intended grant; local privilege boundaries are not raised. Over-the-
  shoulder elevation by a different admin account at the UAC prompt would record
  that admin's SID as the grantee. The WebRTC transport that carries frames off
  the machine is responsible for its own authentication, encryption, and remote
  consent; this contract stops at the local pipe.
