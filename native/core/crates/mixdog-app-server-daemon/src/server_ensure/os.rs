//! The real machine behind `server-ensure`: the process table, the discovery file, the
//! management path over loopback HTTP, and the detached launcher.

use std::cell::RefCell;
use std::fs;
use std::io::Write;
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::Child;
use std::process::Command;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde::de::DeserializeOwned;

use super::args::ProgramArgs;
use super::error::EnsureError;
use super::flow::run;
use super::host::CoreAccess;
use super::host::CoreReport;
use super::host::DrainReport;
use super::host::EnsureHost;
use super::host::Launch;
use super::host::ProcessImage;
use super::host::ServerCore;
use super::idle::ANSWER_IDLE;
use super::idle::IdleWatch;
use super::idle::STOP_IDLE;
use super::layout::RemotePaths;
use super::report::result_line;
use crate::discovery;
use crate::lifecycle::DiscoveryPhase;
use crate::lifecycle::StopMode;
use crate::lifecycle::StopReason;
use crate::control::api::ErrorReply;
use crate::control::api::HOLD_PATH;
use crate::control::api::HoldRequest;
use crate::control::api::ReplacementBuild;
use crate::control::api::STATUS_PATH;
use crate::control::api::STOP_PATH;
use crate::control::api::StatusReply;
use crate::control::api::StopRequest;
use crate::verdict::OsProcessTable;
use crate::verdict::ProcessIdentity;
use crate::verdict::ProcessTable;

/// How long the loop that waits for the launched core to appear in discovery sleeps between
/// looks. The exit of the launched process is observed, not timed.
const BOOT_LOOK: Duration = Duration::from_millis(100);

/// The grace `stopDaemon` gives a core that did not answer its `/stop` between SIGTERM and SIGKILL (`graceMs`).
const TERMINATE_GRACE: Duration = Duration::from_secs(20);

pub struct OsHost {
    home: PathBuf,
}

impl OsHost {
    /// The server's `$HOME`: the bootstrap shell and `~/.mixdog-remote` use the same one.
    pub fn from_env() -> Result<Self, EnsureError> {
        let home = std::env::var_os("HOME")
            .filter(|home| !home.is_empty())
            .ok_or_else(|| EnsureError::InstallFailed("HOME is not set on the server.".to_owned()))?;
        Ok(Self { home: PathBuf::from(home) })
    }
}

impl EnsureHost for OsHost {
    fn home(&self) -> PathBuf {
        self.home.clone()
    }

    fn uid(&self) -> u32 {
        #[cfg(unix)]
        // SAFETY: getuid has no preconditions.
        return unsafe { libc::getuid() };
        #[cfg(windows)]
        0
    }

    fn hostname(&self) -> String {
        #[cfg(unix)]
        {
            let mut buffer = [0u8; 256];
            // SAFETY: the buffer is valid for its length; the name is truncated, not overrun.
            let status = unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) };
            if status != 0 {
                return String::new();
            }
            let end = buffer.iter().position(|&b| b == 0).unwrap_or(buffer.len());
            String::from_utf8_lossy(&buffer[..end]).into_owned()
        }
        #[cfg(windows)]
        std::env::var("COMPUTERNAME").unwrap_or_default()
    }

    fn process_alive(&self, pid: u32) -> bool {
        OsProcessTable.query(u64::from(pid)).is_ok_and(|info| info.is_some())
    }

    fn process_images(&self) -> Option<Vec<ProcessImage>> {
        #[cfg(target_os = "linux")]
        {
            let entries = fs::read_dir("/proc").ok()?;
            Some(
                entries
                    .filter_map(|entry| {
                        let entry = entry.ok()?;
                        let pid: u32 = entry.file_name().to_str()?.parse().ok()?;
                        let image = fs::read_link(entry.path().join("exe")).ok()?;
                        Some(ProcessImage { pid, image })
                    })
                    .collect(),
            )
        }
        #[cfg(target_os = "macos")]
        {
            let output = Command::new("ps").args(["-axww", "-o", "pid=,comm="]).output().ok()?;
            output.status.success().then(|| {
                String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .filter_map(|line| {
                        let (pid, image) = line.trim_start().split_once(' ')?;
                        Some(ProcessImage { pid: pid.parse().ok()?, image: PathBuf::from(image.trim()) })
                    })
                    .collect()
            })
        }
        #[cfg(windows)]
        super::winlist::process_images().ok()
    }

    fn now_ms(&self) -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
    }

    fn pause(&self, duration: Duration) {
        std::thread::sleep(duration);
    }
}

pub struct OsAccess {
    paths: RemotePaths,
    launched: RefCell<Option<Child>>,
    /// The inactivity limit of every request to the core.
    idle: Arc<IdleWatch>,
}

fn failed(what: &str, e: &dyn std::fmt::Display) -> EnsureError {
    EnsureError::Core(format!("{what}: {e}"))
}

impl OsAccess {
    pub fn new(host: &dyn EnsureHost) -> Self {
        Self::with_idle(host, IdleWatch::monotonic())
    }

