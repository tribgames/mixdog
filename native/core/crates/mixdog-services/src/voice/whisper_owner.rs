//! What keeps the managed whisper-server ours: the pid file that lets a restarted core reclaim a
//! stale child, the proof that a recorded pid is still our server, the listener check that no
//! other process answers on its port, and the port choice. Node: `whisper-server.mjs` and
//! `whisper-port.mjs`.

use std::net::{SocketAddr, TcpListener};
use std::path::{Path, PathBuf};
use std::time::Duration;

use mixdog_js::JsRegex;
use mixdog_rt::DurabilityIo;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::lane::{io_on_lane, on_lane};
use crate::tidy::process::{Processes, RunOptions};

/// Ports a fetch client refuses to connect to (WHATWG "bad port"); the server is reached with one.
const FETCH_BLOCKED_PORTS: &[u16] = &[
    0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513,
    514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697,
    10080,
];
/// How many more OS-assigned ports are taken after a blocked one.
const FETCH_SAFE_ATTEMPTS: usize = 16;
const KILL_SETTLE: Duration = Duration::from_millis(500);
const MAX_QUERY_BYTES: usize = 16 * 1024 * 1024;

/// `parseInt(raw, 10)` accepted as a port: an integer in 1..65535, else `None`.
pub fn port_from_env(raw: &str) -> Option<u16> {
    let text = mixdog_js::js_trim_start(raw);
    let digits: String = text.strip_prefix('+').unwrap_or(text).chars().take_while(char::is_ascii_digit).collect();
    digits.parse::<u32>().ok().filter(|n| (1..65536).contains(n)).map(|n| n as u16)
}

/// The preferred port when free; only a busy or forbidden one falls back to an OS-assigned port
/// a fetch client accepts. A foreign listener is never reused.
pub fn select_port(host: &str, preferred: u16) -> Result<u16, String> {
    let reserve = |port: u16| -> std::io::Result<u16> {
        let ip = host.parse().map_err(std::io::Error::other)?;
        let listener = TcpListener::bind(SocketAddr::new(ip, port))?;
        Ok(listener.local_addr()?.port())
    };
    match reserve(preferred) {
        Ok(port) => Ok(port),
        Err(e) if matches!(e.kind(), std::io::ErrorKind::AddrInUse | std::io::ErrorKind::PermissionDenied) => {
            for _ in 0..=FETCH_SAFE_ATTEMPTS {
                let port = reserve(0).map_err(|e| e.to_string())?;
                if !FETCH_BLOCKED_PORTS.contains(&port) {
                    return Ok(port);
                }
            }
            Err("no fetch-safe loopback port was assigned".into())
        }
        Err(e) => Err(e.to_string()),
    }
}

/// `<dir of the server binary>/../../whisper-server.pid.json`.
pub fn pid_file(server_cmd: &Path) -> PathBuf {
    let dir = server_cmd.parent().unwrap_or(Path::new("."));
    dir.parent().and_then(Path::parent).unwrap_or(Path::new(".")).join("whisper-server.pid.json")
}

/// What the pid file records for a running child.
pub struct PidMeta<'a> {
    pub pid: u32,
    pub server_cmd: &'a Path,
    pub model_path: &'a Path,
    pub thread_count: usize,
    pub host: &'a str,
    pub port: u16,
    pub started_at_ms: i64,
}

impl PidMeta<'_> {
    fn to_json(&self) -> Value {
        let (cmd, model) = (self.server_cmd.to_string_lossy(), self.model_path.to_string_lossy());
        json!({
            "pid": self.pid, "serverCmd": cmd, "modelPath": model, "threadCount": self.thread_count,
            "host": self.host, "port": self.port,
            "runtimeKey": json!([cmd, model, self.thread_count, self.host]).to_string(),
            "startedAt": self.started_at_ms,
        })
    }
}

/// Advisory cleanup state: a failed write is ignored.
pub async fn write_pid_file(lane: DurabilityIo, path: PathBuf, meta: &PidMeta<'_>) {
    let body = meta.to_json().to_string();
    let _ = io_on_lane(lane, move || write_file(&path, &body)).await;
}

pub async fn clear_pid_file(lane: DurabilityIo, path: PathBuf) {
    let _ = io_on_lane(lane, move || remove_file(&path)).await;
}

