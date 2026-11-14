# Windows Computer Use: manual run sheet

Run on a **dedicated test machine** (S48-style: a second user session or a spare PC with a tester-owned sentinel window), never on a desktop in use. Nothing in the automated suites drives a real desktop; every step below does. Use a release build of `mixdog-computer.exe` installed by the NSIS package unless a step says otherwise. Record pass or fail and the reply text for each step.

Before starting: 150% DPI primary monitor plus a second monitor, a German keyboard layout available, Notepad, Character Map, regedit, Paint, Windows Settings, Chrome and Edge installed, a Korean-locale machine for the MSAA role-text step, and an elevated Task Manager.

The core now sends `MIXDOG_COMPUTER_INACTIVE_LEDGER` to every helper run (resident and `--abort-cleanup`) and `MIXDOG_COMPUTER_HOST_FOREGROUND_LOCK=1` when the desktop owns a foreground lease; the foreground-lock and abort sections below verify those two.

## Package and host

### 1. package-windows-helper — Ship mixdog-computer.exe in the Windows package and point MIXDOG_COMPUTER_BIN at it

Build and install the NSIS package on a test machine. Check that resources/native-tools/mixdog-computer.exe exists and is Authenticode-signed, and that mixdogd uses it: computer diagnose answers, and the process list shows mixdog-computer.exe.

### 2. desktop-host-native-helper — Desktop computer host on Windows uses mixdog-computer.exe instead of PowerShell

On a test machine: a screen capture from the phone/remote picker works with no powershell.exe process started; Task Manager shows mixdog-computer.exe under the desktop.

## Keys and foreground input

### 3. keys-layout-parity — Key grammar parity tests and keyboard-layout-aware chord resolution (VkKeyScanExW)

On a test machine with a German layout: foreground key '^/' and '^@' into Notepad or VS Code, and confirm the intended shortcut fires.

### 4. foreground-dispatch-guards — Foreground dispatch guards: per-glyph text guard, activation holder, elevated-holder refusal, focus settle, exact cursor, press asserts, restore point

On a test machine:
- foreground-type 2000 characters into Notepad and move the mouse midway: typing stops within one glyph;
- with elevated Task Manager in front, a foreground click into Notepad is refused with the explanation;
- click a small checkbox on a 150% DPI monitor.

### 5. input-transport-receipt — Checked SendInput delivery, ownership receipt state machine, person-held key tracking

On a test machine: key_down '{SHIFT}', hold Left Shift physically, then key_up. Expect input_cleanup_unconfirmed and Shift held until you lift it.

### 6. input-observation-integrity — Input observation integrity: gap detection, hook reinstall, drain before read, target relevance, reasons

On a test machine: start a long foreground type, then open a UAC prompt or lock and unlock the screen. The observer reports input_gap and input stops until quiet. With a debug-frozen hook thread, reads report monitor_unresponsive.

### 7. core-keys-guards — Core: key chord normalisation and destructive-input guards

On a test machine: act key 'ctrl+a' then 'delete' in Notepad clears the text; 'shift+delete' is refused.

### 8. core-policy-targets-diagnose — Core: Observation-only enforcement, app-to-window resolution, Windows diagnose report

On a test machine: turn on Observation only in Settings and ask for a click. It is refused and nothing moves.

## Foreground lock and lane

### 9. foreground-lock-own — Helper-owned foreground lock: LSFW_LOCK with deadline thread, unlock outcomes, QPC lease clock

On a test machine: record whether LSFW_LOCK is granted to the background helper (usually refused). When it is granted, a fixture process's SetForegroundWindow fails inside the hold and works after it, and pressing Alt lifts the lock early (release=unknown).

### 10. core-lease-relay — Core relay of foreground-lease requests to the desktop's lease owner

On a test machine, while the user is in a Mixdog window (after integration flips the gate): the helper is refused, the host grants (facts holder=host, host.answer=locked), a self-activating target's SetForegroundWindow is refused, and the helper -> host -> helper round trip is well under 250 ms.

### 11. core-foreground-lane — Core: cross-session foreground lane with recapture-required refusal

On a test machine: two agents acting on one desktop at the same time; the second is told to recapture.

### 12. activation-guard — Background semantic activation guard: hold through steal watch, foreground lock or host lease, self-activation shield

On a test machine (S48-style), with a tester-owned sentinel window in front and keys typed into it: run background invoke, set_value and toggle on an Electron app, Windows Settings (XAML) and Paint (WinUI 3). Sample the foreground: at most one excursion of 400 ms or less, restored once, and no keystrokes lost to the target.

### 13. activation-restore-report — Guarded one-shot restore of the user's window and reporting of unprotected delivery

