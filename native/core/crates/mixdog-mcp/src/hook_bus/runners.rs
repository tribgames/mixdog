//! Running one hook handler of the `command` and `http` types (Node `command-handler.mjs`,
//! `handlers.mjs`). Commands go through the one `ProcessManager`; a run whose future is dropped
//! (the call was cancelled) tree-kills its child.

use std::collections::BTreeMap;
use std::net::IpAddr;
use std::net::Ipv4Addr;
use std::net::Ipv6Addr;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use futures::StreamExt;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::process::CommandSpec;
use mixdog_core_api::domain::process::EnvSpec;
use mixdog_core_api::domain::process::ExitStatus;
use mixdog_core_api::domain::process::KillReason;
use mixdog_core_api::domain::process::OutputMode;
use mixdog_core_api::domain::process::OutputStream;
use mixdog_core_api::domain::process::ProcessError;
use mixdog_core_api::domain::process::ProcessEvent;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_core_api::domain::process::ProcessOwner;
use mixdog_core_api::domain::process::SpawnRequest;
use mixdog_js::JsRegex;
use mixdog_js::js_trim;
use mixdog_js::json_stringify;
use mixdog_js::value_to_string;
use mixdog_protocol::ProcessHandle;
use mixdog_tools::exec::codepage::decode_shell_bytes;
use mixdog_tools::exec::codepage::host_oem;
use mixdog_tools::exec::signal_name;
use serde_json::Value;
use url::Url;

use super::output::HandlerRun;
use super::output::MAX_BUFFER_BYTES;
use super::output::handler_timeout;
use super::rules::default_shell_kind;
use crate::hooks::HookHandler;

/// Variables a user command must not inherit from the host (runtime root, daemon identity,
/// Electron node mode).
const SCRUBBED_ENV: [&str; 8] = [
    "MIXDOG_ROOT",
    "NODE_ENV",
    "MIXDOG_DAEMON_HOST",
    "MIXDOG_WORKER_MODE",
    "MIXDOG_DAEMON_SPAWNED_FOR",
    "MIXDOG_SUPERVISOR_PID",
    "MIXDOG_SERVER_PID",
    "ELECTRON_RUN_AS_NODE",
];

fn resolve_placeholders(text: &str, project: &str, plugin_data: &str, plugin_root: &str) -> String {
    let mut out = text.to_owned();
    for (names, value) in [
        (["CLAUDE_PROJECT_DIR", "MIXDOG_PROJECT_DIR"], project),
        (["CLAUDE_PLUGIN_ROOT", "MIXDOG_PLUGIN_ROOT"], plugin_root),
        (["CLAUDE_PLUGIN_DATA", "MIXDOG_PLUGIN_DATA"], plugin_data),
    ] {
        for name in names {
            out = out.replace(&format!("${{{name}}}"), value);
        }
    }
    out
}

/// The program and arguments a command handler runs: `command` + `args` as an exec, else the
/// command line through the handler's shell.
fn spawn_spec(handler: &HookHandler, project: &str, plugin_data: &str, plugin_root: &str) -> Option<(String, Vec<String>)> {
    let raw = &handler.raw;
    let command = resolve_placeholders(raw.get("command")?.as_str()?, project, plugin_data, plugin_root);
    if let Some(args) = raw.get("args").and_then(Value::as_array) {
        let args = args.iter().map(|a| resolve_placeholders(&value_to_string(a), project, plugin_data, plugin_root)).collect();
        return Some((command, args));
    }
    let shell = match raw.get("shell").and_then(Value::as_str) {
        Some(shell @ ("powershell" | "bash")) => shell,
        _ => default_shell_kind(),
    };
    Some(if shell == "powershell" {
        (if cfg!(windows) { "powershell.exe" } else { "pwsh" }.to_owned(), vec!["-NoProfile".into(), "-NonInteractive".into(), "-Command".into(), command])
    } else {
        (if cfg!(windows) { "bash.exe" } else { "bash" }.to_owned(), vec!["-lc".into(), command])
    })
}

/// Tree-kills the child when dropped before it exited.
struct KillOnDrop {
    processes: Arc<dyn ProcessManager>,
    handle: ProcessHandle,
    armed: bool,
}

impl Drop for KillOnDrop {
    fn drop(&mut self) {
        if self.armed {
            let _ = self.processes.kill(&self.handle);
        }
    }
}

