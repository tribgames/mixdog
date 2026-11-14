//! Launcher side of "attach or start" (`ensure-core.mjs`): reads discovery, starts a core when none runs, and waits until
//! discovery says `serving` (lifecycle spec section 5.4: "launcher start = spawn detached -> discovery serving").
//!
//! Proxy: nothing about the system proxy is handed to the core. The core reads it itself (`mixdog_ai::netproxy`, which
//! `mixdogd serve` composes at start-up through `NetworkProxy::new` over the process environment and `SystemProxy`), so the
//! launcher starts it with the environment it has and adds nothing to it.

use std::ffi::OsString;
use std::path::PathBuf;
use std::process::Command;
use std::process::Stdio;
use std::time::Duration;
use std::time::Instant;

use mixdog_app_server_client::api::ClientError;
use mixdog_app_server_client::discovery::Discovery;
use mixdog_app_server_client::discovery::DiscoveryError;
use mixdog_app_server_client::discovery::discovery_path;
use serde_json::Value;

use crate::crash_capture::CaptureOptions;
use crate::crash_capture::SpawnCapture;
use crate::crash_capture::paths::data_dir;
use crate::crash_capture::process_runs;
use crate::crash_capture::spawn_capture::Log;

/// How long a launcher waits for a core to serve (`MIXDOG_DAEMON_READY_TIMEOUT_MS` overrides it).
pub const DEFAULT_READY_TIMEOUT: Duration = Duration::from_millis(15_000);
/// How often discovery is read while waiting.
pub const POLL: Duration = Duration::from_millis(50);

/// `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW`: what `windowsHide` plus `detached` give a spawn in Node.
#[cfg(windows)]
const DETACHED_FLAGS: u32 = 0x0000_0008 | 0x0000_0200 | 0x0800_0000;
/// `CREATE_NO_WINDOW`: a core that ends with its launcher (the desktop app) is an ordinary child with no console window.
#[cfg(windows)]
const CHILD_FLAGS: u32 = 0x0800_0000;

#[derive(Debug)]
pub enum EnsureError {
    Spawn { bin: String, message: String },
    /// A core is there and will not serve (`blocked`: the user's decision), or none served in time.
    NotReady { state: Option<String>, blocked: Option<Value> },
    /// The core this launcher started ended abnormally before serving.
    EndedBeforeServing { reason: String, said: Option<String>, code: Option<i64>, signal: Option<String>, stderr_path: Option<PathBuf> },
    Discovery(DiscoveryError),
}

