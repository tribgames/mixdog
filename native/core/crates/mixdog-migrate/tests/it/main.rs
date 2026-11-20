/// The record encodings of a session log and the migrator over one log, shared with the memory test's own binary.
#[path = "../support/log_harness.rs"]
mod log_harness;
mod long_session_log;
mod migrated_145;
/// The 1.4.5 data directory and the migrator of the upgrade chain.
#[path = "../support/profile_harness.rs"]
mod profile_harness;
mod supplement;
mod upgrade_chain;
