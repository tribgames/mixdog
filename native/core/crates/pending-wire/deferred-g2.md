# Core wire lines deferred by CORE-WIRE-G2

Every other line of the G2 core fragments (g2x-pcaccess-installer, s1-page-http, s2a-core-blob-refs, s2b-link-machine,
s2b-model-proxy-relay, s2b-server-feed, s2b-ssh-base, s2b-stores, s3-03, s3-04, s3-05, s3-06 re-exports,
s3-07, s3-08 module lines, s3-09, s3-10, s3-11, s3-12, s3-13 except the registration, s3-14, s3-15, s4-engine-skeleton,
x-migrate-adopt-core, x-notify-parity) and the G2 items of deferred-g1.md (pageserver module line, mixdog-askpass member,
pcAccess registration) is applied; the fragment files are deleted. The lines below are kept for the task named.

## s2b-install-wire -> CORE-WIRE-G5 (with the mixdog-ssh workspace member)

mixdog-ssh is not a member (deferred-g1.md: its last modules come in wave 5), and a path dev-dependency of a member makes it one,
so the daemon's parity test cannot build yet. The `mod` line, written by s2b-install-wire, was taken out of
`server_ensure/mod.rs` by CORE-WIRE-G2 (the test file `server_ensure/args_parity_tests.rs` is kept):

- `native/core/crates/mixdog-app-server-daemon/Cargo.toml` `[dev-dependencies]`, after the mixdog-testkit line: `mixdog-ssh = { workspace = true }`
- `native/core/crates/mixdog-app-server-daemon/src/server_ensure/mod.rs`, after `mod report;`: `#[cfg(test)]` / `mod args_parity_tests;`

## mixdog-connections and mixdog-ssh edges (applied, not compiled)

The dependency edges of s2b-link-machine, s2b-model-proxy-relay, s2b-server-feed and s2b-stores (mixdog-connections/Cargo.toml,
merged into one `[dependencies]` and one `[dev-dependencies]` list), the s2b-ssh-base edges (regex, hmac, sha1) and the
`#[cfg(test)] mod stores_tests;` line of mixdog-connections/src/lib.rs are in the tree. Neither crate is a member (CORE-WIRE-G5 /
CORE-WIRE-G9 add them, deferred-g1.md), so none of this code or its tests has been compiled; the first compile is theirs.

## Compose calls owned by later tasks (not CORE-WIRE lines)

- s3-06: applied by G2.5-WIRE (g25-fu-cu-a gave the turn clock `SavedLoginTurnClock` and `SettlingSavedLogins`, which call
  `SavedLoginRegistry::settle/forget`): the `SavedLoginComputerBackend` wrap, `FullRedactor` for the computer backends and the
  browser channel, and `SettlingSavedLogins` around `SessionDeps.snapshots` are in compose_flip.rs.
- s3-08 -> s3-19 (wave 3): `builder.register(ComputerPointerService::new(pointer_hold))` needs the pool's `PointerHost`;
  `computer/pointerReleased` stays in SERVICE_PENDING.
- s3-13: applied by G2.5-WIRE with the g25-fu-cu-b snippet (`#[cfg(feature = "test-hooks")]` DevComputerRun over the pool,
  registered only with MIXDOGD_TEST_HOOKS=1); `dev/computer/run` stays in SERVICE_PENDING so an ordinary start leaves it unclaimed.
- s3-11 -> FEATURE-FACTS (G3) / s3-19: the `HostPresence` call site.
- s2a-core-blob-refs -> s2a-core-server-wiring (wave 3): `param_refs::expand` in server.rs and
  `mixdog_app_server::param_refs::install(BlobParamRefs::new(..))` in the daemon composition (install returns a Result).
- s1-page-http -> s1-ws-wire (wave 3): mounting `PageServer`.
- s2b-model-proxy-relay -> s2b-service (wave 9): the relay composition.
- s3-03, s3-05, s3-09, s3-10, s3-12 -> s3-18 / s3-19 (wave 3): the consumer notes of their fragments (capture path, run log,
  app-owned routing, display pixels, backend selection); no line here.
- s3-15: packaging of the extension payload (packaging task) and the desktop removal (s3-26). The compose loop is applied.

## g2x-pcaccess-installer: behaviours carried by g25-fu-x (applied by G2.5-WIRE)

needs-enroll readiness, approveWithCredential, the delegated enroll on key delivery, the unpair transaction, revokeOwed/
drainDelegated and the one serial access queue are in PcAccessService; compose_flip.rs builds PC access before remote access,
binds the runtime events (`SectionEvents::bind_pc_access`) and gives RemoteAccessService `with_pc_access`. Still open:
- s3-screen-source (G7): the phone screen control's ScreenPcAccess port calls `approve_with_credential` (mapping in the deleted
  fragment's block 6: `cancelled` = the session's abort, outcome by `KeyOutcome::name()`, `busy` for Busy, the same
  production_installer instance for the lease's InstallPort).
- x-pcaccess-desktop (G3): the desktop maps needsEnroll / revocations-unknown and stops its TS createPcAccess queue (until then
  the TS queue and the core queue both drive the installer exe, review-g25-fu-x).
