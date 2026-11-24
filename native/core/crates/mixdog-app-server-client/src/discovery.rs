//! Client side of the discovery file (LR §4): where a running core listens and the one token that opens both its listeners.
//! The file is written by the daemon; this module only reads it.

use std::path::{Path, PathBuf};

use serde::Deserialize;

/// `<runtime root>/daemon.json`.
pub const DISCOVERY_FILE: &str = "daemon.json";

type Var<'a> = &'a dyn Fn(&str) -> Option<std::ffi::OsString>;

/// Node's `os.tmpdir()`, which 1.4.5 roots the runtime directory in.
fn node_tmpdir(var: Var) -> PathBuf {
    let var = |name: &str| var(name).filter(|value| !value.is_empty());
    #[cfg(windows)]
    {
        let path = var("TEMP").or_else(|| var("TMP")).unwrap_or_else(|| {
            let mut root = var("SystemRoot").or_else(|| var("windir")).unwrap_or_default();
            root.push("\\temp");
            root
        });
        let text = path.to_string_lossy();
        if text.len() > 1 && text.ends_with('\\') && !text.ends_with(":\\") {
            return PathBuf::from(&text[..text.len() - 1]);
        }
        PathBuf::from(path)
    }
    #[cfg(unix)]
    {
        let path = var("TMPDIR").or_else(|| var("TMP")).or_else(|| var("TEMP")).unwrap_or_else(|| "/tmp".into());
        let text = path.to_string_lossy();
        if text.len() > 1 && text.ends_with('/') {
            return PathBuf::from(&text[..text.len() - 1]);
        }
        PathBuf::from(path)
    }
}

fn root_from(var: Var) -> PathBuf {
    if let Some(configured) = var("MIXDOG_RUNTIME_ROOT") {
        let text = configured.to_string_lossy();
        let text = text.trim();
        if !text.is_empty() {
            return std::path::absolute(text).unwrap_or_else(|_| PathBuf::from(text));
        }
    }
    #[cfg(windows)]
    let name = String::from("mixdog");
    #[cfg(unix)]
    // SAFETY: `getuid` has no preconditions and cannot fail.
    let name = format!("mixdog-{}", unsafe { libc::getuid() });
    node_tmpdir(var).join(name)
}

/// The runtime root 1.4.5 clients resolve (`runtime-root.mjs`): `MIXDOG_RUNTIME_ROOT` (trimmed, made absolute), else
/// `tmpdir()/mixdog` on Windows and `tmpdir()/mixdog-<uid>` elsewhere. The core and every launcher share this one definition.
pub fn runtime_root() -> PathBuf {
    root_from(&|name| std::env::var_os(name))
}
pub fn discovery_path() -> PathBuf {
    runtime_root().join(DISCOVERY_FILE)
}

#[derive(Debug, thiserror::Error)]
pub enum DiscoveryError {
    /// No file, or one whose core has ended: no core is running (or it has released).
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
        serde_json::from_slice(bytes).map_err(|e| DiscoveryError::Malformed { path: path.to_path_buf(), message: e.to_string() })
    }

    /// Reads the file anew; callers read it on every connection attempt because the token and the ports change per core.
    /// One read of a document under 1 KiB. The lane-job rule is for core runtime threads; a client process has no lane.
    #[allow(clippy::disallowed_methods)]
    pub fn read(path: &Path) -> Result<Self, DiscoveryError> {
        match std::fs::read(path) {
            Ok(bytes) => Self::parse(&bytes, path),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(DiscoveryError::Absent(path.to_path_buf())),
            Err(source) => Err(DiscoveryError::Read { path: path.to_path_buf(), source }),
        }
    }

    /// The RPC listener and the token that opens it.
    pub fn rpc_endpoint(&self) -> Result<Endpoint, DiscoveryError> {
        let rpc = self.core.rpc.as_ref().ok_or_else(|| DiscoveryError::NoRpc { state: self.core.state.clone() })?;
        Ok(Endpoint { port: rpc.port, token: self.endpoints.session.token.clone() })
    }

    /// The control listener and the token that opens it.
    pub fn control_endpoint(&self) -> Endpoint {
        Endpoint { port: self.core.control.port, token: self.endpoints.session.token.clone() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<std::ffi::OsString> + 'a {
        move |name| pairs.iter().find(|(key, _)| *key == name).map(|(_, value)| (*value).into())
    }

    #[cfg(windows)]
    #[test]
    fn windows_roots_in_temp_before_tmp_as_node_does() {
        let root = root_from(&env(&[("TEMP", "C:\\a"), ("TMP", "C:\\b")]));
        assert_eq!(root, PathBuf::from("C:\\a\\mixdog"));
    }

    #[cfg(unix)]
    #[test]
    fn unix_roots_in_tmp_when_tmpdir_is_unset() {
        let root = root_from(&env(&[("TMP", "/x/")]));
        assert_eq!(root.parent().unwrap(), std::path::Path::new("/x"));
    }

    #[test]
    fn a_configured_root_is_trimmed_and_made_absolute() {
        let root = root_from(&env(&[("MIXDOG_RUNTIME_ROOT", "  rel/dir ")]));
        assert!(root.is_absolute());
        assert!(root.ends_with("rel/dir"));
    }
}