/// The recorded meta, `Ok(None)` when the file is absent or not JSON; `Err` when the read never ran.
pub async fn read_pid_file(lane: DurabilityIo, path: PathBuf) -> std::io::Result<Option<Value>> {
    Ok(on_lane(lane, move || read_file(&path)).await?.and_then(|text| serde_json::from_str(&text).ok()))
}

#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn write_file(path: &Path, body: &str) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(path, body)
}

#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn remove_file(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn read_file(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

/// `--port <port>` or `--port=<port>` in a command line, the port not followed by a digit.
fn names_port(command_line: &str, port: i64) -> bool {
    JsRegex::new(&format!("--port(?:\\s+|=){port}(?!\\d)"), "").is_ok_and(|re| re.is_match(command_line))
}

/// Runs a system query; `None` when it could not run or failed.
async fn query(processes: &Processes, program: &str, args: &[String], cwd: &Path, cancel: Option<&CancellationToken>) -> Option<String> {
    let mut options = RunOptions::new(cwd);
    options.timeout = Duration::ZERO;
    options.max_capture = MAX_QUERY_BYTES;
    options.cancel = cancel;
    let result = processes.run(program, args, options).await;
    (result.code == 0 && result.error.is_empty()).then_some(result.stdout)
}

fn strings(args: &[&str]) -> Vec<String> {
    args.iter().map(|a| (*a).to_owned()).collect()
}

/// The live command line of `pid`; empty when it cannot be read, which callers treat as "cannot
/// prove". Windows asks `wmic` at its System32 path, never through PATH.
async fn command_line(processes: &Processes, pid: u32, cwd: &Path) -> String {
    if cfg!(windows) {
        let Some(root) = std::env::var("SystemRoot").ok().filter(|r| !r.is_empty()) else { return String::new() };
        let wmic = Path::new(&root).join("System32").join("wbem").join("wmic.exe");
        return query(processes, &wmic.to_string_lossy(), &strings(&["process", "where", &format!("ProcessId={pid}"), "get", "CommandLine", "/FORMAT:LIST"]), cwd, None).await.unwrap_or_default();
    }
    query(processes, "ps", &strings(&["-o", "args=", "-p", &pid.to_string()]), cwd, None).await.unwrap_or_default()
}

/// Whether `pid` is a live whisper-server whose command line names our model or port. Anything
/// that cannot be proven reads as not ours: only a positive match licenses a kill.
pub async fn is_owned(processes: &Processes, pid: Option<u32>, model_path: &str, port: Option<i64>, cwd: &Path) -> bool {
    let Some(pid) = pid.filter(|p| *p > 0) else { return false };
    #[cfg(unix)]
    {
        // SAFETY: signal 0 only probes for existence.
        if unsafe { libc::kill(pid as i32, 0) } != 0 {
            return false;
        }
    }
    let image = if cfg!(windows) {
        query(processes, "tasklist", &strings(&["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"]), cwd, None).await.unwrap_or_default().to_lowercase().contains("whisper-server.exe")
    } else {
        query(processes, "ps", &strings(&["-p", &pid.to_string(), "-o", "comm="]), cwd, None).await.unwrap_or_default().to_lowercase().contains("whisper-server")
    };
    if !image {
        return false;
    }
    let line = command_line(processes, pid, cwd).await;
    if line.is_empty() {
        return false;
    }
    (!model_path.is_empty() && line.contains(model_path)) || port.is_some_and(|p| names_port(&line, p))
}