On a test machine: type in your own window during a background invoke, and the window is still restored. Click elsewhere instead, and the restore is skipped.

## Window capture (WGC) and images

### 14. wgc-capture-backend — Windows.Graphics.Capture backend for one exact window

On a test machine only:
- a window covered by a topmost window is captured without foreign pixels, the foreground is unchanged, and two captures are pixel-identical (window-graphics-capture.electron.test.mjs:90-170);
- the yellow border shows and the cursor is absent;
- a Chromium/Electron window that PrintWindow renders black comes through;
- a resize during capture gives capture_geometry_changed;
- a High-IL target gives capture_denied;
- at 150% DPI the item size equals the DWM bounds.

### 15. capture-plan-budget-cleanup — Window capture plan (PrintWindow, frame quality, WGC), work budget, bounded WinRT waits, cleanup reporting and retire

On a test machine:
- capture a deliberately hung fixture window: the reply comes in about 2 s and the plan falls to WGC;
- an Electron window that PrintWindow renders black comes through WGC with capture_attempts listing both.

### 16. core-capture-flow — Core: window capture flow with bounded snapshot, frame issuance, observed-input binding, timeouts and cleanup retire

On a test machine: capture a large Chromium window (bounded skip) and a stalled-provider fixture (answers in about 2 s), then click by the issued frame_id.

### 17. capture-image-output — Capture image output: fit to budget, JPEG via WIC, region crop for zoom, OCR on the unfitted frame

On a test machine: capture a 4K window. The image is at most 1280 wide and coordinates map back correctly; a zoom of a small region is sharp.

### 18. core-zoom — Core: capture mode=zoom over a stored frame

On a test machine: zoom into a small toolbar of a captured window, then click by the zoom frame's coordinates.

### 19. core-capture-ocr — Core: OCR lines in captures and ocr:<frame>:<mark> element aliases

On a test machine: capture a canvas-only app with include_ocr, then click 'ocr:<frame>:<n>'.

### 20. core-frames-targeting — Core: frame store, frame-bound coordinates to physical pixels, allowed_window_ids, observed-input binding

On a test machine: capture Notepad on a 150% DPI monitor and click a menu item by frame coordinates.

## MSAA and UI Automation

### 21. msaa-walk — MSAA (IAccessible) tree walk, role/state text, role map, PROTECTED probe

On a test machine: snapshot Character Map, the Run dialog and regedit, and compare names, roles, states and bounds with the PS MixMsaa output. Repeat on a Korean-locale machine for the localized role text.

### 22. msaa-enrichment — MSAA enrichment of snapshot/find, MsaaElement read side and ref identity

On a test machine:
- a Character Map snapshot shows source=msaa buttons and edits;
- Explorer details-view items carry their column text;
- a bounded Chrome capture prints the skip warning;
- an old ref after Character Map relabels its grid is refused.

### 23. msaa-menu — MSAA-first menu path resolution (msaa_menu)

On a test machine: a legacy app with owner-drawn popup menus is driven by path.

### 24. msaa-semantic-actions — Semantic actions on MSAA refs, observable native state, uia_* path names

On a test machine:
- background-invoke Character Map's Select and Copy;
- set a legacy Win32 edit through MSAA;
- background-click a classic checkbox: state_changed true.

### 25. set-value-guards — set_value guards (Excel, exclusive selection, value-write activators) and keyboard value replacement with edit proofs

On a test machine:
- Explorer rename with 2 files selected is refused;
- an Excel cell is refused with the guidance;
- a Settings text box that raises itself on SetValue;
- set_value on WordPad (RichEdit) and a classic Edit.

### 26. ref-validation — UIA ref validation: live top window, relabel check, Win32 edit exemption, rebind, continuation checks

On a test machine:
- a React page in Chrome that re-renders a button (rebind);
- Notepad's edit, whose name follows its text;
- an owned modal dialog reached through the owner's snapshot.

### 27. snapshot-reads-masking — Snapshot reads: bound_ref/is_password, text surfaces, access_key, marks, integrity order, MSAA masking, LeafNode

On a test machine:
- a saved-login fill into a 6-box OTP form;
- a WinForms UseSystemPasswordChar box gives focus_masked=true;
- Windows Terminal and conhost snapshots show the buffer;
- a regedit leaf key invoked by ref.

### 28. predicates-probe — Window predicate reads (TrueCondition, per-line text, MSAA append) and FindFirst accessibility probe

On a test machine:
- verify absent/present against a dialog with a ToolTip and against earlier terminal history lines;
- diagnose on Character Map returns interactive with source msaa (after msaa-walk lands).

