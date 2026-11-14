//! What one connect attempt carries to every ssh it starts, and the seams the ssh code reaches the machine through.
//!
//! The desktop kept the attempt's settings in an `AsyncLocalStorage`; here the [`AttemptContext`] is an explicit
//! argument of every function that spawns. The machine itself (environment, files, the tool runner, the process
//! spawner, the askpass session, the diagnostics rings) reaches the code through [`SshEnv`], so the argument-building
//! code stays pure and a test hands in in-memory stand-ins.

use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use async_trait::async_trait;
use mixdog_app_protocol::v2::connections::HostClaimResources;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncWrite};

use crate::diagnostics::Diagnostics;

/// The operating system the ssh code runs on; it decides where the OpenSSH tools are looked for, whether
/// connection multiplexing may be used and how paths are written.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    Windows,
    MacOs,
    Linux,
}

impl Platform {
    /// The platform this process runs on.
    pub fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::MacOs
        } else {
            Self::Linux
        }
    }

    pub fn is_windows(self) -> bool {
        self == Self::Windows
    }

    /// Node's `process.platform` name for it (`win32`, `darwin`, `linux`).
    pub fn node_name(self) -> &'static str {
        match self {
            Self::Windows => "win32",
            Self::MacOs => "darwin",
            Self::Linux => "linux",
        }
    }
}

/// Where a saved server's model logins live.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelLogin {
    /// The server's daemon runs models with the logins stored on the server.
    Server,
    /// With this PC's logins (the default).
    Pc,
}

/// What a saved server remembers besides its name and address.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_login: Option<ModelLogin>,
    /// Server folder the session opens in: `~`, `~/x` or an absolute server path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_cwd: Option<String>,
    /// Private key file on this PC (passed to ssh with `-i`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity_file: Option<String>,
    /// Re-dial the tunnel when it drops; on unless `Some(false)`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_reconnect: Option<bool>,
    /// Model providers this server may use through this PC; `None`: every provider enabled on this PC.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowed_providers: Option<Vec<String>>,
    /// Minutes the server keeps its work after the connection drops (1-10080, default 30).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grace_minutes: Option<u32>,
}

/// The environment variables an askpass session adds to the ssh it serves, and what the spawn needs to know of it.
pub trait AskpassEnv: Send + Sync {
    /// `SSH_ASKPASS`, `MIXDOG_ASKPASS_ENDPOINT`, `MIXDOG_ASKPASS_TOKEN` and the like.
    fn env(&self) -> Vec<(String, String)>;
    /// The session ended: spawns no longer use it.
    fn closed(&self) -> bool;
    /// Directory of the connection-sharing sockets of the session (not used on Windows).
    fn control_dir(&self) -> Option<PathBuf>;
}

/// Per-connection settings that follow one connect attempt through every ssh the attempt starts.
#[derive(Clone, Default)]
pub struct AttemptContext {
    pub settings: Option<HostSettings>,
    /// Passed to the remote ensure step: stop whatever daemon is running and start ours.
    pub force_restart: bool,
    /// Which server's diagnostics ring the ssh runs of this attempt write to.
    pub diagnostics_key: Option<String>,
    /// Set for the interactive (password / passphrase / one-time code) retry of an attempt.
    pub askpass: Option<Arc<dyn AskpassEnv>>,
}

/// Which `-F` file an ssh gets: the target's own generated config when there is one, else the generic one.
pub trait SshConfigFiles: Send + Sync {
    /// The generated config of the target the argument list addresses.
    fn for_args(&self, args: &[String]) -> Option<PathBuf>;
    /// Mixdog's own ssh config.
    fn generic(&self) -> Option<PathBuf>;
}

/// What the ssh code needs from the file system (a lane job in production, memory in tests).
pub trait ConfigFiles {
    fn read_text(&self, path: &Path) -> Option<String>;
    /// File names in a directory; empty when it does not exist.
    fn list_names(&self, directory: &Path) -> Vec<String>;
    fn is_file(&self, path: &Path) -> bool;
}

/// The files of this PC, read through `mixdog-fsio` under the proof of the lane job the caller runs in.
pub struct LaneFiles<'a, P: mixdog_fsio::ReadProof>(pub &'a P);

