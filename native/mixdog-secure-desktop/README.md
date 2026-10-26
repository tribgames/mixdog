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
and nothing installs automatically: the binary ships inside every Windows app
build, and the service is installed **on demand** — only when the paired phone
asks for it from the secure-desktop blocked state — through
`install-request.ts` (one UAC prompt per request, never retried, never on app
install or update). The app's uninstaller removes it (one UAC prompt, only when
something is installed).

## Roles (one executable)

| Command     | Who runs it | What it does |
|-------------|-------------|--------------|
| `service`   | SCM         | LocalSystem; keeps one helper alive in the active console session |
| `helper`    | the service | SYSTEM in the console session; owns the pipe, captures, injects |
| `install --controller-key <k>` | elevated | requires the paired phone's public control key (base64url uncompressed P-256 point, checked with `security::decode_controller_key`; missing/invalid refused before anything changes) and writes it as `controllerKey` in the state; one key per install: an approved update rewrites the state with the requesting phone's key, replacing the previous one; under an admin-only private-namespace lock (exit 75 busy) with no overall self-abort timer (each external wait is bounded on its own; see "Timing and limit constants"): refuse another account's install (exit 4); hold the running image open against writers/deleters, verify it with `WinVerifyTrust` against the release signer pinned at build time (subject DN + signing-profile EKU; unpinned/unsigned/foreign/revoked refused, exit 5) and check its chain for revocation online (bounded; undeterminable refused, exit 6), copy exactly those bytes to a protected machine dir, create secret + ACL'd state, register the demand-start service with a restricted DACL granting the user start/stop/query (fatal if it cannot be set), SCM recovery (restart after 60 s for the first three failures, then `SC_ACTION_NONE` — the SCM repeats the last action for later failures — with a daily reset; non-crash failures included) and an HKLM Apps & Features entry, start it and report `running` only once confirmed; over an existing install it stops it and upgrades in place; a failure rolls back: only after a confirmed `SERVICE_STOPPED` and a removed registration is the software SAS marker resolved and are the files and the Apps & Features entry removed; otherwise all of them are kept and cleanup is reported incomplete |
| `uninstall` | elevated    | under the same lock: refuse another account's install (exit 4), else stop the service and delete it only once `SERVICE_STOPPED` is confirmed (`DeleteService` on a service that is still running only marks it for deletion; an unconfirmed stop exits 1 with cleanup incomplete and keeps the registration, the SAS marker, the files and the entry), resolve a `SoftwareSASGeneration` value it left (`service::recover_software_sas`, while its `sas-policy-marker.json` still exists; on failure the state folder and marker are kept and cleanup is incomplete), then remove all state and the Apps & Features entry (a failed rollback of `install` does the same). `install`/update never delete the state folder — they create missing directories and overwrite only the binary and `state.json` — so a marker survives an update and the service resolves it at its next start; when run as the protected copy itself, its running image is renamed (never copied) into a unique admin-only sibling `%ProgramData%\Mixdog\SecureDesktop.uninstalled-<pid>-<ms>` on the same volume, scheduled for deletion at the next restart immediately, and only then is the tree removed. If any file step fails the image is moved back, the Apps & Features entry is kept for a retry, and cleanup is reported incomplete |
| `uninstall --from-apps` | the user | the Apps & Features entry's `UninstallString` (the protected copy): asks for elevation once, then runs `uninstall`; exit 1223 when declined. Plain `uninstall` never prompts |
| `status`    | the user    | print `{installed, running, version}` JSON (no elevation) |
| `check [--controller-key <k>]` | the user | exit 0 current / 1 missing / 2 stale / 4 other-user (3 undetermined, including an invalid key); "current" = registered, valid state that enrolls a controller key (the named one, when given), protected copy byte-identical to this binary — a pre-grant install without `controllerKey`, or one enrolling another phone, is stale; "other-user" = registered but owned by a different account (no elevation) |
| `start`     | the user    | start the installed demand-start service (no elevation; the install granted the user start rights) and follow START_PENDING to running (the documented checkpoint/wait-hint pattern, no extra cap; see "Timing and limit constants") — the app uses it to bring the service back after a reboot |
| `verify-image [path]` | the user | the install's image check, read-only: this image (or `path`) against the pinned release signer and revocation; exit 0 accepted / 5 refused / 6 revocation unknown, with the reason |
| `probe`     | the user    | manual-test client (handshake, frames, input) |

The service runs as LocalSystem, duplicates its own token to a primary token,
retargets it to `WTSGetActiveConsoleSessionId()`, and `CreateProcessAsUser`s the
helper on `winsta0\default`. The helper then follows the input desktop itself —
re-attaching between `winsta0\default` and `winsta0\winlogon` as UAC / the lock
screen come and go — and the service relaunches it when the **console session**
changes. Running the helper as **SYSTEM** (not the logged-in user) is what makes
`Winlogon` reachable.

## Timing and limit constants (install side)

Every timing or limit in the install/start/check path, with its source:
(a) a cited Microsoft pattern used as written, (b) an existing Mixdog
constant, (c) a stated derivation — or **FLAGGED** when none applies.

