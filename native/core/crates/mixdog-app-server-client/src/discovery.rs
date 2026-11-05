//! Client side of the discovery file (LR §4): where a running core listens and the one token that opens both its listeners.
//! The file is written by the daemon; this module only reads it.

use std::path::{Path, PathBuf};

use serde::Deserialize;

/// `<runtime root>/daemon.json`.
pub const DISCOVERY_FILE: &str = "daemon.json";

/// The runtime root 1.4.5 clients resolve: `MIXDOG_RUNTIME_ROOT`, else `<tmp>/mixdog` on Windows and `<tmp>/mixdog-<uid>` elsewhere.
pub fn runtime_root() -> PathBuf {
    if let Some(root) = std::env::var_os("MIXDOG_RUNTIME_ROOT").filter(|v| !v.is_empty()) {
        return PathBuf::from(root);
    }
    let tmp = std::env::temp_dir();
    #[cfg(windows)]
    {
        tmp.join("mixdog")
    }
    #[cfg(unix)]
    {
        // SAFETY: `getuid` has no preconditions and cannot fail.
        let uid = unsafe { libc::getuid() };
        tmp.join(format!("mixdog-{uid}"))
    }
}

pub fn discovery_path() -> PathBuf {
    runtime_root().join(DISCOVERY_FILE)
}

#[derive(Debug, thiserror::Error)]
pub enum DiscoveryError {
    /// No file: no core is running (or it has released).
    #[error("no core is running ({0})")]
    Absent(PathBuf),
    #[error("reading {path}: {source}")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    /// The file is not a 1.4.6 core's discovery document.
    #[error("{path}: {message}")]
    Malformed { path: PathBuf, message: String },
    /// The core is not serving, so it has no RPC listener (booting, blocked, migrating, draining).
    #[error("the core is {state} and has no RPC listener")]
    NoRpc { state: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Endpoint {
    pub port: u16,
    pub token: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct PortOf {
    pub port: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Endpoints {
    /// The control listener and the one token (1.4.5 readers use it as their session endpoint).
    pub session: Endpoint,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreInfo {
    pub version: String,
    pub build: String,
    pub instance_id: String,
    pub process_start_time: String,
    /// `booting|blocked|migrating|serving|draining`.
    pub state: String,
    /// Present only in `serving`.
    #[serde(default)]
    pub rpc: Option<PortOf>,
    /// Present while the process lives.
    pub control: PortOf,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Discovery {
    pub pid: u32,
    pub endpoints: Endpoints,
    pub core: CoreInfo,
}

impl Discovery {
    pub fn parse(bytes: &[u8], path: &Path) -> Result<Self, DiscoveryError> {
        serde_json::from_slice(bytes).map_err(|e| DiscoveryError::Malformed {
            path: path.to_path_buf(),
            message: e.to_string(),
        })
    }

    /// Reads the file anew; callers read it on every connection attempt because the token and the ports change per core.
    /// One read of a document under 1 KiB. The lane-job rule is for core runtime threads; a client process has no lane.
    #[allow(clippy::disallowed_methods)]
    pub fn read(path: &Path) -> Result<Self, DiscoveryError> {
        match std::fs::read(path) {
            Ok(bytes) => Self::parse(&bytes, path),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                Err(DiscoveryError::Absent(path.to_path_buf()))
            }
            Err(source) => Err(DiscoveryError::Read {
                path: path.to_path_buf(),
                source,
            }),
        }
    }

    /// The RPC listener and the token that opens it.
    pub fn rpc_endpoint(&self) -> Result<Endpoint, DiscoveryError> {
        let rpc = self.core.rpc.as_ref().ok_or_else(|| DiscoveryError::NoRpc {
            state: self.core.state.clone(),
        })?;
        Ok(Endpoint {
            port: rpc.port,
            token: self.endpoints.session.token.clone(),
        })
    }

    /// The control listener and the token that opens it.
    pub fn control_endpoint(&self) -> Endpoint {
        Endpoint {
            port: self.core.control.port,
            token: self.endpoints.session.token.clone(),
        }
    }
}
