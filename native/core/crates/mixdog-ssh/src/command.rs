//! Pure building blocks for driving the system OpenSSH client: target validation, argument vectors, failure
//! classification and the tunnel restart schedule. Nothing here spawns a process.

use std::sync::LazyLock;
use std::time::Duration;

use regex::{Regex, RegexSet};

/// A validated ssh destination.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SshTarget {
    /// What ssh receives after `--`: a Host alias, `host` or `user@host`.
    pub destination: String,
    /// Explicit port from a `user@host:port` target; None defers to ssh config.
    pub port: Option<u16>,
    /// The target as configured, for messages.
    pub display: String,
}

/// Options every ssh spawn carries. Windows OpenSSH has no ControlMaster, so multiplexing is switched off
/// everywhere for identical behavior. Host keys are checked strictly: a key enters known_hosts only through the
/// pin the user confirmed, never silently from a connection.
pub const SSH_COMMON_OPTIONS: [&str; 20] = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=15",
    "-o",
    "ServerAliveInterval=10",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    // No credential or display forwarding, whatever the user's ssh config says for this host.
    "-o",
    "ForwardAgent=no",
    "-o",
    "ForwardX11=no",
    "-o",
    "ForwardX11Trusted=no",
];

/// Seconds between tunnel restarts; the last entry repeats.
pub const TUNNEL_BACKOFF_SECONDS: [u64; 9] = [1, 2, 5, 5, 10, 10, 10, 30, 30];
/// A tunnel that stayed up this long starts the schedule over.
const TUNNEL_HEALTHY_RESET: Duration = Duration::from_millis(60_000);

/// The text of a refused target (it names the variable the target came from, as the desktop did).
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct SshTargetError(pub String);

fn quoted(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_else(|_| format!("\"{text}\""))
}

fn parse_port(text: &str, raw: &str) -> Result<u16, SshTargetError> {
    let digits = !text.is_empty() && text.len() <= 5 && text.bytes().all(|byte| byte.is_ascii_digit());
    match text.parse::<u32>() {
        Ok(port) if digits && (1..=65535).contains(&port) => Ok(port as u16),
        _ => Err(SshTargetError(format!("MIXDOG_SSH_TARGET has an invalid port: {}", quoted(raw)))),
    }
}

/// Host aliases, user names, DNS names, IPv4/IPv6 literals (with zone ids). Anything else (quotes, spaces, `$`,
/// `;`, `/`...) is refused: ssh expands the host into ProxyCommand/Match exec lines, where shell metacharacters bite.
fn target_character(c: char) -> bool {
    c.is_ascii_alphanumeric() || "._@:%[]+-".contains(c)
}

/// `[v6]` or `[v6]:port`: the address and the text after the colon.
fn bracketed(host_part: &str) -> Option<(&str, Option<&str>)> {
    let inner = host_part.strip_prefix('[')?;
    let close = inner.find(']')?;
    if close == 0 {
        return None;
    }
    let rest = &inner[close + 1..];
    if rest.is_empty() {
        return Some((&inner[..close], None));
    }
    rest.strip_prefix(':').map(|port| (&inner[..close], Some(port)))
}

