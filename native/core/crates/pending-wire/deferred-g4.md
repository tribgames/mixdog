# Core wire lines deferred by G4-WIRE

Every other line of the G4 core fragments (s1-page-virtual-client, s2b-tunnel, s4-engine-reply) is applied; the fragment files are
deleted. No line of deferred-g1.md, deferred-g2.md or deferred-g3.md was unblocked in this wave (mixdog-ssh / mixdog-connections
membership and the singletons-core card holds still wait for their waves). The lines below are kept for the task named.

## s2b-tunnel -> the wiring that makes mixdog-ssh a workspace member (CORE-WIRE-G5 per deferred-g1.md; the next core wiring the plan has is CORE-WIRE-G7)

Applied: `mixdog-workspace = { workspace = true }` in crates/mixdog-ssh/Cargo.toml `[dependencies]` (after mixdog-app-server-client).
Not applied: the `"mixdog-workspace",` line in the `mixdog-ssh` package of Cargo.lock. Cargo.lock has no `mixdog-ssh` package
entry at all (the crate is not a member, review-s2b-tunnel), so the line has no place yet; the task that adds the member runs
`cargo update --workspace --offline` and `cargo hakari generate`, which writes the entry with this edge. Not compiled until then.
