# DESKTOP-WIRE-G7: fragment lines not applied, and what carries over

Applied (commit f822ee476d "G7-WIRE: desktop host serves the browser engine methods ..."):

- s4-wire-desktop.wire items 2, 3 and 5: host/index.ts calls `serveBrowserEngine(connection, () => options.browser().engine,
  { transcript })` at construction, before the command host, and hands `engine.engineMode` to createBrowserCommandHost as its
  fourth argument; DesktopHostOptions.browser() carries `engine: BrowserEnginePorts` (browser/host.ts hostRole() already returned
  it) and DesktopHostOptions gains `browserEngineTranscript?: TranscriptTap`; main/index.ts passes
  `createTranscriptTap({ dir: process.env.MIXDOG_BROWSER_TRANSCRIPT, devBuild: !app.isPackaged })` (a development record of the
  lane's calls, not a choice of implementation). host/host-coverage.test.mjs: every PENDING entry is served now (the 26 engine
  request methods, host/browser/upload/receiver, host/browser/lease/release, host/browser/ref/mint): PENDING is empty.
- g55-fu-engine.wire: nothing to paste; host/browser/upload/receiver is served (no PENDING entry), secret-precondition.test.mjs
  lists the methods from packages/protocol's ServerRequest and passes.
- x-capture-core-client.wire: apps/desktop/src/main/capture-new-task.test.mjs deleted (it imported the removed CaptureService).
- g55-fu-renderer.wire: nothing to apply (notes only, kept below).
- g55-fu-cu-ssh.wire "s2b renderer tests": already done by g55-fu-renderer (711d360b23, the tests drive the components through
  test-support/connections-core-mock.mjs); observed 118/118 pass with --experimental-test-module-mocks.
- From the older lists, now done: deferred-g5 g45-fu-rest item 2 (ref/mint served, PENDING entry gone); deferred-g5
  observe-nav item 2 (attributes/limit, g55-fu-engine); deferred-g5 capture window (x-capture-core-client); deferred-g5 renderer
  ssh tests (g55-fu-renderer); deferred-g3 s4-host-* and g35-fu-host lines (s4-wire-desktop built the context, this wiring calls
  it; g35-fu-host item 4 is partial, see below); deferred-g3 g35-fu-x pet placement (desktop-pet-window.ts no longer imports
  desktop-pet-store.ts).

Every .wire file of this folder is deleted.

## NOT applied: s4-wire-desktop.wire item 1, `browserEngine` in HOST_CAPABILITIES (host/connection.ts)

The line to add, beside `windows: true`, once unblocked:

  // `host/browser/*` engine methods (host/browser-engine/index.ts). A core that does not compose the engine ignores it.
  browserEngine: { version: 1, features: ['inputBatch', 'snapshot', 'lease', 'blob'] },

