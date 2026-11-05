//! Child-process helpers for the tidy engines. Every spawn goes through [`run_process`]:
//! argument arrays only (never a shell string), no console window, a hard timeout with kill
//! escalation, and capped stdout/stderr buffers. Engine binaries and file paths are untrusted
//! input, so no value ever reaches a shell parser.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio_util::sync::CancellationToken;

pub const DEFAULT_PROCESS_TIMEOUT: Duration = Duration::from_secs(90);
pub const MAX_CAPTURE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Default)]
pub struct ProcessResult {
    /// `-1` when the process could not start or was killed.
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub truncated: bool,
    pub error: String,
    /// The spawn error's kind, e.g. `NotFound`.
    pub error_code: String,
}

pub struct RunOptions<'a> {
    pub cwd: &'a Path,
    pub env: Option<&'a HashMap<String, String>>,
    pub input: Option<Vec<u8>>,
    pub timeout: Duration,
    pub cancel: Option<&'a CancellationToken>,
    pub max_capture: usize,
}

impl<'a> RunOptions<'a> {
    pub fn new(cwd: &'a Path) -> Self {
        Self { cwd, env: None, input: None, timeout: DEFAULT_PROCESS_TIMEOUT, cancel: None, max_capture: MAX_CAPTURE_BYTES }
    }
}

fn is_windows_script(bin: &str) -> bool {
    cfg!(windows) && Path::new(bin).extension().is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"))
}

fn path_dirs(env: Option<&HashMap<String, String>>) -> Vec<PathBuf> {
    let value = env
        .and_then(|e| e.get("PATH").or_else(|| e.get("Path")).cloned())
        .or_else(|| std::env::var("PATH").ok())
        .unwrap_or_default();
    std::env::split_paths(&value).filter(|p| !p.as_os_str().is_empty()).collect()
}

fn executable_candidates(name: &str) -> Vec<String> {
    if !cfg!(windows) || Path::new(name).extension().is_some() {
        return vec![name.to_owned()];
    }
    let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
    std::iter::once(name.to_owned()).chain(pathext.split(';').map(mixdog_js::js_trim).filter(|e| !e.is_empty()).map(|e| format!("{name}{}", e.to_lowercase()))).collect()
}

fn name_key(value: &str) -> String {
    if cfg!(windows) { value.to_lowercase() } else { value.to_owned() }
}

/// One PATH's directory listings, read once per directory on first use, for a batch of
/// [`which`] lookups: a name on no directory costs no filesystem call at all.
pub struct PathIndex {
    pub dirs: Vec<PathBuf>,
    listings: Mutex<HashMap<PathBuf, Option<std::collections::HashSet<String>>>>,
}

impl PathIndex {
    pub fn new(env: Option<&HashMap<String, String>>) -> Self {
        Self { dirs: path_dirs(env), listings: Mutex::default() }
    }

    fn has(&self, dir: &Path, candidate: &str) -> bool {
        let mut listings = self.listings.lock().unwrap();
        let names = listings.entry(dir.to_owned()).or_insert_with(|| {
            // Unlistable (no list permission, gone): probe it per candidate instead.
            std::fs::read_dir(dir).ok().map(|rd| rd.filter_map(|e| e.ok()).map(|e| name_key(&e.file_name().to_string_lossy())).collect())
        });
        names.as_ref().is_none_or(|n| n.contains(&name_key(candidate)))
    }
}

/// First match for `name` on PATH, or `None`. A pure filesystem lookup, no spawn.
pub fn which(name: &str, env: Option<&HashMap<String, String>>, index: Option<&PathIndex>) -> Option<PathBuf> {
    let bin = mixdog_js::js_trim(name);
    if bin.is_empty() {
        return None;
    }
    if Path::new(bin).is_absolute() || bin.contains('/') || bin.contains('\\') {
        return Path::new(bin).exists().then(|| PathBuf::from(bin));
    }
    let owned;
    let dirs = match index {
        Some(i) => &i.dirs,
        None => {
            owned = path_dirs(env);
            &owned
        }
    };
    for dir in dirs {
        for candidate in executable_candidates(bin) {
            if index.is_some_and(|i| !i.has(dir, &candidate)) {
                continue;
            }
            let full = dir.join(&candidate);
            if std::fs::metadata(&full).is_ok_and(|m| m.is_file()) {
                return Some(full);
            }
        }
    }
    None
}

async fn capture(mut pipe: impl tokio::io::AsyncRead + Unpin, cap: usize) -> (String, bool) {
    let mut out: Vec<u8> = Vec::new();
    let mut truncated = false;
    let mut buf = vec![0u8; 16 * 1024];
    while let Ok(n) = pipe.read(&mut buf).await {
        if n == 0 {
            break;
        }
        // Keep draining so the child never blocks on a full pipe.
        let room = cap.saturating_sub(out.len());
        if n > room {
            out.extend_from_slice(&buf[..room]);
            truncated = true;
        } else {
            out.extend_from_slice(&buf[..n]);
        }
    }
    (String::from_utf8_lossy(&out).into_owned(), truncated)
}

#[cfg(windows)]
fn kill_tree(pid: u32) {
    let mut c = std::process::Command::new("taskkill");
    c.args(["/T", "/F", "/PID", &pid.to_string()]).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    use std::os::windows::process::CommandExt;
    c.creation_flags(0x0800_0000);
    let _ = c.status();
}

#[cfg(not(windows))]
fn kill_tree(_pid: u32) {}

