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

// The tests over a recorded 1.4.5 profile and over the recordings of the old reader: local only.
#[cfg(node_twin)]
mod model_context_corpus;
#[cfg(node_twin)]
mod recorded_145;
#[cfg(node_twin)]
mod recorded_145_readers;
#[cfg(node_twin)]
#[path = "../support/recorded_145.rs"]
mod recorded_145_support;
#[cfg(node_twin)]
mod request_system_corpus;
#[cfg(node_twin)]
mod session_log_migration_node_cases;
#[cfg(node_twin)]
#[path = "../support/long_log.rs"]
mod long_log_support;
#[cfg(node_twin)]
#[path = "node-twin/long_session_log_cases.rs"]
mod long_session_log_cases;
