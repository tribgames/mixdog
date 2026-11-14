# Core wire lines deferred by CORE-WIRE-G2

Every other line of the G2 core fragments (g2x-pcaccess-installer, s1-page-http, s2a-core-blob-refs, s2b-link-machine,
s2b-model-proxy-relay, s2b-server-feed, s2b-ssh-base, s2b-stores, s3-03, s3-04 except the part below, s3-05, s3-06 re-exports,
s3-07, s3-08 module lines, s3-09, s3-10, s3-11, s3-12, s3-13 except the registration, s3-14, s3-15, s4-engine-skeleton,
x-migrate-adopt-core, x-notify-parity) and the G2 items of deferred-g1.md (pageserver module line, mixdog-askpass member,
pcAccess registration) is applied; the fragment files are deleted. The lines below are kept for the task named.

## s3-04 -> CORE-WIRE-G3 (once jpeg-encoder is in the local registry cache)

jpeg-encoder 0.6 is not in the local registry cache (`~/.cargo/registry/cache`), so an offline `--locked` build cannot take it
(png 0.18.1, fdeflate 0.3.7 and miniz_oxide 0.8.9 are cached). `computer_marks_draw.rs` calls `jpeg_encoder::Encoder`, so its
module line waits with the dependencies. Needed first: the lead fetches jpeg-encoder 0.6 into the cache (owner direction 12 keeps it).

- `native/core/Cargo.toml` `[workspace.dependencies]`, next to `jpeg-decoder`:
  `jpeg-encoder = "0.6"` and `png = { version = "0.18", default-features = false }`
- `native/core/crates/mixdog-tools/Cargo.toml` `[dependencies]`: `jpeg-decoder = { workspace = true }`, `jpeg-encoder = { workspace = true }`, `png = { workspace = true }`
- `native/core/crates/mixdog-tools/src/desktop/mod.rs`, after `pub mod computer_linux;`: `mod computer_marks_draw;` (`pub mod` if its caller sits outside mixdog-tools)
- then `cargo update --workspace --offline` and `cargo hakari generate`.
  (`pub mod computer_image_output;` is applied, `pub` because nothing calls it before s3-18.)

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

- s3-06 -> s3-19 (wave 3): the `SavedLoginComputerBackend` wrap in the `computer_pool` session closure. The fragment's provider
  arguments are placeholders: no `SavedLoginTurns` implementation exists and nothing calls `SavedLoginRegistry::settle/forget`;
  wired as written the redaction and pixel guard would never lift (review-s3-06). The two re-exports in secret_input.rs are applied.
- s3-08 -> s3-19 (wave 3): `builder.register(ComputerPointerService::new(pointer_hold))` needs the pool's `PointerHost`;
  `computer/pointerReleased` stays in SERVICE_PENDING.
- s3-13 -> s3-19 (wave 3): the `#[cfg(feature = "test-hooks")]` DevComputerRun registration. `dev/computer/run` stays in
  SERVICE_PENDING, so the separate `unclaimed.retain(|method| *method != "dev/computer/run")` line is not needed; s3-19 keeps the
  name in SERVICE_PENDING (or adds that line) when it registers the service only under the feature and MIXDOGD_TEST_HOOKS=1.
- s3-11 -> FEATURE-FACTS (G3) / s3-19: the `HostPresence` call site.
- s2a-core-blob-refs -> s2a-core-server-wiring (wave 3): `param_refs::expand` in server.rs and
  `mixdog_app_server::param_refs::install(BlobParamRefs::new(..))` in the daemon composition (install returns a Result).
- s1-page-http -> s1-ws-wire (wave 3): mounting `PageServer`.
- s2b-model-proxy-relay -> s2b-service (wave 9): the relay composition.
- s3-03, s3-05, s3-09, s3-10, s3-12 -> s3-18 / s3-19 (wave 3): the consumer notes of their fragments (capture path, run log,
  app-owned routing, display pixels, backend selection); no line here.
- s3-15: packaging of the extension payload (packaging task) and the desktop removal (s3-26). The compose loop is applied.

## g2x-pcaccess-installer: behaviours not in the core yet (review)

The pcAccess service is registered with the production installer (readiness, approve). The review lists what the TS path still
does and the core does not: needs-enroll readiness with the in-flight delegated enroll, approveWithCredential, the delegated enroll
on key delivery, the unpair transaction (recordOwedKey, unpair, revokeOwedNow), revokeOwed/drainDelegated and the one serial
access queue. The desktop's TypeScript PcAccess still serves all of it; a task must carry them before x-pcaccess-desktop /
DESKTOP-WIRE-G4 retire the TS path.
