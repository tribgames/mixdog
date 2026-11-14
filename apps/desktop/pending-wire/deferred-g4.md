# DESKTOP-WIRE-G4: fragment lines not applied, and what carries over from G1-G3

Applied (see the G4-WIRE commits): s1-page-virtual-client (route localPageAssetType, its route test case, frame-src names only the
core page origin, the visualize test fakes of items 4 and 5, the client input corpus), s3-26 (registerComputerHost of register-s3.ts
in host/index.ts with stopComputer on close; the presence mirror built before the host in desktop-host-wiring.ts; index.ts computer
wiring, bindCoreComputerEnvironment / coreDrivesComputer / computerUseCoordinator imports gone, the pill controls take the mirror,
computerUseOnWindow reads the mirror, the s3-15 desktop section: applyGnomeExtensionSetting dropped and gnome-extension.ts + test
deleted), s4-engine-reply (facts.ts sends dismissedDialog.reason), x-desktop-adopt (adoptProfileIfBehind after each attach of the
local core), x-residual-moves-client (fonts, attachment read, workflow-config record; the four files and their tests deleted),
x-rs-desktop-pet-client (createDesktopPet gets call/reportError, no prefsPath). From the older lists: deferred-g2/g3 s3-15 desktop
section, deferred-g3 s3-20 item 4 (computerUseOnWindow), s3-21 (showCursor through the presence mirror), s1-page-virtual (frame-src),
x-residual-moves and the x-rs-desktop-pet-client placement line. Every G4 fragment file is deleted.

No fragment line asked for an environment switch or setting between two implementations. (s3-26 item 3c first tied the TS computer
host to `desktop.computerBackend`; its review rewrote it: the TS host is created as before, with no setting tied to it.)

## s2a-ts-api-terminal -> DESKTOP-WIRE-G5 (G5, the renderer's switch to the direct core lane)

- Registration: the renderer api composer spreads createTerminalApi(ctx) from apps/desktop/src/renderer/core-direct/api-terminal.ts
  for DIRECT_KEYS.terminal, one call per window connection. No composer exists yet (s2b-renderer-api built the connections api
  only), and the renderer's switch to the direct lane is wave 5: wiring it now would put a second terminal lane beside main's IPC.
- For s2a-del-terminal (not a wiring line): api-terminal.ts imports TerminalDataBufferer from src/main/terminal-data-buffer.ts. The
  task that deletes the main terminal IPC must move terminal-data-buffer.ts (and its test) out of main, not delete it, and fix that
  import. Review note: main also pushes DESKTOP_IPC.terminalRunRequested from its own terminal loopback bridge; the direct api
  listens only to the core's ui/openRequested {kind: terminal}: G5 confirms the core announces it or keeps that push.

## s3-26 item 4 / deferred-g3 s3-22 -> DESKTOP-WIRE-G5 (G5)

`ComputerHostWiring.pixels.blobChunkBytes: () => limits.maxBlobPutChunkBytes`: the host connection (host/connection.ts over
createHostConnection(protocol)) still does not carry the initialize answer; without it every chunk is 96 KiB, under every core's
limit. Unblocked when the host connection exposes the initialize limits (the direct-lane work of G5 or later).

## Optional, not applied (s3-26 item 1)

host/computer.ts may rename its export registerComputerHost to registerComputerHandlers now that index.ts no longer imports it
(register-s3.ts imports it under that alias). Cosmetic; left for the task that next edits host/computer.ts.

## x-residual-moves-client: what was left as the fragment allowed

- DesktopService `readSessionHistory` / `readSessionTranscript?` (desktop-service-contract.ts, desktop-service-client.ts, the
  SERVICE_OPERATION list) are kept: the service-route still names them and dropping them is the deletion task's (s2a-del-*) call.
- benchmarks/rust-core/recorders/record-session-history-boundary-cases.mjs still loads the deleted main/session-attachments.ts:
  the recorder's owner moves it to the core's desktop/attachment/resolve (not a test the suites run).

## Carried over unchanged (reason and wave as before)

- deferred-g3 s3-23 item 4: bindComputerEnvironmentGuard (computer/host/powershell-host.ts) goes with the PowerShell stack's deletion
  (s3-31; ownerDirection.windowsComputerOnePath: no longer gated on s3-30).
- deferred-g3 s3-21 protocol note (HostComputerAppInputResult fields): protocol lead.
- deferred-g2/g3 s2a-ts-host-extras preload half and the claim's `resources` (askpass helper): DESKTOP-WIRE-G5.
- deferred-g3 x-pcaccess-desktop / g35-fu-x pcAccess leftover: x-screen-source-desktop / DESKTOP-WIRE-G8.
- deferred-g3 s4-host-* and g35-fu-host lines: s4-wire-desktop (G6) / DESKTOP-WIRE-G7 (the capability is declared from what the
  connected core serves, never from MIXDOG_BROWSER_ENGINE).
- The notes of deferred-g1/g2/g3 (windowFocus sessionId, the shared mixdog_window.node loader, native Cargo lines, the
  appInput answer contract, onSurfaceRequest leftovers) stand.