/// Spawns `bin` with `args` and collects its output. A failed spawn is reported, never thrown,
/// so one broken engine cannot abort the multiplexer.
pub async fn run_process(bin: &str, args: &[String], options: RunOptions<'_>) -> ProcessResult {
    let (program, argv): (String, Vec<String>) = if is_windows_script(bin) {
        let shell = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into());
        (shell, ["/d", "/s", "/c", bin].iter().map(|s| (*s).to_owned()).chain(args.iter().cloned()).collect())
    } else {
        (bin.to_owned(), args.to_vec())
    };
    let mut cmd = tokio::process::Command::new(&program);
    cmd.args(&argv).current_dir(options.cwd).stdin(if options.input.is_some() { std::process::Stdio::piped() } else { std::process::Stdio::null() }).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).kill_on_drop(true);
    if let Some(env) = options.env {
        cmd.env_clear().envs(env);
    }
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return ProcessResult { code: -1, error: e.to_string(), error_code: format!("{:?}", e.kind()), ..Default::default() },
    };
    if let (Some(input), Some(mut stdin)) = (options.input.clone(), child.stdin.take()) {
        tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            let _ = stdin.write_all(&input).await;
        });
    }
    let cap = options.max_capture;
    let out = tokio::spawn(capture(child.stdout.take().expect("piped"), cap));
    let err = tokio::spawn(capture(child.stderr.take().expect("piped"), cap));
    let pid = child.id();
    let mut timed_out = false;
    let never = CancellationToken::new();
    let cancel = options.cancel.unwrap_or(&never);
    let status = tokio::select! {
        s = child.wait() => s,
        _ = tokio::time::sleep(options.timeout), if !options.timeout.is_zero() => {
            timed_out = true;
            if let Some(pid) = pid { kill_tree(pid); }
            let _ = child.start_kill();
            child.wait().await
        }
        _ = cancel.cancelled() => {
            if let Some(pid) = pid { kill_tree(pid); }
            let _ = child.start_kill();
            child.wait().await
        }
    };
    let (stdout, out_truncated) = out.await.unwrap_or_default();
    let (stderr, err_truncated) = err.await.unwrap_or_default();
    let code = status.as_ref().ok().and_then(|s| s.code()).unwrap_or(-1);
    ProcessResult {
        code,
        stdout,
        stderr,
        timed_out,
        truncated: out_truncated || err_truncated,
        error: if timed_out { format!("timed out after {}ms", options.timeout.as_millis()) } else { String::new() },
        error_code: String::new(),
    }
}

/// Bounded-concurrency map that preserves input order and never rejects early.
pub async fn map_limit<T, R, F, Fut>(items: Vec<T>, limit: usize, worker: F) -> Vec<R>
where
    F: Fn(T) -> Fut,
    Fut: std::future::Future<Output = R>,
{
    use futures::stream::{self, StreamExt};
    stream::iter(items.into_iter().map(worker)).buffered(limit.max(1)).collect().await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[tokio::test]
    async fn output_is_captured_and_a_missing_binary_is_reported_not_thrown() {
        let dir = temp();
        let (bin, args): (&str, Vec<String>) = if cfg!(windows) { ("cmd.exe", vec!["/C".into(), "echo hi & echo err 1>&2 & exit 3".into()]) } else { ("sh", vec!["-c".into(), "echo hi; echo err >&2; exit 3".into()]) };
        let result = run_process(bin, &args, RunOptions::new(dir.path())).await;
        assert_eq!(result.code, 3);
        assert_eq!(result.stdout.trim(), "hi");
        assert_eq!(result.stderr.trim(), "err");
        let missing = run_process("definitely-not-a-binary-xyz", &[], RunOptions::new(dir.path())).await;
        assert_eq!((missing.code, missing.error_code.as_str()), (-1, "NotFound"));
    }

    #[tokio::test]
    async fn a_timeout_kills_the_child_and_output_is_capped() {
        let dir = temp();
        let (bin, args): (&str, Vec<String>) = if cfg!(windows) { ("cmd.exe", vec!["/C".into(), "ping -n 30 127.0.0.1 >nul".into()]) } else { ("sh", vec!["-c".into(), "sleep 30".into()]) };
        let mut options = RunOptions::new(dir.path());
        options.timeout = Duration::from_millis(300);
        let started = std::time::Instant::now();
        let result = run_process(bin, &args, options).await;
        assert!(result.timed_out && started.elapsed() < Duration::from_secs(10));
        let (bin, args): (&str, Vec<String>) = if cfg!(windows) { ("cmd.exe", vec!["/C".into(), "echo 0123456789".into()]) } else { ("sh", vec!["-c".into(), "echo 0123456789".into()]) };
        let mut options = RunOptions::new(dir.path());
        options.max_capture = 4;
        let capped = run_process(bin, &args, options).await;
        assert_eq!((capped.stdout.as_str(), capped.truncated), ("0123", true));
    }

    #[test]
    fn which_finds_files_on_a_supplied_path_through_the_index() {
        let dir = temp();
        let name = if cfg!(windows) { "tool.exe" } else { "tool" };
        std::fs::write(dir.path().join(name), b"x").unwrap();
        let env = HashMap::from([("PATH".to_owned(), dir.path().to_string_lossy().into_owned())]);
        let index = PathIndex::new(Some(&env));
        assert_eq!(which("tool", Some(&env), Some(&index)), Some(dir.path().join(name)));
        assert!(which("nothing-here", Some(&env), Some(&index)).is_none());
        assert!(which("", Some(&env), None).is_none());
    }

    #[tokio::test]
    async fn map_limit_keeps_input_order() {
        let out = map_limit(vec![3u64, 1, 2], 2, |n| async move {
            tokio::time::sleep(Duration::from_millis(n * 10)).await;
            n * 2
        })
        .await;
        assert_eq!(out, vec![6, 2, 4]);
    }
}
