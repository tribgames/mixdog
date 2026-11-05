//! The `MIXDOG_RESULT` of every mode, as `remote-install-program.ts` documents it.

use serde::Serialize;

use super::error::EnsureError;
use super::host::ServerCore;
use crate::lifecycle::DiscoveryPhase;

/// The core of an older version this run retired. A core is never signalled, so the exit is
/// always the graceful one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Replaced {
    pub pid: u32,
    pub version: String,
    pub graceful: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Stopped {
    pub pid: u32,
    pub stopped: bool,
}

#[derive(Debug, Default, PartialEq, Eq, Serialize)]
pub struct CleanupResult {
    pub stopped: Option<Stopped>,
    pub removed: Vec<String>,
    pub kept: Vec<String>,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub home: String,
    pub uid: u32,
    pub runtime_root: String,
    pub version_dir: String,
    /// This build's `mixdogd` exists on the server.
    pub installed: bool,
    /// The raw discovery file of the core, when one runs (LR §4).
    pub daemon_json: Option<String>,
    /// A core is serving (discovery names an RPC listener).
    pub healthy: bool,
    /// The core is this desktop's version and build.
    pub core_current: bool,
    /// This run started the core.
    pub started: bool,
    pub replaced: Option<Replaced>,
    pub gc_removed: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cleanup: Option<CleanupResult>,
}

impl Report {
    /// What is known without a core.
    pub fn base(paths: &super::layout::RemotePaths, uid: u32, version_dir: &std::path::Path, installed: bool) -> Self {
        let text = |path: &std::path::Path| path.to_string_lossy().into_owned();
        Self {
            home: text(paths.root.parent().unwrap_or(&paths.root)),
            uid,
            runtime_root: text(&paths.runtime_root),
            version_dir: text(version_dir),
            installed,
            daemon_json: None,
            healthy: false,
            core_current: false,
            started: false,
            replaced: None,
            gc_removed: Vec::new(),
            cleanup: None,
        }
    }

    pub fn with_core(mut self, core: &ServerCore, args: &super::args::ProgramArgs) -> Self {
        self.daemon_json = Some(core.raw.clone());
        self.healthy = core.state == DiscoveryPhase::Serving;
        self.core_current = core.version == args.version && core.build == args.build && core.model_proxy == args.wants_model_proxy();
        self
    }
}

/// The lines the desktop parses from stdout: the result, or the error preceded by the drain
/// it can be confirmed against.
pub fn result_line(result: &Result<Report, EnsureError>) -> String {
    match result {
        Ok(report) => {
            let json = serde_json::to_string(report).expect("reports serialize");
            format!("MIXDOG_RESULT {json}\n")
        }
        Err(error) => {
            let drain = match error {
                EnsureError::Busy { drain, .. } => {
                    format!("MIXDOG_DRAIN {}\n", serde_json::to_string(drain).expect("drains serialize"))
                }
                _ => String::new(),
            };
            let message = error.to_string().split_whitespace().collect::<Vec<_>>().join(" ");
            format!("{drain}MIXDOG_ERROR {} {message}\n", error.code())
        }
    }
}