Reason: the core decides per command from this declaration alone (mixdog-tools desktop/browser_engine.rs runs_in_engine:
`is_action(action) && serves(HostCapability::BrowserEngine)`; mixdog-app-server outgoing.rs serves(): `declared.browser_engine`).
Declaring it moves every Browser Use action of this PC's sessions from the working TypeScript runner to the core engine, which
still lacks behaviour in use today (review-s4-engine-runner, g61; native/core/crates/pending-wire/deferred-g7.md "Browser engine:
what the composition does not carry yet", which says these must be covered before DESKTOP-WIRE-G7 declares the capability):
- `network` with `requestId` is refused (runner.rs network_action, "not available"); the TS runner serves headers, bodies, frames.
- `fill` with `savedAccount` is refused (runner.rs fill_stored, "not available").
- `downloads` with `attach` no longer attaches the file (ToolReply has no file part).
- autoSignIn.afterCommand / linkedSignIn.beforeAction / replyLine hooks are not called.
- no TurnEvents: no turn end reaches the engine and the tool sends no numeric turn, so agent pages are not closed or discarded at
  turn end; and once turns are wired, every background page would count as disposable (TS: agent kind and not keepAlive only).
- failed action on a page the command created does not close the blank page; untouched blank agent page not discarded.
Declaring it now would turn those into refusals or lost behaviour (owner direction: nothing in use today is lost). With the
methods registered and the capability not declared, the core never calls an engine method and keeps using host/browser/command:
behaviour is unchanged.
Unblocked by: a follow-up of s4-engine-runner covering the list above (no task in tasks-v2.json owns it yet; the lead must name
one), plus the turn number the tool sends (s4-engine-runner follow-up / s4-harness-rebase-a). The G8 tasks that need the engine
live in a dev start (s4-harness-rebase-a, s4-harness-rebase-b, s4-latency-gate) depend on this line: they cannot run the engine
path until it is applied. Then add the line above (no env switch) and nothing else: serveBrowserEngine already engages the lane
from the first engine method the core calls.

## Not applied: g55-fu-cu-ssh.wire s3-bridge-forward -> DESKTOP-WIRE-G10 (s3-bridge-forward, G10)

The desktop's bridge `/command` handler still runs Node's own computer host (assertPublicComputerRequest refuses owner_attach and
owner_detach today). When s3-bridge-forward makes `/command` forward to the core's computer/bridge/run, the forward must refuse
`owner_attach` and `owner_detach` with the same 400 `invalid request: invalid_action: computer bridge action is not available`;
`/owner` is the only place that sends them.

## Not applied: x-capture-core-client harness note (no owner task named)

The capture harness must give the capture process MIXDOGD_BIN (the built mixdogd with js-runtime.json beside it, as
scripts/live/lib/instance.mjs prepareCore stages it); startCaptureCore refuses to start without it. src/renderer/capture-ui.mjs
passes `...process.env` through, so a caller that sets MIXDOGD_BIN works; it does not stage one itself. review-x-capture-core-client
open gaps (dictation smoke without a voice runtime, MIXDOG_JITTER_PROBE modes throwing, settings fixtures without a config key)
stay with that task's follow-up.

## g55-fu-renderer notes (kept)

- previewProjectFile stays the host's (preload/host-api.ts, main/ipc-project-files.ts registerPreviewIpc, mixdog-media://preview).
- The main IPC handlers of the channels the renderer no longer calls (DESKTOP_IPC.ssh*, connectionLink*, connectionNotice,
  connectionRetry*, reopenServerWindows*, serverRestoreProgress*, serverPorts*, serverPort*, connectionSignIn) were removed with their
  channel names by g9-compose-connections (main no longer registers them: the core serves the connections methods); listSystemFonts,
  getNotificationPreferences, sendTestNotification stay registered until x-del-notify-ts (G11).

## Carried over unchanged (reason and wave as before)

- deferred-g5: the claim's `resources` ({serverCoresDir, askpassHelper}): g9-compose-connections reads `MIXDOG_SERVER_CORES_DIR` /
  `MIXDOG_ASKPASS_HELPER`, else the `server-cores` folder and the `mixdog-askpass` beside the core's own folder (the packaged layout), in
  the daemon (compose_connections.rs); the claim's `resources` field has still no core reader; ipc-state-bridge.ts reduction -> the
  s2a-del-* deletion tasks (G11).
- deferred-g4: s3-23 item 4 bindComputerEnvironmentGuard -> s3-31; s3-21 protocol note (protocol lead); optional
  registerComputerHost rename; x-residual-moves-client notes (readSessionHistory members, the recorder script).
- deferred-g3 / g35-fu-x: pcAccess leftover in index.ts -> x-screen-source-desktop / DESKTOP-WIRE-G8.
- deferred-g3 g35-fu-host item 4 (review-s4-wire-desktop minor): facts.changed on a page moving to or from the background outside
  setPanelActive/setNativeShown is not sent; matters only once the engine is live (item 1 above); s4-host-type-split (G9) or the
  engine follow-up.
- Notes of deferred-g1/g2 (onSurfaceRequest leftovers and the browserRemoteOpen route for the deletion task, ipc-host-extras.ts
  PcQuotaHost import, host/browser/page no resend on reclaim, windowFocus sessionId, the shared mixdog_window.node loader, native
  Cargo lines) stand.
