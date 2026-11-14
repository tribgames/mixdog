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
`host/humanOnly` hold). The `CoreTakeover` drain (`with_computer_drain(human_only.clone())`) is applied by G3.5-WIRE (g35-fu-cu).

## x-residual-moves: applied by G3.5-WIRE

DesktopResidualService is registered after MigrateProfileService over g35-fu-x's `DesktopAttachmentHost` (session directory + the one
BlobStore; it checks `sessionId` like `requiredSessionId`); the six names are out of SERVICE_PENDING.

## FEATURE-FACTS: applied by G3.5-WIRE

`HostChannel::serves_method` (default `serves`) in mixdog-core-api host.rs and the `Outgoing` override (`claimant(capability, Some(method))`)
are in; `ToolBridges::present` calls it (g35-fu-cu).

## s2b-askpass-server, s2b-ssh-spawn: applied, not compiled

The mixdog-ssh dependency edges (`mixdog-core-api`, `mixdog-protocol`, `rand`; `[dev-dependencies]` mixdog-rt test-support, tempfile)
are in its Cargo.toml. mixdog-ssh is still not a workspace member (deferred-g1.md: its last modules come in wave 5), so neither the
code nor Cargo.lock has them yet; the wiring task that adds the member (deferred-g1.md names CORE-WIRE-G5, which the plan does not
have: the next core wiring is CORE-WIRE-G7) runs `cargo update --workspace --offline` and `cargo hakari generate` then.