/// Node's Windows tree kill (`TREE_KILL_SCRIPT`, `child-tree.mjs`), one PowerShell pass. `taskkill
/// /T` is never used: it follows parent ids with no creation times. A root counts only if it was
/// created no later than `-AliveAt`, a descendant only if created no earlier than its parent, and
/// each process is ended through a handle whose start time matches the table.
const TREE_KILL_SCRIPT: &str = r#"param([int[]]$Pids, [long]$AliveAt, [object[]]$Table, [switch]$List)
$ErrorActionPreference = 'Stop'
$limit = [DateTime]::FromFileTimeUtc($AliveAt)
if ($Table) {
  $rows = @(foreach ($t in $Table) { [pscustomobject]@{ Id = [int]$t.Id; Parent = [int]$t.Parent; Created = [DateTime]::FromFileTimeUtc([long]$t.Created) } })
} else {
  $rows = @(Get-CimInstance Win32_Process -OperationTimeoutSec 10 | Where-Object CreationDate | ForEach-Object { [pscustomobject]@{ Id = [int]$_.ProcessId; Parent = [int]$_.ParentProcessId; Created = $_.CreationDate.ToUniversalTime() } })
}
$byId = @{}
$byParent = @{}
foreach ($r in $rows) {
  $byId[$r.Id] = $r
  if (-not $byParent.ContainsKey($r.Parent)) { $byParent[$r.Parent] = [Collections.Generic.List[object]]::new() }
  $byParent[$r.Parent].Add($r)
}
$members = [Collections.Generic.List[object]]::new()
foreach ($id in $Pids) {
  $r = $byId[$id]
  if ($r -and $r.Created -le $limit -and -not $members.Contains($r)) { $members.Add($r) }
}
$roots = $members.Count
if ($roots -eq 0) { exit 128 }
for ($i = 0; $i -lt $members.Count; $i++) {
  $parent = $members[$i]
  if (-not $byParent.ContainsKey($parent.Id)) { continue }
  foreach ($child in $byParent[$parent.Id]) {
    if ($child.Created -ge $parent.Created -and -not $members.Contains($child)) { $members.Add($child) }
  }
}
if ($List) { foreach ($m in $members) { $m.Id }; exit 0 }
$survived = $false
for ($i = 0; $i -lt $members.Count; $i++) {
  $m = $members[$i]
  try { $p = [Diagnostics.Process]::GetProcessById($m.Id) } catch { continue }
  try { $same = [math]::Abs(($p.StartTime.ToUniversalTime() - $m.Created).TotalMilliseconds) -lt 1 } catch { $same = $null }
  if ($same -eq $false) { continue }
  # A start time that cannot be read proves nothing: the process is left alone,
  # and a root left alone counts as surviving.
  if ($null -eq $same) { if ($i -lt $roots) { $survived = $true }; continue }
  try { $p.Kill() } catch {}
  if ($i -lt $roots) { try { if (-not $p.WaitForExit(2000)) { $survived = $true } } catch { $survived = $true } }
}
if ($survived) { exit 1 }
exit 0"#;

/// The hard lifetime of one tree-kill pass (`TREE_KILL_DEADLINE_MS`).
const TREE_KILL_DEADLINE: Duration = Duration::from_secs(15);

/// `fileTime`: epoch milliseconds as a Windows FILETIME.
fn file_time(ms: i64) -> i128 {
    i128::from(ms) * 10_000 + 116_444_736_000_000_000
}

/// `treeKillCommand([pid], { aliveAt })`: the program and arguments of one Windows tree kill.
pub fn tree_kill_command(pid: u32, alive_at_ms: i64) -> (String, Vec<String>) {
    use base64::Engine as _;
    let source = format!("& {{\n{TREE_KILL_SCRIPT}\n}} -Pids @({pid}) -AliveAt {}", file_time(alive_at_ms));
    let units: Vec<u8> = source.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let root = ["SystemRoot", "WINDIR"].iter().find_map(|k| std::env::var(k).ok().filter(|v| !v.is_empty())).unwrap_or_else(|| "C:\\Windows".into());
    (format!("{root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"), strings(&["-NoProfile", "-NonInteractive", "-EncodedCommand", &base64::engine::general_purpose::STANDARD.encode(units)]))
}

/// Ends a stale child by pid, as Node's `killPid` does: the shared tree kill on Windows (no
/// graceful stop exists for a console server), SIGTERM or SIGKILL elsewhere. `alive_at_ms`: when
/// `pid` was last known to be the process meant.
pub async fn kill_pid(processes: &Processes, pid: u32, force: bool, cwd: &Path, alive_at_ms: i64) {
    #[cfg(windows)]
    {
        let _ = force;
        let (command, args) = tree_kill_command(pid, alive_at_ms);
        let mut options = RunOptions::new(cwd);
        options.timeout = TREE_KILL_DEADLINE;
        let _ = processes.run(&command, &args, options).await;
    }
    #[cfg(unix)]
    {
        let _ = (processes, cwd, alive_at_ms);
        // SAFETY: a signal to a pid proven to be our server a moment ago.
        unsafe { libc::kill(pid as i32, if force { libc::SIGKILL } else { libc::SIGTERM }) };
    }
}