    pub(super) fn with_idle(host: &dyn EnsureHost, idle: Arc<IdleWatch>) -> Self {
        Self { paths: RemotePaths::new(&host.home()), launched: RefCell::new(None), idle }
    }

    /// `POST path` with `body`, its reply read under `limit` of inactivity (Node's `daemonRequest` timeout). `Ok(None)`
    /// when the core stayed silent that long, as `daemonRequest` resolves `null`.
    fn call(&self, core: &ServerCore, path: &str, body: &impl serde::Serialize, limit: Duration) -> Result<Option<StatusReply>, EnsureError> {
        let body = serde_json::to_vec(body).map_err(|e| failed("encoding the request", &e))?;
        let exchange = self.idle.begin(limit);
        let stream = Self::send(core, "POST", path, &body)?;
        match self.idle.read_to_end(exchange, stream) {
            Some(raw) => Self::reply(&raw.map_err(|e| failed("reading the reply", &e))?).map(Some),
            None => Ok(None),
        }
    }

    fn send(core: &ServerCore, method: &str, path: &str, body: &[u8]) -> Result<TcpStream, EnsureError> {
        let mut stream = TcpStream::connect(("127.0.0.1", core.control_port))
            .map_err(|e| failed("connecting to the core's control listener", &e))?;
        let head = format!(
            "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            core.token,
            body.len()
        );
        stream
            .write_all(head.as_bytes())
            .and_then(|()| stream.write_all(body))
            .map_err(|e| failed("sending the request", &e))?;
        Ok(stream)
    }

    fn reply(raw: &[u8]) -> Result<StatusReply, EnsureError> {
        let text = String::from_utf8_lossy(raw);
        let (head, reply) = text.split_once("\r\n\r\n").ok_or_else(|| failed("the reply", &"is not HTTP"))?;
        let status: u16 = head
            .split(' ')
            .nth(1)
            .and_then(|s| s.parse().ok())
            .ok_or_else(|| failed("the reply", &"has no status"))?;
        if (200..300).contains(&status) {
            return decode(reply);
        }
        let refusal: ErrorReply = decode(reply)?;
        Err(EnsureError::Core(format!("{}: {}", refusal.code, refusal.message)))
    }

    fn stop(&self, core: &ServerCore, mode: StopMode, reason: StopReason, token: Option<&str>, replacement: Option<&ReplacementBuild>) -> Result<Option<StatusReply>, EnsureError> {
        let request = StopRequest { mode, reason, confirm_token: token.map(str::to_owned), replacement: replacement.cloned() };
        self.call(core, STOP_PATH, &request, STOP_IDLE)
    }

    fn identity(core: &ServerCore) -> Result<ProcessIdentity, EnsureError> {
        let start_ms = core
            .process_start_time
            .parse()
            .map_err(|_| EnsureError::Core(format!("unreadable process start time {}", core.process_start_time)))?;
        Ok(ProcessIdentity { pid: core.pid, start_ms })
    }
}

fn decode<T: DeserializeOwned>(text: &str) -> Result<T, EnsureError> {
    serde_json::from_str(text).map_err(|e| EnsureError::Core(format!("unreadable reply: {e}")))
}

impl CoreAccess for OsAccess {
    fn discovery(&self) -> Result<Option<ServerCore>, EnsureError> {
        let raw = match fs::read_to_string(discovery::path(&self.paths.runtime_root)) {
            Ok(raw) => raw,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(EnsureError::Core(format!("reading discovery: {e}"))),
        };
        // A 1.4.5 daemon's file has no `core` block: the starting core waits for it by itself.
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else { return Ok(None) };
        let text = |v: Option<&serde_json::Value>| v.and_then(serde_json::Value::as_str).map(str::to_owned);
        let core = value.get("core");
        let (Some(pid), Some(token), Some(port), Some(state), Some(start)) = (
            value.get("pid").and_then(serde_json::Value::as_u64).and_then(|p| u32::try_from(p).ok()),
            text(value.pointer("/endpoints/session/token")),
            core.and_then(|c| c.pointer("/control/port")).and_then(serde_json::Value::as_u64).and_then(|p| u16::try_from(p).ok()),
            core.and_then(|c| c.get("state")).and_then(|s| serde_json::from_value::<DiscoveryPhase>(s.clone()).ok()),
            text(core.and_then(|c| c.get("processStartTime"))),
        ) else {
            return Ok(None);
        };
        // The file of a core that died without withdrawing it names nobody.
        if !discovery::names_running_core(pid, &start).map_err(|e| EnsureError::Core(format!("reading the process table: {e}")))? {
            return Ok(None);
        }
        let build = text(core.and_then(|c| c.get("build"))).unwrap_or_default();
        Ok(Some(ServerCore {
            pid,
            version: text(core.and_then(|c| c.get("version"))).unwrap_or_default(),
            build,
            instance_id: text(core.and_then(|c| c.get("instanceId"))).unwrap_or_default(),
            state,
            process_start_time: start,
            control_port: port,
            model_proxy: value.pointer("/endpoints/modelProxy").is_some_and(|v| !v.is_null()),
            token,
            raw,
        }))
    }

