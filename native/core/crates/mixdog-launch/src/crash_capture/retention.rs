//! Retention of the core's crash captures (`daemon-crash-capture/retention.mjs`): completed boots share a budget of
//! eight boots and 2 MiB, an oversized completed capture is trimmed to its last 256 KiB, the newest completed boot is never
//! deleted, and active or unknown boots are never touched. The core prunes its own directory with the same functions, so the
//! launcher and the core share one implementation and one set of limits.

use std::path::Path;

use mixdog_app_server_daemon::stale_temps;

pub use stale_temps::Pruned;

/// `pruneDaemonCrashCaptures`: first the debris of atomic sidecar writes whose writer is gone (a live or unidentifiable writer
/// keeps its temp), then the completed boots beyond the budget. `alive` says whether a process may still run.
pub fn prune_crash_captures(dir: &Path, alive: &dyn Fn(u32) -> bool) -> Pruned {
    stale_temps::reclaim_dead_capture_temps(dir, alive);
    stale_temps::prune_crash_captures(dir, alive)
}