/// `os.setPriority(pid, PRIORITY_ABOVE_NORMAL)`: a warm transcription stays fast when every core
/// is busy. Best-effort; a refusal leaves the default priority.
pub fn raise_priority(pid: u32) {
    #[cfg(unix)]
    {
        // SAFETY: setpriority on a pid we just spawned; failure is ignored.
        unsafe { libc::setpriority(libc::PRIO_PROCESS, pid, -7) };
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{ABOVE_NORMAL_PRIORITY_CLASS, OpenProcess, PROCESS_SET_INFORMATION, SetPriorityClass};
        // SAFETY: the handle is opened, used and closed here.
        unsafe {
            let handle = OpenProcess(PROCESS_SET_INFORMATION, 0, pid);
            if !handle.is_null() {
                SetPriorityClass(handle, ABOVE_NORMAL_PRIORITY_CLASS);
                CloseHandle(handle);
            }
        }
    }
}

/// Reclaims a child a previous core left behind, when the pid file proves it is ours; `true` when
/// it did (the caller then clears the file).
pub async fn reclaim_stale(processes: &Processes, meta: &Value, model_path: &str, preferred_port: u16, cwd: &Path) -> bool {
    let pid = meta.get("pid").and_then(Value::as_f64).filter(|p| p.fract() == 0.0 && *p > 0.0 && *p <= f64::from(u32::MAX)).map(|p| p as u32);
    let model = meta.get("modelPath").and_then(Value::as_str).unwrap_or(model_path);
    let port = match meta.get("port") {
        None | Some(Value::Null) => Some(i64::from(preferred_port)),
        Some(other) => other.as_f64().filter(|p| p.fract() == 0.0).map(|p| p as i64),
    };
    let Some(pid) = pid else { return false };
    // The instants are taken before each proof: the kill may only end what the proof saw.
    let proven_at = crate::media::store::now_ms();
    if !is_owned(processes, Some(pid), model, port, cwd).await {
        return false;
    }
    kill_pid(processes, pid, false, cwd, proven_at).await;
    tokio::time::sleep(KILL_SETTLE).await;
    let reproven_at = crate::media::store::now_ms();
    if is_owned(processes, Some(pid), model, port, cwd).await {
        kill_pid(processes, pid, true, cwd, reproven_at).await;
        tokio::time::sleep(KILL_SETTLE).await;
    }
    true
}

/// One `OwningProcess` number per line (no localized words).
pub(crate) fn listener_pids_include(stdout: &str, pid: u32) -> bool {
    stdout.split(['\n']).any(|line| mixdog_js::js_trim(line) == pid.to_string())
}

/// Whether the process `pid` is the one listening on `host:port`. No evidence reads as not
/// owned: such a server gets neither readiness nor audio. The query is ended by `cancel` only.
pub async fn listener_owned(processes: &Processes, host: &str, port: u16, pid: u32, cwd: &Path, cancel: &CancellationToken) -> bool {
    let os = if cfg!(windows) { Os::Windows } else if cfg!(target_os = "linux") { Os::Linux } else { Os::Other };
    listener_owned_on(os, processes, host, port, pid, cwd, cancel).await
}

/// The operating systems whose listener query differs (`process.platform` of Node).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Os {
    Windows,
    Linux,
    Other,
}

