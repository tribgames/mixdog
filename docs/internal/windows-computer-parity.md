# Windows computer use: parity checklist for deleting the PowerShell/C# stack

Task g4x-one-windows-computer-path (wave 4). Owner decision of 2026-11-14: Windows computer use has one path, the
`mixdog-computer` helper driven by the core. The old TypeScript PowerShell/C# host is not a selectable rollback; it is
deleted by s3-31, s3-32 and x-del-remote-screen once every line below is covered.

What this task changed: `MIXDOG_COMPUTER_WINDOWS_WORKER` and `windowsWorkerFromEnvironment` are gone; the
`WindowsWorker` type and every `windowsWorker` option (host-worker-process, worker-pool, lifecycle-abort,
powershell-host, computer/index, screen-electron) are gone. A Windows worker, the abort cleanup and the screen-input
host are the helper, always. The published PowerShell script is no longer launched as a worker; the screen-input host
now always sweeps the old script and DLL cache once.

How the lines were read. "Old" is the file and symbol under `apps/desktop/src/main/computer` (backend/sources/*.cs and
*.ps1, backend/*.ts, host/*.ts) that does it. "Rust" is the file and symbol under `native/mixdog-computer/src` (H:) or
`native/core/crates/mixdog-tools/src/desktop` (C:) that does it now. Every Rust place was found by searching the
current tree for the symbol. I read the symbol lists of the files and the bodies of a handful (fg_text, text,
foreground_refusal, elevated decide, ALLOWED_ACTIONS), not every body; no test or binary was run. Behaviour equality is
therefore inferred from names and from the unit tests the Rust files carry. The gap map (`wincu-gapmap.json`, 05:12) is
older than most of the Rust now in the tree; every line it called missing was searched again. Other sources:
`wincu-reaudit.json`, `wincu-audit.json`, g25 wire.json, deferred-g3.md (the line naming `bindComputerEnvironmentGuard`).

## Work the deletion tasks must do first (every NOT COVERED and UNVERIFIED line)

1. **The elevated (UAC) route still runs PowerShell, so the host script is still published and run.** Old
   `host/input-dispatch.ts` decides `usePrivilegedWorker` from `readForegroundIntegrity` and calls
   `callPowerShellElevated` (worker-pool `createElevatedRequests`, `elevated-launcher.ts`, `elevated-program.ts`,
   `elevated-requests.ts`, `session-jobs.ts`), which elevates `powershell.exe` over the hash-checked host script
   (`hostScript.ensure`). The helper already routes a foreground request to a higher-integrity target itself
   (H:host/elevated.rs `decide`/`route`, H:platform/windows/elevated.rs). Owner: s3-31. First: make
   `input-dispatch.ts` send such a request to the helper unchanged (no `callPowerShellElevated`); then delete the
   elevated TS files, `host-script.ts`, `program.ts`, `sources/*` and the `elevated`/`hostScript` wiring in
   `worker-pool.ts`. Until then the PowerShell program is reachable for elevated targets only.
2. **`target_integrity_unknown` refusal.** Old `readForegroundIntegrity` (input-dispatch.ts) refuses a foreground input
   whose target integrity cannot be read ("target_integrity_unknown: foreground input was not sent because the target
   integrity could not be verified"). Rust `decide()` in H:host/elevated.rs treats an unreadable level as a normal
   dispatch. NOT COVERED. Owner: s3-31; place: H:host/elevated.rs (`decide`: a `Refuse` for a foreground delivery whose
   level is None or not known), with a unit test.
3. **Owner-window capture fallback.** Old `capture-pixels.ts` `captureThroughOwner`: a child window whose surface could
   not be read is captured once through its owner, and the attempts carry scope `owner`. Rust `run_plan`
   (H:host/windows.rs) and C:computer_capture.rs have no owner retry. NOT COVERED. Owner: s3-31; place:
   H:host/windows.rs `window_capture` (one retry through `info.owner`, attempts tagged owner).
4. **Reserved OCR budget in captures, zoom of a display frame, arrivals baseline.** `wincu-reaudit.json` lists them as
   still open; the current tree has C:computer_zoom.rs, C:computer_settle.rs (`windows_opened_since_last_action`) and OCR
   code in C:computer_capture.rs, written after that audit. UNVERIFIED: the s3-31 review reads
   `observation/capture-ocr.ts`, `capture-zoom.ts` and `host/window-arrivals.ts` against those three files before the TS
   observation folder goes.
5. **Held keys after a daemon crash.** The receipt lives in the helper and the daemon (reaudit stillOpen); the startup
   sweep (C:computer_backend.rs `sweep_leftover_ledgers`) clears ledgers only. The old worker lost them the same way, so
   this is not a regression; listed so nobody believes it is covered.
6. **The helper's own foreground lock on a panic abort; `SPI_SETFOREGROUNDLOCKTIMEOUT` inside `focus()`** (reaudit
   stillOpen, low): the old C# had the same two windows. Same status as 5.
7. **`bindComputerEnvironmentGuard` in `host/powershell-host.ts`** (deferred-g3.md, s3-23 item 4) goes with the host.
   Rust: C:computer_env.rs and C:computer_user_control.rs `take_over_environment`. Covered; s3-31 deletes the in-process
   guard.
8. **The remote-screen sweep** (`sweepPowerShellScreenHostFiles` in `remote-screen/screen-input-host.ts`) stays until
   x-del-remote-screen decides how long old script and DLL-cache files are still removed; it is not a PowerShell path.
9. **The TS host's Windows input is already read-only.** `worker-pool.ts` `hostRequestScope` marks every request to the
   helper `read_only` except the four releases, so the input dispatch of `powershell-host.ts` cannot move the mouse on
   Windows; the core does all input. s3-31 deletes that dispatch with the host (dead on Windows today).

No other line below is NOT COVERED.

## Parity lines

### CursorTheme.cs, input-guard.ps1 (cursor), pointer-hold.ts
| Old behaviour | Old place | Rust |
|---|---|---|
| Every system cursor role replaced by a transparent 32x32 cursor (14 roles) | CursorTheme.cs CreateCursor, SetSystemCursor | H:platform/windows/cursor_theme/lease.rs |
| Lease: back up all roles first, restore in reverse order, reload scheme last, fail closed | MixCursorThemeLease | H:cursor_theme/lease.rs |
| Independent watchdog outside the job, one per desktop session, line protocol | LaunchDetachedWatchdog | H:cursor_theme/watchdog.rs, cursor_theme.rs `launch` (breakaway child), main.rs `--cursor-watchdog` |
| Watchdog restores after foreign input, parent exit, 60 s, desktop loss; releases input the dead worker owned | CursorTheme.cs observer and ownership | H:watchdog.rs `watch`, `release_input`, `lease_over` |
| `computer_cursor_unavailable` refusal when no theme can be held | Reserve, Complete | H:cursor_theme.rs `reserve`, H:host/cursor.rs `theme_acquire` |
| Reserve in parallel with focus, complete before dispatch, timed as cursor_theme_ms | input-guard.ps1 | H:host/mod.rs foreground_input (ThemeRun) |
| One lease across commands (hold_pointer, input_continues), keepTheme rule | input-guard.ps1 | H:host/cursor.rs `theme_kept`, `theme_finish` |
| `release_cursor_theme`; release_session releases the theme | runtime.ps1 Do-ReleaseCursorTheme | H:host/cursor.rs `release_cursor_theme`, `release_session_state` |
| Hide only when the overlay arrow is presented | input-guard.ps1 decorate | H:host/cursor.rs `theme_decorates` |
| Pointer hold: hidden while the agent thinks, grace, release on another session or user move | host/pointer-hold.ts | C:computer_pointer.rs (target-lease grace), `release_cursor_theme` |
| system_theme_applied / system_theme_restored on replies | input-guard.ps1 | H:host/mod.rs, C:computer_reply.rs, computer_history.rs |
| Pointer progress `@@MIXDOG_POINTER@@`, failed counter, glide wait 140..360 ms at 1.4 px/ms | MixWin32.cs, runtime.ps1 | H:protocol.rs, H:host/input/pointer.rs, C:computer_backend.rs, computer_feedback.rs |
| Overlay arrow drawn by Electron, fed by the core | overlay/cursor-overlay.ts | stays in Electron (s3-21); core feed C:computer_feedback.rs |

### MixForegroundLock.cs, MixWin32Foreground.cs, foreground-lock-host.ts, foreground-lease-thread.cjs
| Old behaviour | Old place | Rust |
|---|---|---|
| LSFW_LOCK with deadline from acquisition, own timer thread | MixForegroundLock Acquire | H:platform/windows/foreground_lock.rs |
| Unlock outcomes released/unknown/failed/noack, 3 attempts 10 ms apart | MixForegroundLock | H:foreground_lock.rs `ReleaseOutcome`, `UnlockError` |
| Cross-process QPC clock | MixLeaseClock | H:foreground_lock.rs `lease_now_ms`, H:lease_api.rs |
| Host lease channel `@@MIXDOG_FGLOCK@@` and reply, relay, validation | MixForegroundLock, foreground-lock-host.ts | H:host/lease.rs, H:protocol.rs, C:computer_lease.rs |
| Stdin pump so lease answers reach a blocked request thread | MixWorkerInput | H:host/stdin.rs `Router`, `pump` |
| Lease owner thread (max hold 1000 ms, quarantine) | foreground-lease-thread.cjs | stays in the desktop (host/computer-lease.ts); Rust asks it through H:host/lease.rs |
| Self-activation shield (WinUI, UWP, Chromium) with a ledger record before disabling | MixWin32Keyboard SelfActivatesOnSemanticInput | H:platform/windows/activation_guard.rs `self_activates`, `shield`, `unshield`; H:ledger.rs `record_shield` |
| Guarded one-shot restore of the user's window; skipped when user input superseded | input-semantic.ps1 Restore-UserForeground | H:platform/windows/activation_restore.rs `RestoreOutcome`, `run`, `superseded` |
| Background semantic activation guard around UIA invoke, toggle, set_value, menu | input-semantic.ps1 Invoke-BackgroundWindow | H:activation_guard.rs, H:host/input/mod.rs |
| Foreground activation escalation, InFront check, 120 ms settle, foreground_changed | MixWin32Foreground.cs, input-window.ps1 | H:host/windows.rs `do_focus`, `focus_body`; H:platform/windows/native.rs |
| Refusal when a higher-integrity window holds the foreground (`foreground_unavailable`) | input-guard.ps1 Get-ForegroundRefusal | H:host/mod.rs `foreground_refusal` |
| Pointer-activation holder (target, or the window that kept the foreground) | AssertDragTarget | H:host/mod.rs `Dispatch.holder` |
| foreground_lock facts and activation_protection in replies | MixForegroundLock, runtime.ps1 | H:host/protection.rs, C:computer_reply.rs |
| Cross-session foreground lane (one keyboard, one pointer) | host/command-queue-foreground.ts | C:computer_lane.rs `ForegroundLane` |
| Message-path inactive scope, one 50 ms settle across deliveries, recovery | MixWin32Keyboard scopes | H:platform/windows/background/holds.rs `Scope`, `hold_inactive`, `release_inactive` |
| Session release gives focus back from the restore point | runtime.ps1, input recovery | H:host/input/recovery.rs |

### MixMsaa.cs, BoundedUia.cs, observation.ps1, input-refs.ps1, input-menu.ps1, input-window.ps1
| Old behaviour | Old place | Rust |
|---|---|---|
| MSAA walk, role and state text, role to control-type map | MixMsaa.cs | H:platform/windows/msaa.rs, msaa_element.rs |
| MSAA merge into snapshot and find, 5000 combined limit, source=msaa | observation.ps1 | H:host/semantic/mod.rs, H:a11y.rs |
| Invoke and set_value on MSAA refs, identity and staleness | input-semantic.ps1, input-refs.ps1 | H:msaa_element.rs, H:host/input/ref_tests.rs |
| Password detection, PROTECTED second opinion, focus_masked | input-guard.ps1 Test-FocusMasked | H:msaa.rs `is_protected_input`, H:platform/windows/uia/mod.rs |
| snapshot/find with ref: bound_ref, is_password | observation.ps1 | H:host/semantic/mod.rs, C:mixdog-core-session secret_input/fill.rs |
| Deadline-bounded accessibility reads | BoundedUia.cs | H:platform/windows/bounded.rs `Deadline`, `Bounded` |
| UIA ref validation, rebind, relabel check | input-refs.ps1 | H:platform/windows/uia/rebind.rs, H:host/input/mod.rs |
| set_value guards (Excel refusal, exclusive selection, value-write activators) | input-semantic.ps1 | H:host/semantic/value.rs (`value_write_ignored`) |
| Observable state after native actions | input-semantic.ps1 | H:host/semantic/observable.rs |
| ExpandCollapse leaf invoke rule, focusable text surfaces, access key | input-semantic.ps1, observation.ps1 | H:host/semantic/invoke.rs, H:uia/snapshot.rs |
| window_predicates for verify, accessibility_probe | input-window.ps1, observation.ps1 | H:host/semantic/predicates.rs, H:uia/reads.rs, C:computer_verify.rs |
| MSAA-first menu path, UIA menu walk with protection, Win32 menu (GetMenu, WM_INITMENUPOPUP, WM_COMMAND) | input-menu.ps1 | H:platform/windows/uia/menu.rs `menu`, `msaa_candidate`, `menu_candidates`, `classic_menu`; H:platform/windows/msaa.rs `menu_snapshot` |
| Element marks (element, to_element, ocr marks) | session/element-aliases.ts | H:host/marks.rs, C:computer_marks_draw.rs |
| Capture-level accessibility fold (budget, stalled-provider cache, clipping) | observation/capture-accessibility.ts | C:computer_capture.rs, H:platform/windows/capture_budget.rs |

### InputObservation.cs, InputTransport.cs, TaggedKeys.cs, MixWin32SendInput.cs, MixWin32.cs, MixWin32Keyboard.cs, MixWin32Message.cs
| Old behaviour | Old place | Rust |
|---|---|---|
| Input ledger: ticks, foreign sequence, gap latch, quiet confirmation, resync | MixInputLedger | H:observer.rs (`begin_expected`), H:platform/windows/observe.rs |
| Hooks with process attribution; GetLastInputInfo gap check; reinstall; reasons | InputObservation.cs | H:platform/windows/observe.rs (`HookMonitor`, `input_tick`, `drain`) |
| Observer liveness, fresh generation, "replaced during this action" | Read, ReadFor | H:observer.rs |
| Cross-process monitor receipt (shared memory) for the elevated sender | Local\MixdogInputObservation | H:platform/windows/input.rs, input/receipt.rs |
| Target-scoped action scope, BeginExpected, BeginRestore, AssertContinue | runtime.ps1 Handle | H:observer.rs, H:host/mod.rs |
| input_idle_state reply (ready, reason, desktop_ready, system idle) | runtime.ps1 | H:host/misc.rs, C:computer_user_control.rs, computer_frames.rs |
| Tagged key grammar (groups, repeats, escapes, `~`, 512 cap, Alt+F4 and Win+L refusal) | TaggedKeys.cs | H:keys.rs, C:computer_keys.rs |
| VkKeyScan layout resolution, AltGr | ResolveTextKey | H:platform/windows/layout.rs |
| SendInput key events, host marker in dwExtraInfo, KEYEVENTF_UNICODE text | MixWin32SendInput.cs | H:platform/windows/input.rs |
| Per-glyph guarded typing (user input, foreground, authorization) | SendText | H:host/mod.rs `fg_text`, H:input.rs `text` |
| Checked delivery: partial rollback, delivery vs cleanup codes | InputTransport.Deliver | H:input/receipt.rs `deliver_with` |
| Receipt that outlives the worker, in-flight marker, cross-process mutex, no blind release | InputTransport | H:input/receipt.rs (`Receipt`, `Lock`, `settle`, `release_each`) |
| Foreign key tracking, generic modifiers | RecordForeignKey | H:observer.rs, receipt.rs `accounts_for` |
| Foreground pointer: glide, click family, drag with waypoints, occlusion checks, modifiers | MixWin32Foreground.cs, input-pointer.ps1 | H:host/input/pointer.rs |
| Held pointer button and held keys, per session, released at turn end | input-pointer.ps1, runtime-typing.ps1 | H:host/input/recovery.rs, H:host/mod.rs |
| Background keyboard target = exact native child; select-all and text-end proof | MixWin32Keyboard, runtime-typing.ps1 | H:platform/windows/background/keyboard.rs, H:platform/windows/edit.rs |
| Background key grammar validation and sequence preflight | ParseBackgroundKeys | H:keys.rs, C:computer_act.rs |
| Background dialog-manager refusal (#32770) | input/background-dialog-input.ts | H:platform/windows/background/dialog.rs |
| Background message transport (SendMessageTimeout, `background_blocked_uipi`, release retries) | MixWin32Message.cs | H:background/mod.rs, pointer.rs, holds.rs |
| Background pointer targeting (child walk, WinUI refusal, DPI points, Chromium double click) | MixWin32Message.cs | H:background/pointer.rs, drops.rs |
| Wait with quiet:true (200 ms samples, 3 equal) | quiet-wait.ps1, input-pointer.ps1 | H:host/input/quiet.rs |
| Key chord normalisation, destructive chord and shell-payload guards | input/keyboard.ts, guards.ts | C:computer_keys.rs, computer_policy.rs |
| Frame-bound coordinates, allowed_window_ids, app to exact window | host/input-target.ts | C:computer_targets.rs, H:host/targets.rs |
| Ref point (element centre, "no clickable bounds", occlusion guard), raw x/y to the window at the point, owned popups via allowed_window_ids | input-target.ps1 Get-ElPoint, Get-PointArg, Get-TopWindow | H:host/input/mod.rs `el_point`, `point_arg`; H:platform/windows/uia/element.rs `top_window`; H:host/input/pointer.rs (target_mismatch after focus) |
| Assert-InputTarget (last focus must still be the foreground) | input-target.ps1 | no caller in the old code (dead); nothing to port |

### Ledger, abort cleanup, worker lifecycle (worker-ledgers.ts, inactive-ledger-registry.ts, worker-pool.ts, worker-requests.ts, lifecycle-abort.ts, resident-workers.ts)
| Old behaviour | Old place | Rust |
|---|---|---|
| Journal of WS_EX_NOACTIVATE bits, write-through, no bit without a record | MixWin32InactiveLedger.cs, worker-ledgers.ts | H:platform/windows/ledger.rs |
| Ledger of an exited worker recovered; abort cleanup with MIXDOG_ABORT_LEDGERS, marker required | inactive-ledger-registry.ts, RecoverLedgers | H:abort.rs; C:computer_backend.rs `sweep_leftover_ledgers`, `recover_dead_host` |
| Unexpected worker exit: fail pending, latch uncertain input, cleanup before respawn | host-worker-process.ts watchHostWorker | C:computer_backend.rs, C:computer_user_control.rs `cleanup_unconfirmed` |
| Unconfirmed background-release latch | worker-requests.ts | C:computer_user_control.rs |
| One unpredictable input marker shared by worker and abort cleanup | worker-pool.ts | H:config.rs, C:computer_env.rs |
| Worker caps (8 live, 32 in flight, reader headroom, timeouts, idle retire) | worker-capacity.ts, worker-pool.ts | C:computer_budget.rs, C:computer_backend.rs |
| Stdin EOF releases held input | new in Rust | H:host/mod.rs `release_on_exit` |
| Hidden, contained process launch | host-worker-process.ts | C:computer_backend.rs (owner ComputerHelper job, breakaway only for the watchdog) |

### runtime*.ps1, session.ps1, sequence.ps1, window-capture.ps1, MixWin32Window.cs, MixWin32Process.cs, WindowGraphicsCapture.cs
| Old behaviour | Old place | Rust |
|---|---|---|
| Window rows, list_windows, window_snapshot, related windows, bounds (DWM frame, compositor rect) | MixWin32Window.cs, session.ps1 | H:host/windows.rs, H:platform/windows/native.rs |
| Exclusion of the desktop's own overlay and indicator windows | host/window-reads.ts | C:computer_internal_windows.rs |
| Window resolution by id, title, foreground; app label to window | session.ps1 | H:host/targets.rs |
| window_integrity, accessibility_blocked_by_integrity, UIPI refusals | MixWin32Window.cs | H:host/windows.rs `window_integrity`, H:a11y.rs, H:background/mod.rs |
| move_window, window_state, close_window (WM_CLOSE), terminate_process | runtime-window.ps1 | H:host/windows.rs |
| launch (catalogue, packaged activation, shell open, declined UAC = launch_cancelled), list_installed_apps | runtime-window.ps1 | H:platform/windows/shell.rs `launch`, `installed_apps`; H:host/misc.rs |
| list kind=apps and history | input/targeting.ts | C:computer_command.rs, H:host/misc.rs |
| Post-action settle, transition, windows opened since last action | window-transition.ts, window-arrivals.ts | C:computer_settle.rs, C:computer_delta.rs |
| PrintWindow (PW_RENDERFULLCONTENT then 0), WGC capture, ordered plan, black-frame fallthrough | MixWin32Window.cs, window-capture.ps1, capture-source-plan.ts | H:platform/windows/native.rs, wgc.rs; H:host/windows.rs `run_plan` |
| Bounded WinRT waits, capture budget, capture_cleanup, retire on unconfirmed release | session.ps1 Await-WinRt | H:platform/windows/capture_budget.rs; H:host/windows.rs `cleanup_json`; C:computer_capture.rs |
| Frame quality judgement, fit to model budget, JPEG quality, frame ids | frame-quality.ts, capture-source-plan.ts | H:host/frame_quality.rs, frame.rs; C:computer_frames.rs, computer_capture.rs |
| Backend memory (last winner first, 120 s, 64 entries) | capture-backend-memory.ts | H:host/windows.rs `remember_backend` |
| Capture attempts log, pixel_unavailable, image_unchanged | capture-source-attempt.ts, capture-image-dedup.ts | C:computer_history.rs, computer_act.rs, computer_capture.rs |
| Owner fallback for an unreadable child | capture-pixels.ts | NOT COVERED (item 3) |
| Zoom of a frame region | capture-zoom.ts | C:computer_zoom.rs (display-frame case UNVERIFIED, item 4) |
| Screen (display) capture, per-monitor DPI | screenshot-target.ts | C:computer_pixels.rs, computer_screen.rs; H:platform/windows/mod.rs |
| OCR (ocr_image, ocr_status), upscale rule, language | runtime-ocr-clipboard.ps1 | H:platform/windows/shell.rs `ocr`, `ocr_status`; C:computer_ocr.rs |
| Clipboard read, write, clear with read-back | runtime-ocr-clipboard.ps1 | H:shell.rs `clipboard_read`, `clipboard_write` |
| process_fate bound to creation time | MixWin32Process.cs | H:platform/windows/process.rs `fate`, `creation_time` |
| input_recovery_state, restore_input_state, release_held_input, release_session | runtime-recovery.ps1, runtime.ps1 | H:host/input/recovery.rs, H:host/mod.rs |
| retain_refs, sequence_step envelope, release_sequence_holds | runtime.ps1, sequence.ps1 | H:host/mod.rs, C:computer_act.rs |
| Sequence runner (1..6 steps, 10 s of waits, stale_target, preflight) | host/sequence-runner.ts | C:computer_act.rs, computer_desktop_host.rs |
| Authorization settings and policy (authorization.ps1, allowElevatedInput) | host/authorization-settings.ts, execution-policy.ts | C:computer_policy.rs |
| Process start-up: DPI, COM, ownership table, observer ready before the first request | session.ps1 | H:platform/windows/mod.rs, H:host/mod.rs |
| Assembly compile cache, warm worker | host-script.ts | not needed (native binary); old cache swept by screen-input-host |

### runtime-saved-login.ps1, MixWin32Process.cs (Authenticode), saved-login.ts
| Old behaviour | Old place | Rust |
|---|---|---|
| saved_login_check and saved_login_type, no value in replies | runtime.ps1, runtime-saved-login.ps1 | H:host/saved_login.rs; C:mixdog-core-session secret_input/saved_login_host.rs |
| Browser window identification and refusals (Chrome and Edge only, widget class) | Assert-SavedLoginBrowser | H:host/saved_login.rs `browser_refusal`, `vendor_of` |
| Authenticode-verified image, process start-time binding | VerifiedProcessImage | H:platform/windows/saved_login.rs `authenticode_valid`, `signer_organization`, `verified_image`, `start_time`; H:host `verified_start` |
| Focused field target and rules, document resolution, address bars, HTTPS origin | Get-SavedLogin* | H:host/saved_login.rs `field_refusal`, `page_url`, `origin_of`, `address_bar_shows`, `assert_address_bars` |
| Change detection, single direct ValuePattern write, no keystroke fallback | Get-SavedLoginChange | H:host/saved_login.rs `change`, `value_refusal` |
| Elevated browser never goes through UAC | input-dispatch.ts | H:host/elevated.rs `ALLOWED_ACTIONS` has no saved-login action |
| fill_saved_login admission, turn scoping, pixel guard on every capture path | host/bridge-server-request.ts, saved-login.ts | C:mixdog-core-session secret_input/saved_login.rs, computer.rs |

### Elevated bootstrap (elevated-launcher.ts, elevated-program.ts, elevated-requests.ts, session-jobs.ts)
| Old behaviour | Old place | Rust |
|---|---|---|
| One-shot UAC-elevated worker, consented supervisor | elevated-launcher.ts | H:platform/windows/elevated.rs `launch`, `start` |
| Token nonce, SHA-256 of the staged request, authenticated reply | elevated-program.ts | H:elevated.rs `new_token`, `sha256_hex`, `read_response`, `same_identity` |
| Request allow-list, pre-UAC refusals (policy denial, ref unsupported) | elevated-program.ts, execution-policy.ts | H:host/elevated.rs `ALLOWED_ACTIONS`, `validate`, `decide` |
| 120 s deadline, cancel file, 6 s grace, unconfirmed stop | elevated-launcher.ts | H:elevated.rs `wait`, `CANCEL_FILE`, `missing_response` |
| Release of held input from the elevated side | elevated-program.ts | H:elevated.rs supervisor, H:input/receipt.rs |
| Reply annotation `uac_elevated_<path>` and privilege object | input-dispatch.ts | H:host/elevated.rs |
| Session bookkeeping for elevated runs (pending, unconfirmed-stop latch) | session-jobs.ts | C:computer_recovery.rs, C:computer_user_control.rs |
| Running the elevated route from the TS host | input-dispatch.ts, elevated-*.ts | NOT COVERED (item 1): still PowerShell |
| `target_integrity_unknown` refusal | input-dispatch.ts | NOT COVERED (item 2) |
| Windows permission report (input `target_integrity_dependent`) | host/permission-reads.ts | C:computer_diagnose.rs; mixdog-app-protocol v2/computer_host.rs |

### The remote-screen input host (remote-screen/screen-input-host.ts and the former screen PowerShell program)
| Old behaviour | Old place | Rust |
|---|---|---|
| Input on the phone's behalf, also on the UAC prompt and sign-in screen | screen-input-host.ts, secure-desktop-* | H:screen_input.rs, H:platform/windows/screen_input.rs |
| Release of held keys and buttons on `q` and stdin EOF | screen input program | H:platform/windows/screen_input.rs |
| Sweep of the old script and DLL cache | screen-input-host.ts | stays (item 8); now unconditional |

### Packaging and gating
| Old behaviour | Old place | Rust |
|---|---|---|
| Backend program shipped in the package, located at run time | host-script.ts, native-host.ts | apps/desktop/scripts/prepare-runtime.mjs, electron-builder.yml, C:mixdog-core run_host/native_tools.rs (`MIXDOG_COMPUTER_BIN`) |
| Feature gate and observation-only mode | host/index.ts | C:mixdog-app-server-daemon computer_gate.rs, compose_computer.rs |
| Upper bound on resident processes | worker-capacity.ts | C:computer_budget.rs |
