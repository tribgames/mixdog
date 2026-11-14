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

## Not applied: depends on t-s2b-packaging (not merged, its review said do not merge)

Nothing in the G2 desktop fragments depends on it. Its own desktop packaging (stage-core.mjs staging mixdog-askpass beside
mixdogd, the stage-mixdogd action, linux-build-core-old-glibc.sh, dev-update-windows.ps1 / dev-update-mac.sh) is not in
the tree; the claim's `resources` (askpass helper path) is therefore not sent by this desktop. Unblocked when s2b-packaging
is reworked and merged (G2 rework or the next packaging slot).

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

- MIXDOG_CORE_WINDOWS=1 gates `host/window/*` (CORE_WINDOWS in host/connection.ts: the capability, registerWindowHost in
  host/index.ts, and so the windowFocus/closed reports). DESKTOP-WIRE-G9 removes the gate; host/window/open builds the
  window from the saved ssh host store until s2b-electron-wiring (G9) replaces DesktopConnection with ServerWindowRecord.
- windowFocus `sessionId` is the first session screen-sessions.ts reports for a window and, as isSessionOnScreen, only
  while the window is up and focused (the entry carries one session; a split pane shows more).
- `report` of WindowHostDeps is built in host/index.ts from the host connection (host/state/set as a request,
  host/window/closed as a notification), not in main/index.ts as the fragment wrote it.
- window-mica.ts and foreground-lock-host.ts each process.dlopen mixdog_window.node (s3-fglease-rust review): one shared
  loader exported from window-mica.ts would remove the duplicate registration.
- native/mixdog-window/Cargo.toml (napi4 for ThreadsafeFunction) and cargo test there are the core/native wiring's lines
  of s3-fglease-rust.wire, not desktop lines.