/// [`listener_owned`] for an explicit operating system.
pub async fn listener_owned_on(os: Os, processes: &Processes, host: &str, port: u16, pid: u32, cwd: &Path, cancel: &CancellationToken) -> bool {
    if pid == 0 {
        return false;
    }
    if os == Os::Windows {
        let root = std::env::var("SystemRoot").ok().filter(|r| !r.is_empty()).unwrap_or_else(|| "C:\\Windows".into());
        // The CIM-backed cmdlet lists listeners netstat omits on a large TCP table; a listening
        // row is the one with no remote endpoint.
        if host.is_empty() || !host.chars().all(|c| c.is_ascii_hexdigit() || c == ':' || c == '.') {
            return false;
        }
        let shell = Path::new(&root).join("System32").join("WindowsPowerShell").join("v1.0").join("powershell.exe");
        let script = format!("(Get-NetTCPConnection -LocalAddress '{host}' -LocalPort {port} -ErrorAction SilentlyContinue | Where-Object RemotePort -eq 0).OwningProcess");
        let out = query(processes, &shell.to_string_lossy(), &strings(&["-NoProfile", "-NonInteractive", "-Command", &script]), cwd, Some(cancel)).await;
        return out.is_some_and(|stdout| listener_pids_include(&stdout, pid));
    }
    if os == Os::Linux {
        let Some(out) = query(processes, "ss", &strings(&["-H", "-ltnp", &format!("sport = :{port}")]), cwd, Some(cancel)).await else { return false };
        let own = format!("{host}:{port}");
        let marker = JsRegex::new(&format!("\\bpid={pid},"), "");
        return out.split(['\n']).any(|line| {
            let fields: Vec<&str> = mixdog_js::js_words(line).collect();
            fields.get(3).is_some_and(|f| *f == own) && marker.as_ref().is_ok_and(|re| re.is_match(line))
        });
    }
    let Some(out) = query(processes, "lsof", &strings(&["-nP", "-a", "-p", &pid.to_string(), &format!("-iTCP@{host}:{port}"), "-sTCP:LISTEN", "-Fp"]), cwd, Some(cancel)).await else { return false };
    out.split(['\n']).any(|line| line.strip_suffix('\r').unwrap_or(line) == format!("p{pid}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_port_variable_reads_like_parse_int() {
        assert_eq!(port_from_env("9000"), Some(9000));
        assert_eq!(port_from_env("  42abc"), Some(42));
        assert_eq!(port_from_env("65536"), None);
        assert_eq!(port_from_env("0"), None);
        assert_eq!(port_from_env("x"), None);
        assert_eq!(port_from_env("-5"), None);
    }

    #[test]
    fn the_pid_file_sits_two_levels_above_the_binary_directory() {
        assert_eq!(pid_file(Path::new("/data/voice-runtime/bin/whisper-server")), PathBuf::from("/data/whisper-server.pid.json"));
    }

    #[test]
    fn a_command_line_names_the_port_only_as_a_whole_number() {
        assert!(names_port("whisper-server --port 8771 -t 4", 8771));
        assert!(names_port("whisper-server --port=8771", 8771));
        assert!(!names_port("whisper-server --port 87710", 8771));
        assert!(!names_port("whisper-server --port8771", 8771));
    }

    #[test]
    fn listener_pids_match_whole_trimmed_lines() {
        assert!(listener_pids_include("12\r\n 345 \r\n", 345));
        assert!(!listener_pids_include("12\r\n3456\r\n", 345));
    }

    #[test]
    fn a_busy_preferred_port_falls_back_but_a_bad_host_is_an_error() {
        let held = TcpListener::bind("127.0.0.1:0").unwrap();
        let busy = held.local_addr().unwrap().port();
        let chosen = select_port("127.0.0.1", busy).unwrap();
        assert_ne!(chosen, busy);
        assert!(!FETCH_BLOCKED_PORTS.contains(&chosen));
        assert!(select_port("not-an-ip", 8771).is_err());
    }

    #[tokio::test]
    async fn an_unknown_pid_is_not_ours() {
        let processes = Processes::for_tests();
        let cwd = std::env::temp_dir();
        assert!(!is_owned(&processes, None, "m", Some(1), &cwd).await);
        assert!(!is_owned(&processes, Some(u32::MAX - 1), "m", Some(1), &cwd).await);
    }

    #[tokio::test]
    async fn the_pid_file_round_trips_and_clears() {
        let dir = tempfile::tempdir().unwrap();
        let lane = mixdog_rt::testing::tokens().durability_io;
        let path = pid_file(&dir.path().join("rt").join("bin").join("whisper-server"));
        write_pid_file(lane, path.clone(), &PidMeta { pid: 7, server_cmd: Path::new("s"), model_path: Path::new("m"), thread_count: 2, host: "127.0.0.1", port: 8771, started_at_ms: 5 }).await;
        let meta = read_pid_file(lane, path.clone()).await.unwrap().unwrap();
        assert_eq!(meta["pid"], 7);
        assert_eq!(meta["runtimeKey"], r#"["s","m",2,"127.0.0.1"]"#);
        clear_pid_file(lane, path.clone()).await;
        assert!(read_pid_file(lane, path).await.unwrap().is_none());
    }
}
