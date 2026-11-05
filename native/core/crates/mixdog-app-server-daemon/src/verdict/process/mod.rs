//! Process and socket facts from the OS tables (LR §3.1): whether a pid names
//! a running process, its identity (pid, start time) and whether it owns a
//! LISTEN socket on a loopback port. Nothing here probes a port or times out.

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
pub(crate) mod windows;

use std::io;
use std::path::PathBuf;

#[cfg(target_os = "linux")]
use linux as sys;
#[cfg(target_os = "macos")]
use macos as sys;
#[cfg(windows)]
use windows as sys;

/// A process by (pid, start time), as Codex's pid record check identifies one.
/// `start_ms` is the OS start time in Unix ms; 0 when the OS denies it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ProcessIdentity {
    pub pid: u32,
    pub start_ms: u64,
}

/// What the user is shown for a blocked verdict.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcessInfo {
    pub identity: ProcessIdentity,
    pub image: Option<PathBuf>,
    pub command_line: Option<String>,
}

pub trait ProcessTable: Send + Sync {
    /// The running process `pid` names; `None` when there is none (never
    /// existed, exited, a zombie, or not a valid pid on this OS).
    fn query(&self, pid: u64) -> io::Result<Option<ProcessInfo>>;
    /// Whether `pid` owns a LISTEN socket on 127.0.0.1:`port`.
    fn listens(&self, pid: u32, port: u16) -> io::Result<bool>;
}

/// The OS process and socket tables.
pub struct OsProcessTable;

/// Valid pids: Windows uses the full `u32` range, Unix `pid_t` is a positive `i32`.
fn os_pid(pid: u64) -> Option<u32> {
    #[cfg(windows)]
    let max = u64::from(u32::MAX);
    #[cfg(unix)]
    let max = i32::MAX as u64;
    (pid > 0 && pid <= max).then_some(pid as u32)
}

impl ProcessTable for OsProcessTable {
    fn query(&self, pid: u64) -> io::Result<Option<ProcessInfo>> {
        match os_pid(pid) {
            Some(pid) => sys::query(pid),
            None => Ok(None),
        }
    }

    fn listens(&self, pid: u32, port: u16) -> io::Result<bool> {
        sys::listens(pid, port)
    }
}

/// This process's identity (discovery `processStartTime`).
pub fn current_identity() -> io::Result<ProcessIdentity> {
    sys::query(std::process::id())?
        .map(|info| info.identity)
        .ok_or_else(|| io::Error::other("own process not in the process table"))
}

/// The start time of the process `pid` currently names, if it runs.
#[cfg(unix)]
pub(crate) fn start_ms(pid: u32) -> io::Result<Option<u64>> {
    Ok(sys::query(pid)?.map(|info| info.identity.start_ms))
}