/// Validate an ssh destination (`alias`, `host`, `user@host`, `user@host:port`, `user@[v6]:port`) so it can never
/// be read as an ssh option.
pub fn parse_ssh_target(raw: &str) -> Result<SshTarget, SshTargetError> {
    if raw.chars().any(char::is_control) {
        return Err(SshTargetError("MIXDOG_SSH_TARGET must not contain control characters.".into()));
    }
    let value = raw.trim();
    if value.is_empty() {
        return Err(SshTargetError("MIXDOG_SSH_TARGET is empty.".into()));
    }
    if value.starts_with('-') {
        return Err(SshTargetError(format!("MIXDOG_SSH_TARGET must not start with \"-\": {}", quoted(value))));
    }
    if !value.chars().all(target_character) {
        return Err(SshTargetError(format!("MIXDOG_SSH_TARGET contains unsupported characters: {}", quoted(value))));
    }
    let at = value.rfind('@');
    let user = at.map_or("", |index| &value[..index]);
    let host_part = at.map_or(value, |index| &value[index + 1..]);
    if at.is_some() && user.is_empty() {
        return Err(SshTargetError(format!("MIXDOG_SSH_TARGET has an empty user: {}", quoted(value))));
    }
    let mut host = host_part;
    let mut port = None;
    if let Some((address, port_text)) = bracketed(host_part) {
        host = address;
        if let Some(text) = port_text {
            port = Some(parse_port(text, value)?);
        }
    } else if host_part.contains('[') || host_part.contains(']') {
        return Err(SshTargetError(format!("MIXDOG_SSH_TARGET has an unbalanced IPv6 literal: {}", quoted(value))));
    } else if host_part.split(':').count() == 2 {
        let colon = host_part.find(':').unwrap_or(0);
        host = &host_part[..colon];
        port = Some(parse_port(&host_part[colon + 1..], value)?);
    }
    // More than one colon without brackets is a bare IPv6 literal: no port.
    if host.is_empty() {
        return Err(SshTargetError(format!("MIXDOG_SSH_TARGET has an empty host: {}", quoted(value))));
    }
    if host.starts_with('-') || user.starts_with('-') {
        return Err(SshTargetError(format!(
            "MIXDOG_SSH_TARGET must not start a user or host with \"-\": {}",
            quoted(value)
        )));
    }
    let destination = if user.is_empty() { host.to_owned() } else { format!("{user}@{host}") };
    Ok(SshTarget { destination, port, display: value.to_owned() })
}

impl SshTarget {
    /// The alias or host of a target, without user and port: the default name of a saved server.
    pub fn label(&self) -> &str {
        self.destination.rfind('@').map_or(self.destination.as_str(), |at| &self.destination[at + 1..])
    }

    /// What makes two saved servers the same one: the user and port as typed, the host name without regard to case.
    pub fn key(&self) -> String {
        let (user, host) = match self.destination.rfind('@') {
            Some(at) => (&self.destination[..at], &self.destination[at + 1..]),
            None => ("", self.destination.as_str()),
        };
        let port = self.port.map(|port| port.to_string()).unwrap_or_default();
        format!("{user}@{}:{port}", host.to_lowercase())
    }

    fn base_args(&self) -> Vec<String> {
        let mut args: Vec<String> = SSH_COMMON_OPTIONS.iter().map(|option| (*option).to_owned()).collect();
        if let Some(port) = self.port {
            args.push("-p".into());
            args.push(port.to_string());
        }
        args
    }
}

/// Short exec: one remote command, no forwards inherited from ssh_config.
pub fn exec_args(target: &SshTarget, remote_command: &str) -> Vec<String> {
    let mut args = target.base_args();
    for item in ["-T", "-o", "ClearAllForwardings=yes", "--"] {
        args.push(item.into());
    }
    args.push(target.destination.clone());
    args.push(remote_command.to_owned());
    args
}

/// Long-lived local forward to the daemon's loopback session port. ClearAllForwardings cannot be used here: ssh
/// would drop this `-L` with the forwards of the config, so forwards a config defines for the host are found
/// beforehand (host-key `forwards`) and the connection refuses them. `companion` is a second `(local, remote)` pair.
pub fn tunnel_args(target: &SshTarget, local_port: u16, remote_port: u16, companion: Option<(u16, u16)>) -> Vec<String> {
    let mut args = target.base_args();
    for item in ["-N", "-T", "-o", "ExitOnForwardFailure=yes", "-L"] {
        args.push(item.into());
    }
    args.push(format!("127.0.0.1:{local_port}:127.0.0.1:{remote_port}"));
    if let Some((companion_local, companion_remote)) = companion {
        args.push("-L".into());
        args.push(format!("127.0.0.1:{companion_local}:127.0.0.1:{companion_remote}"));
    }
    args.push("--".into());
    args.push(target.destination.clone());
    args
}

/// One connection carried to 127.0.0.1:`remote_port` on the server over the child's stdin/stdout (`-W` implies
/// -N, -T, ExitOnForwardFailure and ClearAllForwardings).
pub fn stdio_forward_args(target: &SshTarget, remote_port: u16) -> Vec<String> {
    let mut args = target.base_args();
    args.push("-W".into());
    args.push(format!("127.0.0.1:{remote_port}"));
    args.push("--".into());
    args.push(target.destination.clone());
    args
}

/// Whether trying again can help.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FailureClass {
    Terminal,
    Transient,
}

/// The kind an [`SshError`] carries.
pub type SshErrorKind = FailureClass;

