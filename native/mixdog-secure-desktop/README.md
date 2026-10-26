# Mixdog secure-desktop bridge

A Windows **service** (LocalSystem) plus a **session helper** that let the
Mixdog desktop app see and operate the current input desktop — including the
**secure desktop** (`Winlogon`: UAC consent, Ctrl+Alt+Del, lock and sign-in
screens) — over a local, secret-gated named pipe. This is one component of the
upcoming remote-desktop feature. The transport that streams frames to a phone
over WebRTC and relays input is a **separate effort** and is not in this crate;
that effort imports the TypeScript client (below) and treats
[`docs/ipc-spec.md`](docs/ipc-spec.md) as its contract.

Ordinary apps cannot capture or inject on the secure desktop. The standard
solution — used by remote-desktop products — is a LocalSystem service that
launches a helper into the active console session on the current input desktop.
This crate implements that, in Mixdog's own style. No reference code is copied
verbatim, so no `LICENSES` attribution is required; the crate is licensed
Apache-2.0, matching the Mixdog repository (see `LICENSE` and
`LICENSES/Apache-2.0.txt` at the repo root). Its statically linked Rust
dependencies (serde, serde_json, base64, rand, hmac, sha2, windows) are all dual-licensed
`MIT OR Apache-2.0` and used here under Apache-2.0; `build.ps1` emits the
dependency notice beside the binary.

## Layout

```
native/mixdog-secure-desktop/
  Cargo.toml            standalone crate (detached [workspace])
  build.ps1             reproducible release build into dist/ (+ licence notice)
  README.md             this file
  docs/ipc-spec.md      versioned IPC contract + threat model + capture evidence
  src/
    main.rs             subcommand dispatch: service|helper|install|uninstall|status|probe
    protocol.rs         wire framing + non-blocking accumulator (pure, unit-tested)
    security.rs         secret, SDDL builders, install state, trusted-path/SID rules (pure, unit-tested)
    paths.rs            service/pipe names, state/log, protected binary location (pure)
    log.rs              append-only lifecycle log (never the secret or pixels)
    winutil.rs          owned handles, SDDL→descriptor, token/session/client/process SIDs
    acl.rs              trusted-path verification (reparse, owner, modify-ACE) of the install path
    ipc.rs              named-pipe server/client (local, no-remote, labelled DACL, SYSTEM-verified)
    launch.rs           SYSTEM-token duplication + CreateProcessAsUser into a session
    service.rs          SCM entry + session policy monitor (launches/stops the helper)
    shutdown.rs         SYSTEM-only stop/ack events for graceful helper shutdown
    desktop.rs          attach to / name the input desktop (Default <-> Winlogon)
    capture.rs          GDI BitBlt capture (works on the secure desktop)
    inject.rs           SendInput injection + held-key/button tracking (unit-tested)
    install.rs          install / uninstall / status (protected binary copy, SCM, ACL'd state)
    probe.rs            manual-test CLI client over the pipe
```

The TypeScript client the app and the WebRTC effort import lives at
`apps/desktop/src/main/secure-desktop/` (`client.ts`, `protocol.ts`,
`paths.ts`, `index.ts`), with `secure-desktop.test.mjs` exercising the codec and
client against a mock pipe. It is a **no-op when the service is not installed**
and nothing installs automatically.

## Roles (one executable)

| Command     | Who runs it | What it does |
|-------------|-------------|--------------|
| `service`   | SCM         | LocalSystem; keeps one helper alive in the active console session |
| `helper`    | the service | SYSTEM in the console session; owns the pipe, captures, injects |
| `install`   | elevated    | copy the binary to a protected machine dir, create secret + ACL'd state, register + start the demand-start service |
| `uninstall` | elevated    | stop + delete the service, remove all state |
| `status`    | the user    | print `{installed, running, version}` JSON (no elevation) |
| `probe`     | the user    | manual-test client (handshake, frames, input) |

