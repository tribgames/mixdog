# Core wire lines deferred by CORE-WIRE-G7

Applied (see the G7-WIRE commits after 1ab2ed690e): x-residual-moves-b.wire sections 1-5 (module line, `image` edge, `file_preview_type`
made pub, DesktopResidualBService registered, its nine names out of SERVICE_PENDING); s3-bridge-core.wire (module lines,
compose_computer_bridge.rs, the bridge's fill turns before the core's clock in the saved-login backend, ComputerBridgeRun registered where a
computer pool exists; `computer/bridge/run|abort` stay in SERVICE_PENDING because a start without a pool leaves them unclaimed, as
`dev/computer/run`); s3-screen-input.wire module line; s3-screen-source.wire items 1-3 (the `#[path]` source module and the `screen_source`
surface, `PcAccessHelper` as the lease's `InstallPort`, `production_installer_with_helper`); g55-fu-cu-ssh.wire (`AccountAdmin` exported);
s4-golden-replay.wire section 1 (engine dev-dependencies, unify-test-features, Cargo.lock); s4-tool-adapter.wire 1, 2, 3a, 3b, 3c;
s4-engine-runner.wire section 3 (the engine over the claimed host's `HostLane`, its ports and its sink); g55-fu-engine.wire (nothing left:
its rows were applied by PROTO-WIRE-G7). From the older lists: deferred-g3.md singletons-core `CardHolds` (taken by the browser card's hold)
and deferred-g5.md s4-core-events-service (OutgoingClaimants, BrowserEngineService registered with the test hook, the eighth
ConnectionOwners owner, the three host/browser names out of SERVICE_PENDING). New file: mixdog-app-server-daemon/src/compose_browser_engine.rs.
s2b-*.wire: their Cargo edges (mixdog-core-domains, mixdog-services, mixdog-workspace, dev mixdog-core-api mock, dev mixdog-workspace) and
the `pub mod remote_file_reader;` line are in mixdog-connections; the crate is still not a member (below). Every fragment file is deleted;
the lines below are kept for the task named.

## mixdog-connections membership -> CORE-WIRE-G9

Tried once (`cargo check -p mixdog-connections` with the member added, then reverted): the only errors are E0583 for the four modules lib.rs
declares without a file: `cleanup_ops.rs`, `diagnostics_ops.rs`, `host_list_ops.rs` (created by s2b-ops, wave 8) and `service.rs` (created
by s2b-service, wave 9). Add `"crates/mixdog-connections",` to the workspace members when they land, then `cargo update --workspace --offline`,
unify-test-features and `cargo hakari generate`. The daemon edge to mixdog-connections (`link_pool.reader(&connection_id)` for
`ServerDownloads::begin`) is the service wiring's (review-S2B-REMOTE-FILE-READER).

## s3-screen-source item 4 / s3-screen-input live-view hookup / g55-fu-cu-ssh InputDesktop -> CORE-WIRE-G9 (after x-screen-source-desktop, G8)

Not composed: composing `ScreenSources` into the live view now would drop what the phone has today. (a) The indicator pill and its Stop
button need `host/screen/indicator` and `screenIndicatorStop`, which no protocol row has (x-screen-source-desktop owns the desktop side, a
PROTO-WIRE the rows). (b) `Screen::displays` (computer_screen.rs) reports one virtual display `0` at scale 100, so the phone's monitor picker
would lose every monitor's id, label and DPI scale (no task owns the per-monitor enumeration yet: it must be added before the hookup).
(c) Nothing reports display changes (`displays_changed()` has no source). The hookup also writes the one `ScreenInputHost` adapter over
`ScreenInput` (giving the source's trait the input module's `InputDesktop` and deleting the source's own struct and its `local_desktop`
copy), the `ScreenPcAccessPort` over `PcAccessService` (`account_is_admin` over one `Arc<AccountAdmin>`), `DisplayPixels`, the sink over
the live view, the shutdown's `stop_for_quit()`, and takes the helper of `production_installer_with_helper` in the `PcAccessService::new`
call (compose_flip.rs still calls `production_installer`). The fragment text follows.

#### 4. The compose hookup (compose_flip.rs, after PC access and the live view are built)

Windows only; elsewhere the phone's screen control reports once, at error level, that it is Windows-only and is off.

    let screen_sources = Arc::new(mixdog_tools::desktop::screen_source::ScreenSources::new(ScreenSourcesDeps {
        backend,        // the default (session "") backend of the computer pool: ComputerSessions::backend("")
        installer,      // the Arc<PcAccessHelper> of step 3
        input_host,     // s3-screen-input: Arc<dyn Fn() -> Arc<dyn ScreenInputHost>>, see below
        indicator,      // Arc<dyn Fn() -> Arc<dyn ScreenIndicatorPort>>: a fresh port per session onto the desktop's pill
        pc_access,      // Some(Arc<dyn ScreenPcAccessPort>) over PcAccessService, see below
        pixels,         // Some(Arc<dyn DisplayPixels>) over computer_pixels (`host/computer/pixels` of the display)
        sink,           // Arc<dyn ScreenSink> over the live view's host (geometry, capture renewal, channel, drawn track, frame)
        log,            // Arc<dyn Fn(Value)>: tracing at debug, a `start-failed` at warn
    }));

- ScreenPcAccessPort over `PcAccessService` (deferred-g2.md, "s3-screen-source (G7)"): `account_is_admin` -> the PC account's
  administrator check of Node `secure-desktop/account-admin.ts` (`createAccountAdminCheck`: `whoami /groups` lists the
  Administrators group, the answer cached, a failed read answers None and is read again next time). NO core code has that check
  today (PcAccessService has none): it must be ported for this port (owner: the compose hookup, CORE-WIRE-G7); answering a
  constant None would drop the `accountIsAdmin` helper fact the phone is told today. `approve_with_credential(client_id, public_key, credential, cancelled)` ->
  `PcAccessService::approve_with_credential(CredentialRequest { client_id, public_key, credential: PcCredential { user, password },
  cancelled })`, mapped `Ok(answer)` -> `PcAccessAnswer { outcome: match answer.outcome { CredentialOutcome::Busy => "busy",
  CredentialOutcome::Ran(k) => k.name() }.to_string(), state: <HelperState as mixdog-tools InstallState>, detail: answer.detail }`
  (`cancelled` = the session's abort, `busy` for Busy, outcome by `KeyOutcome::name()`).
- ScreenInputHost: s3-screen-input's `ScreenInput{apply, cursor, release_all, desktop_watch}` behind the trait of this file
  (`start`, `input` -> the `ok` fields, `cursor` -> `[x, y]` as decimal strings, `desktop` as `InputDesktop`, `session`,
  `on_desktop`, `on_exit`, `stop` = release then end, `kill`). The geometry the input is mapped through is the session's own
  (`ScreenSession` keeps the pointer mapping and the geometry generation and refuses stale-generation input), so there is no
  `ScreenGeometry` impl to write: a `ScreenGeometry` trait in computer_screen_input.rs has nothing to be implemented by.
  CONFLICT for the lead: s3-screen-input.wire says the opposite (this source implements its `ScreenGeometry` and the live view
  calls `ScreenInput::apply_remote`). Only one of the two mappings may stay: the session's (already ported, with its tests) is
  the one this file uses; `apply_remote` / `screen_input_ops` / `ScreenGeometry` of computer_screen_input.rs would then have no
  caller. Its `InputDesktop` and this file's `InputDesktop` are the same three facts: one of them should be used by both.
- Display changes: `screen_sources.displays_changed()` must be called when a display is added, removed or rescaled (Node:
  Electron `screen` `display-added` / `display-removed` / `display-metrics-changed`, which renew every session's geometry).
  Nothing in the core reports that today: the hookup needs a source for it (a desktop -> core notification or a Windows
  display-change watch).
- Displays: `Screen::displays` (computer_screen.rs, not this task's) reports one display `0`, the virtual screen at scale 100.
  Node lists every monitor with its own id, OS label, primary flag and DPI scale; per-monitor enumeration has to be added there
  for the phone's display picker to keep choosing a monitor.
- ScreenIndicatorPort: the Electron pill stays in the desktop (screen-indicator*.ts); the port needs a core -> desktop host
  notification `host/screen/indicator` {state: show|update|hide, clientLabel, screenId, controlling} and a desktop -> core call
  for the pill's Stop button (`screenIndicatorStop`). Neither protocol row exists yet (x-screen-source-desktop owns the
  desktop side; PROTO-WIRE for the rows).
- The live view (`live_view.rs`):
  - `RelayDeps::screen_displays` answers `screen_sources.displays()` (an array of the picker's summaries) instead of
    `host_request("host/screen/displays")`; `host/screen/displays` is then no longer asked of the desktop.
  - A paired phone's connection becomes screen access where the connection is established/authorized
    (`PairedScreenAccess::allowed` is true): `screen_sources.grant(client, connection_id, label)` before the screen `ready`
    is forwarded; when the connection leaves the relay registry `screen_sources.withdraw(client, ViewerLeft)`, on an unpair
    `withdraw(client, Revoked)` (the publisher's `removed` and `revokeCredential`).
  - `HostEnv::source(&Source::Screen { screen_id }, client, signal)` -> `screen_sources.resolve(screen_id, client,
    signal == "ready")`, adapted to `VideoSource` (`start`, `stop`, `page`, `dispatch` = `ScreenViewer::dispatch`); the viewer's
    channel messages `screen-frame-seen` / `screen-helper-grant` / `screen-helper-install` reach `ScreenViewer::frame_seen`,
    `helper_grant`, `helper_install`, `helper_credential`; `channel_state()` is what a promoted channel is sent; `delivered(run)`
    after a helper frame drew into the track; `release()` when the channel is gone.
    `LiveHost::signal` today answers `SOURCE_NOT_STREAMED` for anything but `Source::Browser` (host.rs): the screen branch is the hookup's.
  - The sender's capture track for a screen source is `screen_sources.capture(screen_id)` (a `MediaFrameSource`: in-process
    capture, else the desktop's pixels).
- Close: the daemon's shutdown calls `screen_sources.stop_for_quit()` (5 s budget, shares one completion with `dispose()`).
- `ScreenSink::frame` carries the helper's BGRX picture (`mime_type` `image/x-bgrx`) located on the locked geometry; the sender
  crops and scales it (no pixel is touched here).


#### Live-view hookup (compose_flip.rs / the compose function that builds the screen session)

`computer_screen_input::ScreenInput` is the process behind the session's input host. Build one per screen session:

    let input = ScreenInput::new(process_manager.clone(), ScreenInputConfig::new(computer_binary.clone(), cwd));

(`computer_binary` is the `mixdog-computer` path the computer backend already resolves; `cwd` is `AbsPath` of the process's current dir, as
`ProcessComputerBackend::request_for`.) Where the screen session needs its `create_input_host` (`computer_screen/session.rs`
`SessionDeps::create_input_host`, a `Box<dyn Fn() -> Arc<dyn ScreenHost>>`), an adapter inside the `computer_screen` module (a new
`impl ScreenHost for ...` there, owned by the task that edits computer_screen.rs; `ScreenHost` is `pub(super)` to that module) maps:

    start()        -> ScreenInput::start()
    command(Input(op)) -> ScreenInput::apply(&op)  (reply fields: none);  command(Cursor) -> ScreenInput::cursor()  (fields: x, y)
    desktop()      -> *desktop_watch().borrow()   mapped to LocalDesktop { input_desktop: name, consent, logon_ui }
    on_desktop     -> a task over desktop_watch().changed()
    session()      -> ScreenInput::session()
    on_exit        -> a task over exit_watch().changed()
    stop()         -> ScreenInput::stop()
    kill()         -> tokio::spawn(ScreenInput::kill())

Errors: `ScreenInputError.code` is the host error code the session already reads (`host_unavailable`, `host_unresponsive`, ...).

A phone's input is mapped and its holds are kept by the screen session (`computer_screen/session.rs` `screen_input_commands`,
`router.rs`): `ScreenInput` is the host process only (the one pointer mapping and the one hold tracking live there; the earlier
`ScreenGeometry`, `RemoteInput`, `apply_remote`, `release_all` copies of them were removed from this module).
When the helper binary is missing (`MIXDOG_COMPUTER_BIN` unset), `ScreenInput::start()` fails with `start_failed`: the wiring reports the
reason once at error level and leaves phone screen control off; there is no other implementation.

## x-residual-moves-b section 6 (library parts with no call site) -> x-residual-moves-b-client (DESKTOP-WIRE-G10)

`ImportProgress`, `NetworkWatcher` and the login-shell functions have no caller in the core. Their TypeScript twins
(conversation-import-progress.ts, network-watch.ts, login-shell-environment.ts) still run in the desktop today; calling the Rust ones now
would publish `conversation-import-progress` twice and redial twice. They are switched together with the client task that removes the
TypeScript (the launcher edge for the login shell is the lead's decision named in the fragment). The fragment text follows.

#### 6. Library parts the launcher and the relay leg take (no method)
- `ImportProgress` (conversation-import-progress.ts): `ImportProgress::new(Arc<dyn ImportJobSource>, Duration::from_millis(CONVERSATION_IMPORT_POLL_MS))`. The
  node-capability call site (mixdog-app-server node_calls.rs: `import/startConversationImport`, `import/cancelConversationImport`, `import/getConversationImportJobs`)
  calls `progress.observe(capability, &result)` after each of those calls; its ImportJobSource fetches the job list with the same capability
  and publishes `conversation-import-progress` (CONVERSATION_IMPORT_PROGRESS_EVENT) on whatever carries a desktop event today.
- `NetworkWatcher::start(Duration::from_millis(NETWORK_POLL_MS), Arc::new(network_snapshot), on_change)` for the relay leg (mixdog-remote): `on_change` redials
  at once. The OS interface list of network-watch.ts is replaced by the routing table's answer for each address family (a connected UDP socket sends nothing):
  online is "a route exists", the signature is the local address of the route; a Wi-Fi switch, a VPN toggle or a dock changes it.
- `read_login_shell_environment("linux" | "darwin", None, LOGIN_SHELL_READ_BUDGET)`, `login_shell_overrides(inherited, shell)` and `with_homebrew_path(path, exists)`
  (login-shell-environment.ts): they run before the daemon is spawned, so the launcher calls them and applies the overrides to the daemon's environment. The launcher
  (mixdog-spawn or the daemon start) must depend on mixdog-core-domains for that, or the three functions move to a crate it already depends on: a dependency edge
  and a call site the lead decides. The functions are synchronous and spawn a shell, so they must not run on a core executor thread.

#### 7. Client side (x-residual-moves-b-client)
The desktop callers (ipc-file-dialogs.ts, ipc-projects.ts, ipc-sessions.ts, index.ts, the launch-record and model-bootstrap call sites) call the nine methods; the OS hand-off
(`shell.openPath(path)` for a `{result: "file" | "folder", path}` answer, and the "Unable to open file: <failure>" error when it returns one) stays with Electron.
Deleting the TypeScript files and their tests is the client task's, after its parity check. The rows already in Rust (agent-memory, approval-grant-change,
child-environment, feedback-client, git-contract, ipc-control-chars, mixy-first, session-sidebar-actions) are named in the module header of desktop_residual_b.rs
with where they live.

## Browser engine: what the composition does not carry yet (live once DESKTOP-WIRE-G7 declares `browserEngine`)

- `TurnEvents` (s4-engine-runner.wire section 3): no session-runtime hook reports a turn's end to the engine, and the `browser` tool sends no
  turn number (`turn_id` absent: a core-hosted session sent none to the desktop either), so no command owns a page and `turn_ended` would
  close nothing. Owner: the task that gives the tool the session's numeric turn (s4-engine-runner follow-up / s4-harness-rebase-a).
- review-s4-engine-runner gaps that become refusals once the engine runs: `network` with `requestId`, `fill` with `savedAccount`,
  `downloads` with `attach`, the auto/linked sign-in hooks, untouched-blank discard. They must be covered before DESKTOP-WIRE-G7 declares
  `browserEngine` or before s4-delete-ts-engine (owner direction: nothing in use is lost).
- review-g55-fu-engine / review-s4-core-events-service: `host_gone` fires on the newer desktop's first push or the earlier connection's
  close, not at claim time; `Outgoing` has one `ClaimHook` slot (system_proxy_claim.rs holds it). A claim-time signal needs that hook to
  fan out; no behaviour of today depends on it.
- s4-golden-replay section 3: `cargo test -p mixdog-browser-engine --test golden` fails until s4-harness-rebase-a records
  native/core/fixtures/desktop-host/browser-engine-transcript.jsonl (the test does not skip by design).
- s4-tool-adapter section 5: no `browser_timing` trace row for a command the engine ran; a card left open when the engine drops the asking
  future stays until the run or the person ends it.
- URL policy: `allow_private_network` is true (a session of this core works on this PC, `remote: false` in host-policy.ts); a server core
  has no `browserEngine` claimant today (the link declares no host capabilities, review-s2b-link-pool), so the engine never runs there.

## Carried over unchanged

- deferred-g2.md s2b-model-proxy-relay relay composition -> s2b-service (G9).
- deferred-g2.md x-pcaccess-desktop note (desktop side, no core line).
- SERVICE_PENDING keeps `host/window/closed` and the namespaces `connections`, `remoteHosts` (s2b-service, G9), `dev/computer/run` and
  `test/browserEngine/run` (test hooks only), `computer/bridge/run|abort` (served only with a computer pool).

## s2b fragments: the service wiring (s2b-service, CORE-WIRE-G9)

### From s2b-attempts-connect.wire (kept verbatim)

#### 3. SERVICE_PENDING (mixdog-app-server-daemon compose_flip.rs)
This task serves no protocol method by itself. The task that registers the connections service (s2b-service) serves these with the
functions below, and removes them from SERVICE_PENDING: `connections/ssh/inspect`, `connections/ssh/connect`, `connections/ssh/cancel`,
`connections/ssh/askpassReply`, `connections/ssh/open`, `connections/ssh/openEphemeral`.

#### 4. For the service wiring (s2b-service)
- Build `Connect::new(ConnectDeps { attempts: Attempts::new(link_pool as Arc<dyn ServerLinks>, push), machine: Arc::new(EnvMachine { env: ssh_env, configs }),
  login: Arc::new(EnvLoginHelpers::new(ssh_env, io, user_data_dir)), hosts, windows, view, clock })` once.
  `configs: Arc<ResolvedConfigs>` is the instance the ssh environment's `config_files` holds: the inspection builds the target's own
  config there and lists the user's forwards in the summary when it cannot (the TS inspectWithForwards).
  `LinkPool` implements `ServerLinks` (attempts.rs). `view` is the connection feed's `SshHost` of a record (its `open` flag is `link_pool.get(id)` attached).
- `windows: Arc<dyn ServerWindows>` is the callback that calls `WindowHost::open(id, name)` of the desktop host; `Err(message)` becomes a `failed` result.
- `push: Arc<dyn ConnectionsPush>` sends `connections/ssh/askpass` (SshAskpass) and `connections/ssh/progress` (SshProgress) notifications to the
  protocol connection `to` (both are `@connection` notifications; a connection that is gone is ignored).
- Methods (`caller` is the protocol connection the request came from; role checks are the dispatcher's):
  - `connections/ssh/inspect {target}` -> `connect.inspect(caller, &target)`
  - `connections/ssh/connect {attemptId, ...}` -> `connect.connect(caller, &req.attempt_id, req)`
  - `connections/ssh/cancel {attemptId}` -> `connect.cancel(caller, &attempt_id)` (empty result)
  - `connections/ssh/askpassReply {attemptId, requestId, secret}` -> `connect.askpass_reply(caller, ..)` (empty result)
  - `connections/ssh/open {id}` -> `connect.open(&id)`; `connections/ssh/openEphemeral {target, name}` -> `connect.open_ephemeral(&target, &name)`
  - `AttemptError` is the request error (its Display text is the message the dialog shows).
- When a protocol connection closes (the dispatcher's connection-closed hook), call `connect.caller_closed(connection_id).await`: its attempts are
  cancelled and pending questions answered with null.
- `login::with_login_retry(helpers, prompter, base, run, is_cancelled)` is generic over `LoginOutcome` (implemented for `SshConnectResult` and
  `SshCleanupResult`): the cleanup task (s2b-ops) calls it with `Attempts::operation_prompter(caller, operation_id, host)`,
  whose questions the caller answers with `connections/ssh/askpassReply {attemptId: operationId, ...}`.
- `connect::host_settings(&SshHostSettings) -> HostSettings` converts a saved server's settings for an `AttemptContext` (pub(crate)).

### From s2b-link-pool.wire (kept verbatim)

#### 4. For the daemon wiring (CORE-WIRE-G9, s2b-service)
- `LinkPool::new(env: SshEnv, stores: LinkStores{hosts: Arc<SshHostStore>, port_forwards: Arc<PortForwardStore>, payloads: Arc<dyn ServerPayloads + Send>}, local_proxy: Arc<dyn LocalModelProxy>)`.
  `payloads` must be an owned implementation of `mixdog_ssh::bootstrap::ServerPayloads` over `SshEnv::server_cores_dir`: the only one in the tree,
  `StagedPayloads<'a, P>`, borrows a lane job's read proof, so the daemon adapter reads the manifest and archive itself (one lane job per read).
- `open(LinkSpec{id, name, target}, AttemptContext, Option<Progress>)`: folder, automatic reconnection, grace and model login are read from
  `AttemptContext.settings` (the host's `HostSettings`), so the caller passes the saved settings there; `force_restart` and `askpass` are the attempt's.
  A caller that gets `ConnectError` maps it with `mixdog_ssh::connect_failure::failure_of`.
- `LinkPool::on_attach()` yields the id each time a link attaches (first time, and after every redial of the client): the connections feed
  (`view.rs`) re-reads `get(id)` then, because a stopped link whose client was refused for its version is replaced by a new `Arc<ServerLink>`.
- `ServerLink::notices()` is the `broadcast::Sender<ConnectionNotice>` the re-attach report writes `Reattached` / `OutcomeUnknown` to (the link itself
  writes `ModelSignIn`); `ServerLink::model_calls()` is the relay's settled-call stream the report counts `interruptedModelCalls` from.
- `ServerLink::view_ports(viewed)` is what `system/ports/subscribe|unsubscribe` of the local core must call on the server's client for the server's
  `ports` list to arrive (the server samples only while subscribed; it is subscribed again on every re-attach while viewed).
- `LinkPool::power(LinkPower::{Suspend, Resume})` is the sleep/wake fan-out; `ServerLink::apply_model_login(ModelLogin)` is what
  `host_list_ops::update_settings` calls when the saved model login changes (convert `host_store::ModelLogin` to `link_machine::ModelLogin`).
- `LinkPool::close_all()` at quit / host absent for 30 s; `LinkPool::close(id)` on `host/window/closed byUser`.

### From s2b-reattach-notifier.wire (kept verbatim)

#### SERVICE_PENDING (compose_flip.rs)
The notifier serves no protocol method; nothing to remove.

#### For the daemon wiring (s2b-service, CORE-WIRE-G9)
When a link attaches (`LinkPool::on_attach()`, and again for the replacement `Arc<ServerLink>` after a version refusal), the service holds, per link:
- `ReattachReport::attach(&link)`: writes `ConnectionNotice::Reattached` / `OutcomeUnknown` to `link.notices()`.
- `ServerNotifier::attach(&link, sink, prefs, focus, texts)`; drop the value when the link is closed or replaced. Adapters (one of each per daemon):
  - `NotifySink`: `supported()` is the host's `notificationStatus.supported`; `show` sends `host/notification/show` to the host claimant
    (`host.notify(HostCapability::Notifications, Method("host/notification/show"), params)`). Sound and volume are left `None` by the notifier:
    the adapter fills them from the same `ToastStyleReader` the `notify` domain uses, so a server toast sounds like this PC's own.
  - `NotifyPrefs`: `view()` is the `PreferencesView` the `notify` domain's `AudienceSource` reads for this PC (`Audience::pc`).
  - `WindowFocusSource`: reads the `windowFocus` value (`WindowFocusValue.windows`, `connection_id`, `visible && focused`, `session_id`) from the
    host state the `host/state/set` handler stores.
  - `NotifyTexts`: this PC's UI-language strings (the core has no i18n of its own); the desktop's existing server-notifier texts are the source.
- Double notification risk: the `notify` domain's `NotificationEngine` plans host toasts for this PC's own sessions only; a server's thread events must
  not be fed to it as well, or the desktop would show two toasts for one final answer.

### From s2b-remote-file-reader.wire (kept verbatim)

#### 4. Compose
Where the daemon builds `ServerDownloads::begin(reader, ...)` for a server window: `link_pool.reader(&connection_id)`
(`LinkPool::reader(&self, server_id: &str) -> Option<Arc<dyn mixdog_workspace::RemoteFileReader>>`, `None` when no link is held: the caller answers
the not-connected refusal it already uses for any server call).

### From s2b-restore-view-policy.wire (kept verbatim)

#### 4. For s2b-service and the daemon wiring
- policy: `policy::authorize(ctx, method, connection_id: Option<&str>)` is the whole table (`policy::callers(method)`, `policy::methods()`); the
  primitives `require_main(ctx, method)`, `require_main_or_server(ctx, method, id)`, `require_host(ctx, method)`, `require_server(ctx, method, id)` take
  the method name too (the refusal is `CoreError::PermissionDenied{method, origin}`, the same refusal the window gate gives). `connections/subscribe`:
  `subscription_scope(ctx, method, requested)` returns the connection the subscription is limited to (`None` = every key).
- restore: `Restore::new(Arc<WindowRestoreStore>, Arc<SshHostStore>)`; `run(Arc<dyn RestoreLinks>, Arc<dyn RestoreWindows>) -> Result<(), StoreError>`
  resolves when every reopening settled; `progress()` is the watch (answer of `connections/restore/progress` is its current value).
  `RestoreLinks` is implemented for `LinkPool`; `RestoreWindows::open(connection_id, name) -> Result<(), String>` is the host's `host/window/open`
  (the service's WindowHost adapter implements it; `opened: false` is an `Err`). `restore::attempt_context(&SshHostRecord)` is the batch-mode context of a
  saved server (connect.rs may reuse it).
- view: `ConnectionsFeed::start(feeds: Arc<dyn ScopedFeeds>, links: Arc<LinkPool>, hosts, restore_store, &restore)` (a `LinkPool` is a `FeedLinks`).
  `connections/subscribe` replies `Reply::Subscribe{feed: feed.source(scope.as_deref()), window: Window::Fixed, ..}`. After every `LinkPool::open`
  returns and every `close`/`close_all`, call `feed.reconcile()` (the pool announces a first attach before it lists the link, and a close not at all).
  After `connections/restore/set`, call `feed.refresh_restore().await`. `view::ssh_host_view(record, open)` is the `SshHost` of a record (connections/ssh/list
  should answer with it) and `view::connection_link_view(&LinkViewState)` the answer of `connections/link/get`.

### From s2b-server-logins.wire (kept verbatim)

#### 3. SERVICE_PENDING
server_logins.rs registers no protocol method itself; the service (s2b-service) dispatches to it. It removes from SERVICE_PENDING:
connections/ssh/serverLogins, serverLoginBegin, serverLoginStatus, serverLoginComplete, serverLoginCancel, serverLoginSaveKey, serverLoginLogout,
serverLoginRemoveCustom (and the notification connections/ssh/serverLoginUpdated is sent from `ServerLogins::updates()`).

#### 4. For the daemon wiring (s2b-service, CORE-WIRE-G9)
- `ServerLogins::new(pool: LinkPool, ServerLoginStores { hosts: Arc<SshHostStore> }, env: SshEnv)` (one per daemon; the pool is the same one the connect service uses).
- Method mapping (ids and params are `connections/ssh/*` params of v2/connections.rs):
  - serverLogins{id} -> `list(&id)` -> SshServerLogins.
  - serverLoginBegin{id, provider} -> `begin` -> SshServerLoginFlow whose `open_url` the renderer opens with openExternal (nothing is opened by the core).
  - serverLoginStatus{id, flowId} -> `status`; serverLoginComplete{id, flowId, redirectUrl} -> `complete`; serverLoginCancel{id, flowId} -> `cancel` (result `{}`).
  - serverLoginSaveKey / serverLoginLogout / serverLoginRemoveCustom -> `save_key` / `logout` / `remove_custom`, then answer `list(&id)` (those three results are SshServerLogins).
  - `LoginError(String)` is the message to put in the JSON-RPC error; it never carries a key.
- `connections/ssh/serverLoginUpdated{id, flow}`: one task forwards `updates()` (a login that ended on this PC's side: its link went or its model login changed).
- `forget_host(&id)` when a saved server is forgotten; `dispose()` at quit (closes every callback forward, cancels the pending logins on the server).
- Not wired here: the server's pushed `login:<flowId>` feed. This PC's client folds a scoped feed into its thread store only and never surfaces `login/updated`,
  so a login's progress is read by `status` (the dialog's own events), never on a timer.
