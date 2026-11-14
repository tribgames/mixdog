//! Crash and lifecycle capture for the core's launchers (`packages/protocol-client/src/launch/crash-capture`).
//!
//! A fatal error of the core (a panic, an abort) is printed straight to FILE DESCRIPTOR 2, below every hook of the core's own
//! logging, and a launcher's stderr pipe stops being drained the moment the launcher detaches or exits. So the launcher hands
//! the core an append file for fd 2 instead of a pipe ([`spawn_capture`]); the kernel keeps that descriptor open for the core's
//! whole life, independent of the launcher. A JSON sidecar records the correlated lifecycle as far as the launcher can observe
//! it; it carries no environment, argument or credential material. The core writes its own exit into the same sidecar
//! (`mixdog_app_server_daemon::crash_record`). Retention of completed boots is [`retention`].

pub mod exit_record;
pub mod paths;
pub mod retention;
pub mod spawn_capture;

pub use exit_record::describe_exit;
pub use paths::capture_dir;
pub use paths::data_dir;
pub use paths::process_capture_dir;
pub use retention::Pruned;
pub use retention::prune_crash_captures;
pub use spawn_capture::CaptureOptions;
pub use spawn_capture::CaptureRecord;
pub use spawn_capture::CaptureSummary;
pub use spawn_capture::SpawnCapture;

/// `isPidAlive` / `processRuns`: whether the process `pid` may still run. Only the process table's "no such process" proves it
/// gone; a table that cannot answer proves nothing, so the process counts as running and its files are kept.
pub fn process_runs(pid: u32) -> bool {
    mixdog_app_server_daemon::crash_record::pid_alive(&mixdog_app_server_daemon::verdict::OsProcessTable, pid)
}