| Constant | Value | Source | Use |
| --- | --- | --- | --- |
| `wait_slice` (`install.rs`) | hint/10, clamped to [1 s, 10 s] | (a) Microsoft Learn "Starting a Service" (`DoStartSvc`): "one-tenth of the wait hint but not less than 1 second and not more than 10 seconds" | poll interval while START/STOP_PENDING |
| `stall_window` (`install.rs`) | `dwWaitHint` | (a) same sample: `GetTickCount() - dwStartTickCount > dwWaitHint` → "No progress made within the wait hint" | give up a start/stop whose checkpoint stopped advancing |
| start overall cap | none (the former 45 s is removed) | (a) the sample has no overall cap: by design the waiter keeps going for as long as the checkpoint keeps advancing, and gives up only after a whole wait hint without progress | `start`, and the post-install start wait |
| `REVOCATION_RETRIEVAL_TIMEOUT_MS` (`signature.rs`) | 20 000 ms cumulative | (a) Windows' default "path validation cumulative retrieval timeout" (Certificate Path Validation Settings > Network Retrieval, `ChainRevAccumulativeUrlRetrievalTimeoutMilliseconds`; Microsoft Learn ff627826), with `CERT_CHAIN_REVOCATION_ACCUMULATIVE_TIMEOUT` | bound on online CRL/OCSP retrieval |
| `RESTART_DELAY_MS` / `RESTART_ATTEMPTS` / `FAILURE_RESET_SECONDS` (`install.rs`) | 60 000 ms / 3 / 86 400 s, then `SC_ACTION_NONE` | (a) reference-parity standard pattern: the Chrome Remote Desktop host installer, upstream Chromium `remoting/host/win/chromoting.wxs` (`util:ServiceConfig`: restart on first, second and subsequent failures after 60 s, 1-day reset). The trailing `SC_ACTION_NONE` is (a) `SERVICE_FAILURE_ACTIONSW` Remarks ("repeats the last action") | SCM recovery actions |
| `service_stop_bound` (`install.rs`) | 21 s | (c) what the documented waiter amounts to for this service (no timer is armed; tests check it). The waiter itself, by design, keeps going for as long as the checkpoint keeps advancing; the bound holds because this service stops advancing it: it reports STOP_PENDING with `dwWaitHint = helper::SHUTDOWN_DEADLINE` (10 s, Mixdog constant) and progresses for at most that long before force-killing the helper; the documented waiter then gives up after a whole hint without progress, noticed at the next slice: 10 + 10 + 1 s | stopping an installed service (install upgrade, uninstall) |
| `service_start_bound` (`install.rs`) | 4 s | (c) the service reports one START_PENDING with `dwWaitHint` 3000 ms and never advances the checkpoint (the waiter would keep going while it advanced, by design), then RUNNING; a stuck start is given up after the hint, noticed at the next 1 s slice: 3 + 1 s. `SERVICE_START_WAIT_HINT_MS` is imported from `service.rs`, which reports it in `run_service` (`set_status(SERVICE_START_PENDING, 0, SERVICE_START_WAIT_HINT_MS)`) | starting the service after install |
| `WINDOWS_DEFAULT_URL_RETRIEVAL_TIMEOUT_MS` (`signature.rs`, not set by this crate) | 15 000 ms per URL retrieval (default; configurable policy) | (a) Windows' default per-URL retrieval timeout, left in force: Microsoft Learn *CertGetCertificateChain* ("each revocation URL is assigned a maximum default timeout of 15 seconds"; network retrievals of "CRLs, OCSP, AIA issuers and Windows platform CTL cabs and Third Party roots", "the maximum time allowed for each network retrieval" 15 s by default; "You can set the default values by using Group Policy") and Microsoft Learn ee619786 / *Authority Information Access in Windows* (Certificate Path Validation Settings > Network Retrieval: "Default URL retrieval timeout" 15 s, AIA retrieval during path validation allowed). `WinVerifyTrust` runs **without** `WTD_CACHE_ONLY_URL_RETRIEVAL` (*WINTRUST_DATA*: only that flag stops its network retrieval), so a fresh PC can fetch the Microsoft Identity Verification root or an intermediate on demand | limits each single fetch of `WinVerifyTrust`'s Authenticode chain build and each intermediate fetch of the revocation step. A configurable policy value (Group Policy can change it per machine), and a per-retrieval limit — not a bound on the whole `WinVerifyTrust` operation, which may make several retrievals |
| overall self-abort deadline (`install`/`uninstall`/`verify-image`) | none (the former 120 s, then 45/21/20 s, and exit 124 are removed) | every external wait has its own limit (revocation 20 s cumulative; each chain-building fetch Windows' default per-URL retrieval timeout, 15 s, configurable, per retrieval; SCM stop/start the wait-hint pattern, which by design keeps waiting while the checkpoint advances); the remaining steps are local work with nothing external to wait on. A global timer could only abort local work half-way (slow disk, AV scanning) | — |
| `DEFAULT_REPORT_AFTER_MS` (`install-request.ts`) | 5 min | (b) `NATIVE_FILE_SAVE_INTERACTIVE_TIMEOUT_MS` (`apps/desktop/src/shared/native-file-save.ts`), Mixdog's bound for waiting on a modal OS dialog the user must answer | when a request answers `in-progress` while UAC is unanswered |
| `start` wrapper timeout (`client.ts`) | none (the former 60 s is removed) | the command is bounded inside: the documented start pattern against this service's single 3 s START_PENDING (`service_start_bound`, 4 s); the pattern keeps waiting while a checkpoint advances, by design | `startSecureDesktopService` |
| `check` wrapper timeout (`client.ts`) | none (the former 15 s is removed) | `check` is local work (an SCM query and file reads) with no external wait | `secureDesktopInstallState` |
| `status` wrapper timeout (`client.ts`) | none (the former 15 s is removed) | `status` is local work (an SCM query and a file read) with no external wait | `secureDesktopStatus` |
| `verify-image` wrapper timeout (`client.ts`) | none (the former 30 s is removed) | its external waits are limited inside: revocation retrieval 20 s cumulative, each chain-building fetch Windows' default per-URL retrieval timeout (15 s, configurable; per retrieval, not for the whole check); the rest is local work | `verifySecureDesktopImage` |
| Win32 / exit codes (1223, 1056, 1060, 183, 75, 4, 5, 6) | — | Win32 error codes as documented; bridge exit codes are protocol values, not timings | — |

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
uninstall (and a failed install's rollback) requires a confirmed
`SERVICE_STOPPED` before it deletes the registration, resolves the software SAS
marker or removes any file — an unconfirmed stop keeps all of them and reports
incomplete cleanup — then removes everything and reports anything it could not
clean up. The full threat model is in the spec.

**Residual risk (consent model).** UAC authenticates the executable being
elevated (the signed Mixdog bridge), not the phone key the app passes to it with
`--controller-key`. A compromised desktop app running as the user could request
the same UAC prompt with a key of its own and, once the prompt is approved,
enroll that key as the controller; the elevated install checks only the key's
form. Approving the prompt is therefore consent to the app as it runs on this
PC, including the key it supplies. Showing the key's fingerprint in trusted
elevated UI, for comparison with the phone, is out of scope for this release.

## Build

```powershell
# Release build + dist/ with the licence notice (what packaging would invoke):
pwsh native/mixdog-secure-desktop/build.ps1

# Or directly during development:
cargo build --release          # produces target/release/mixdog-secure-desktop.exe
cargo test                     # unit tests (framing, deadlines, security, handshake)
```

`build.rs` embeds a Windows VERSIONINFO resource (winresource, the crate the
other native tools use; a UTF-8 `.rc` with `#pragma code_page(65001)`
compiled by the MSVC toolchain's `rc.exe`): `FileDescription` "Mixdog 원격 접근"
— the program name the UAC prompt for `install` shows — `ProductName` /
`CompanyName` "Mixdog", `LegalCopyright` "Copyright (C) Mixdog", and the file
and product version from `Cargo.toml`. A missing resource compiler fails the
build rather than shipping a nameless prompt. The Apps & Features entry carries
the same `DisplayName`; its registry key (`Uninstall\MixdogSecureDesktop`)
does not depend on the name, so an install or update rewrites an entry written
under the earlier name "Mixdog Secure Desktop Helper", and uninstall finds it
either way. The service keeps its internal name and its display name "Mixdog
Secure Desktop Bridge".

Packaging follows the other product-native tools: the release exe is copied to
the installed app's `resources/native-tools/`. The TypeScript client resolves it
there when packaged and from `target/release` in development (see
`apps/desktop/src/main/secure-desktop/paths.ts`), mirroring
`profile-import-native.ts`. `apps/desktop/scripts/prepare-runtime.mjs` builds it
for Windows targets through `build.ps1` (cached by a source digest, like the
browser importer) into `native-tools`, and electron-builder signs it with the
other packaged executables. `apps/desktop/build/installer.nsh`
(`customUnInstall`) runs the elevated `uninstall` on a real app uninstall.

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

> **`install` requires a pinned, signed release image.** The release workflow
> compiles the release signer (subject DN + Artifact Signing profile EKU) into
> the helper (`MIXDOG_SECURE_DESKTOP_SIGNER_SUBJECT` / `_EKU`), and `install`
> stages itself only when its own held image verifies against that pin. A local
> `target\release` build has no pin (and no signature) and is **refused** — by
> design, with no override. Manual install/capture testing therefore runs from
> a **released** build's `resources\native-tools\`; `verify-image` there should
> print `{"ok":true,...}`. `status`, `check`, `start`, `probe` and `uninstall`
> need no signature.

1. **Install (one UAC prompt).** Via the app's on-demand
   `SecureDesktopInstaller.request()`, or from a signed packaged build:
   ```powershell
   Start-Process .\resources\native-tools\mixdog-secure-desktop.exe -ArgumentList install -Verb RunAs -Wait
   .\resources\native-tools\mixdog-secure-desktop.exe status   # {"installed":true,"running":true,...}
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