impl<P: mixdog_fsio::ReadProof> ConfigFiles for LaneFiles<'_, P> {
    fn read_text(&self, path: &Path) -> Option<String> {
        // Invalid UTF-8 is replaced, as Node's utf8 read did, so one odd byte does not hide the whole file.
        mixdog_fsio::read(self.0, path).ok().map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
    }

    fn list_names(&self, directory: &Path) -> Vec<String> {
        let Ok(entries) = mixdog_fsio::read_dir(self.0, directory) else {
            return Vec::new();
        };
        entries.filter_map(Result::ok).map(|entry| entry.file_name().to_string_lossy().into_owned()).collect()
    }

    fn is_file(&self, path: &Path) -> bool {
        mixdog_fsio::is_file(self.0, path)
    }
}

/// What a short-lived OpenSSH helper (`ssh -G`, `ssh-keygen`, `icacls`) printed.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ToolOutput {
    /// None when the tool was ended by a signal.
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// Runs a helper to the end and captures what it printed; an `Err` means it could not be started or passed its deadline.
#[async_trait]
pub trait ToolRunner: Send + Sync {
    async fn run(&self, command: &Path, args: &[String], timeout: Duration) -> io::Result<ToolOutput>;
}

/// What a spawn really runs: the resolved tool, the argument list after the attempt's rewrites and the environment.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreparedSpawn {
    pub command: PathBuf,
    pub args: Vec<String>,
    /// None: the child inherits this process's environment unchanged.
    pub env: Option<BTreeMap<String, String>>,
}

/// How a child ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChildExit {
    pub code: Option<i32>,
    pub signal: Option<String>,
}

/// A started ssh process.
#[async_trait]
pub trait SshChild: Send {
    fn take_stdin(&mut self) -> Option<Box<dyn AsyncWrite + Send + Unpin>>;
    fn take_stdout(&mut self) -> Option<Box<dyn AsyncRead + Send + Unpin>>;
    fn take_stderr(&mut self) -> Option<Box<dyn AsyncRead + Send + Unpin>>;
    async fn wait(&mut self) -> io::Result<ChildExit>;
    /// Ends the child (and what it started).
    fn kill(&mut self);
}

/// Starts ssh processes; the children live and die with this process.
pub trait SshSpawner: Send + Sync {
    fn spawn(&self, prepared: &PreparedSpawn) -> io::Result<Box<dyn SshChild>>;
}

/// The machine the ssh code runs on.
#[derive(Clone)]
pub struct SshEnv {
    pub platform: Platform,
    /// This process's environment variables.
    pub env: BTreeMap<String, String>,
    /// The user's home directory.
    pub home: PathBuf,
    /// The askpass helper executable handed to ssh as `SSH_ASKPASS`.
    pub askpass_helper: Option<PathBuf>,
    /// Folder holding the server cores the remote install uploads.
    pub server_cores_dir: Option<PathBuf>,
    pub files: Arc<dyn ConfigFiles + Send + Sync>,
    pub config_files: Arc<dyn SshConfigFiles>,
    pub tools: Arc<dyn ToolRunner>,
    pub spawner: Arc<dyn SshSpawner>,
    pub diagnostics: Arc<Diagnostics>,
}

impl SshEnv {
    /// An environment variable by name; on Windows the name matches without regard to case.
    pub fn var(&self, name: &str) -> Option<&str> {
        if let Some(value) = self.env.get(name) {
            return Some(value);
        }
        if self.platform.is_windows() {
            return self.env.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.as_str());
        }
        None
    }
}

/// The environment variable that names the server cores folder, and the one that names the askpass helper.
pub const SERVER_CORES_ENV: &str = "MIXDOG_SERVER_CORES_DIR";
pub const ASKPASS_HELPER_ENV: &str = "MIXDOG_ASKPASS_HELPER";

/// What the desktop that claimed the host role says it keeps (`host/claim` `resources`): where the server cores and the askpass
/// helper are. The claim arrives after the machine is composed, so the ssh code reads this where it needs the folders and not
/// from the environment it was built with.
#[derive(Default)]
pub struct ClaimedResources {
    current: Mutex<HostClaimResources>,
}

impl ClaimedResources {
    /// The resources of the claim that was just accepted (`None`: the claimant named none).
    pub fn set(&self, resources: Option<HostClaimResources>) {
        *self.current.lock().unwrap_or_else(PoisonError::into_inner) = resources.unwrap_or_default();
    }

