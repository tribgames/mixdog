# DESKTOP-WIRE-G2: fragment lines not applied, and what carries over from G1

Every line of the four G2 desktop fragments (s2b-electron-host, s3-fglease-rust, s3-hold-fixes, x-jitter-dev-split)
was applied (see the DESKTOP-WIRE-G2 commits); the fragments are deleted.

## Carried over from deferred-g1.md: s2a-ts-host-extras preload half (unblocked by DESKTOP-WIRE-G5, G5)

The mapping G1 waited for now exists: preload/host-api.ts (s2a-ts-preload-host-api) builds the four extras of
`window.mixdogDesktopHost` on DESKTOP_IPC.enableAllowAllActions/observeSignIn/pcQuotaInvoke/pcQuotaRead, the channels
main/ipc-host-extras.ts registers (observeSignIn sent as (request, value)); HOST_EXTRA_IPC's four unused duplicate
channels were dropped in G2. Still not applied: preload/index.ts exposing `mixdogDesktopHost` through
createHostApi({invokeIpc, subscribeIpc, ipcRenderer, webUtils, browserTexture: createBrowserTextureBridge()}). That is the
G5 switch (DESKTOP-WIRE-G5: "preload exposes mixdogDesktopHost and mixdogCorePort, mixdogDesktop only under
MIXDOG_DESKTOP_IPC_LANE=1"): exposing it now beside the full mixdogDesktop would run two copies of the held
notification-open and desktop-notice listeners and a second browser texture bridge in every window.
Consumer note for s2a-ts-api-capabilities (G4): DesktopHostExtras types the PC quota results as non-null, but main
answers null for a call that is not the PC's quota; null means "send to the window's own host".

## Unblocked in G2.5: the claim's askpass `resources` (DESKTOP-WIRE, next desktop wiring)

t-s2b-packaging and t-g25-fu-pkg are merged: stage-core.mjs stages mixdog-askpass beside mixdogd, and the stage-mixdogd action,
linux-build-core-old-glibc.sh, dev-update-windows.ps1 and dev-update-mac.sh build and carry it. The claim's `resources`
(askpass helper path) is still not sent by this desktop; no G2.5 fragment carried that line, so it stays with the next
DESKTOP-WIRE task.

## Not applied: s3-15.wire (core fragment), its desktop section (unblocked by DESKTOP-WIRE-G4, G4)

native/core/crates/pending-wire/s3-15.wire ends with desktop lines marked "after wiring, s3-26": drop the
applyGnomeExtensionSetting call and import from main/index.ts applyComputerControlSetting and delete
computer/host/gnome-extension.ts and its test. s3-26 and DESKTOP-WIRE-G4 own that switch (G4). Until then both the
desktop and, once the core wiring applies the s3-15 compose_flip call, the core keep the extension in line with
computerControl; each step is idempotent, so the overlap changes nothing for the user.

## Applied from a protocol fragment

native/core/crates/mixdog-app-protocol/pending-rows/s3-10.rows line 10 (desktop line): readDisplays answers x and y
from nativeDisplayGeometry (computer/host/display-reads.ts).

## Notes for later tasks (not fragment lines)

- `host/window/*` is always served and the `windows` capability always declared; `host/window/closed` is sent only for a
  window the core opened through host/window/open (a core without the connections service opens none). Since
  g9-compose-connections host/window/open makes a ServerWindowRecord and its window; the service connection of the window
  (DesktopConnection with `throughPcCore`) dials where this PC's core says the server's tunnel ends.
- windowFocus `sessionId` is the first session screen-sessions.ts reports for a window and, as isSessionOnScreen, only
  while the window is up and focused (the entry carries one session; a split pane shows more).
- `report` of WindowHostDeps is built in host/index.ts from the host connection (host/state/set as a request,
  host/window/closed as a notification), not in main/index.ts as the fragment wrote it.
- window-mica.ts and foreground-lock-host.ts each process.dlopen mixdog_window.node (s3-fglease-rust review): one shared
  loader exported from window-mica.ts would remove the duplicate registration.
- native/mixdog-window/Cargo.toml (napi4 for ThreadsafeFunction) and cargo test there are the core/native wiring's lines
  of s3-fglease-rust.wire, not desktop lines.
- appInput answer contract (s3-09.wire as amended by g25-fu-cu-a, applied to the core by G2.5-WIRE; the desktop handler is
  s3-21's, none exists yet): answer `{delivered, effect: delivered|not_editable|click_unconfirmed|window_gone|refused,
  evidence?, cursor?, presses?, pid?, code?, text?, deliveryAccepted?, inputMayHaveExecuted?}`; `presses` (key steps) and
  `pid` (renderer process) ride a delivered answer; `click_unconfirmed` is the preparatory click of a `type` not confirmed
  (`preparatoryClickFailure`, `code` default `typing_target_unconfirmed`, `deliveryAccepted: false`); only key, type and
  scroll steps are routed (no click/move op). Per-step re-authorization (`authorizeDispatch`) and the unmappable-key refusal
  (`electronKeyPresses`, `background_unsupported`) are s3-18's preflight plus this handler.