/// Runs command handlers.
pub struct CommandRunner {
    processes: Arc<dyn ProcessManager>,
    next: AtomicU64,
    prefix: String,
}

/// Where a handler runs and what it knows of its plugin.
pub struct CommandContext<'a> {
    pub project_dir: &'a Path,
    /// The project directory exists (otherwise the process working directory is used).
    pub project_exists: bool,
    pub plugin_data_dir: &'a Path,
    pub payload: &'a Value,
    pub event: &'a str,
    /// Told why a detached run failed after the call returned (its payload could not be written): the bus's `hook:error`.
    pub report_detached: Option<DetachedReport>,
}

/// Receives the failure of a detached run, which nobody awaits.
pub type DetachedReport = Arc<dyn Fn(String) + Send + Sync>;

// http

/// Hosts that name the local machine or a private network.
fn private_hostname(host: &str) -> bool {
    let lowered = js_trim(host).to_lowercase();
    let h = lowered.strip_prefix('[').unwrap_or(&lowered);
    let h = h.strip_suffix(']').unwrap_or(h);
    let h = h.strip_suffix('.').unwrap_or(h);
    let h = h.strip_prefix("::ffff:").unwrap_or(h);
    if h.is_empty() || h == "localhost" || h.ends_with(".localhost") || h.ends_with(".local") {
        return true;
    }
    if h == "::1" || h == "::" || h.starts_with("fe80:") {
        return true;
    }
    if h.contains(':') && (h.starts_with("fc") || h.starts_with("fd")) {
        return true;
    }
    let dotted = JsRegex::new_static(r"^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$", "");
    dotted.captures(h).is_some_and(|m| {
        let octet = |group: usize| m.get(group).and_then(|g| g.parse::<u32>().ok()).unwrap_or_default();
        private_v4_prefix(octet(1), octet(2))
    })
}

/// The first two octets of a private, loopback, link-local or carrier-grade-NAT IPv4 address.
fn private_v4_prefix(a: u32, b: u32) -> bool {
    a == 10
        || a == 127
        || a == 0
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 168)
        || (a == 100 && (64..=127).contains(&b))
}

fn private_v4(ip: Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    private_v4_prefix(u32::from(a), u32::from(b))
}

/// An address a hook may not reach unless the handler opts in: loopback, private, link-local,
/// carrier-grade NAT, unique-local, multicast, unspecified.
pub fn non_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => private_v4(v4) || v4.is_multicast() || v4.is_broadcast() || v4.is_link_local(),
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => non_public(IpAddr::V4(v4)),
            None => v6.is_loopback() || v6.is_unspecified() || v6.is_multicast() || is_unique_local(v6) || is_link_local_v6(v6),
        },
    }
}

fn is_unique_local(ip: Ipv6Addr) -> bool {
    ip.segments()[0] & 0xfe00 == 0xfc00
}

fn is_link_local_v6(ip: Ipv6Addr) -> bool {
    ip.segments()[0] & 0xffc0 == 0xfe80
}

struct Checked {
    url: Url,
    allow_private: bool,
}

