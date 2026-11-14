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
use mixdog_js::JsRegex;
use mixdog_js::js_trim;
use mixdog_js::json_stringify;
use mixdog_js::value_to_string;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::process::CommandSpec;
use mixdog_core_api::domain::process::EnvSpec;
use mixdog_core_api::domain::process::ExitStatus;
use mixdog_core_api::domain::process::KillReason;
use mixdog_core_api::domain::process::OutputMode;
use mixdog_core_api::domain::process::OutputStream;
use mixdog_core_api::domain::process::ProcessEvent;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_core_api::domain::process::ProcessOwner;
use mixdog_core_api::domain::process::SpawnRequest;
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
        let args = args
            .iter()
            .map(|a| resolve_placeholders(&value_to_string(a), project, plugin_data, plugin_root))
            .collect();
        return Some((command, args));
    }
    let shell = match raw.get("shell").and_then(Value::as_str) {
        Some(shell @ ("powershell" | "bash")) => shell,
        _ => default_shell_kind(),
    };
    Some(if shell == "powershell" {
        (
            if cfg!(windows) { "powershell.exe" } else { "pwsh" }.to_owned(),
            vec!["-NoProfile".into(), "-NonInteractive".into(), "-Command".into(), command],
        )
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
        if let Err(error) = self.processes.spawn(request).await {
            return HandlerRun::spawn_failed(format!("could not start {program}: {error:?}"));
        }
        let mut guard = KillOnDrop { processes: Arc::clone(&self.processes), handle: handle.clone(), armed: !detached };
        let mut events = match self.processes.subscribe(&handle, Some(0)) {
            Ok(events) => events,
            Err(error) => return HandlerRun::spawn_failed(format!("could not start {program}: {error:?}")),
        };
        // A hook may ignore its input and exit before it drains; the exit status reports that.
        let input = json_stringify(ctx.payload).into_bytes();
        let _ = self.processes.write_stdin(&handle, input).await;
        let _ = self.processes.close_stdin(&handle);
        if detached {
            // The hook outlives the initiating turn: nothing is captured, and the time limit
            // keeps its lifetime finite.
            return HandlerRun { exit_code: 0, is_async: true, ..HandlerRun::default() };
        }
        let (mut stdout, mut stderr): (Vec<u8>, Vec<u8>) = (Vec::new(), Vec::new());
        let exit = loop {
            match events.next().await {
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

// ---- http ------------------------------------------------------------------------------

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
    a == 10 || a == 127 || a == 0 || (a == 169 && b == 254) || (a == 172 && (16..=31).contains(&b)) || (a == 192 && b == 168) || (a == 100 && (64..=127).contains(&b))
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
        return Err(format!(
            "blocked hook URL to private/loopback host: {host} (set allowPrivateHosts or allowedHosts to opt in)"
        ));
    }
    Ok(Checked { url, allow_private })
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
    let allowed: Vec<String> = handler
        .raw
        .get("allowedEnvVars")
        .and_then(Value::as_array)
        .map(|v| v.iter().map(value_to_string).collect())
        .unwrap_or_default();
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_and_local_hosts_are_recognised() {
        for host in ["localhost", "foo.localhost", "printer.local", "127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.1.1", "100.64.0.1", "[::1]", "fd12::1", "::ffff:127.0.0.1", ""] {
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
}
