# DESKTOP-WIRE-G3: fragment lines not applied, and what carries over from G2

Applied (see the DESKTOP-WIRE-G3 commits): s1-wire-hot (absorbed: createCoreFileGrants in ipc.ts, the core page origin in
index.ts and frame-src, host files().localPageUrl through coreLocalPages; the term-data `reset` field was already in
contract.ts from G1), s1-page-virtual, s3-20, s3-21, s3-22, s3-23, x-notify-switch, x-pcaccess-desktop, and item 1 of
s4-host-secret-precondition. Every fragment file is deleted; the lines below are kept here with their reason and wave.

## Defaults that stay off

- MIXDOG_COMPUTER_HOST_V2=1 (COMPUTER_HOST_V2 in host/connection.ts, `computerHostV2` of DesktopHostOptions) serves
  host/computer/cursorPrepare, appWindows, appInput, pixels, permissions and command and binds bindComputerEnvironment
  (computer/userControl takeover reports). DESKTOP-WIRE-G4 (s3-26) serves them unconditionally and removes the gate.
- MIXDOG_CORE_WINDOWS=1 still gates host/window/* until DESKTOP-WIRE-G9 (unchanged).
- The renderer direct lane (preload mixdogDesktopHost / mixdogCorePort) stays off until DESKTOP-WIRE-G5 (unchanged).

## s3-20 / s3-21 / s3-22 / s3-23: lines for DESKTOP-WIRE-G4 (s3-26, G4)

- s3-20 item 4: `computerUseOnWindow` (index.ts, `computerUseOperates(computerUseCoordinator, ...)`) reads
  `windowIdsWithActiveCommand` from `hostRole.computerPill` once s3-26 takes the legacy host out; until then the legacy
  coordinator is right (the legacy backend delegates to it).
- s3-21: main/index.ts `computerAppInput.showCursor` calls `computerUseCoordinator.showCursor`; replace it with the
  presence overlay's showCursor when s3-26 adds one.
- s3-22 (optional): `blobChunkBytes: () => <limits.maxBlobPutChunkBytes from initialize>` in registerComputerPixels'
  deps. The host connection does not expose the initialize limits; without it every chunk is 96 KiB, under every core's
  limit. Unblocked when the host connection carries the initialize answer (s3-26 or later).
- s3-23 item 4: the in-process bindComputerEnvironmentGuard (computer/host/powershell-host.ts) goes with the legacy path
  (s3-30/s3-31, owner-gated); with MIXDOG_COMPUTER_HOST_V2=1 both report, which is harmless (the core holds only while a
  core computer execution is open).
- s3-21 protocol note (protocol lead, not desktop): HostComputerAppInputResult lacks effect `click_unconfirmed`, `presses`,
  `pid`, `code`, `text`, `deliveryAccepted`, `inputMayHaveExecuted`, and HostComputerAppInputParams lacks `modifiers`
  (computer-app-input.ts types them locally as ComputerAppInputAnswer). No pending-rows fragment was written.
- s3-20 note: host.test.mjs pins the six handlers behind `computerHostV2` (cursorPrepare answers `unavailable` with no
  overlay bound); s3-26 drops the gate and the `computerHostV2: false` half of that test.

## x-pcaccess-desktop: for s3-screen-source / x-screen-source-desktop (G7 / G8)

KEEP windowsPcAccess(), the `pcAccess` variable and the createPcAccess / pendingRevokesFile / PcAccess imports in index.ts:
the phone screen's `pcAccess.approveWithCredential` (createScreenSourceHost options) still calls windowsPcAccess() until the
screen source moves to the core's approve_with_credential; that task deletes them. Until then two installer queues coexist
for the phone password path only.

Protocol (not desktop): operations_map.json lists neither pcAccessReadiness nor pcAccessApprove; the route test keeps them
beside the rooted operations (added after the spec map). An inventory row for them is the protocol wiring's (PROTO-WIRE-G4).

## s1-page-virtual: for s1-page-virtual-client and DESKTOP-WIRE-G4 (G4)

CoreLocalPages.virtualUrl and the localPageVirtualIn route exist now; the callers (visualize host-pane-preview.ts,
host-export-path.ts) still use localVirtualPageUrl of the Electron page server, and frame-src still names its origin beside
the core's. s1-page-virtual-client moves them; DESKTOP-WIRE-G4 drops the Electron origin from frame-src.

## Carried over from deferred-g2.md

- s2a-ts-host-extras preload half (preload exposes `mixdogDesktopHost` through createHostApi): DESKTOP-WIRE-G5 (G5),
  unchanged reason (two copies of the held listeners and a second texture bridge beside the full mixdogDesktop).
- The claim's `resources` ({serverCoresDir, askpassHelper}, HostClaimParams.resources): no core consumer yet. Nothing in
  the daemon reads the claim's resources; mixdog-ssh (SshEnv.askpass_helper / server_cores_dir) becomes a workspace member
  and is composed with the ssh wiring in G5, so the line moves to DESKTOP-WIRE-G5 (askpassHelper = mixdog-askpass[.exe]
  beside the started mixdogd: coreBinaryPath's folder).
- s3-15 desktop section (drop applyGnomeExtensionSetting from index.ts, delete computer/host/gnome-extension.ts and its
  test): DESKTOP-WIRE-G4 (s3-26), unchanged.
- The notes of deferred-g2.md (CORE_WINDOWS until G9, windowFocus sessionId, window-mica / foreground-lock-host shared
  loader, native Cargo lines) stand. The appInput answer contract note is now implemented by s3-21's handler
  (host/computer-app-input.ts).

## s4-host-* fragments: for s4-wire-desktop (G6) and DESKTOP-WIRE-G7 (G7)

Nothing builds an EngineContext yet and the desktop does not declare `browserEngine`: s4-wire-desktop (G6) writes
registerBrowserEngine (host/browser-engine/index.ts) and builds the EngineContext from the browser host, and
DESKTOP-WIRE-G7 calls it from host/index.ts and declares the capability (unless MIXDOG_BROWSER_ENGINE=host). Registering
the handlers or building the facts/events, leases, intercept table or emulation owner now would serve engine methods with
no context, or (intercept table, emulation owner) give the legacy command path a second state nobody reads. The fragment
lines follow verbatim (review corrections included). Applied now: s4-host-secret-precondition item 1 (agent-bridge.ts
forwards `expect: fields.expect` into the secret_fill value; the core sends no `expect` today, so the legacy path is
unchanged).

### s4-host-facts-events

    # s4-host-facts-events: wiring for facts.ts and events.ts (desktop)

    1. Build once per host (where the EngineContext is built, host/index.ts or its wiring module):
         const events = createEngineEvents(connection, {
           nextSeq: (pageId) => state.nextSeq(guestOf(pageId)),
           redact: (pageId, text) => state.redactText(guestOf(pageId), text),
           facts: (pageId) => facts.facts(guestOf(pageId)),
         });
         const facts = createPageFacts({ connection, state, source: { background, visible, popupPageId? },
                                         flushEvents: events.flush });
         bindGuestState(state, facts, events, ctx.isEngineMode);
       EngineContext.events = events (flush, facts). guestOf maps a pageId to its WebContents (the live guest registry).

    2. browser/cdp.ts, createBrowserCdpEventRouter({...}): add
         engine: createEngineEventSink(events, (guest) => state.pageId(guest), ctx.isEngineMode)
       Host mode (isEngineMode false) records locally as before.

    3. Call facts.attach(guest) when a guest page is registered (keep the returned stop for its close),
       and on close: facts.forget(guest); events.drop(pageId).

    4. Call facts.changed(guest) after: pushBounded(state.for(opener).openedPopups, ...) in guest-background-pages.ts
       (popup), and where the page is shown or hidden or moved to the background (visibility, background flag).
       The call sends nothing when the facts did not change.

    5. The registry already flushes before a response through ctx.events.flush.

### s4-host-input-batch

    # s4-host-input-batch: host/browser/input/batch executor

    No HOST_METHOD row: the method is served by name through registerEngineMethod (host/browser-engine/registry.ts).

    main/host/index.ts (where the other engine handlers are registered with the shared EngineContext, after registerEngineMethod users):
      import { registerInputBatch } from './browser-engine/input-batch';
      registerInputBatch(connection, engineContext);

    Behaviour the wiring owes the handler: when the person takes the page while a batch runs, abort that call's signal with
      new HostRpcError(ENGINE_ERROR.userInput, 'the person holds the page', { until })
    as its reason; the batch then answers outcome "userInput" with the steps completed so far. Any other abort is outcome "cancelled".
    The engine context's `cdp` must be the guest CDP (sendCdpInput, call, guestDebugger): the batch builds its input dispatch, hit guard and
    frame-offset resolver from it and from the page state (cdpSessions, pendingDialog, accessibilityRefs, interceptedDrag slots).

    Core: nothing. SERVICE_PENDING: host/browser/input/batch is a host method (served by the desktop), not listed there.

### s4-host-lease

    # s4-host-lease (desktop wiring, applied by the wave's wiring task)

    host/index.ts (where the engine lane is wired, after the EngineContext exists):
      const leases = createLeases(connection, ctx);          // from ./browser-engine/lease
      - pass `engine: { isEngineMode: ctx.isEngineMode, leases }` to createBrowserLocalPageControl (browser/local-page-control.ts)
        at its call site, browser/host.ts (the `browserPageControl:` entry). The browser is built after the host connection,
        so hand it `leases` through the browser's options (or a getter); `leases` belongs to the connection that made it:
        a new connection makes new leases, and the page control must reach the current ones.
      - host/browser/pages/resolve handler: when params.lease is present, `leaseId = leases.acquire(page.pageId, lease.commandId, lease.ttlMs)`
        and return it as `leaseId` in the result (acquire throws the -32012 error while the person holds the page).
      - page closed / session ended: `leases.forget(pageId)`.

    browser-engine/registry.ts (registerEngineMethod, owned by s4-host-scaffold, not edited here): around `handler(fields, signal, call)`
      const engineCall = leases.beginCall(pageId, signal);   // throws -32012 while the person holds the page
      run the handler with engineCall.signal, and call engineCall.end() in the `.finally` beside `ctx.events.flush(pageId)`.
      The -32012 data ({until}) rides the HostRpcError that the abort reason already is.

### s4-host-page-methods

    # s4-host-page-methods (desktop wiring; applied by the wave's wiring task, which deletes this file)

    In apps/desktop/src/main/host/index.ts (or the module that builds the EngineContext, after registerEngineMethod's
    scaffold is wired), beside the other register calls of host/browser-engine, with `connection` and the `ctx: EngineContext`:

      registerPages(connection, ctx, pagesHost);
      registerPage(connection, ctx, pageHost);
      registerCdpSend(connection, ctx);

    imports: registerPages / PagesHost / PageLeases from './browser-engine/pages', registerPage / PageHost from
    './browser-engine/page', registerCdpSend from './browser-engine/cdp-send'.

    pageHost (PageHost) is built from the live browser host:
      store         = the BrowserGuestStateStore (state)
      urls          = createBrowserUrlAdmission({ policy }) of the host (its validatedAgentUrl)
      documents     = the createBrowserDocuments(...) of the host (readPage, extractPage, renderCheckpoint, revision, collect)
      handleDialog  = createBrowserDialogReport(...).handleDialog
      downloadsForSession = partition.downloadLedger.downloadsForSession
      sessionIdOf   = (guest) => sessions.sessionIdForGuest(guest)
      isBackground  = (guest) => Boolean(sessions.backgroundPageForGuest(sessions.sessionIdForGuest(guest) ?? '', guest)) && its kind !== 'user'
      consoleFloor  = (pageId) => the console ledger floor createEngineEvents (s4-host-facts-events) keeps for the page

    pagesHost (PagesHost) = { sessions (BrowserSessionRegistry), tabs (createBrowserTabs(...)), lifecycle
    (createBrowserGuestLifecycle(...): restoreSession, ensureGuest, requestBrowserSurface, revealPage, discardCreatedPage,
    discardUntouchedBlank, recoverCrashedGuest, backgroundEntryByPageId, destroyBackgroundPage), taskLifecycle
    (createBrowserHostTaskLifecycle's task lifecycle: retain), store (same BrowserGuestStateStore), leases (createLeases(...) of
    s4-host-lease: acquire(pageId, commandId, ttlMs) -> leaseId), page: { urls, downloadsForSession, sessionIdOf } of pageHost }.

    host/browser/surface: pages/surface goes through lifecycle.requestBrowserSurface, which notifies the listeners of
    lifecycle.onSurfaceChanged; registerBrowserSurfaceReport(connection, lifecycle) must be registered (it already is for the
    legacy forward path) so the reveal, hide and handoff reach the core as host/browser/surface. Nothing is sent twice.

    The lease a resolve acquires must be released when the connection closes (createLeases does, s4-host-lease).

### s4-host-secret-precondition

    # s4-host-secret-precondition: what the wiring adds (agent-bridge.ts and the host wiring are not this task's files)

    1. (applied by DESKTOP-WIRE-G3: agent-bridge.ts secret_fill forwards `expect: fields.expect`.)

    2. Where the browser host agent is built (createBrowserHostAgent options, host/index.ts or the engine wiring): pass
       `engine: { isEngineMode: ctx.isEngineMode, page: ctx.page, facts: ctx.events.facts }` (type FillEngine, browser/credential-autofill.ts)
       built from the EngineContext. With it, secret_fill and saved_login_type without `expect` are refused -32010 reason "document".
       Without it (no browserEngine capability) `expect` stays optional.

    3. Engine handlers that fill a vault credential (credentialFill / approved submit / upload) call
       `fillGuard(engine, pageId, params.expect)` (credential-autofill.ts) and pass the result as the `guard` argument of
       fillCredentialInGuest (7th) or the `guard` field of fillSecretField's request. fillGuard throws the -32010 refusal when
       engine mode has no `expect`.

### s4-host-session-methods

    # s4-host-session-methods: desktop wiring lines (applied by the wave's desktop wiring task, then this file is deleted)

    No protocol row and no core change: every method already exists in v2/browser_engine.rs and in packages/protocol.
    SERVICE_PENDING is not touched (these are host methods the core calls, not core services).

    ## main/host/index.ts (or the module that builds the EngineContext and registers the engine methods)

      import { registerSession, createInterceptTable } from './browser-engine/session';
      import { registerUpload } from './browser-engine/upload';

      const intercept = createInterceptTable();            // ONE table, shared with the CDP fetch router (below)
      registerSession(connection, engineContext, {
        partitionSession,                                  // host-foundation.ts storage.partition.session
        urlPolicy,                                         // the same getter command-toolkit hands createBrowserPageState
        evaluate,                                          // cdp.evaluate bound as command-toolkit's pageState host does
        invalidateInteractionState,                        // state.invalidateInteraction
        intercept,
        applyFetchPatterns: (guest, signal) => cdp.applyFetchPatterns(guest, signal),
        tracesByGuest,                                     // the GuestSlot the Tracing.* listener in cdp-event-router.ts feeds
        processMemoryMb,                                   // what createBrowserPerformanceCommands got today
        pause,                                             // browser/settle.ts
        emulation: emulationOwner,                         // createBrowserEmulationOwner({ configure: tools.emulation.configureEmulation })
        downloads: ledger.downloadsForSession,             // createBrowserDownloadLedger(...)
      });
      registerUpload(connection, engineContext, {
        host: refActionsHost,                              // the BrowserRefActionsHost createBrowserRefActions is built from
        invalidateInteractionState,
      });

    ## browser/host-presentation.ts (remoteDrive.emulate, the pane preset path)

      emulate: async (guest, config) => { await emulationOwner.applyPane(guest, config); },
      // replaces: tools.emulation.configureEmulation(guest, browserViewportEmulation(config))
      // emulationOwner remembers the pane viewport per guest, so an agent `emulation` with overrides: null returns to it.

    ## CDP fetch router / cdp host (interceptFetchPatterns, matchInterceptRule)

      Take these three from the table above (`intercept.interceptFetchPatterns`, `intercept.matchInterceptRule`,
      `intercept.hasInterceptRules`) instead of createBrowserIntercept(): the `intercept` method edits that table, so the
      router must read the same one.
      Until s4-delete-ts-engine removes createBrowserIntercept, the old `intercept` command (host-foundation.ts) still
      edits its own table: the router then reads both (patterns = the old table's + this table's, match = this table
      first, then the old one; hasInterceptRules = either), or the old command path's rules stop taking effect.

    ## For s4-delete-ts-engine (not done here: those files belong to it)

      - intercept.ts: createBrowserIntercept and its rule table go (session.ts createInterceptTable replaces them);
        keep `BrowserInterceptRule`, `BrowserFetchPattern` and `interceptFulfillParams` (cdp-events-fetch.ts, cdp-session-init.ts).
      - init-scripts.ts: goes whole (session.ts keeps the per-page script registry beside the `initScripts` method).
      - performance.ts: createBrowserPerformanceCommands and formatPerformanceMetrics go; keep BrowserPerformanceTrace and
        ActiveBrowserPerformanceTrace (session.ts, the Tracing listener).
      - page-state.ts: createBrowserPageState goes; keep browserStorageKeyIsSensitive (session.ts).
      - downloads.ts: createBrowserDownloads (the list/attach text) goes; keep the ledger, MAX_BROWSER_DOWNLOAD_BYTES, TrackedBrowserDownload.
      - ref-upload.ts / ref-actions.ts: stay (registerUpload runs createRefUpload over a guarded host); uploadReceiver is
        used by action-approval.ts only until the engine owns the approval.
      - emulation.ts: stays (configureEmulation, fitMetrics, unfitMetrics); only its callers change.

### s4-host-snapshot

    # s4-host-snapshot: desktop wiring lines (applied by the wave's wiring task)

    ## apps/desktop/src/main/host/index.ts (where the engine methods are registered, with the EngineContext)

    Import and call, with the connection and the EngineContext the wiring builds:

      import { registerSnapshot } from './browser-engine/snapshot';
      import { registerRefCall } from './browser-engine/ref-call';
      import { registerScreenshot } from './browser-engine/screenshot';

      registerSnapshot(connection, engineCtx, { captureSnapshotPayload: snapshotCapture.captureSnapshotPayload });
      registerRefCall(connection, engineCtx, { evaluate: cdp.evaluate });
      registerScreenshot(connection, engineCtx, {
        screenshots,            // createBrowserScreenshotService(...) of command-toolkit.ts: only capture, captureElement are read
        resolveRefRect: refPoints.resolveRefRect,
        evaluate: cdp.evaluate,
      });

    The objects are the ones command-toolkit.ts already builds for the in-process browser host (snapshotCapture =
    createBrowserSnapshotCapture(...), screenshots = createBrowserScreenshotService(cdp, ..., visualPrivacy), refPoints =
    createBrowserRefPoints(...), cdp = the guest CDP). Build them once and share them with the in-process path while both exist.

    ## Notes for the wiring

    - The host methods served: host/browser/snapshot, host/browser/ref/call, host/browser/screenshot.
    - captureSnapshotPayload must be handed the GuestSlot adapters over the same guest state the registry reads
      (accessibilityRefs, refSets -> state.refSet, visualGrounding), so the refs a snapshot mints are the ones
      ref/call and a screenshot clip resolve (and the -32010 `snapshot` precondition of precondition.ts reads).
    - precondition.ts checks `expect.snapshotId` against state.accessibilityRefs only; a DOM-fallback snapshot (no
      accessibility tree) keeps its refs in state.refSet, so ref/call and screenshot compare against
      accessibilityRefs ?? refSet (ref-call.ts currentSnapshotId). The scaffold task's precondition would refuse an
      `expect.snapshotId` of a DOM-fallback snapshot with reason `snapshot`.
    - The visual privacy check runs inside screenshots.capture (the service is built with visualPrivacy), so no extra call.

### Review notes for the engine wiring (G6/G7)

- s4-host-secret-precondition review: the crit-security #7 scan test covers two stand-in methods only; extend it to every
  method registerBrowserEngine registers. Item 2 hands `ctx.isEngineMode`, `ctx.page` and `ctx.events.facts` over as
  detached references: wrap them in arrows unless they do not use `this`.
- s4-host-snapshot review: precondition.ts compares `expect.snapshotId` against accessibilityRefs only; a DOM-fallback
  snapshot keeps its refs in state.refSet (ref-call.ts uses accessibilityRefs ?? refSet), so the scaffold or the wiring
  must read `accessibilityRefs ?? refSet` there too.
- s4-host-lease review: registry.ts must run handlers under `leases.beginCall` before a person's input can abort an
  in-flight engine call.