    /// `env` with the two folders filled in from the claim. They are read after the environment variables: a variable that is set
    /// wins; a folder the desktop named replaces the one found beside the core's own executable; a name the desktop left out
    /// changes nothing.
    pub fn applied(&self, env: &SshEnv) -> SshEnv {
        let claimed = self.current.lock().unwrap_or_else(PoisonError::into_inner).clone();
        let named = |variable: &str, claimed: Option<String>, found: &Option<PathBuf>| -> Option<PathBuf> {
            if env.var(variable).is_some_and(|value| !value.is_empty()) {
                return found.clone();
            }
            claimed.filter(|path| !path.is_empty()).map(PathBuf::from).or_else(|| found.clone())
        };
        SshEnv {
            askpass_helper: named(ASKPASS_HELPER_ENV, claimed.askpass_helper, &env.askpass_helper),
            server_cores_dir: named(SERVER_CORES_ENV, claimed.server_cores_dir, &env.server_cores_dir),
            ..env.clone()
        }
    }
}

#[cfg(test)]
#[path = "base_tests.rs"]
mod base_tests;

#[cfg(test)]
mod claimed_tests {
    use super::*;

    struct NoFiles;

    impl ConfigFiles for NoFiles {
        fn read_text(&self, _path: &Path) -> Option<String> {
            None
        }

        fn list_names(&self, _directory: &Path) -> Vec<String> {
            Vec::new()
        }

        fn is_file(&self, _path: &Path) -> bool {
            false
        }
    }

    struct NoConfig;

    impl SshConfigFiles for NoConfig {
        fn for_args(&self, _args: &[String]) -> Option<PathBuf> {
            None
        }

        fn generic(&self) -> Option<PathBuf> {
            None
        }
    }

    struct NoTools;

    #[async_trait]
    impl ToolRunner for NoTools {
        async fn run(&self, _command: &Path, _args: &[String], _timeout: Duration) -> io::Result<ToolOutput> {
            Ok(ToolOutput::default())
        }
    }

    struct NoSpawn;

    impl SshSpawner for NoSpawn {
        fn spawn(&self, _prepared: &PreparedSpawn) -> io::Result<Box<dyn SshChild>> {
            Err(io::Error::other("no spawn"))
        }
    }

    fn env(vars: &[(&str, &str)], askpass: Option<&str>, cores: Option<&str>) -> SshEnv {
        SshEnv {
            platform: Platform::Linux,
            env: vars.iter().map(|(name, value)| ((*name).to_owned(), (*value).to_owned())).collect(),
            home: PathBuf::from("/home/u"),
            askpass_helper: askpass.map(PathBuf::from),
            server_cores_dir: cores.map(PathBuf::from),
            files: Arc::new(NoFiles),
            config_files: Arc::new(NoConfig),
            tools: Arc::new(NoTools),
            spawner: Arc::new(NoSpawn),
            diagnostics: Arc::new(Diagnostics::new()),
        }
    }

    fn claim(askpass: Option<&str>, cores: Option<&str>) -> HostClaimResources {
        HostClaimResources { server_cores_dir: cores.map(str::to_owned), askpass_helper: askpass.map(str::to_owned) }
    }

    #[test]
    fn the_folders_the_desktop_named_fill_a_machine_that_found_none() {
        let claimed = ClaimedResources::default();
        claimed.set(Some(claim(Some("/app/askpass"), Some("/app/cores"))));
        let applied = claimed.applied(&env(&[], None, None));
        assert_eq!(applied.askpass_helper, Some(PathBuf::from("/app/askpass")));
        assert_eq!(applied.server_cores_dir, Some(PathBuf::from("/app/cores")));
    }

    #[test]
    fn an_environment_variable_wins_and_a_name_left_out_changes_nothing() {
        let claimed = ClaimedResources::default();
        claimed.set(Some(claim(Some("/app/askpass"), None)));
        let applied = claimed.applied(&env(&[(ASKPASS_HELPER_ENV, "/env/askpass")], Some("/env/askpass"), Some("/beside/cores")));
        assert_eq!(applied.askpass_helper, Some(PathBuf::from("/env/askpass")));
        assert_eq!(applied.server_cores_dir, Some(PathBuf::from("/beside/cores")));
        // Without the variable the desktop's folder replaces the one found beside the executable.
        let applied = claimed.applied(&env(&[], Some("/beside/askpass"), None));
        assert_eq!(applied.askpass_helper, Some(PathBuf::from("/app/askpass")));
        // A claim without resources, or an empty name, is no claim.
        claimed.set(None);
        assert_eq!(claimed.applied(&env(&[], Some("/beside/askpass"), None)).askpass_helper, Some(PathBuf::from("/beside/askpass")));
        claimed.set(Some(claim(Some(""), Some(""))));
        assert_eq!(claimed.applied(&env(&[], None, None)).server_cores_dir, None);
    }
}
