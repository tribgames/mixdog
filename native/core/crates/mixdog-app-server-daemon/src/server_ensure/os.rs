//! The real machine behind `server-ensure`: the process table, the discovery file, the
//! management path over loopback HTTP, and the detached launcher.

use std::cell::RefCell;
use std::fs;
use std::io::Read;
use std::io::Write;
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::Child;
use std::process::Command;
use std::process::Stdio;
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
use crate::control::api::STOP_PATH;
use crate::control::api::StatusReply;
use crate::control::api::StopRequest;
use crate::verdict::OsProcessTable;
use crate::verdict::ProcessIdentity;
use crate::verdict::ProcessTable;

/// How long the loop that waits for the launched core to appear in discovery sleeps between
/// looks. The exit of the launched process is observed, not timed.
const BOOT_LOOK: Duration = Duration::from_millis(100);

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
}

impl OsAccess {
    pub fn new(host: &dyn EnsureHost) -> Self {
        Self { paths: RemotePaths::new(&host.home()), launched: RefCell::new(None) }
    }

    fn call(core: &ServerCore, path: &str, body: &impl serde::Serialize) -> Result<StatusReply, EnsureError> {
        let failed = |what: &str, e: &dyn std::fmt::Display| EnsureError::Core(format!("{what}: {e}"));
        let body = serde_json::to_vec(body).map_err(|e| failed("encoding the request", &e))?;
        let mut stream = TcpStream::connect(("127.0.0.1", core.control_port))
            .map_err(|e| failed("connecting to the core's control listener", &e))?;
        let head = format!(
            "POST {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            core.token,
            body.len()
        );
        stream
            .write_all(head.as_bytes())
            .and_then(|()| stream.write_all(&body))
            .map_err(|e| failed("sending the request", &e))?;
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).map_err(|e| failed("reading the reply", &e))?;
        let text = String::from_utf8_lossy(&raw);
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

    fn stop(core: &ServerCore, mode: StopMode, reason: StopReason, token: Option<&str>, replacement: Option<&ReplacementBuild>) -> Result<StatusReply, EnsureError> {
        let request = StopRequest { mode, reason, confirm_token: token.map(str::to_owned), replacement: replacement.cloned() };
        Self::call(core, STOP_PATH, &request)
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
        let running = OsProcessTable
            .query(u64::from(pid))
            .map_err(|e| EnsureError::Core(format!("reading the process table: {e}")))?;
        let alive = running.is_some_and(|info| {
            let recorded: Option<u64> = start.parse().ok();
            info.identity.start_ms == 0 || recorded == Some(info.identity.start_ms)
        });
        if !alive {
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

    fn hold(&self, core: &ServerCore, on: bool) -> Result<(), EnsureError> {
        Self::call(core, HOLD_PATH, &HoldRequest { on }).map(drop)
    }

    fn stop_when_idle(&self, core: &ServerCore, reason: StopReason, replacement: Option<&ReplacementBuild>) -> Result<DrainReport, EnsureError> {
        let status = Self::stop(core, StopMode::WhenIdle, reason, None, replacement)?;
        let drain = status
            .status
            .drain
            .ok_or_else(|| EnsureError::Core("the core accepted the stop but reports no drain".to_owned()))?;
        Ok(DrainReport { drain_id: drain.drain_id, running: status.status.running, confirm_token: drain.confirm_token })
    }

    fn stop_confirmed(&self, core: &ServerCore, reason: StopReason, confirm_token: &str, replacement: Option<&ReplacementBuild>) -> Result<(), EnsureError> {
        Self::stop(core, StopMode::AbortConfirmed, reason, Some(confirm_token), replacement).map(drop)
    }

    fn wait_exit(&self, core: &ServerCore) -> Result<(), EnsureError> {
        let start_ms = core
            .process_start_time
            .parse()
            .map_err(|_| EnsureError::Core(format!("unreadable process start time {}", core.process_start_time)))?;
        crate::verdict::wait_for_exit(ProcessIdentity { pid: core.pid, start_ms })
            .map_err(|e| EnsureError::Core(format!("waiting for the core to exit: {e}")))
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