    fn answers(&self, core: &ServerCore) -> bool {
        let exchange = self.idle.begin(ANSWER_IDLE);
        let Ok(stream) = Self::send(core, "GET", STATUS_PATH, &[]) else { return false };
        let Some(Ok(raw)) = self.idle.read_to_end(exchange, stream) else { return false };
        Self::reply(&raw).is_ok_and(|reply| reply.status.instance_id == core.instance_id)
    }

    /// Hold is the first request of a replacement, so a core silent on it has not shown that it answers. Node stops only
    /// a daemon whose `/health` answered and leaves one that does not (`wait`) running; so the run fails here and
    /// nothing is stopped, signalled or launched.
    fn hold(&self, core: &ServerCore, on: bool) -> Result<(), EnsureError> {
        self.call(core, HOLD_PATH, &HoldRequest { on }, ANSWER_IDLE)?.map(drop).ok_or_else(|| {
            EnsureError::Core(format!("the core (pid {}) accepted the hold request and sent nothing for {} ms", core.pid, ANSWER_IDLE.as_millis()))
        })
    }

    fn stop_when_idle(&self, core: &ServerCore, reason: StopReason, replacement: Option<&ReplacementBuild>) -> Result<Option<DrainReport>, EnsureError> {
        let Some(status) = self.stop(core, StopMode::WhenIdle, reason, None, replacement)? else { return Ok(None) };
        let drain = status
            .status
            .drain
            .ok_or_else(|| EnsureError::Core("the core accepted the stop but reports no drain".to_owned()))?;
        Ok(Some(DrainReport { drain_id: drain.drain_id, running: status.status.running, confirm_token: drain.confirm_token }))
    }

    fn stop_confirmed(&self, core: &ServerCore, reason: StopReason, confirm_token: &str, replacement: Option<&ReplacementBuild>) -> Result<bool, EnsureError> {
        Ok(self.stop(core, StopMode::AbortConfirmed, reason, Some(confirm_token), replacement)?.is_some())
    }

    fn wait_exit(&self, core: &ServerCore) -> Result<(), EnsureError> {
        crate::verdict::wait_for_exit(Self::identity(core)?).map_err(|e| EnsureError::Core(format!("waiting for the core to exit: {e}")))
    }

    fn terminate(&self, core: &ServerCore) -> Result<(), EnsureError> {
        let ended = crate::verdict::terminate(Self::identity(core)?, TERMINATE_GRACE)
            .map_err(|e| EnsureError::Core(format!("ending the core: {e}")))?;
        if ended { Ok(()) } else { Err(EnsureError::DaemonStop(core.pid)) }
    }

    fn launch(&self, launch: &Launch) -> Result<(), EnsureError> {
        let failed = |e: std::io::Error| EnsureError::Core(format!("starting the core: {e}"));
        let log = fs::OpenOptions::new().create(true).append(true).open(&launch.log).map_err(failed)?;
        let mut command = Command::new(&launch.exe);
        for name in &launch.env_remove {
            command.env_remove(name);
        }
        command
            .args(&launch.args)
            .envs(launch.env.iter().cloned())
            .stdin(Stdio::null())
            .stdout(log.try_clone().map_err(failed)?)
            .stderr(log);
        // The core leaves this ssh session's process group and survives it.
        #[cfg(unix)]
        std::os::unix::process::CommandExt::process_group(&mut command, 0);
        #[cfg(windows)]
        std::os::windows::process::CommandExt::creation_flags(&mut command, 0x0000_0008 | 0x0000_0200);
        *self.launched.borrow_mut() = Some(command.spawn().map_err(failed)?);
        Ok(())
    }

    fn await_core(&self) -> Result<CoreReport, EnsureError> {
        loop {
            let pid = {
                let mut launched = self.launched.borrow_mut();
                let child = launched.as_mut().ok_or_else(|| EnsureError::Core("no core was launched".to_owned()))?;
                if let Some(status) = child.try_wait().map_err(|e| EnsureError::Core(e.to_string()))? {
                    return Ok(CoreReport::Exited { status: status.code() });
                }
                child.id()
            };
            if let Some(core) = self.discovery()?.filter(|c| c.pid == pid && c.state != DiscoveryPhase::Booting) {
                return Ok(CoreReport::Reached(core));
            }
            std::thread::sleep(BOOT_LOOK);
        }
    }
}

/// `mixdogd server-ensure <argument>`: prints the result lines; the exit status is 0 or 3.
pub fn main(argument: &str) -> i32 {
    let result = (|| {
        let args = ProgramArgs::decode(argument)?;
        let host = OsHost::from_env()?;
        let access = OsAccess::new(&host);
        let exe = std::env::current_exe().map_err(|e| EnsureError::InstallFailed(format!("Cannot find the running binary: {e}")))?;
        run(&args, &host, &access, &exe)
    })();
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(result_line(&result).as_bytes());
    let _ = out.flush();
    if result.is_ok() { 0 } else { 3 }
}
