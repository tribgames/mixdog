//! JSON state files as `src/runtime/shared/atomic-file.mjs` keeps them, once for every crate:
//! atomic publication (temp file, fsync of the file and optionally the directory, rename with
//! Windows retries), a `.bak` of the replaced version, damaged-file recovery
//! (`<file>.corrupt-<ms>` plus `.bak` restore), the newer-version guard, and a per-file lock
//! with Node's timeout.
//!
//! Every function is blocking file I/O and takes the proof of the lane job it runs in
//! ([`mixdog_rt::InLane`]): reads on a read lane, writes and locks on a write lane. Waiting
//! for a held lock or a refused rename sleeps on that lane thread, never on an executor.
//! Callers that must not occupy a lane thread while waiting for another writer of the same
//! file order those writers themselves before submitting the job.
#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "every file call here runs inside a lane job (the InLane proof argument)"
)]

mod access;
mod json;
mod lock;
mod publish;
mod trace;

#[cfg(test)]
mod golden_tests;
#[cfg(test)]
mod tests;

pub use access::Access;
pub use access::create_new;
pub use access::create_private_dir_all;
pub use access::is_owner_only;
pub use access::sync_dir;
pub use access::unlaned;
#[cfg(windows)]
pub use access::verbatim_wide;
pub use json::Invalid;
pub use json::Peek;
pub use json::StateError;
pub use json::Validate;
pub use json::is_json_content;
pub use json::json_bytes;
pub use json::parse_json_text;
pub use json::peek;
pub use json::read_json;
pub use json::rename_with_retry;
pub use json::update_json;
pub use json::with_lock;
pub use json::write_file;
pub use json::write_file_stepped;
pub use json::write_json;
pub use lock::LockError;
pub use lock::LockOpts;
pub use lock::default_timeout;
pub use lock::lock_path;
pub use publish::Opts;
pub use publish::PublishFailure;
pub use publish::Step;
pub use publish::Published;
pub use publish::holds_no_data;
pub use publish::read_content;

use mixdog_rt::DurabilityIo;
use mixdog_rt::InteractiveIo;
use mixdog_rt::LaneToken;
use mixdog_rt::MaintenanceIo;

/// Lanes that may read state files.
pub trait IoLane: LaneToken {}
impl IoLane for InteractiveIo {}
impl IoLane for DurabilityIo {}
impl IoLane for MaintenanceIo {}

/// Lanes that may write state files and take their locks.
pub trait WriteLane: IoLane {}
impl WriteLane for DurabilityIo {}
impl WriteLane for MaintenanceIo {}
