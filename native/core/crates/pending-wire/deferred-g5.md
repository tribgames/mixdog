# Core wire lines deferred by G5-WIRE

Applied (see the G5-WIRE commits): every line of pending-rows/g45-fu-rest.rows, s4-engine-actions-page.rows and
s4-engine-actions-pointer.rows (host/browser/ref/mint with its types, frameOffset, observation, read offset, checkUnchanged /
unchanged, BrowserPointerKind::Swipe, the pinInset doc line; free_text and free_text_fields.json classes; goldens and
packages/protocol/src/index.ts regenerated; the stale MIXDOG_DEV_COMPUTER_RUN doc text of s3-27.wire fixed); g45-fu-rest.wire
(compose_flip.rs reads attachments through DesktopAttachmentHost); s4-engine-actions-page.wire (icu_locale_core edge);
s4-engine-actions-observe-nav.wire and s4-engine-actions-pointer.wire (no core line beyond the protocol rows; base64 was already
an edge); s2b-port-forwards.wire and s2b-remote-session.wire (no line). From the older lists: mixdog-ssh is a workspace member
(deferred-g1.md CORE-WIRE-G5) with its Cargo.lock entry (deferred-g4.md s2b-tunnel line, written by `cargo update --workspace
--offline`), its deferred-g3.md edges compiled for the first time, the daemon's `mixdog-ssh` dev-dependency and
`mod args_parity_tests` (deferred-g2.md); `cargo hakari generate` moved hmac into the workspace-hack's common dependencies.
The engine crate's callers were brought to the g45-fu-rest interfaces (ActionabilityError over ActionabilityReason,
FilePort::write_frame with a mime type and io::Result) and the new protocol fields. Every G5 fragment file is deleted.

## s4-core-events-service -> CORE-WIRE-G7 (s4-wire-core: the wiring that composes the browser engine)

Applied now: `pub mod browser_engine_service;` in the daemon's lib.rs (the service compiles with the workspace) and
`Outgoing::serves_capability(id, capability)` in mixdog-app-server outgoing.rs.
Kept (the engine is not composed into mixdogd yet: no HostLane, no EngineSinkImpl and no BrowserToolRunner exist in the
composition, so the service has no sink to feed):

- compose_flip.rs: `struct OutgoingClaimants(Arc<mixdog_app_server::Outgoing>)` implementing
  `browser_engine_service::ClaimantProbe` with `self.0.serves_capability(connection, HostCapability::BrowserEngine)`.
- compose_flip.rs, next to `builder.register(live_view.clone())?;`: `BrowserEngineService::new(engine_sink.clone(),
  Arc::new(OutgoingClaimants(b.outgoing.clone())))`, under `#[cfg(feature = "test-hooks")]` `.with_test_hook(&*env, tool_runner)`,
  then `Arc::new` and `builder.register(browser_engine.clone())?`. `engine_sink` is `EngineSinkImpl::new(lane.mirror().clone(),
  lane.hold().clone())` of the engine's HostLane; `tool_runner` is the engine adapter's `BrowserToolRunner` (s4-tool-adapter).
- connection_close.rs `ConnectionOwners::new`: an eighth parameter `browser_engine: Arc<BrowserEngineService>` appended to the
  owners; the compose_flip.rs call passes it last.
- SERVICE_PENDING: remove "host/browser/events", "host/browser/page/facts", "host/browser/userInput" in the same change (the
  service registers them); keep "test/browserEngine/run" (registered only with MIXDOGD_TEST_HOOKS=1); reword the group comment
  to "the browser engine composed into mixdogd; the test hook only with MIXDOGD_TEST_HOOKS=1".
- Review note (review-s4-core-events-service): host_gone fires on the newer desktop's first push or the earlier connection's
  close, not at claim time; a claim-time signal would need the ClaimHook system_proxy_claim.rs uses (decide there).

## The engine runner's notes (s4-engine-runner, G6), not wire lines

g45-fu-rest.wire item 4, s4-engine-actions-observe-nav.wire item 3, s4-engine-actions-page.wire item 3 and
s4-engine-actions-pointer.wire item 3 describe what the runner takes from the action modules (RefSet::from_payload(..)
.with_document(..).with_observation(..), EffectBaseline::of(&set), EngineSinkImpl over the lane's hold, FilePort::write_frame by
mime type, ActionPage / StepRunner, the timing phases). They are for s4-engine-runner, not for a wiring task.

## mixdog-connections -> CORE-WIRE-G9 (unchanged)

Not a member: its lib.rs declares 23 modules and 14 of them have no file yet (link, attempts, connect, login, server_logins,
cleanup_ops, diagnostics_ops, host_list_ops, reattach, notifier, restore, view, policy, service). It cannot compile until
s2b-service and the other G9 tasks land; add it then (it now only needs its own modules: mixdog-ssh is a member).

## Carried over unchanged

- deferred-g3.md singletons-core `CardHolds` -> CORE-WIRE-G7.
- deferred-g2.md s2b-model-proxy-relay relay composition -> s2b-service (G9); s3-screen-source ScreenPcAccess -> G7.
