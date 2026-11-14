# Core wiring after wave 11 (DELETE-HOT-G11): waiting

- s2a-del-ipc-handlers.wire (Rust line): the operation names `readSessionTranscript` and `readSessionHistory` in
  mixdog-app-protocol schema/operations_map.json, src/inventory.rs (and tests/fixtures/parity-inventory.json) and
  mixdog-core-domains src/domains/desktop_residual.rs have no desktop caller left (the desktop removed them from
  desktop-service-contract.ts, desktop-service-client.ts and shared/core-lanes/session-lane.ts). The protocol lead removes them with
  the next [remove] section; mixdog-core-session reads.rs/seams.rs and mixdog-workspace transfer/replay.rs name them too and must be
  checked for an internal use first. Not applied in DELETE-HOT-G11 (desktop phase).
