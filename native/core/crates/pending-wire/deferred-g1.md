# Core wire lines deferred by CORE-WIRE-G1

Every other line of the G1 core fragments is applied. CORE-WIRE-G2 applied the G2 items of this file (the `pageserver`
module line of s1-page-policy, the `crates/mixdog-askpass` member, the pcAccess registration through g2x-pcaccess-installer);
the lines below are still kept for the wiring task named.

## s2b-scaffold -> workspace members (native/core/Cargo.toml `[workspace] members`, after "crates/mixdog-askpass")

Each member is added by the CORE-WIRE task of the wave that makes the crate buildable (its last module file lands), then
`cargo update --workspace --offline` and `cargo hakari generate`:

- `"crates/mixdog-ssh",` -> CORE-WIRE-G5: lib.rs declares 21 modules; the last ones (`resolved_config`, `session`) come from s2b-resolved-config and s2b-remote-session (wave 5).
- `"crates/mixdog-connections",` -> CORE-WIRE-G9: lib.rs declares 23 modules; `service` comes from s2b-service (wave 9). It also needs mixdog-ssh as a member.
- mixdog-askpass is kept out of the workspace-hack (`.config/hakari.toml` `[final-excludes]`): it is a std-only helper binary.
