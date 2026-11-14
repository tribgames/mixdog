# DESKTOP-WIRE-G5: fragment lines not applied, and what carries over

Applied (see the G5-WIRE commits):

- DESKTOP-WIRE-G5, the renderer switch. main/index.ts creates the CorePortRelay (endpointFor: the window's own connection is
  slot `primary`, a server window also gets slot `pc` to this PC's core, both with role `main` or `server:<connectionId>`;
  coreWindowScope from this PC's core's initialize reply; closeAll on system resume; dispose on quit). ipc.ts registers
  `mixdog:core-port:open` (CORE_PORT_OPEN_CHANNEL) per window. preload/index.ts exposes only `mixdogDesktopHost` (createHostApi plus
  the bootContext and connection launch values) and `mixdogCorePort` (installCorePort). renderer/main.tsx awaits
  installDirectDesktopApi() in the Electron branch, after the language and before the restored-session read and the bootstrap.
  There is no lane switch: no MIXDOG_DESKTOP_IPC_LANE, no setting; the old IPC handlers stay registered for their deletion tasks
  and are simply no longer called by the renderer.
- Kept behaviour across the switch: install.ts wraps the composed API in withApiFileGrantRefresh (the preload did); the core's
  terminal open reaches the window over its own link (main's ui/openRequested terminal relay is now a no-op) while main's own
  agent `terminal` bridge reveals still arrive by IPC through the new host extra `onHostTerminalRunRequested`, and
  `onTerminalRunRequested` listens to both; a deleted session releases its in-app browser pages from the core's `thread/deleted`
  (the old deleteSession IPC handler did it).
- deferred-g4.md: the terminal API registration (install.ts spreads createTerminalApi; the terminalRunRequested push note is
  answered above) and `pixels.blobChunkBytes` (this PC's core's `limits.maxBlobPutChunkBytes` from its initialize reply).
- deferred-g2.md / deferred-g3.md: the s2a-ts-host-extras preload half (mixdogDesktopHost exposed).
- s2a-ts-install.wire (main.tsx and preload), s3-27.wire item 1 (core-transport.ts computer wiring with the presence mirror) and
  its item 2 doc fix (in the protocol), s4-engine-actions-page.wire (page/eval answers `unchanged` when asked with
  `checkUnchanged`; the eval no longer invalidates refs itself), s4-engine-actions-pointer.wire (the `swipe` step in
  input-batch.ts, with its test), s4-engine-actions-observe-nav.wire item 1 (cdp/send serves Page.printToPDF through the page's
  printer inside the visual-output privacy check, inline or as a blob, and Network.getRequestPostData / getResponseBody;
  registerCdpSend takes a CdpSendHost with prepareVisualOutput), g45-fu-rest.wire items 1, 3, 4 and 5 (already in place from
  G4: ipc.ts passes `core` and `pcCore`; nothing left). Every G5 fragment file is deleted.

## Not applied, with the task that takes it

- g45-fu-rest.wire item 2 -> s4-wire-desktop / DESKTOP-WIRE-G7: `registerRefMint(connection, engineCtx)` beside registerRefCall
  and the PENDING entry of host/host-coverage.test.mjs. No engine method is registered on the host connection yet (registerRefCall,
  registerSnapshot, registerPage, registerCdpSend are all still PENDING there). When registerCdpSend is wired it needs
  `{ prepareVisualOutput: screenshots.prepareVisualOutput }` of the browser host.
- s4-engine-actions-observe-nav.wire item 2 (BrowserPageReadOptions `attributes` and `limit` for extract): a protocol and host
  follow-up; `offset` now exists (g45-fu-rest rows), `attributes`/`limit` do not.
- ipc-state-bridge.ts reduction (the plan's DESKTOP-WIRE-G5 text: updater, notices, conversation import progress, resume): not
  done. Its state, session, agent-pool and core-event pushes are the old IPC lane's; their tests (ipc-state-bridge-late-read,
  -resync, -notices) pin them, and the owner's direction keeps the old lane's code until its deletion tasks (s2a-del-*). Nothing
  in the renderer listens to those pushes any more. The resume resend is replaced in effect by corePortRelay.closeAll on resume.
- The claim's `resources` ({serverCoresDir, askpassHelper}, deferred-g3.md): still no core consumer; mixdog-ssh is a member now
  but nothing in mixdogd composes it before the connections service (G9). Moves to DESKTOP-WIRE-G9.
- The capture window (main/capture-window.ts, a test/screenshot harness with a fake host and no core) loads the same preload: it
  no longer has a full window.mixdogDesktop; its renderer's install finds no core port. x-capture-core-client (G6) moves it to a
  core; until then capture runs do not work. No switch was added for it (owner decision).

## Carried over unchanged

- deferred-g4.md: s3-23 item 4 (bindComputerEnvironmentGuard with the PowerShell stack's deletion, s3-31), s3-21 protocol note,
  x-pcaccess-desktop leftovers (G8), s4-host-* lines (G6/G7), the optional registerComputerHost rename, the x-residual-moves-client
  notes (readSessionHistory members, the recorder script).
- The notes of deferred-g1/g2/g3 (windowFocus sessionId, onSurfaceRequest leftovers, appInput answer contract) stand.
- Renderer tests that mock window.mixdogDesktop.ssh* / getConnectionLink (review-s2b-renderer-switch-settings and -window: six
  renderer tests and the settings ssh dialog tests) still need an owner to rewrite them over a fake core client.
