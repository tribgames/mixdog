# Core wire lines deferred by CORE-WIRE-G3

Every other line of the G3 core fragments (FEATURE-FACTS, s1-page-virtual, s1-ws-wire, s2a-core-server-wiring, s2b-askpass-server,
s2b-ssh-spawn, s3-18, s3-19, s4-engine-approval, s4-engine-queue, singletons-core, x-residual-moves module line, x-rs-desktop-pet) and
the G3 items of deferred-g2.md is applied; the fragment files are deleted. The lines below are kept for the task named.

## singletons-core -> s4-engine-runner (wave 6) / s4-tool-adapter, applied by CORE-WIRE-G7

`compose_flip.rs` real_core, next to `let takeover = Arc::new(crate::takeover_port::CoreTakeover::new(takeover_holds.clone()));`:

    let card_holds = Arc::new(mixdog_core_session::session::secret_input::CardHolds::new(human_only.clone()));

Nothing takes it yet (an unused binding is refused by the lint): the browser engine wiring calls `hold_for_request_in` when it raises
`item/browser/requestApproval` and `release` on the answer and on `serverRequest/resolved`. Per review-SINGLETONS-CORE take card holds
for `BrowserApproval` only (Node never held the human-only lock for a secret request; the developer-risk confirm stays the desktop's
`host/humanOnly` hold), and give `CoreTakeover` the lock's drain so a computer-surface takeover also waits for running Computer Use.

## x-residual-moves -> x-residual-moves-client (wave 4); the next core wiring (CORE-WIRE-G7) registers it if no wave-4 task does

No `AttachmentHost` implementation (session transcript window, whole history, attachment bytes by content hash) exists in the tree, so
`DesktopResidualService` is not registered and its six names stay in SERVICE_PENDING: `desktop/link/resolve`, `desktop/link/resolvePath`,
`desktop/attachment/resolve`, `desktop/attachment/stage`, `desktop/workflowConfig/read`, `desktop/fonts/list`. When it lands:

    builder.register(Arc::new(mixdog_core_domains::domains::desktop_residual::DesktopResidualService::new(<attachment_host>, &b.tokens)))?;

after the `migrate_profile::MigrateProfileService` registration, and remove the six names. The implementation must check `sessionId`
(the IPC handler applied `requiredSessionId` before reading a session directory).

## FEATURE-FACTS -> the protocol hot file host.rs (PROTO-WIRE-G7 with CORE-WIRE-G7)

The method-level claim check: `fn serves_method(&self, capability: HostCapability, method: Method) -> bool` (default
`self.serves(capability)`) on `HostChannel` (mixdog-core-api host.rs, a protocol hot file), an override in mixdog-app-server
`Outgoing` = `self.claimant(capability, Some(method)).is_ok()`, then `ToolBridges::present` passes
`|c| host.serves_method(c, <host/browser/command | host/visualize/command | host/computer/*>)`. Until then a claimant that declared the
capability but listed other methods in its `serves` counts as serving it (as before this wave).

## s2b-askpass-server, s2b-ssh-spawn: applied, not compiled

The mixdog-ssh dependency edges (`mixdog-core-api`, `mixdog-protocol`, `rand`; `[dev-dependencies]` mixdog-rt test-support, tempfile)
are in its Cargo.toml. mixdog-ssh is still not a workspace member (deferred-g1.md: its last modules come in wave 5), so neither the
code nor Cargo.lock has them yet; the wiring task that adds the member (deferred-g1.md names CORE-WIRE-G5, which the plan does not
have: the next core wiring is CORE-WIRE-G7) runs `cargo update --workspace --offline` and `cargo hakari generate` then.
