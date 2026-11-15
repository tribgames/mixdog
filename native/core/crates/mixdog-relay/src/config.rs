//! The command-line block of `server.mjs` (lines 878-897): what the relay reads from its environment.

use std::collections::BTreeMap;
use std::path::PathBuf;

use mixdog_js::nodepath;

/// The port `Number(process.env.PORT || 9800)` gives when `PORT` is unset or empty.
pub const DEFAULT_PORT: f64 = 9800.0;

/// What the relay is started with.
#[derive(Debug, Clone, PartialEq)]
pub struct Config {
    /// A JavaScript number: an empty `PORT` is 9800, text that is not a number is NaN (the listen then fails).
    pub port: f64,
    pub data_dir: String,
    pub renderer_dir: String,
    /// `RENDERER_RELEASES_DIR`, or beside `RENDERER_DIR` when that is set; empty means a single-renderer relay.
    pub renderer_releases_dir: String,
    pub tls_cert: String,
    pub tls_key: String,
    /// The whole environment, handed to the feedback, native push and TURN groups, which parse their own names.
    pub env: BTreeMap<String, String>,
    /// The directory of the running executable: where `mobile-release.json` is read.
    pub install_dir: PathBuf,
}

impl Config {
    /// The configuration of this process: its environment and the directory of its executable.
    pub fn from_process() -> Self {
        let env = std::env::vars_os().map(|(k, v)| (k.to_string_lossy().into_owned(), v.to_string_lossy().into_owned())).collect();
        let install_dir = std::env::current_exe().ok().and_then(|exe| exe.parent().map(PathBuf::from)).unwrap_or_default();
        Self::from_env(env, install_dir)
    }

    pub fn from_env(env: BTreeMap<String, String>, install_dir: PathBuf) -> Self {
        let text = |name: &str, default: &str| env.get(name).filter(|v| !v.is_empty()).cloned().unwrap_or_else(|| default.to_owned());
        let port = match env.get("PORT").filter(|v| !v.is_empty()) {
            Some(value) => mixdog_js::string_to_number(value),
            None => DEFAULT_PORT,
        };
        let renderer_dir = text("RENDERER_DIR", "");
        let renderer_releases_dir = match env.get("RENDERER_RELEASES_DIR").filter(|v| !v.is_empty()) {
            Some(dir) => dir.clone(),
            None if renderer_dir.is_empty() => String::new(),
            // Beside RENDERER_DIR so an already installed unit file needs no edit.
            None => {
                let parent = nodepath::resolve_host(&[renderer_dir.as_str(), ".."]);
                nodepath::resolve_host(&[parent.as_str(), "renderer-releases"])
            }
        };
        Self {
            port,
            data_dir: text("DATA_DIR", "./data"),
            renderer_dir,
            renderer_releases_dir,
            tls_cert: text("TLS_CERT", ""),
            tls_key: text("TLS_KEY", ""),
            env,
            install_dir,
        }
    }

    /// The port Node's `listen` accepts: an integer in 0..=65535. Anything else is the error `listen` throws, which the
    /// relay reports as `[relay] failed to start: <message>`.
    pub fn listen_port(&self) -> Result<u16, String> {
        let port = self.port;
        if port.fract() == 0.0 && (0.0..65536.0).contains(&port) {
            return Ok(port as u16);
        }
        Err(format!("options.port should be >= 0 and < 65536. Received type number ({}).", mixdog_js::number_to_string(port)))
    }

    /// `https` when both TLS files are named, else `http`.
    pub fn scheme(&self) -> &'static str {
        if !self.tls_cert.is_empty() && !self.tls_key.is_empty() { "https" } else { "http" }
    }
}
