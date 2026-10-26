# Mixdog Secure-Desktop IPC Contract

Version: **protocol 4**, state schema **1**.

Changelog:

- Protocol 4: the helper authorizes control itself. New input and `sas` are
  applied only under a live **control grant** — a one-shot `grant-challenge`
  the helper issued on this connection, signed by the paired phone's enrolled
  P-256 key for the current `video-run` ([Control grants](#control-grants)).
  New messages `video-run`, `grant-challenge`, `grant`, `sas`
  ([Ctrl+Alt+Del](#ctrlaltdel-sas)); `server-hello` and `desktop-changed`
  carry an optional `locked` (the session's WTS lock state); new advisory
  `error` codes ([Error codes](#error-codes)). State schema 1 gains the
  optional `controllerKey`; a state without one refuses every grant.
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
   `…-ack-<token>`, from a fresh 128-bit hex token passed as the helper's
   only argument (`helper <token>`; anything else is refused). Both carry a protected SYSTEM-only DACL
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
injector releases on deactivate, a grant's lapse, desktop switch, session
change, disconnect, and stop, and also whenever it is dropped, so even an
early return cannot strand a press.

**Parent watch.** The helper also waits on a handle to the service process
**that launched it** in every wait that watches the stop event; a process
handle is signalled when the process exits
(<https://learn.microsoft.com/windows/win32/sync/synchronization-objects>). A
service that dies without signalling stop — a crash or a `TerminateProcess` —
therefore ends the helper the same graceful way (release, ack, exit), so an
orphaned helper never keeps holding the pipe or locking the binary.

The handle is the launching service's own process **object**, handed over
before the helper runs; nothing is looked up by process id. The whole
hand-over happens inside a kill-on-close **bootstrap job**, so a service that
dies at any step takes the helper with it:

1. The service creates a fresh, unnamed job and sets its only limit,
   `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` ("Causes all processes associated with
   the job to terminate when the last handle to the job is closed",
   <https://learn.microsoft.com/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information>),
   through `SetInformationJobObject(JobObjectExtendedLimitInformation)`, which
   that limit requires. `CreateJobObject` without attributes gives a handle
   that "cannot be inherited"
   (<https://learn.microsoft.com/windows/win32/api/jobapi2/nf-jobapi2-createjobobjectw>),
   and "only named job objects can be opened"
   (<https://learn.microsoft.com/windows/win32/procthread/job-objects>), so the
   service holds the job's only handle.
2. The service creates the helper with `CREATE_SUSPENDED` (its primary thread
   "does not run until the ResumeThread function is called") and
   `EXTENDED_STARTUPINFO_PRESENT` ("the lpStartupInfo parameter specifies a
   STARTUPINFOEX structure",
   <https://learn.microsoft.com/windows/win32/procthread/process-creation-flags>),
   whose attribute list holds `PROC_THREAD_ATTRIBUTE_JOB_LIST` = [the job]: "a
   list of job handles to be assigned to the child process"
   (<https://learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute>;
   Windows 10 and later). The job is assigned at creation, with no gap
   between create and assign. `CreateProcessAsUser` accepts "a STARTUPINFO or
   STARTUPINFOEX structure"
   (<https://learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessasuserw>).
   One job per launch: "All processes associated with a job must run in the
   same session. A job is associated with the session of the first process to
   be assigned to the job" (`CreateJobObject`), and the helper is the only
   process ever assigned, so a job created in session 0 holds a helper in the
   console session.
   The process handle `CreateProcessAsUser` returns has `PROCESS_ALL_ACCESS`
   (<https://learn.microsoft.com/windows/win32/procthread/process-security-and-access-rights>),
   which includes the `PROCESS_DUP_HANDLE` a duplication target needs.
3. It calls `DuplicateHandle(GetCurrentProcess(), GetCurrentProcess(), helper,
   &target, SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, 0)`: the
   pseudo handle becomes a real handle, valid in the helper, that "refers to
   the same object as the original handle"
   (<https://learn.microsoft.com/windows/win32/api/handleapi/nf-handleapi-duplicatehandle>).
   Neither page restricts duplicating into a process of another session.
4. It writes `target` and its own process id (u64 LE + u32 LE, 16 bytes) into
   a per-launch section, `Global\MixdogSecureDesktop-parent-<token>`, created
   before the launch with the same protected SYSTEM-only DACL and squat
   refusal as the events. The service runs in session 0, so creating it in
   the global namespace needs no `SeCreateGlobalPrivilege`
   (<https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-createfilemappingw>).
5. Only then `ResumeThread`
   (<https://learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-resumethread>).
   If any step fails, the service drops the job still armed, and the
   never-run helper is terminated through it.
6. The helper opens its events, reads and verifies the handle (below), and
   then — its parent watch armed — sets
   `Global\MixdogSecureDesktop-armed-<token>`. It then waits for
   `Global\MixdogSecureDesktop-released-<token>`, together with stop and the
   parent watch, **before it creates its pipe**. Both events are per-launch,
   manual-reset, with the same protected SYSTEM-only DACL and squat refusal
   as the others.
7. The service's monitor loop waits on `armed` (instead of the SAS event)
   while the job is armed. On it, the service clears kill-on-close the
   documented way — "call the QueryInformationJobObject function to obtain
   the current limits, modify these limits, and then call
   SetInformationJobObject"
   (<https://learn.microsoft.com/windows/win32/api/jobapi2/nf-jobapi2-setinformationjobobject>)
   — closes its job handle, and only then sets `released`. A failed disarm
   drops the job armed, terminating the helper; a failed `released` leaves
   the helper waiting, so the service stops it the graceful way. Either counts
   as a launch failure.

Why this is atomic: until step 7 the helper lives only as long as the
service's job handle, and "open handles to kernel objects are closed
automatically when a process terminates"
(<https://learn.microsoft.com/windows/win32/procthread/terminating-a-process>),
so a service that crashes, or is killed, anywhere between creating the helper
and releasing it terminates the helper — suspended or running. Up to the
release the helper has served nothing (no pipe, no client, no input held), so
that hard kill strands nothing. After the release, the service's death ends
the helper through the parent watch instead: gracefully, releasing held input
first.

The helper stays in the job after the release — "After a process is
associated with a job, the association cannot be broken" (Job Objects page) —
but it is a job with no limits and no open handle: nothing can act on the
helper through it, a later service restart does not touch it (the parent
watch ends it), and the job goes away when the helper exits. The helper starts
no processes, so the job's child-process rules never apply.

Neither wait has a timeout of its own. The service waits for `armed` in its
monitor loop, which also wakes on its own stop and polls the helper's exit (a
helper that fails before arming exits, which is handled as any helper exit);
the helper waits for `released` together with stop and the parent watch.

The helper reads the section (read-only) and accepts the value only if
`GetProcessId` on it succeeds — so it is a process handle with a query right
(<https://learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocessid>)
— and returns the recorded id; otherwise it exits 2 without closing a handle
it could not verify. The id is only compared with the handle's own object,
never used to open anything, so a recycled id or a clock step cannot
substitute another process.

Why a section carries the value: the command line is fixed when the process
is created, before a handle can be duplicated into it, and the pipe hello
comes from the user-mode app, not the service. `DuplicateHandle` leaves
passing the value to "some form of interprocess communication (for example, a
named pipe or shared memory)".

Why `PROCESS_QUERY_LIMITED_INFORMATION` beside `SYNCHRONIZE`: `GetProcessId`
requires it, and it is what lets the helper refuse a value that is not a
process handle or names another process. It grants no route to more access;
`PROCESS_DUP_HANDLE`, which that page warns can be turned into full access, is
not granted.

An inherited handle (a `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` entry) is not an
option for this launch: `CreateProcessAsUser` documents "You cannot inherit
handles across sessions" and that with inheritance on "you must create the
process in the same session as the caller"
(<https://learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessasuserw>),
while the service runs in session 0 and the helper in the console session.

**SAS request.** The same per-launch token names a third SYSTEM-only,
auto-reset event, `Global\MixdogSecureDesktop-sas-<token>`, which the helper
sets to ask the service for Ctrl+Alt+Del ([Ctrl+Alt+Del](#ctrlaltdel-sas)).
Requests made before the service handles one coalesce: setting an event that
is already set has no effect
(<https://learn.microsoft.com/windows/win32/api/synchapi/nf-synchapi-setevent>).

**Lock notification.** A fourth SYSTEM-only, auto-reset event,
`Global\MixdogSecureDesktop-session-<token>`, is set by the service when the
SCM delivers `SERVICE_CONTROL_SESSIONCHANGE` with `WTS_SESSION_LOCK` (7) or
`WTS_SESSION_UNLOCK` (8)
(<https://learn.microsoft.com/windows/win32/api/winsvc/nc-winsvc-lphandler_function_ex>,
<https://learn.microsoft.com/windows/win32/termserv/wm-wtssession-change>); the
helper re-reads the lock flag then, and never polls it.

## Supervision (service)

Supervision is the SCM's; the service has no backoff or log limiter of its own.

- A helper that exits on its own (crash, fatal error), or that cannot be
  launched, stops the service with `dwWin32ExitCode =
  ERROR_SERVICE_SPECIFIC_ERROR` and the helper's exit code (or `0xFFFFFFFF`
  for a launch failure) as `dwServiceSpecificExitCode`. With the
  non-crash-failure flag set, "the failure actions are queued if … it enters
  the SERVICE_STOPPED state but the dwWin32ExitCode member … is not
  ERROR_SUCCESS"
  (<https://learn.microsoft.com/windows/win32/api/winsvc/ns-winsvc-service_failure_actions_flag>).
- The SCM's failure actions (set at install): restart after 60 s, at most 3
  times, failure count reset after 1 day. A crash loop therefore costs at most
  three restarts a day, one log line each; after that the service stays
  stopped until the app starts it again.
- Stops the service asks for (session change, revocation, service stop) are
  not failures.

## Helper token

The helper runs as SYSTEM (only SYSTEM can attach to the `Winlogon` desktop)
but the service removes every privilege from its primary token except:

- `SeChangeNotifyPrivilege` — path traversal for the state file, log and image;
- `SeImpersonatePrivilege` — `ImpersonateNamedPipeClient` yields an
  impersonation-level token only to a holder, and the per-connection identity
  check reads the client's user from it.

Removal uses `AdjustTokenPrivileges` with `SE_PRIVILEGE_REMOVED` (permanent for
the token); a failure to remove them fails the launch rather than starting a
fully privileged helper. Attaching to the input desktop, `SendInput`, GDI
capture, the pipe, the events, opening the parent section (and querying the
handed-over service handle), the WTS queries and reading the SAS policy need
SYSTEM's identity, not a privilege. Hardware verification of this list is
pending (see the crate README's manual test).

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
| `server-hello`    | helper → app   | `protocol:number`, `version:string`, `session:number`, `desktop`, `locked?:boolean` |
| `desktop-changed` | helper → app   | `desktop`, `session:number`, `locked?:boolean` |
| `input`           | app → helper   | `event:` [InputEvent](#input-events) |
| `control`         | app → helper   | `active:boolean` |
| `video-run`       | app → helper   | `epoch:number` |
| `grant-challenge` | helper → app   | `nonce:string`, `challenge:string` |
| `grant`           | app → helper   | `challenge:string`, `epoch:number`, `signature:string` |
| `sas`             | app → helper   | (none) |
| `error`           | helper → app   | `code:string`, `message:string` |

`locked` is the console session's lock state from WTS
(`WTSQuerySessionInformationW(WTSSessionInfoEx)` → `SessionFlags`:
`WTS_SESSIONSTATE_LOCK` / `_UNLOCK`), read at connect and again on each
[lock notification](#shutdown-service--helper) the service relays; it tells the lock /
sign-in screen apart from UAC consent, which share the `Winlogon` desktop. It is
omitted when Windows reports the state unknown. A change of `locked` alone is
also announced with `desktop-changed`. (Microsoft documents the two flags as
swapped on Windows 7 / Server 2008 R2; the app requires Windows 10 or later.)

`epoch` is a non-negative integer no larger than 2^53 − 1 (JSON-exact).

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
   1. app → `client-hello { protocol: 4, clientNonce: Nc }`.
   2. helper checks `protocol`, picks a fresh `Ns`, and sends
      `server-auth { protocol: 4, serverNonce: Ns, mac: HMAC(K, "server" ‖ Nc ‖ Ns) }`.
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
   Until then, the helper captures nothing and injects no new input. While
   active, frames stream, but new input and `sas` are applied **only while a
   [control grant](#control-grants) is live**.
   **The only exception is a release of this connection's own press:** while
   control is inactive or no grant is live, a `pointer-button` or `key` event with `down: false` is
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
4. `control { active: false }` (or disconnect) stops capture and injection,
   revokes the grant and every open challenge, and
   **releases any pointer button or key the app left pressed** so nothing is
   stranded down on the (possibly secure) desktop. The same release happens on
   disconnect, when a grant lapses, before each desktop switch, on a session
   change, and at helper shutdown.

### Control grants

The pipe's gates (mandatory label, DACL, install secret, session + user check)
admit **every process of the installing user**, not only the Mixdog app: the
secret file is readable by that user. Input injected by the SYSTEM helper is not
subject to UIPI, so without a further gate a medium-integrity process of the
same user could drive the helper and click "Yes" on its own UAC prompt — a UAC
bypass for split-token administrators. The helper therefore authorizes control
itself, with a grant that only the paired phone can produce and the app can only
relay.

- **Key.** The phone generates a P-256 ECDSA key as a non-extractable Web Crypto
  key (`apps/desktop/src/shared/secure-desktop-grant.ts`). Its public half
  (unpadded base64url of the 65-byte uncompressed point) is enrolled by the
  phone-requested, elevated `install` as `controllerKey` in the protected state
  file, which only SYSTEM and Administrators can write. A state without a key
  refuses every grant (`grant_key_missing`): control needs a reinstall from the
  phone.
- **Challenge.** While control is active the helper sends
  `grant-challenge { nonce, challenge }` — `nonce` is this connection's
  handshake server nonce `Ns`, `challenge` 16 fresh random bytes — at once and
  then every **2 s** (`GRANT_REFRESH`, see [Constants](#constants)). The next
  challenge is due 2 s after the last one was **issued**, whether or not it was
  answered. Activating control and declaring a new `video-run` make one due at
  once (a new run ends the grant, and runs change exactly when a secure-desktop
  prompt appears, so control resumes after one round trip). Open challenges
  older than the grant lifetime are dropped.
- **Run.** The app declares the video run the phone is shown with
  `video-run { epoch }` (the app's run counter, announced to the phone as
  `screen-video`). Declaring a different run ends the live grant.
- **Grant.** The phone signs, with ECDSA P-256 / SHA-256 (signature `r ‖ s`, 64
  bytes, base64 on the wire):

  ```
  "mixdog-secure-desktop-grant-v1" ‖ 0x00 ‖ Ns(16) ‖ challenge(16) ‖ epoch (u64 big-endian)
  ```

  and the app relays `grant { challenge, epoch, signature }`. The helper
  accepts it only if the challenge is open on this connection (each challenge
  is consumed by the first grant naming it, valid or not — no replay, one
  verification per challenge), younger than the lifetime, `epoch` equals the
  declared run, and the signature verifies under the enrolled key (CNG
  `BCryptVerifySignature`). Refusals are reported with the codes below.
- **Lifetime: 6 s** (`GRANT_LIFETIME`), measured on the helper's monotonic
  clock from when it **issued** the challenge — never from a phone timestamp,
  so clock skew cannot extend it and holding a signed grant only burns its
  life. It is the relay's bound on a silent leg (4 s missed-turn stall + 2 s
  liveness probe, see [Constants](#constants)): a grant outlives a missed
  refresh exactly as long as the path itself would stay up, and it bounds how
  long anyone could keep driving the desktop after the phone stops signing.
- **Lapse.** When the grant lapses (expiry, a new run, deactivation) the helper
  releases everything held and reports `grant_expired` once. Expiry is checked
  **before every message is dispatched**, not only once per loop pass, so a
  renewal that arrives just after expiry (in the same read as other messages)
  cannot hide the lapse: the held input is released first, then the renewal
  is checked. A new `video-run` releases held input, ends the grant and
  revokes every open challenge on the spot, so a grant later in the same read
  cannot make control live again while the old run's input is still held.
  Input that arrives without a live grant is dropped (in-place releases
  excepted) and reported once per lapse as `grant_required`.
- **Held input across a failed repeat.** A press that inserts nothing is not
  tracked as held — unless an earlier press of the same key or button already
  landed: a failed repeat (auto-repeat) leaves that press held, so it is still
  released on every exit path.
- Interoperability is pinned by a vector signed with Web Crypto and verified
  with CNG in the Rust tests (`security.rs`) and with Web Crypto in
  `secure-desktop-grant.test.mjs`.

### Ctrl+Alt+Del (SAS)

`sas` asks for the secure attention sequence. It is accepted only while control
is active and a grant is live (else `grant_required`). Repeats before the
service acts coalesce in the auto-reset SAS event; there is no rate limit of
our own.
`SendInput` cannot produce a SAS, and `SendSAS` must be called from a service or
a signed uiAccess application
(<https://learn.microsoft.com/windows/win32/api/sas/nf-sas-sendsas>), so:

1. The helper reads `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System\SoftwareSASGeneration`
   (0 none, 1 services, 2 Ease of Access apps, 3 both — the "Disable or enable
   software Secure Attention Sequence" policy). If an administrator set it to a
   value that excludes services (0, 2, or unknown), it replies
   `sas_disabled_by_policy` and changes nothing.
2. Otherwise it releases everything it holds (the combo's Ctrl and Alt). If
   those releases find the input desktop gone (a blocked insert whose
   re-attach fails), the outage is settled on the spot — suspended,
   `desktop_unavailable` — and no SAS is raised; a desktop loss pending from
   anything is also settled before every message is dispatched, so input
   later in the same read is never attempted. Otherwise it sets the SAS
   event; the service re-reads the policy and:
   - 1 or 3: calls `SendSAS(FALSE)`, touching nothing;
   - absent: temporarily enables it under an ownership marker (below);
   - anything else: refuses (logged).
3. **Session targeting.** The docs state that a service impersonating another
   token "simulates a SAS on the session associated with the impersonated
   token". The service (session 0) therefore duplicates its own SYSTEM token as
   an impersonation token, sets its `TokenSessionId` to the console session the
   helper serves, sets it on the calling thread (`SetThreadToken`), calls
   `SendSAS(FALSE)` from `sas.dll` (loaded from System32 only, with
   `LOAD_LIBRARY_SEARCH_SYSTEM32`) and reverts.

`SendSAS` returns nothing, so success is observed as the input desktop switching
to `Winlogon`.

**Temporary policy, ownership-aware.** When `SoftwareSASGeneration` is absent
the service (`security.rs` `send_sas_under_policy`):

1. resolves any marker a previous attempt left (step 5);
2. writes an ownership marker, `sas-policy-marker.json` in the protected state
   directory (SYSTEM / Administrators write only), recording key, value name
   and the value it is about to write (1), and flushes it to disk;
3. sets the value to 1 (`RegSetKeyValueW`,
   <https://learn.microsoft.com/windows/win32/api/winreg/nf-winreg-regsetkeyvaluew>);
4. calls `SendSAS(FALSE)`;
5. resolves the marker: re-reads the value and deletes it
   (`RegDeleteKeyValueW`,
   <https://learn.microsoft.com/windows/win32/api/winreg/nf-winreg-regdeletekeyvaluew>)
   **only if** the marker is ours and the value still equals what it records;
   if an administrator changed or removed it meanwhile, it is left as it is.
   The marker is then cleared; a failed deletion keeps it for a retry.

The service also resolves a leftover marker at every start, which recovers a
crash anywhere in steps 2–5. A torn or foreign marker never touches the
registry (being written before the value, a torn one proves the value was not
set). A value that existed before step 1 is never written or removed.

Residual race windows (the registry has no compare-and-set for values): an
administrator who creates the value between the absence check and step 3 has
it overwritten with 1, then removed; one who changes it between the re-read and
the delete in step 5 loses that change; and one who sets exactly 1 while a
marker exists (during the call, or between a crash and the next start) is
indistinguishable from ours, so that 1 is removed. The first two windows are
two consecutive registry calls wide. Uninstall removes the state directory
with the marker, so it must resolve the marker first
(`service::recover_software_sas`).

The app maps the phone's `ctrl-alt-del` special key (presses Ctrl, Alt, Delete)
to `sas`: a Delete press while Ctrl and Alt are down through the helper is sent
as `sas` instead.

### Error codes

`error` frames after the handshake are advisory; the connection stays up.

| `code` | Meaning |
|--------|---------|
| `protocol_mismatch`, `unauthorized` | handshake failures (connection closes) |
| `desktop_attach_failed` | the input desktop could not be attached at connect (closes) |
| `capture_failed` | one capture failed |
| `desktop_unavailable` | the input desktop changed but cannot be attached: capture and injection pause (never the old desktop), held input is released, re-attach is retried once per frame interval (66 ms); the next `desktop-changed` ends the outage. Found either by the loop's desktop check or by an injection (an insert of zero events whose re-attach fails — reported as this, not as `input_failed`), which suspends at once, before the next message. Logged when it is found and when it ends |
| `input_failed` | `SendInput` inserted no events even after re-attaching to the input desktop and retrying once, or inserted only some (not retried, so nothing is typed twice); sent once per failure streak (a full insert ends the streak) |
| `grant_key_missing` | no phone key is enrolled |
| `grant_required` | input or `sas` without a live grant |
| `grant_expired` | the live grant lapsed; held input was released |
| `grant_malformed`, `grant_unknown_challenge`, `grant_expired_challenge`, `grant_no_video_run`, `grant_wrong_video_run`, `grant_bad_signature` | a `grant` was refused |
| `sas_disabled_by_policy` | `SoftwareSASGeneration` excludes services |

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
- `setVideoRun(epoch)` declares the run; `sendGrant({challenge, epoch,
  signature})` and `sas()` settle like `sendInput`. The `grant-challenge` event
  carries `{nonce, challenge}` for the phone; `desktop-changed` also passes
  `locked`, and `session().locked` follows it.

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
  "format": "bgra",       // always BGRA (protocols 1–4)
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
- The copy uses `SRCCOPY | CAPTUREBLT`, which includes layered windows
  (<https://learn.microsoft.com/windows/win32/api/wingdi/nf-wingdi-bitblt>);
  without it layered UI is missing from the frame. Known risk: on some systems
  `CAPTUREBLT` copies make the mouse cursor flicker on the PC's own screen while
  a remote session captures. To be checked on the hardware test.

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

`SendInput` returns the number of events it inserted; zero means the input was
blocked
(<https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-sendinput>).
On zero the helper re-attaches to the current input desktop and retries once; a
partial insert is not retried (the inserted events would repeat). A press that
did not land is not tracked as held. Failures are reported as `input_failed`.

## Constants

Every timing and limit added in protocol 4, with its source: **(a)** a cited
Microsoft document, used as written; **(b)** an existing Mixdog constant;
**(c)** derived from the protocol, derivation stated. Where Windows provides
the mechanism, it is used instead of a constant of ours.

| Constant | Value | Source | Use |
|----------|-------|--------|-----|
| `GRANT_REFRESH` (`security.rs`) | 2 s | (b) `DESKTOP_LIVENESS_PROBE_MS`, `apps/relay/lib/relay-legs.mjs:61` — the time a silent leg gets to answer a ping | a fresh `grant-challenge` is due 2 s after the last one was issued |
| `RELAY_HANDSHAKE_STALL` (`security.rs`) | 4 s | (b) `DESKTOP_HANDSHAKE_STALL_MS`, `relay-legs.mjs:58` | term of `GRANT_LIFETIME` |
| `GRANT_LIFETIME` (`security.rs`) | 6 s = 4 s + 2 s | (b)+(c) the relay's bound on a leg that missed a turn, `DESKTOP_HANDSHAKE_STALL_MS + DESKTOP_LIVENESS_PROBE_MS` (stated in `relay-legs.mjs`), after which the relay closes it | a grant is live until its challenge's issue time + 6 s, so it never outlasts the path that delivers the phone's input. Pinned to the relay values by `secure-desktop-grant.test.mjs` |
| `REATTACH_INTERVAL` (`helper.rs:98`) | 66 ms = `CAPTURE_INTERVAL` | (b) `CAPTURE_INTERVAL`, `helper.rs:54` (pre-existing; mirrored by `HELPER_FRAME_INTERVAL_MS`, `screen-webrtc-source.ts:49`) — (c) a re-attach matters only for the next frame, so it is retried at the frame cadence | re-attach attempts while `desktop_unavailable` |
| `input_failed` | once per failure streak | (c) event-driven: reported when a failure follows a success (or the start); no interval | client notice |
| `desktop_unavailable` log | when an outage is found + when it ends | (c) event-driven; no interval | helper log |
| SAS repeat handling | — | (a) auto-reset event: "setting an event that is already set has no effect" (`SetEvent`) | repeated `sas` before the service acts coalesce; no rate limit |
| Lock state | on notification | (a) `SERVICE_CONTROL_SESSIONCHANGE` + `WTS_SESSION_LOCK` (7) / `WTS_SESSION_UNLOCK` (8) (`service.rs:100-101`, `WM_WTSSESSION_CHANGE` docs) | replaces the 500 ms poll |
| Helper relaunch / crash loop | SCM failure actions | (a) `SERVICE_FAILURE_ACTIONS_FLAG` (non-crash failures queue the failure actions when `dwWin32ExitCode` ≠ 0) | replaces the 1 s → 60 s backoff and the once-a-minute log limit |
| `ERROR_SERVICE_SPECIFIC_ERROR` (`service.rs:92`) | 1066 | (a) `SERVICE_STATUS` docs | exit status that triggers the failure actions |
| `SERVICE_START_WAIT_HINT_MS` (`service.rs`, exported) | 3000 ms | (a) Microsoft's ServiceMain sample, used as written: `ReportSvcStatus( SERVICE_START_PENDING, NO_ERROR, 3000 )`, then an event, then `SERVICE_RUNNING` ("Writing a ServiceMain Function") — the same steps this service takes | `dwWaitHint` of the single START_PENDING; imported by the installer's start wait |
| Parent watch | the launching service's handle | (a) a process handle is signalled at exit; `CREATE_SUSPENDED` + `DuplicateHandle` + `ResumeThread` (see [Parent watch](#shutdown-service--helper)) | replaces the process-id lookup; no constant |
| Bootstrap job | — | (a) `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` assigned at creation through `PROC_THREAD_ATTRIBUTE_JOB_LIST`; disarmed by query-modify-set (see [Parent watch](#shutdown-service--helper)) | no timeout: each side's wait also wakes on the other's stop or exit |
| Parent record | 16 bytes | (c) a u64 handle value (pointer-sized on 64-bit) + a u32 process id, padded | the parent section's size |
| `LAUNCH_FAILED` (`service.rs:95`) | `0xFFFFFFFF` | (c) a code no helper exit uses (the helper returns 0, 1 or 2, `helper.rs` `run`) | service-specific code for a failed launch |
| Grant/SAS byte sizes (nonce 16, key 65, signature 64) | — | (a) P-256 / ECDSA encodings (SEC 1 uncompressed point, IEEE P1363 `r ‖ s`); nonce = existing `NONCE_BYTES` | wire validation |

Pre-existing values these rely on, unchanged in this round: `POLL_INTERVAL`
1 s (`service.rs:87`, monitor backstop and SCM checkpoint slice),
`CAPTURE_INTERVAL` 66 ms (`helper.rs:54`), `FRAME_DEADLINE` /
`SHUTDOWN_DEADLINE` 10 s and `HANDSHAKE_DEADLINE` 10 s (`helper.rs`, documented
decisions).

**Flagged (not sourced here):** the SCM failure-action values — restart after
60 s, at most 3 times, reset after 1 day — are set by `install.rs` (another
owner); their source must be stated there.

## Threat model

Assets: the ability to view and control the most privileged UI on the machine
(the secure desktop). This is the most sensitive component in the product, so
the defaults are restrictive.

- **Off by default.** The binary ships with the app, but nothing is installed or
  started until the paired phone's user asks for the helper; each request is a
  single elevated step (one UAC prompt on the PC), never repeated on its own.
  Uninstall (also run by the app's uninstaller) removes everything and leaves
  nothing running. Windows' Apps & Features lists the bridge (entry
  `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\MixdogSecureDesktop`),
  whose uninstall command runs `uninstall --from-apps` through the protected
  copy; only `--from-apps` elevates itself. The app's install request reports
  `installed`, `updated`, or a failure, and offers `install`, `update` (a stale
  `check`, exit 2) or nothing (`installOfferFor`).
- **No network.** Neither the service nor the helper opens a socket. The only
  IPC is the local named pipe, which rejects remote clients.
- **Consent model (standard, accepted).** The app elevates the helper it ships
  in the per-user app folder with the `runas` verb, so UAC shows the verified
  publisher of the exact binary being elevated; approving that prompt is the
  consent, as for any remote-desktop or per-user application that elevates its
  own executable. Whatever binary the user approves runs elevated: nothing
  inside that process can prove more about the process itself, and the bridge
  does not claim to. If a user-level attacker replaced the helper *before* the
  prompt, UAC shows the attacker's publisher (or "Unknown publisher"), and an
  administrator who approves it anyway is outside this guarantee.
- **Verified staging after consent.** What the bridge does guarantee is that the
  binary it registers as the SYSTEM service is a genuine release image, even if
  the approved exe is renamed away (a running image can be renamed, not written
  or deleted) and other bytes are planted at its path before the elevated
  process opens itself. `install` resolves the *current* name of its own mapped
  image (`GetMappedFileNameW`, which follows renames), opens it sharing only
  read — no writer or deleter, and a rename needs delete access, so the held
  file can no longer change or move — and confirms the image still has that name
  and the handle resolves to it (so the held file is the running image). It then
  verifies that handle with `WinVerifyTrust` (Authenticode, chain to a
  Windows-trusted root, code-signing usage, timestamp) and requires the signer
  to equal the **release signer pinned at build time**: the full subject DN and
  the Artifact Signing certificate-profile EKU (`1.3.6.1.4.1.311.97.<profile>`,
  Microsoft's documented durable identity across the daily certificate
  renewals). Only the bytes read from that held, verified handle are staged. A
  build without a pin (local / development) is refused, with no override; the
  release workflow runs the packaged helper's `verify-image` against the pin, so
  an identity change fails the release rather than every install. The signer's
  chain (root excluded) is then checked for revocation online —
  `CertGetCertificateChain` with `CERT_CHAIN_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT`,
  a 20 s cumulative retrieval bound (`dwUrlRetrievalTimeout` +
  `CERT_CHAIN_REVOCATION_ACCUMULATIVE_TIMEOUT`), judged as of the signature's
  timestamp. Revoked is refused; a status that cannot be determined is refused
  too ("could not check certificate revocation (offline?)", exit 6), never
  silently accepted.
- **Trusted binary path.** The installer copies the executable into a protected
  machine directory (`%ProgramData%\Mixdog\SecureDesktop\bin`) that is created
  atomically with an owner-Administrators, SYSTEM/Administrators-only DACL
  (`P`-protected, so no inherited user-write ACE applies); the installing user
  gets read+execute only. The copied binary and **every ancestor directory** are
  verified — not a reparse point, owned by a trusted SID, and granting modify
  rights only to trusted SIDs — before the service is registered against the
  quoted path. This stops the user who installed from replacing the file the
  service runs as SYSTEM (an EoP), and stops symlink/junction redirection.
- **One install at a time, bounded.** The elevated step's lock is the creation
  of a private object namespace whose boundary requires the Administrators SID
  and the High mandatory label; Windows lets only a caller inside the boundary,
  at that integrity or above, create it, so a standard user or an
  administrator's unelevated process cannot pre-create it to block installs (a
  `Global` named mutex could be squatted). A second install exits at once as
  busy. There is no overall deadline: each step that waits on something
  external is bounded on its own (the revocation check, the chain-building
  fetches at Windows' default per-URL timeout, the SCM stop/start by the
  wait-hint pattern), and the rest is local work — see the constants table in
  the crate `README.md`. The app latches a launched elevation until that
  process exits, never launching a second one meanwhile.
- **No silent takeover.** Under that lock, before changing anything, `install`
  and `uninstall` read the existing state and refuse (exit 4, `other-user`) a
  registration recorded for a different Windows account; the app uninstaller
  also skips it up front. A failed install rolls back; if the registration
  cannot be removed the files are kept (so a still-registered service keeps a
  working binary) and the result is reported as an explicit incomplete cleanup,
  never a silent not-installed.
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
  **These gates identify the user, not the app**: any process of the installing
  user can read the secret file, pass every gate, receive frames, and declare
  control active.
- **Control needs the phone.** Because of that, new input and Ctrl+Alt+Del also
  need a live [control grant](#control-grants) signed by the paired phone's
  enrolled key, which no process on the PC holds. A same-user process can watch
  the stream but cannot inject, so it cannot approve its own UAC prompt through
  the helper. Residual risks, accepted: (1) while the phone is actively
  controlling and keeps signing, a same-user process that has taken over the app
  can inject alongside within the live grant (at most 6 s past the phone's last
  signature); (2) enrollment trusts the app at install time — a same-user
  process already active then could substitute its own key in the elevated
  install's arguments, which the UAC prompt does not show; (3) the stream itself
  (including the lock and UAC screens) is readable by any same-user process, as
  the user's own desktop already is.
- **Session-scoped to the rightful console user.** The helper serves only the
  console session, and only when its user is the installing user or it is the
  logon/lock screen; a fast user switch to another account stops the helper.
  Within a session, the helper streams frames only while
  `control { active: true }` and injects new input **only** while also holding a
  live grant (the sole exception: an in-place release of
  a button/key the same connection pressed and still holds), never releases
  input the connection did not press, and acts only in response to
  messages on the authenticated pipe. Stopping the session, disconnecting,
  switching desktop, a session change, or shutdown halts streaming, revokes
  control, and **releases every held pointer button and key**.
- **Graceful, authenticated shutdown.** The service stops the helper through a
  SYSTEM-only stop/ack event pair with unguessable per-launch names; the helper
  releases all held input before acknowledging, and is force-killed only after
  its documented 10 s shutdown deadline. A helper whose launching service died
  ends itself the same way (parent watch, bound to that service instance).
- **Least privilege for the helper.** SYSTEM identity, but only
  `SeChangeNotifyPrivilege` and `SeImpersonatePrivilege` ([Helper token](#helper-token)).
- **Bounded, non-blocking I/O.** Frames are assembled incrementally from only
  the bytes available, so a dribbled or truncated frame cannot stall capture;
  writes are overlapped and polled, never flushed; the handshake deadline and
  the *total* per-frame deadline (both directions) drop a stuck peer; all
  declared sizes are bounds- and overflow-checked before allocation.
- **Least privilege for service control.** The install grants the user
  start/stop/query on the service — never change-config or delete — so the
  feature can be toggled without re-elevation but its configuration cannot be
  altered except by an administrator. Applying that security descriptor
  (`SetServiceObjectSecurity`) is required: if it fails, the install fails and
  rolls back rather than leave a service with default permissions.
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
- **Residual risks (documented, out of scope here).** Any process of the
  installing user can connect and watch; driving needs the phone's grant (see
  above). An elevated administrator can rewrite the state (including the
  enrolled key) — local administrators are outside this boundary. Over-the-
  shoulder elevation by a different admin account at the UAC prompt would record
  that admin's SID as the grantee. The WebRTC transport that carries frames off
  the machine is responsible for its own authentication, encryption, and remote
  consent; this contract stops at the local pipe.