The service runs as LocalSystem, duplicates its own token to a primary token,
retargets it to `WTSGetActiveConsoleSessionId()`, and `CreateProcessAsUser`s the
helper on `winsta0\default`. The helper then follows the input desktop itself —
re-attaching between `winsta0\default` and `winsta0\winlogon` as UAC / the lock
screen come and go — and the service relaunches it when the **console session**
changes. Running the helper as **SYSTEM** (not the logged-in user) is what makes
`Winlogon` reachable.

## Capture / injection

GDI `BitBlt` capture and `SendInput` injection, both on the thread's attached
desktop. GDI is chosen deliberately: DXGI Desktop Duplication loses access the
moment the secure desktop appears and cannot capture `Winlogon`, so GDI is the
only method that works on both desktops. Full rationale and evidence are in
[`docs/ipc-spec.md`](docs/ipc-spec.md). Frames are raw top-down BGRA with size,
stride, timestamp, origin, and desktop; dirty regions are empty (full-frame)
because GDI exposes none cheaply.

## Security

Off by default; no network listener. The service is registered against a copy
of the binary in a protected, admin/SYSTEM-only machine directory (owner
Administrators, created atomically with a `P`-protected DACL, binary and every
ancestor verified non-reparse/trusted before registration) so the installing
user cannot swap the file the service runs as SYSTEM. The pipe denies
low-integrity clients with a mandatory label, admits only the installing user +
SYSTEM by DACL, and requires a mutual HMAC-SHA256 challenge-response over the
per-install 256-bit secret (server proves first; the secret never crosses the
pipe, so a pipe-name squatter learns only a random nonce); the native client
also verifies the server is SYSTEM. Both sides validate every message against
the schema and close on anything invalid. The helper serves only the
rightful console session (the installing user or the logon/lock screen — a fast
user switch to another account revokes it) and acts only on authenticated pipe
messages from a client it has confirmed is the installing user in that session.
Capture and injection of new input run only while a remote-control session is
active (`control { active: true }`); a connection can only ever release buttons
and keys it pressed itself (while inactive, in place with no pointer movement);
held pointer buttons and keys are released on deactivate, disconnect,
desktop switch, session change, and shutdown. The service stops the helper
gracefully (SYSTEM-only stop/ack events; the helper releases everything, then
acknowledges) and force-kills only after the 10 s shutdown deadline. Pipe I/O
never blocks the helper on its peer: parsing is non-blocking, writes are
overlapped (no per-frame flush) through a small 4 KiB outbound buffer, and a
handshake deadline plus a total 10 s per-frame deadline drop a stuck peer
(inbound: a late frame is never dispatched; outbound: a write that cannot
complete — backpressure, not a read acknowledgement). The user is granted only start/stop/query on the service (never
change-config or delete). The secret and screen pixels are never logged;
uninstall confirms the stop (bounded by the service wait hint), removes
everything, and reports anything it could not clean up. The full threat model is
in the spec.

## Build

```powershell
# Release build + dist/ with the licence notice (what packaging would invoke):
pwsh native/mixdog-secure-desktop/build.ps1

# Or directly during development:
cargo build --release          # produces target/release/mixdog-secure-desktop.exe
cargo test                     # unit tests (framing, deadlines, security, handshake)
```

Packaging follows the other product-native tools: the release exe is copied to
the installed app's `resources/native-tools/`. The TypeScript client resolves it
there when packaged and from `target/release` in development (see
`apps/desktop/src/main/secure-desktop/paths.ts`), mirroring
`profile-import-native.ts`. Wiring the exe into `scripts/prepare-runtime.mjs` /
`electron-builder.yml` is a packaging change owned separately and intentionally
not made here.

To keep a workstation responsive, build and test at Idle priority and run one
heavy job at a time:

```powershell
$p = Start-Process cargo -ArgumentList 'test' -WorkingDirectory native\mixdog-secure-desktop -NoNewWindow -PassThru
$p.PriorityClass = 'Idle'; $p.WaitForExit(); $p.ExitCode
```