fn validate_url(handler: &Value) -> Result<Checked, String> {
    let text = handler.get("url").map(value_to_string).unwrap_or_default();
    let url = Url::parse(&text).map_err(|_| format!("invalid hook URL: {text}"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(format!("blocked non-http(s) hook URL scheme: {}:", url.scheme()));
    }
    let allowed: Vec<String> = handler
        .get("allowedHosts")
        .and_then(Value::as_array)
        .map(|hosts| hosts.iter().map(|h| js_trim(h.as_str().unwrap_or_default()).to_lowercase()).filter(|h| !h.is_empty()).collect())
        .unwrap_or_default();
    let host = url.host_str().unwrap_or_default().to_lowercase();
    let allow_private = allowed.contains(&host) || handler.get("allowPrivateHosts") == Some(&Value::Bool(true));
    if !allow_private && private_hostname(&host) {
        return Err(format!("blocked hook URL to private/loopback host: {host} (set allowPrivateHosts or allowedHosts to opt in)"));
    }
    Ok(Checked { url, allow_private })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_and_local_hosts_are_recognised() {
        for host in [
            "localhost",
            "foo.localhost",
            "printer.local",
            "127.0.0.1",
            "10.1.2.3",
            "172.20.0.1",
            "192.168.1.1",
            "169.254.1.1",
            "100.64.0.1",
            "[::1]",
            "fd12::1",
            "::ffff:127.0.0.1",
            "",
        ] {
            assert!(private_hostname(host), "{host}");
        }
        for host in ["example.com", "8.8.8.8", "172.32.0.1"] {
            assert!(!private_hostname(host), "{host}");
        }
        assert!(non_public("::ffff:10.0.0.1".parse().unwrap()));
        assert!(!non_public("93.184.216.34".parse().unwrap()));
    }

    #[test]
    fn urls_are_validated_before_anything_is_sent() {
        assert!(validate_url(&serde_json::json!({"url": "ftp://x/y"})).is_err());
        assert!(validate_url(&serde_json::json!({"url": "http://localhost/h"})).is_err());
        assert!(validate_url(&serde_json::json!({"url": "http://localhost/h", "allowPrivateHosts": true})).is_ok());
        assert!(validate_url(&serde_json::json!({"url": "http://hooks.test/h", "allowedHosts": ["hooks.test"]})).is_ok());
    }

    #[test]
    fn headers_expand_only_allowed_environment_variables() {
        let path = std::env::var("PATH").unwrap_or_default();
        let allowed = vec!["PATH".to_owned()];
        assert_eq!(resolve_header(&serde_json::json!("Bearer ${PATH}"), &allowed), format!("Bearer {path}"));
        assert_eq!(resolve_header(&serde_json::json!("Bearer $PATH"), &[]), "Bearer ");
    }

    /// An event the process's input queue refuses is a failed hook, not a run with empty input.
    #[tokio::test]
    async fn a_payload_the_input_queue_refuses_fails_the_hook() {
        let manager = Arc::new(mixdog_core_api::domain::mock::MockProcessManager::default());
        manager.saturate(mixdog_core_api::domain::process::ProcessQueue::Input);
        let runner = CommandRunner::new(manager);
        let handler = HookHandler {
            raw: serde_json::json!({"command": "cat", "args": []}),
            source: std::path::PathBuf::new(),
            plugin_root: None,
            plugin_data: None,
            untrusted: false,
        };
        let dir = std::env::temp_dir();
        let payload = serde_json::json!({"big": "x"});
        let ctx = CommandContext { project_dir: &dir, project_exists: true, plugin_data_dir: &dir, payload: &payload, event: "Stop", report_detached: None };
        let run = runner.run(&handler, &ctx).await;
        assert_eq!(run.exit_code, -1);
        assert!(run.stderr.contains("could not write the hook input"), "{}", run.stderr);
    }

    /// An async hook whose payload cannot be written returns at once, and the failure is reported afterwards.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_async_hook_reports_a_failed_payload_write_later() {
        // The background write runs on the runtime's executors, which the process installs at boot.
        mixdog_rt::testing::tokens();
        let manager = Arc::new(mixdog_core_api::domain::mock::MockProcessManager::default());
        manager.saturate(mixdog_core_api::domain::process::ProcessQueue::Input);
        let runner = CommandRunner::new(manager);
        let handler = HookHandler {
            raw: serde_json::json!({"command": "cat", "args": [], "async": true}),
            source: std::path::PathBuf::new(),
            plugin_root: None,
            plugin_data: None,
            untrusted: false,
        };
        let dir = std::env::temp_dir();
        let payload = serde_json::json!({"big": "x"});
        let (reported, mut reports) = tokio::sync::mpsc::unbounded_channel();
        let report: DetachedReport = Arc::new(move |error: String| {
            let _ = reported.send(error);
        });
        let ctx =
            CommandContext { project_dir: &dir, project_exists: true, plugin_data_dir: &dir, payload: &payload, event: "Stop", report_detached: Some(report) };
        let run = runner.run(&handler, &ctx).await;
        assert!(run.is_async && run.exit_code == 0, "{run:?}");
        let error = mixdog_rt::time::timeout(std::time::Duration::from_secs(20), reports.recv()).await.expect("the failure is reported").unwrap();
        assert!(error.contains("could not write the hook input"), "{error}");
    }

    /// The real process manager with a feed and an input queue far smaller than what the hooks below exchange.
    fn local_runner() -> CommandRunner {
        local_runner_and_manager().0
    }

    fn local_runner_and_manager() -> (CommandRunner, Arc<mixdog_spawn::LocalProcessManager>) {
        let config = mixdog_spawn::ProcessConfig { ring_bytes: 64 * 1024, input_queue_bytes: 64 * 1024, ..mixdog_spawn::ProcessConfig::default() };
        let manager = Arc::new(mixdog_spawn::LocalProcessManager::new(mixdog_rt::testing::tokens().spawn_io, config));
        (CommandRunner::new(manager.clone()), manager)
    }

    async fn run_hook(runner: &CommandRunner, raw: Value, payload: &Value) -> HandlerRun {
        let handler = HookHandler { raw, source: std::path::PathBuf::new(), plugin_root: None, plugin_data: None, untrusted: false };
        let dir = std::env::temp_dir();
        let ctx = CommandContext { project_dir: &dir, project_exists: true, plugin_data_dir: &dir, payload, event: "Stop", report_detached: None };
        runner.run(&handler, &ctx).await
    }

    const BIG: usize = 1024 * 1024;

    /// A hook that writes a megabyte and reads a megabyte of input, in either order, completes well inside its time limit:
    /// its output is drained while its input is written.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_hook_exchanging_large_input_and_output_in_either_order_completes() {
        let runner = local_runner();
        let payload = serde_json::json!({"big": "x".repeat(BIG)});
        let (shell, write, read) = if cfg!(windows) {
            (
                "powershell",
                format!("[Console]::Out.Write('x' * {BIG}); [Console]::Out.Flush()"),
                format!("$n = [Console]::In.ReadToEnd().Length; if ($n -lt {BIG}) {{ exit 5 }}"),
            )
        } else {
            ("bash", format!("head -c {BIG} /dev/zero | tr '\\0' x"), format!("n=$(wc -c); [ \"$n\" -ge {BIG} ] || exit 5"))
        };
        for script in [format!("{write}; {read}"), format!("{read}; {write}")] {
            let run = run_hook(&runner, serde_json::json!({"command": script, "shell": shell, "timeout": 60}), &payload).await;
            assert!(!run.timed_out, "{script}: {}", run.stderr);
            assert_eq!(run.exit_code, 0, "{script}: {}", run.stderr);
            assert_eq!(run.stdout.len(), BIG, "{script}");
        }
    }

    /// A hook that exits without reading its input breaks the pipe the payload is written to: its exit status reports the
    /// run, not the write.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_broken_input_pipe_defers_to_the_exit_status() {
        let runner = local_runner();
        let payload = serde_json::json!({"big": "x".repeat(4 * BIG)});
        let raw = if cfg!(windows) {
            serde_json::json!({"command": "cmd.exe", "args": ["/c", "exit 3"], "timeout": 60})
        } else {
            serde_json::json!({"command": "sh", "args": ["-c", "exit 3"], "timeout": 60})
        };
        let run = run_hook(&runner, raw, &payload).await;
        assert!(!run.timed_out && run.spawn_error.is_none(), "{run:?}");
        assert_eq!(run.exit_code, 3, "{}", run.stderr);
        assert!(!run.stderr.contains("could not write the hook input"), "{}", run.stderr);
    }

    /// A hook that closes its input unread, works on and then blocks (exit 2 with its reason) is not ended by the broken pipe:
    /// its block and reason come back.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_hook_that_closes_its_input_and_works_on_returns_its_block() {
        let runner = local_runner();
        let payload = serde_json::json!({"big": "x".repeat(4 * BIG)});
        let (shell, script) = if cfg!(windows) {
            (
                "powershell",
                concat!(
                    r#"$k = Add-Type -Name StdIn -Namespace HookTest -PassThru -MemberDefinition '[DllImport("kernel32.dll")] public static extern System.IntPtr GetStdHandle(int n); [DllImport("kernel32.dll")] public static extern bool CloseHandle(System.IntPtr h);'; "#,
                    r#"[void]$k::CloseHandle($k::GetStdHandle(-10)); Start-Sleep -Milliseconds 1500; [Console]::Error.Write('keep going'); exit 2"#,
                ),
            )
        } else {
            ("bash", "exec 0<&-; sleep 1; echo 'keep going' >&2; exit 2")
        };
        let run = run_hook(&runner, serde_json::json!({"command": script, "shell": shell, "timeout": 60}), &payload).await;
        assert!(!run.timed_out && run.spawn_error.is_none(), "{run:?}");
        assert_eq!(run.exit_code, 2, "{}", run.stderr);
        assert!(run.stderr.contains("keep going"), "{}", run.stderr);
    }

    /// An async hook that never reads a payload larger than its pipe does not hold the caller: the write is started and the
    /// run returns.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn an_async_hook_returns_before_its_payload_is_written() {
        let (runner, manager) = local_runner_and_manager();
        let payload = serde_json::json!({"big": "x".repeat(4 * BIG)});
        let raw = if cfg!(windows) {
            serde_json::json!({"command": "ping", "args": ["-n", "60", "127.0.0.1"], "async": true, "timeout": 60})
        } else {
            serde_json::json!({"command": "sleep", "args": ["60"], "async": true, "timeout": 60})
        };
        let run = mixdog_rt::time::timeout(std::time::Duration::from_secs(20), run_hook(&runner, raw, &payload)).await;
        for process in manager.list() {
            let _ = manager.kill(&process.handle);
        }
        let run = run.expect("the async hook returns without waiting for its input to drain");
        assert!(run.is_async && run.exit_code == 0, "{run:?}");
    }
}