### 29. bounded-uia-reads — Deadline-bounded accessibility reads on an MTA worker thread

On a test machine: a fixture window whose WM_GETOBJECT handler sleeps 30 s. Capture returns computer_command_timeout in about 2 s, and the next command works without a helper restart.

### 30. core-verify — Core: verify as a polling predicate evaluation with a verdict

On a test machine: type into Notepad, then verify present:'hello' and title_contains:'Notepad'. verify absent for text that is there times out as unsatisfied.

## Background holds and delivery

### 31. background-holds-scopes — Background no-activate holds: ledger, scopes across click+text and sequence steps, recovery, abort replay, protection annotation

On a test machine:
- background-type into a Win32 Edit while another app is in front: the target never comes forward, and there is at most one restore with no bounce between click and text;
- kill the helper during a hold, then run --abort-cleanup: the target can be activated again.

### 32. background-keyboard-routing — Background keyboard to the ref's exact native child; type routing without value replacement or SetFocus

On a test machine:
- a WinForms dialog with two TextBoxes and focus in #1: background key 'abc' with the ref of #2 lands in #2;
- background type 'X' into a Notepad Edit holding 'abc' gives 'abcX';
- a Chrome input is refused rather than value-replaced.

### 33. background-preflight-dialog — Background key grammar preflight before any step, dialog-manager refusal

On a test machine:
- act [click, key '^c'] in background against a Tk app is refused before the click;
- background {ENTER} to Notepad's 'Save changes?' dialog while another window is focused is refused.

### 34. held-pointer-session-release — Held background pointer button kept no-activate, release retry, visible focus home, session hand-off

On a test machine:
- background mouse_down on a scrollbar, wait, mouse_up: the window never comes forward;
- two sessions ending in either order;
- the Start menu open when a session began.

### 35. misc-actions-targets — App target resolution, element marks, quiet wait, list kind=apps, launch matching, process_fate

On a test machine:
- with Explorer in front and Notepad behind it, window close with app 'Notepad' closes Notepad;
- launch 'Paint' and 'devmgmt.msc'.

### 36. core-sequence-runner — Core: bounded sequence runner for act with per-step rows, stop rules, transitions and holds release

On a test machine: act [click 'Save As', type 'name', key '{ENTER}'] in Notepad stops at target_transition, and the capture shows the Save As dialog.

### 37. core-settle-arrivals — Core: post-action settle, window transitions, dialog watch, launch successor, window arrivals

On a test machine: launch 'notepad' returns the new window_id; a menu command that opens a dialog names it.

## Elevated worker

### 38. uac-elevated-worker — UAC-consented one-shot elevated helper for foreground input into higher-integrity windows

On a test machine:
- foreground-type into an elevated Notepad: the UAC prompt appears, and the text lands after consent;
- declining gives privileged_worker_cancelled;
- a ref-based click is refused before any prompt.

## Saved login

### 39. saved-login-worker — Saved-login check and type in the helper, and core routing of the fill steps to it

On a test machine:
- fill a saved login into a Chrome login page and an Edge login page;
- an http page is refused;
- Brave is refused;
- changing the focused field between check and type gives saved_login_changed.

## Cursor presentation and overlay

### 40. cursor-presentation — Agent cursor presentation: pointer-feedback relay to the desktop overlay and the transparent system cursor theme

On a test machine with the overlay on: during a foreground glide the real pointer is hidden and the overlay arrow moves. Kill the helper mid-glide: the cursor scheme comes back. With the overlay off, the real pointer stays visible.

### 41. core-internal-windows — Core: hide Mixdog's own overlay, pill and indicator windows from lists, targets and transitions

On a test machine, with the overlay visible: list_windows does not show it, and a click that shows the pill reports no dialog transition.

### 42. core-user-control — Core: user-control yield, wait_for_user, desktop-wide takeover after input_cleanup_unconfirmed, pill resume

On a test machine: type during a foreground act. The reply says yielded, and wait_for_user returns once you stop typing; the pill Resume resumes a manual takeover.

## Abort and ownership survival

### 43. ownership-survival-abort — Ownership receipt survives the helper; no blind release; abort restores pointer and focus

On a test machine:
- key_down '{F24}' or 'a' into Notepad, trigger Stop (the helper is killed): the key is up afterwards;
- physically hold Ctrl during Stop: it is not released;
- cancel a foreground click mid-glide: the pointer returns and the previous window regains focus.

## Sign-off sweep

After the sections above, with one session active: trigger Stop from the pill, then confirm that no key or mouse button stays down, the cursor scheme is restored, no window stays inactive (activate each target by hand), and no `mixdog-computer.exe` or `powershell.exe` child of the daemon remains.
