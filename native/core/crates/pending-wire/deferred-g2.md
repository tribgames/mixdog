# Core wire lines deferred by CORE-WIRE-G2

Every other line of the G2 core fragments (g2x-pcaccess-installer, s1-page-http, s2a-core-blob-refs, s2b-link-machine,
s2b-model-proxy-relay, s2b-server-feed, s2b-ssh-base, s2b-stores, s3-03, s3-04 except the part below, s3-05, s3-06 re-exports,
s3-07, s3-08 module lines, s3-09, s3-10, s3-11, s3-12, s3-13 except the registration, s3-14, s3-15, s4-engine-skeleton,
x-migrate-adopt-core, x-notify-parity) and the G2 items of deferred-g1.md (pageserver module line, mixdog-askpass member,
pcAccess registration) is applied; the fragment files are deleted. The lines below are kept for the task named.

## s3-04 -> CORE-WIRE-G3 (once jpeg-encoder 0.6 is in the local registry cache)

g25-fu-cu-c replaced the `png` crate with a PNG reader/writer on flate2 (in Cargo.lock), but nothing in the lock encodes JPEG:
`computer_marks_draw.rs` `encode()` answers an error naming jpeg-encoder 0.6 for a JPEG frame, and every real capture is JPEG
(som-overlay.ts toJPEG), so set-of-marks burn-in would be off in use. The module stays unwired until the crate exists offline.
Needed first: the lead fetches **jpeg-encoder 0.6** (crates.io `jpeg-encoder = "0.6"`, no default features needed) into the
registry cache (owner direction 12 keeps it). Not in the cache as of G2.5-WIRE (cached and also not in the lock: image 0.25.9,
zune-jpeg 0.4.21/0.5.12, png 0.17/0.18). Then:

- `native/core/Cargo.toml` `[workspace.dependencies]`, next to `jpeg-decoder`: `jpeg-encoder = "0.6"`
- `native/core/crates/mixdog-tools/Cargo.toml` `[dependencies]`: `flate2 = { workspace = true }`, `jpeg-decoder = { workspace = true }`, `jpeg-encoder = { workspace = true }`
- `computer_marks_draw.rs` `encode()`: the JPEG arm takes the one `jpeg_encoder::Encoder::new(&mut out, quality).encode(..)` call back
- `native/core/crates/mixdog-tools/src/desktop/mod.rs`, after `pub mod computer_linux;`: `mod computer_marks_draw;` (`pub mod` if its caller sits outside mixdog-tools)
- then `cargo update --workspace --offline` and `cargo hakari generate`.
  (`pub mod computer_image_output;` is applied, `pub` because nothing calls it before s3-18.)
- Compose call: none; the capture reply (SOM mode, `image_output: "file"`) is s3-03's / s3-17's wiring.

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