static TERMINAL_SSH_FAILURES: LazyLock<RegexSet> = LazyLock::new(|| {
    RegexSet::new([
        r"(?i)REMOTE HOST IDENTIFICATION HAS CHANGED",
        r"(?i)Host key verification failed",
        r"(?i)Host key for \S+ has changed",
        r"(?i)Permission denied",
        r"(?i)Too many authentication failures",
        r"(?i)Authentication failed",
        r"(?i)No more authentication methods",
    ])
    .unwrap_or_else(|_| RegexSet::empty())
});

/// Retrying cannot fix a changed host key or a refused login.
pub fn classify_failure(stderr: &str) -> FailureClass {
    if TERMINAL_SSH_FAILURES.is_match(stderr) { FailureClass::Terminal } else { FailureClass::Transient }
}

static LOCAL_BIND_FAILURE: LazyLock<Option<Regex>> = LazyLock::new(|| {
    Regex::new(
        r"(?i)cannot listen to port|Could not request local forwarding|bind \[?127\.0\.0\.1\]?.*(?:Address already in use|Permission denied)",
    )
    .ok()
});

/// The local end of a forward could not be bound: pick another local port.
pub fn is_local_forward_bind_failure(stderr: &str) -> bool {
    LOCAL_BIND_FAILURE.as_ref().is_some_and(|pattern| pattern.is_match(stderr))
}

/// Last lines of ssh's stderr, verbatim.
pub fn stderr_tail(stderr: &str, max_lines: usize, max_chars: usize) -> String {
    let normalized = stderr.replace("\r\n", "\n");
    let lines: Vec<&str> = normalized.split('\n').filter(|line| !line.trim().is_empty()).collect();
    let tail = lines[lines.len().saturating_sub(max_lines)..].join("\n");
    let count = tail.chars().count();
    if count > max_chars { tail.chars().skip(count - max_chars).collect() } else { tail }
}

/// `stderr_tail` with the defaults of the connect code (12 lines, 2000 characters).
pub fn stderr_tail_default(stderr: &str) -> String {
    stderr_tail(stderr, 12, 2_000)
}

/// An ssh run that failed.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct SshError {
    pub message: String,
    pub kind: SshErrorKind,
    pub stderr_tail: String,
    pub exit_code: Option<i32>,
}

impl SshError {
    pub fn new(message: impl Into<String>, kind: SshErrorKind) -> Self {
        Self { message: message.into(), kind, stderr_tail: String::new(), exit_code: None }
    }

    pub fn with_stderr(mut self, tail: impl Into<String>, exit_code: Option<i32>) -> Self {
        self.stderr_tail = tail.into();
        self.exit_code = exit_code;
        self
    }

    pub fn is_terminal(&self) -> bool {
        self.kind == FailureClass::Terminal
    }
}

/// Restart schedule for the supervised tunnel: walks [`TUNNEL_BACKOFF_SECONDS`] and starts over once a tunnel
/// stayed healthy for a minute.
#[derive(Clone, Debug)]
pub struct TunnelBackoff {
    schedule: Vec<Duration>,
    healthy_reset: Duration,
    index: usize,
}

impl Default for TunnelBackoff {
    fn default() -> Self {
        Self::new()
    }
}

impl TunnelBackoff {
    pub fn new() -> Self {
        Self::with_schedule(TUNNEL_BACKOFF_SECONDS.iter().map(|seconds| Duration::from_secs(*seconds)).collect(), TUNNEL_HEALTHY_RESET)
    }

    /// An empty schedule is treated as one immediate restart.
    pub fn with_schedule(schedule: Vec<Duration>, healthy_reset: Duration) -> Self {
        Self { schedule, healthy_reset, index: 0 }
    }

    /// Delay before the next start, given how long the last tunnel was ready (zero when it never became ready).
    pub fn next(&mut self, healthy_for: Duration) -> Duration {
        if healthy_for >= self.healthy_reset {
            self.index = 0;
        }
        let delay = self.schedule.get(self.index.min(self.schedule.len().saturating_sub(1))).copied().unwrap_or_default();
        self.index += 1;
        delay
    }

    pub fn reset(&mut self) {
        self.index = 0;
    }
}

#[cfg(test)]
#[path = "command_tests.rs"]
mod command_tests;