## Manual test (requires the maintainer's UAC approval — not done automatically)

Build first (`cargo build --release`). Then, in order:

All commands are run from the **build/dev** executable (`target\release\...`, or
`resources\native-tools\...` when packaged) — never the protected installed copy
under `%ProgramData%`, so `uninstall` can delete that copy while it is not the
running image.

1. **Install (one UAC prompt).** From an elevated prompt, or via the app's
   `installSecureDesktop()`:
   ```powershell
   Start-Process .\target\release\mixdog-secure-desktop.exe -ArgumentList install -Verb RunAs -Wait
   .\target\release\mixdog-secure-desktop.exe status   # {"installed":true,"running":true,...}
   ```
   Then confirm the service runs from the protected copy and the user cannot
   replace it (the privilege-escalation fix):
   ```powershell
   (Get-CimInstance Win32_Service -Filter "Name='MixdogSecureDesktop'").PathName
   # => "C:\ProgramData\Mixdog\SecureDesktop\bin\mixdog-secure-desktop.exe" service  (quoted)
   icacls C:\ProgramData\Mixdog\SecureDesktop\bin\mixdog-secure-desktop.exe
   # Owner BUILTIN\Administrators; the user has only (RX), SYSTEM/Administrators (F)
   # From a NON-elevated prompt, replacing it must be denied:
   Copy-Item .\target\release\mixdog-secure-desktop.exe `
     C:\ProgramData\Mixdog\SecureDesktop\bin\mixdog-secure-desktop.exe -Force   # Access denied
   ```
2. **Attach the probe as the normal user** (a second, non-elevated terminal):
   ```powershell
   .\target\release\mixdog-secure-desktop.exe probe --frames 20
   ```
   Expect `server-hello ... desktop=Default` and a stream of
   `frame seq=... WxH stride=... desktop=Default bytes=...` lines.
3. **Trigger a UAC prompt** (e.g. run `Start-Process notepad -Verb RunAs`, or
   any elevation) while the probe is running. Expect a
   `desktop-changed desktop=Winlogon` line, then frames with `desktop=Winlogon`
   — the UAC consent screen. This is the secure-desktop capture the unit tests
   cannot prove on an uninstalled machine.
4. **Confirm input reaches the (secure) desktop:**
   ```powershell
   # Move/click at virtual-screen pixel (x y); or type into a focused field:
   .\target\release\mixdog-secure-desktop.exe probe --frames 5 --click 400 300
   .\target\release\mixdog-secure-desktop.exe probe --frames 5 --text "hello"
   ```
   With a UAC prompt up, a click on its "Yes"/"No" button should actuate it.
5. **Session policy (needs a second local account).** With the probe streaming,
   use fast user switching to switch to a *different* account. Expect the stream
   to stop and the helper to exit gracefully (log: `helper in session … released
   input and exited (session … no longer permitted)`); the other user's desktop is never streamed. Switching back to
   the installing user restores service. Locking the workstation (installing
   user) keeps streaming as `desktop=Winlogon`.
6. **Uninstall (one UAC prompt).** Verify it confirms the stop and leaves
   nothing:
   ```powershell
   Start-Process .\target\release\mixdog-secure-desktop.exe -ArgumentList uninstall -Verb RunAs -Wait
   .\target\release\mixdog-secure-desktop.exe status   # {"installed":false,"running":false}
   Get-Service MixdogSecureDesktop -ErrorAction SilentlyContinue   # none
   Test-Path C:\ProgramData\Mixdog\SecureDesktop                   # False
   ```
   A clean run emits no `warnings`; a failure to stop or remove is reported in
   the JSON and the log rather than silently ignored.

The lifecycle log at `%ProgramData%\Mixdog\SecureDesktop\secure-desktop.log`
records each step (never the secret or screen contents).