impl std::fmt::Display for EnsureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Spawn { bin, message } => write!(f, "cannot start {bin}: {message}"),
            Self::NotReady { state, blocked } => {
                match state {
                    Some(state) => write!(f, "core is not ready: the core is {state}")?,
                    None => write!(f, "core is not ready: no core published its endpoint")?,
                }
                match blocked {
                    Some(blocked) => write!(f, " ({blocked})"),
                    None => Ok(()),
                }
            }
            Self::EndedBeforeServing { reason, said, .. } => {
                write!(f, "core is not ready: the core ended before serving ({reason})")?;
                match said {
                    Some(said) => write!(f, ": {said}"),
                    None => Ok(()),
                }
            }
            Self::Discovery(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for EnsureError {}

impl From<DiscoveryError> for EnsureError {
    fn from(error: DiscoveryError) -> Self {
        Self::Discovery(error)
    }
}

/// The discovery document of a core, with what the typed one does not carry: why a `blocked` core is blocked.
#[derive(Debug, Clone)]
pub struct CoreView {
    pub discovery: Discovery,
    pub blocked: Option<Value>,
}

/// What `ensure_core` asks of the machine; [`SystemHost`] is the real one.
pub trait CoreHost: Sync {
    /// `readDiscovery`: `None` when no core published one.
    fn read_discovery(&self) -> Result<Option<CoreView>, DiscoveryError>;
    /// Whether the process `pid` still runs.
    fn runs(&self, pid: u32) -> bool;
    /// `launchCore`: starts a core and answers the boot's capture.
    fn launch(&self) -> Result<SpawnCapture, EnsureError>;
}

/// What a launcher decides.
#[derive(Clone)]
pub struct EnsureOptions {
    /// The core binary; [`core_binary`] when not named.
    pub bin: Option<PathBuf>,
    pub ready_timeout: Duration,
    /// `false` for a launcher that owns its core (the desktop app): the core is an ordinary child and ends with it.
    pub detached: bool,
    pub log: Log,
    /// The discovery file; the process's runtime root when not named.
    pub discovery_path: Option<PathBuf>,
    /// The data folder whose `daemon-crash` keeps the capture; the process's when not named.
    pub data_dir: Option<PathBuf>,
    /// Variables the core starts with beyond the launcher's own environment.
    pub env: Vec<(OsString, OsString)>,
}

impl Default for EnsureOptions {
    fn default() -> Self {
        Self {
            bin: None,
            ready_timeout: ready_timeout_of_process(),
            detached: true,
            log: std::sync::Arc::new(|_| {}),
            discovery_path: None,
            data_dir: None,
            env: Vec::new(),
        }
    }
}

/// `Number(process.env.MIXDOG_DAEMON_READY_TIMEOUT_MS) || 15000`.
fn ready_timeout_of_process() -> Duration {
    let configured = std::env::var("MIXDOG_DAEMON_READY_TIMEOUT_MS").ok().and_then(|text| text.trim().parse::<f64>().ok()).filter(|ms| ms.is_finite() && *ms != 0.0);
    // A negative number is a wait of the least length (`Math.max(1, ...)`).
    configured.map_or(DEFAULT_READY_TIMEOUT, |ms| Duration::from_millis(if ms < 0.0 { 1 } else { ms as u64 }))
}

/// `mixdogd`: `MIXDOGD_BIN` when set (development), else the one beside the running executable, else under `core/` beside it
/// (the packaged desktop's layout), else the name itself for the system's search path.
pub fn core_binary() -> PathBuf {
    if let Some(bin) = std::env::var_os("MIXDOGD_BIN").filter(|bin| !bin.is_empty()) {
        return PathBuf::from(bin);
    }
    let name = if cfg!(windows) { "mixdogd.exe" } else { "mixdogd" };
    if let Some(dir) = std::env::current_exe().ok().and_then(|exe| exe.parent().map(std::path::Path::to_path_buf)) {
        for candidate in [dir.join(name), dir.join("core").join(name)] {
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    PathBuf::from(name)
}

/// A detached core leaves this process's console and process group (Windows: no console and no window) or session (Unix), so it
/// outlives it; a core a launcher owns is an ordinary child with no window.
#[cfg(windows)]
fn detach(command: &mut Command, detached: bool) {
    std::os::windows::process::CommandExt::creation_flags(command, if detached { DETACHED_FLAGS } else { CHILD_FLAGS });
}

#[cfg(unix)]
fn detach(command: &mut Command, detached: bool) {
    if detached {
        // SAFETY: `setsid` is async-signal-safe and touches no memory of this process; it runs between fork and exec.
        unsafe {
            std::os::unix::process::CommandExt::pre_exec(command, || {
                libc::setsid();
                Ok(())
            });
        }
    }
}

/// The machine: discovery file, process table, `mixdogd serve`.
pub struct SystemHost {
    bin: PathBuf,
    discovery_path: PathBuf,
    data_dir: Option<PathBuf>,
    detached: bool,
    log: Log,
    env: Vec<(OsString, OsString)>,
}

impl SystemHost {
    pub fn new(options: &EnsureOptions) -> Self {
        Self {
            bin: options.bin.clone().unwrap_or_else(core_binary),
            discovery_path: options.discovery_path.clone().unwrap_or_else(discovery_path),
            data_dir: options.data_dir.clone().or_else(data_dir),
            detached: options.detached,
            log: options.log.clone(),
            env: options.env.clone(),
        }
    }
}

impl CoreHost for SystemHost {
    fn read_discovery(&self) -> Result<Option<CoreView>, DiscoveryError> {
        let bytes = match std::fs::read(&self.discovery_path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(source) => return Err(DiscoveryError::Read { path: self.discovery_path.clone(), source }),
        };
        let discovery = Discovery::parse(&bytes, &self.discovery_path)?;
        let blocked = serde_json::from_slice::<Value>(&bytes).ok().and_then(|document| document.pointer("/core/blocked").filter(|blocked| !blocked.is_null()).cloned());
        Ok(Some(CoreView { discovery, blocked }))
    }

    fn runs(&self, pid: u32) -> bool {
        process_runs(pid)
    }

    /// Starts `mixdogd serve` detached from this process, so closing the terminal never stops running work: a hidden console on
    /// Windows, its own session on Unix, stdin and stdout null, fd 2 the boot's crash capture (`<data>/daemon-crash`), whose
    /// sidecar the core fills with its own exit. A launcher that owns its core (`detached` false) starts it as an ordinary child.
    fn launch(&self) -> Result<SpawnCapture, EnsureError> {
        (self.log)("starting core");
        let mut capture_options = CaptureOptions::new("core");
        capture_options.log = self.log.clone();
        capture_options.data_dir = self.data_dir.clone();
        let capture = SpawnCapture::begin(capture_options);
        let mut command = Command::new(&self.bin);
        command.arg("serve").envs(self.env.iter().map(|(name, value)| (name, value))).stdin(Stdio::null()).stdout(Stdio::null()).stderr(capture.stderr_stdio());
        detach(&mut command, self.detached);
        match command.spawn() {
            Ok(child) => {
                capture.attach(child, self.detached);
                Ok(capture)
            }
            Err(error) => {
                capture.note_spawn_error(&error.to_string());
                Err(EnsureError::Spawn { bin: self.bin.display().to_string(), message: error.to_string() })
            }
        }
    }
}

/// The core this launcher started has ended without serving, when nothing else can still bring one up: it ended abnormally (a
/// clean exit is a contender that lost the claim to another core, which is waited for), and discovery names no core or names
/// the ended one. `None` while that is not known.
fn ended_before_serving(capture: Option<&SpawnCapture>, last: Option<&CoreView>) -> Option<EnsureError> {
    let capture = capture?;
    let record = capture.snapshot();
    record.exited_at.as_ref()?;
    if record.exit_code == Some(0) && record.exit_signal.is_none() {
        return None;
    }
    if last.is_some_and(|view| Some(view.discovery.pid) != record.pid) {
        return None;
    }
    let summary = capture.summary();
    let reason = summary.exit_reason.filter(|reason| !reason.is_empty()).unwrap_or_else(|| match (&record.exit_signal, record.exit_code) {
        (Some(signal), _) => format!("killed by {signal}"),
        (None, Some(code)) => format!("exited with code {code}"),
        (None, None) => "exited with code ?".to_owned(),
    });
    Some(EnsureError::EndedBeforeServing {
        reason,
        said: summary.stderr_error_line.or(summary.stderr_last_line),
        code: record.exit_code,
        signal: record.exit_signal,
        stderr_path: summary.stderr_path,
    })
}

fn not_ready(last: Option<&CoreView>) -> EnsureError {
    EnsureError::NotReady { state: last.map(|view| view.discovery.core.state.clone()), blocked: last.and_then(|view| view.blocked.clone()) }
}

/// The serving core's discovery. A `blocked` core is the user's decision, so it fails at once instead of waiting; `booting`,
/// `migrating` and `draining` end by themselves, so they are waited out. A core this call started that ends abnormally before
/// serving fails at once too, with its exit and what it last said.
///
/// A discovery file outlives a process that was killed: one that names a process no longer running names no core, so a core
/// is started as when there is no file. Waiting for it never ends. When another launcher wins the race to start the core, this
/// one attaches to the winner: its own contender exits cleanly having lost the claim, and discovery then names the winner.
pub async fn wait_for_core(host: &dyn CoreHost, ready_timeout: Duration, poll: Duration) -> Result<CoreView, EnsureError> {
    let deadline = Instant::now() + ready_timeout.max(Duration::from_millis(1));
    let mut launched = false;
    let mut capture: Option<SpawnCapture> = None;
    let mut last: Option<CoreView> = None;
    while Instant::now() < deadline {
        last = host.read_discovery()?;
        if last.as_ref().is_some_and(|view| !host.runs(view.discovery.pid)) {
            last = None;
        }
        if let Some(view) = last.as_ref().filter(|view| view.discovery.core.state == "serving" && view.discovery.core.rpc.is_some()) {
            if let Some(capture) = &capture {
                capture.note_ready();
            }
            return Ok(view.clone());
        }
        if last.as_ref().is_some_and(|view| view.discovery.core.state == "blocked") {
            return Err(not_ready(last.as_ref()));
        }
        if let Some(ended) = ended_before_serving(capture.as_ref(), last.as_ref()) {
            return Err(ended);
        }
        if last.is_none() && !launched {
            launched = true;
            capture = Some(host.launch()?);
        }
        let left = deadline.saturating_duration_since(Instant::now());
        mixdog_rt::time::sleep(poll.min(left.max(Duration::from_millis(1)))).await;
    }
    Err(not_ready(last.as_ref()))
}

/// Attach to the serving core, starting one when none runs.
pub async fn ensure_core(options: EnsureOptions) -> Result<Discovery, EnsureError> {
    let host = SystemHost::new(&options);
    wait_for_core(&host, options.ready_timeout, POLL).await.map(|view| view.discovery)
}

/// The line a launcher prints when its connection to the core fails: `mixdog: <the protocol's message>`. A version refusal
/// from `initialize` names who is outdated and both versions.
pub fn client_error_line(error: &ClientError) -> String {
    match error {
        ClientError::VersionRefused { reason, server_version, client_version } => {
            format!("mixdog: version refused: {reason} (core {server_version}, this program {client_version})")
        }
        other => format!("mixdog: {other}"),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::sync::atomic::AtomicU32;
    use std::sync::atomic::Ordering;

    use mixdog_app_server_client::discovery::CoreInfo;
    use mixdog_app_server_client::discovery::Endpoint;
    use mixdog_app_server_client::discovery::Endpoints;
    use mixdog_app_server_client::discovery::PortOf;

    use super::*;

    fn view(pid: u32, state: &str, rpc: bool, blocked: Option<Value>) -> CoreView {
        CoreView {
            discovery: Discovery {
                pid,
                endpoints: Endpoints { session: Endpoint { port: 1, token: "t".to_owned() } },
                core: CoreInfo {
                    version: "1".to_owned(),
                    build: "b".to_owned(),
                    instance_id: "i".to_owned(),
                    process_start_time: "p".to_owned(),
                    state: state.to_owned(),
                    rpc: rpc.then_some(PortOf { port: 2 }),
                    control: PortOf { port: 3 },
                },
            },
            blocked,
        }
    }

    /// A host whose discovery is what the test says on each read, and which counts the starts.
    struct Script {
        reads: Mutex<Vec<Option<CoreView>>>,
        dead: Vec<u32>,
        launches: AtomicU32,
        captures: tempfile::TempDir,
    }

    impl Script {
        fn new(reads: Vec<Option<CoreView>>) -> Self {
            Self { reads: Mutex::new(reads), dead: Vec::new(), launches: AtomicU32::new(0), captures: tempfile::tempdir().unwrap() }
        }
    }

    impl CoreHost for Script {
        fn read_discovery(&self) -> Result<Option<CoreView>, DiscoveryError> {
            let mut reads = self.reads.lock().unwrap();
            Ok(if reads.len() > 1 { reads.remove(0) } else { reads[0].clone() })
        }
        fn runs(&self, pid: u32) -> bool {
            !self.dead.contains(&pid)
        }
        fn launch(&self) -> Result<SpawnCapture, EnsureError> {
            self.launches.fetch_add(1, Ordering::SeqCst);
            let mut options = CaptureOptions::new("core");
            options.dir = Some(self.captures.path().to_path_buf());
            options.prune = false;
            Ok(SpawnCapture::begin(options))
        }
    }

    const FAST: Duration = Duration::from_millis(1);

    #[tokio::test]
    async fn a_serving_core_is_attached_to_without_starting_one() {
        let host = Script::new(vec![Some(view(7, "serving", true, None))]);
        let found = wait_for_core(&host, Duration::from_secs(5), FAST).await.unwrap();
        assert_eq!(found.discovery.pid, 7);
        assert_eq!(host.launches.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn no_core_starts_one_once_and_waits_through_booting_and_migrating() {
        let host = Script::new(vec![None, None, Some(view(9, "booting", false, None)), Some(view(9, "migrating", false, None)), Some(view(9, "serving", true, None))]);
        let found = wait_for_core(&host, Duration::from_secs(5), FAST).await.unwrap();
        assert_eq!(found.discovery.pid, 9);
        assert_eq!(host.launches.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_discovery_naming_a_vanished_process_names_no_core() {
        let mut host = Script::new(vec![Some(view(5, "serving", true, None)), Some(view(8, "serving", true, None))]);
        host.dead = vec![5];
        let found = wait_for_core(&host, Duration::from_secs(5), FAST).await.unwrap();
        assert_eq!((found.discovery.pid, host.launches.load(Ordering::SeqCst)), (8, 1));
    }

    #[tokio::test]
    async fn a_blocked_core_fails_at_once_with_what_blocks_it() {
        let host = Script::new(vec![Some(view(7, "blocked", false, Some(serde_json::json!({ "reason": "newer data" }))))]);
        let error = wait_for_core(&host, Duration::from_secs(5), FAST).await.unwrap_err();
        assert_eq!(error.to_string(), r#"core is not ready: the core is blocked ({"reason":"newer data"})"#);
        assert_eq!(host.launches.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_core_that_never_publishes_ends_the_wait_with_the_timeout_text() {
        let host = Script::new(vec![None]);
        let error = wait_for_core(&host, Duration::from_millis(60), FAST).await.unwrap_err();
        assert_eq!(error.to_string(), "core is not ready: no core published its endpoint");
        assert_eq!(host.launches.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_core_that_stays_draining_ends_the_wait_naming_its_state() {
        let host = Script::new(vec![Some(view(7, "draining", false, None))]);
        let error = wait_for_core(&host, Duration::from_millis(60), FAST).await.unwrap_err();
        assert_eq!(error.to_string(), "core is not ready: the core is draining");
    }

    #[test]
    fn a_version_refusal_is_one_mixdog_line() {
        let refused = ClientError::VersionRefused { reason: "clientOutdated".to_owned(), server_version: "1.6.0".to_owned(), client_version: "1.5.0".to_owned() };
        assert_eq!(client_error_line(&refused), "mixdog: version refused: clientOutdated (core 1.6.0, this program 1.5.0)");
        assert_eq!(client_error_line(&ClientError::ConnectionLost), "mixdog: connection lost");
    }
}
