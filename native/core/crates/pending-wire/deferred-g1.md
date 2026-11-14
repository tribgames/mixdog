# Core wire lines deferred by CORE-WIRE-G1

Every other line of the G1 core fragments (s1-dl-core, s1-grants-core, s1-openedpath-core, s1-page-policy cargo part,
s2a-core-transport-window, s2b-scaffold workspace.dependencies + zeroize, s3-01a, s4-policy-twins, s4-ui-validate,
x-pcaccess-core) is applied; the fragment files are deleted. The lines below are kept for the wiring task named.

## s1-page-policy -> CORE-WIRE-G2

- `native/core/crates/mixdog-workspace/src/lib.rs`, after `pub mod pathguard;`: `pub mod pageserver;`
  Reason: `pageserver/mod.rs` declares `pub mod http;` and `pub mod serve;` and re-exports `serve::{PageAuthority, PageServer, Refusal}`;
  those files come from s1-page-http (wave 2). With the line applied now mixdog-workspace does not compile.

## s2b-scaffold -> workspace members (native/core/Cargo.toml `[workspace] members`, after "crates/mixdog-app-server-client")

The `[workspace.dependencies]` path entries for the three crates and `zeroize = "1"` are applied (unused until the members are added).
Each member is added by the CORE-WIRE task of the wave that makes the crate buildable (its last module file lands), then `cargo update --workspace --offline` and `cargo hakari generate`:

- `"crates/mixdog-askpass",` -> CORE-WIRE-G2: `src/main.rs` (its `[[bin]]` path) is created by s2b-askpass-helper (wave 2).
- `"crates/mixdog-ssh",` -> CORE-WIRE-G5: lib.rs declares 21 modules; the last ones (`resolved_config`, `session`) come from s2b-resolved-config and s2b-remote-session (wave 5).
- `"crates/mixdog-connections",` -> CORE-WIRE-G9: lib.rs declares 23 modules; `service` comes from s2b-service (wave 9). It also needs mixdog-ssh as a member.
- Note (review of s2b-scaffold): mixdog-askpass has no mixdog-workspace-hack dependency; `cargo hakari manage-deps` may add it when it becomes a member.

## x-pcaccess-core -> compose_flip.rs registration (no wave owns the dependency yet)

- `native/core/crates/mixdog-app-server-daemon/src/compose_flip.rs`, `fn real_core`, directly after the `RemoteAccessService` registration:
  `builder.register(Arc::new(mixdog_core_domains::domains::pc_access::PcAccessService::new(installer, Arc::new(mixdog_core_domains::domains::pc_access::RuntimeRoster(remote_runtime.clone())))))?;`
  Reason: `installer: Arc<dyn PcAccessInstaller>` must be the one production `SecureDesktopInstaller` instance. In this tree that type is
  `pub(super)` in the private `mixdog-tools` `desktop/computer_screen` module, and it is never constructed outside tests: there is no
  production `InstallerPort` implementation in the core yet (the desktop's TypeScript installer still serves PC access). Registering
  the service with a stand-in installer would answer `unavailable`/`failed` where today's desktop works, so it is not registered.
  Needed first: a production `InstallerPort` + `SecureDesktopInstaller` instance in mixdog-tools and a `pub` adapter implementing
  `PcAccessInstaller` over it (mapping as stated in the x-pcaccess-core fragment), reachable from compose_flip.rs.
  The plan has no task creating them; the first consumer of `pcAccess/*` is x-pcaccess-desktop (wave 3), and DESKTOP-WIRE-G4 removes the TS
  secure-desktop creation. Lead/plan item: assign the installer port + adapter to a wave <= 3 and its CORE-WIRE task registers the line above.
  The domain, its protocol rows, `Roster::owe_access`, the `legacy_revokes` module and the fold call in access/runtime.rs are applied.