impl CommandRunner {
    pub fn new(processes: Arc<dyn ProcessManager>) -> Self {
        Self { processes, next: AtomicU64::new(0), prefix: format!("hook-{}", std::process::id()) }
    }

    fn handle(&self) -> ProcessHandle {
        ProcessHandle(format!("{}-{}", self.prefix, self.next.fetch_add(1, Ordering::Relaxed)))
    }

    pub async fn run(&self, handler: &HookHandler, ctx: &CommandContext<'_>) -> HandlerRun {
        let project = ctx.project_dir.to_string_lossy().into_owned();
        let plugin_root = handler.plugin_root.as_ref().map_or_else(|| project.clone(), |p| p.to_string_lossy().into_owned());
        let plugin_data = ctx.plugin_data_dir.to_string_lossy().into_owned();
        let Some((program, args)) = spawn_spec(handler, &project, &plugin_data, &plugin_root) else {
            return HandlerRun::spawn_failed("command handler has no command");
        };
        let cwd = if ctx.project_exists { ctx.project_dir.to_path_buf() } else { std::env::current_dir().unwrap_or_default() };
        let Some(cwd) = AbsPath::new(&cwd) else { return HandlerRun::spawn_failed("the hook working directory is not absolute") };
        let mut set = vec![
            ("MIXDOG_PROJECT_DIR".to_owned(), project.clone()),
            ("MIXDOG_PLUGIN_ROOT".to_owned(), plugin_root.clone()),
            ("MIXDOG_PLUGIN_DATA".to_owned(), plugin_data.clone()),
            ("CLAUDE_PROJECT_DIR".to_owned(), project),
            ("CLAUDE_PLUGIN_ROOT".to_owned(), plugin_root),
            ("CLAUDE_PLUGIN_DATA".to_owned(), plugin_data),
        ];
        let effort = ctx.payload.get("effort").map(|e| e.get("level").unwrap_or(e)).filter(|e| !e.is_null() && e.as_str() != Some(""));
        if let Some(level) = effort {
            set.push(("CLAUDE_EFFORT".to_owned(), value_to_string(level)));
        }
        let timeout = handler_timeout(&handler.raw, ctx.event);
        let detached = handler.raw.get("async") == Some(&Value::Bool(true));
        // Serialized before the spawn: nothing stands between the start and the subscription to the output.
        let input = json_stringify(ctx.payload).into_bytes();
        let handle = self.handle();
        let request = SpawnRequest {
            handle: handle.clone(),
            command: CommandSpec::Argv { program: program.clone(), args },
            cwd,
            env: EnvSpec { inherit: true, set, remove: SCRUBBED_ENV.iter().map(|s| (*s).to_owned()).collect() },
            pty: None,
            stdin_piped: true,
            output: OutputMode::Separate,
            owner: ProcessOwner::Internal,
            time_limit: Some(timeout),
        };
        if detached {
            // The hook outlives the initiating turn (Node's `runDetached`): the write is started and the call returns.
            // Nothing is captured (no subscriber holds its output back), and the time limit keeps its lifetime finite.
            if let Err(error) = self.processes.spawn(request).await {
                return HandlerRun::spawn_failed(format!("could not start {program}: {error:?}"));
            }
            let processes = Arc::clone(&self.processes);
            let report = ctx.report_detached.clone();
            drop(mixdog_rt::spawn("hook-stdin", mixdog_rt::TaskClass::Work, async move {
                match processes.write_stdin_whole(&handle, input).await.or_else(input_ended) {
                    Ok(()) => {
                        let _ = processes.close_stdin(&handle);
                    }
                    // Ended and reported later, as Node's `runDetached` does (`hook spawn failed: …` through `hook:error`).
                    Err(error) => {
                        let _ = processes.kill(&handle);
                        if let Some(report) = report {
                            report(format!("could not write the hook input: {error:?}"));
                        }
                    }
                }
            }));
            return HandlerRun { exit_code: 0, is_async: true, ..HandlerRun::default() };
        }
        // Subscribed in the spawn itself, from the first byte: output the hook writes before the subscription would
        // otherwise overrun the replay ring.
        let mut events = match self.processes.spawn_subscribed(request).await {
            Ok((_, events)) => events,
            Err(error) => return HandlerRun::spawn_failed(format!("could not start {program}: {error:?}")),
        };
        let mut guard = KillOnDrop { processes: Arc::clone(&self.processes), handle: handle.clone(), armed: true };
        // The whole payload goes in, whatever its size, and then the input is closed.
        let write = async {
            let written = self.processes.write_stdin_whole(&handle, input).await;
            if written.is_ok() {
                let _ = self.processes.close_stdin(&handle);
            }
            written
        };
        // The output is drained while the payload is written: a hook that writes much before it reads would otherwise
        // stall its output feed and, with it, its reading.
        let mut write = std::pin::pin!(write);
        let mut written = false;
        let (mut stdout, mut stderr): (Vec<u8>, Vec<u8>) = (Vec::new(), Vec::new());
        let exit = loop {
            let event = tokio::select! {
                result = &mut write, if !written => {
                    // A failed write ends the run at once; the guard ends the hook.
                    if let Err(error) = result.or_else(input_ended) {
                        return HandlerRun::failed(format!("could not write the hook input: {error:?}"), false);
                    }
                    written = true;
                    continue;
                }
                event = events.next() => event,
            };
            match event {
                Some(ProcessEvent::Output { stream, bytes, .. }) => {
                    let target = if stream == OutputStream::Stderr { &mut stderr } else { &mut stdout };
                    if target.len() < MAX_BUFFER_BYTES {
                        let room = MAX_BUFFER_BYTES - target.len();
                        target.extend_from_slice(&bytes[..bytes.len().min(room)]);
                    }
                }
                Some(ProcessEvent::Exited { exit, .. }) => break Some(exit),
                None => break None,
            }
        };
        // The process is gone, so a write still pending ends now; its outcome decides as one that ended first.
        if !written && let Err(error) = write.await.or_else(input_ended) {
            return HandlerRun::failed(format!("could not write the hook input: {error:?}"), false);
        }
        guard.armed = false;
        let stdout = String::from_utf8_lossy(&stdout).into_owned();
        let stderr_text = decode_shell_bytes(&stderr, host_oem());
        let Some(exit) = exit else { return HandlerRun::failed("hook process events ended without an exit", false) };
        if exit.killed == Some(KillReason::TimeLimit) {
            return HandlerRun {
                exit_code: -1,
                stdout,
                stderr: if stderr_text.is_empty() { format!("hook command timed out after {}ms", timeout.as_millis()) } else { stderr_text },
                timed_out: true,
                ..HandlerRun::default()
            };
        }
        match exit.status {
            ExitStatus::Code(code) => HandlerRun { exit_code: code, stdout, stderr: stderr_text, ..HandlerRun::default() },
            // `hook command terminated by ${terminationSignal}` (`command-handler.mjs`): the signal's name.
            ExitStatus::Signal(signal) => HandlerRun {
                exit_code: -1,
                stdout,
                stderr: if stderr_text.is_empty() {
                    format!("hook command terminated by {}", signal_name(signal).map_or_else(|| signal.to_string(), str::to_owned))
                } else {
                    stderr_text
                },
                ..HandlerRun::default()
            },
        }
    }
}
/// A hook that exits, or closes its input, before the payload drained (Node's tolerated `EPIPE`/`EOF`): not a failure, the
/// exit status reports the run. Any other write failure stays one.
fn input_ended(error: ProcessError) -> Result<(), ProcessError> {
    let ended = match &error {
        ProcessError::StdinClosed => true,
        ProcessError::Io { os_code: Some(code) } => {
            matches!(std::io::Error::from_raw_os_error(*code).kind(), std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::UnexpectedEof)
        }
        _ => false,
    };
    if ended { Ok(()) } else { Err(error) }
}

