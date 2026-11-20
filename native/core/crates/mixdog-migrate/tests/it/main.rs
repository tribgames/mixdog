mod long_session_log;
/// The record encodings of a session log and the migrator over one log, shared with the memory test's own binary.
#[path = "../support/log_harness.rs"]
mod log_harness;
mod migrated_145;
mod supplement;
/// The 1.4.5 data directory and the migrator of the upgrade chain.
#[path = "../support/profile_harness.rs"]
mod profile_harness;
mod upgrade_chain;

