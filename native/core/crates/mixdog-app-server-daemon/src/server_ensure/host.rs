//! What `server-ensure` needs from the machine it runs on. The composition root implements
//! these over the process table, the discovery file, the control client and the detached
//! launcher; tests use recorders.

use std::path::PathBuf;
use std::time::Duration;

use serde::Serialize;

use super::error::EnsureError;
use crate::lifecycle::DiscoveryPhase;
use crate::lifecycle::RunningWork;
use crate::lifecycle::StopReason;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessImage {
    pub pid: u32,
    /// The executable the process runs from.
    pub image: PathBuf,
}

impl ProcessImage {
    /// The executable lives under dir. Windows paths are case-insensitive and the OS may
    /// report the \\?\ form of the same path.
    pub fn within(&self, dir: &std::path::Path) -> bool {
        #[cfg(windows)]
        {
            let plain = |path: &std::path::Path| PathBuf::from(path.to_string_lossy().trim_start_matches(r"\\?\").to_lowercase());
            plain(&self.image).starts_with(plain(dir))
        }
        #[cfg(not(windows))]
        self.image.starts_with(dir)
    }
}

pub trait EnsureHost {
    /// `$HOME` of the user running the program: `~/.mixdog-remote` lives there.
    fn home(&self) -> PathBuf;
    fn uid(&self) -> u32;
    fn hostname(&self) -> String;
    fn process_alive(&self, pid: u32) -> bool;
    /// Every process's executable; `None` when they cannot be listed. An unanswered question
    /// is never evidence that a directory is unused, so garbage collection then removes
    /// nothing.
    fn process_images(&self) -> Option<Vec<ProcessImage>>;
    fn now_ms(&self) -> u64;
    /// Lets another installer finish: the install lock is a directory lock shared with 1.4.5
    /// installers and has no notification.
    fn pause(&self, duration: Duration);
}

/// A core found through discovery on this server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerCore {
    pub pid: u32,
    pub version: String,
    pub build: String,
    pub instance_id: String,
    pub state: DiscoveryPhase,
    pub process_start_time: String,
    pub control_port: u16,
    /// The core runs models through the desktop's model proxy (discovery ndpoints.modelProxy).
    #[serde(skip)]
    pub model_proxy: bool,
    #[serde(skip)]
    pub token: String,
    /// The discovery file as read; the desktop parses it itself (LR §4).
    #[serde(skip)]
    pub raw: String,
}

/// The reply of `stop` on a core: the drain it is in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DrainReport {
    pub drain_id: String,
    pub running: Vec<RunningWork>,
    pub confirm_token: String,
}

/// How a launched core ended its boot, as far as `server-ensure` waits for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CoreReport {
    /// Discovery names the launched process in a state past `booting`.
    Reached(ServerCore),
    /// The launched process exited before discovery named it.
    Exited { status: Option<i32> },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    pub exe: PathBuf,
    pub args: Vec<String>,
    /// The runtime root, Mixdog home and data dir of the desktop-managed core, kept apart from
    /// a core of the user's own install.
    pub env: Vec<(String, String)>,
    /// Variables the core must not inherit from the launching session (Node deletes
    /// `MIXDOG_MODEL_PROXY` for the server's own logins, `remote-install-daemon.ts:220`).
    pub env_remove: Vec<String>,
    pub log: PathBuf,
}

/// The server's core: discovery, the management path, the process.
pub trait CoreAccess {
    /// The core named by discovery whose process is alive and that announces a `core` block.
    /// A 1.4.5 daemon has none; the starting core waits for it (LR §3.1 `waitExit`).
    fn discovery(&self) -> Result<Option<ServerCore>, EnsureError>;
    /// `POST /mgmt/hold{on}`.
    fn hold(&self, core: &ServerCore, on: bool) -> Result<(), EnsureError>;
    /// `POST /mgmt/stop{whenIdle, reason}`: idempotent on a core already draining.
    fn stop_when_idle(&self, core: &ServerCore, reason: StopReason) -> Result<DrainReport, EnsureError>;
    /// `POST /mgmt/stop{abortConfirmed, reason, confirmToken}`.
    fn stop_confirmed(&self, core: &ServerCore, reason: StopReason, confirm_token: &str) -> Result<(), EnsureError>;
    /// Blocks until the OS reports the process (pid and start time) gone.
    fn wait_exit(&self, core: &ServerCore) -> Result<(), EnsureError>;
    /// Starts the core detached from this process's lifetime.
    