fn resolve_header(value: &Value, allowed: &[String]) -> String {
    let Some(text) = value.as_str() else { return if value.is_null() { String::new() } else { mixdog_js::value_to_string(value) } };
    let pattern = regex::Regex::new(r"\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))").expect("static pattern");
    pattern
        .replace_all(text, |c: &regex::Captures<'_>| {
            let name = c.get(1).or_else(|| c.get(2)).map_or("", |m| m.as_str());
            if allowed.iter().any(|a| a == name) { std::env::var(name).unwrap_or_default() } else { String::new() }
        })
        .into_owned()
}
/// POSTs the payload to an HTTP hook. Redirects are refused; a host that resolves to a
/// non-public address is refused (and the connection is pinned to the address that was
/// checked) unless the handler opts in.
pub async fn run_http(handler: &HookHandler, payload: &Value, event: &str) -> HandlerRun {
    let checked = match validate_url(&handler.raw) {
        Ok(checked) => checked,
        Err(message) => return HandlerRun::spawn_failed(message),
    };
    let timeout = handler_timeout(&handler.raw, event);
    let mut builder = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(timeout);
    if !checked.allow_private {
        let host = checked.url.host_str().unwrap_or_default().to_owned();
        let port = checked.url.port_or_known_default().unwrap_or(80);
        let addresses: Vec<std::net::SocketAddr> = match tokio::net::lookup_host((host.as_str(), port)).await {
            Ok(found) => found.collect(),
            Err(error) => return HandlerRun::spawn_failed(format!("could not resolve {host}: {error}")),
        };
        if addresses.is_empty() || addresses.iter().any(|a| non_public(a.ip())) {
            return HandlerRun::spawn_failed(format!("blocked hook URL to a non-public address: {host}"));
        }
        builder = builder.resolve_to_addrs(&host, &addresses);
    }
    let Ok(client) = builder.build() else { return HandlerRun::spawn_failed("could not build the HTTP client") };
    let allowed: Vec<String> = handler.raw.get("allowedEnvVars").and_then(Value::as_array).map(|v| v.iter().map(value_to_string).collect()).unwrap_or_default();
    let mut headers: BTreeMap<String, String> = BTreeMap::from([("Content-Type".to_owned(), "application/json".to_owned())]);
    if let Some(extra) = handler.raw.get("headers").and_then(Value::as_object) {
        for (key, value) in extra {
            headers.insert(key.clone(), resolve_header(value, &allowed));
        }
    }
    let mut request = client.post(checked.url.clone()).body(json_stringify(payload));
    for (key, value) in &headers {
        request = request.header(key, value);
    }
    let response = match request.send().await {
        Ok(response) => response,
        Err(error) if error.is_timeout() => {
            return HandlerRun::failed(format!("HTTP hook timed out: {}", checked.url), true);
        }
        Err(error) => return HandlerRun::spawn_failed(error.without_url().to_string()),
    };
    let status = response.status();
    if status.is_redirection() {
        return HandlerRun::spawn_failed(format!("HTTP hook redirect refused ({status})"));
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let Ok(chunk) = chunk else { return HandlerRun::spawn_failed("HTTP hook response could not be read") };
        body.extend_from_slice(&chunk);
        if body.len() > MAX_BUFFER_BYTES {
            return HandlerRun::spawn_failed("HTTP hook response is too large");
        }
    }
    let text = String::from_utf8_lossy(&body).into_owned();
    if !status.is_success() {
        let reason = status.canonical_reason().unwrap_or_default();
        return HandlerRun { exit_code: 1, stdout: text, stderr: js_trim(&format!("HTTP {} {reason}", status.as_u16())).to_owned(), ..HandlerRun::default() };
    }
    HandlerRun { exit_code: 0, stdout: text, ..HandlerRun::default() }
}
