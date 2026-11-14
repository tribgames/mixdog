//! What a failed connection threw ([`ConnectError`]) and the guidance view the connect dialog shows for it.
//!
//! The view is a [`SshFailureKind`] of the protocol; [`SshFailureLite`] carries it with the error code behind it, the
//! message the view shows and whether only Settings -> Connection can confirm the fix. Its tests are in
//! `bootstrap_tests.rs`, beside the rest of the connect-side ones.

use std::sync::LazyLock;

use mixdog_app_protocol::v2::connections::{SshFailure, SshFailureKind};
use regex::Regex;

use crate::binary::{client_install_command, is_missing_message};
use crate::command::{FailureClass, SshError, SshTarget};
use crate::context::Platform;
use crate::install_wire::RemoteBootstrapError;

/// What one connect attempt's ssh or bootstrap step failed with.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ConnectError {
    #[error(transparent)]
    Ssh(SshError),
    #[error(transparent)]
    Bootstrap(RemoteBootstrapError),
}

impl From<SshError> for ConnectError {
    fn from(error: SshError) -> Self {
        Self::Ssh(error)
    }
}

impl From<RemoteBootstrapError> for ConnectError {
    fn from(error: RemoteBootstrapError) -> Self {
        Self::Bootstrap(error)
    }
}

impl ConnectError {
    /// Terminal ssh failures (host key, login) and terminal bootstrap failures: redialing cannot fix them.
    pub fn is_terminal(&self) -> bool {
        match self {
            Self::Ssh(error) => error.is_terminal(),
            Self::Bootstrap(error) => error.is_terminal(),
        }
    }
}

/// The view of a failure with the code behind it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshFailureLite {
    pub kind: SshFailureKind,
    /// A bootstrap code, `ssh-terminal` / `ssh-transient` for a plain ssh failure, else the view's own name.
    pub code: String,
    /// The text the view shows (empty for a view that has none of its own).
    pub message: String,
    /// A refused host key or login can only be confirmed again where servers are managed.
    pub settings_required: bool,
}

impl SshFailureLite {
    /// The wire form, with `code`.
    pub fn into_failure(self) -> SshFailure {
        SshFailure { kind: self.kind, code: Some(self.code) }
    }

    /// The view's own name (`auth`, `host-key-changed`, `failed`, ...).
    pub fn kind_name(&self) -> String {
        kind_name(&self.kind)
    }
}

fn kind_name(kind: &SshFailureKind) -> String {
    serde_json::to_value(kind)
        .ok()
        .and_then(|value| value.get("kind").and_then(|name| name.as_str().map(str::to_owned)))
        .unwrap_or_else(|| "failed".to_owned())
}

const MAX_MESSAGE_CHARS: usize = 800;

fn bounded(message: &str) -> String {
    let trimmed = message.trim();
    let count = trimmed.chars().count();
    if count > MAX_MESSAGE_CHARS { trimmed.chars().skip(count - MAX_MESSAGE_CHARS).collect() } else { trimmed.to_owned() }
}

static HOST_KEY_CHANGED: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"(?i)REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|Host key for \S+ has changed").ok());
/// Strict checking refuses a key it has never seen with the same closing line as a changed one; only the second is a
/// warning about the server.
static HOST_KEY_UNKNOWN: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(r"(?i)No \S+ host key is known for").ok());
static LOGIN_REFUSED: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"(?i)Permission denied|Too many authentication failures|Authentication failed|No more authentication methods").ok());
static PID: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(r"\bpid (\d+)").ok());

fn hit(pattern: &LazyLock<Option<Regex>>, text: &str) -> bool {
    pattern.as_ref().is_some_and(|regex| regex.is_match(text))
}

fn pid_of(message: &str) -> Option<u32> {
    let pid = PID.as_ref()?.captures(message)?.get(1)?.as_str().parse::<u32>().ok()?;
    (pid > 0).then_some(pid)
}

/// The two commands that put this PC's login key on the server. Windows has no ssh-copy-id, so its second command
/// pipes the public key through ssh.
pub fn login_key_commands(target: &SshTarget, platform: Platform) -> (String, String) {
    let port = target.port.map(|port| format!("-p {port} ")).unwrap_or_default();
    let register = if platform.is_windows() {
        format!(
            r#"Get-Content "$env:USERPROFILE\.ssh\id_ed25519.pub" | ssh {port}{} "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys""#,
            target.destination
        )
    } else {
        format!("ssh-copy-id {port}{}", target.destination)
    };
    ("ssh-keygen -t ed25519".to_owned(), register)
}

/// The failure view for what a connection threw, with the code the view shows in its details.
pub fn failure_of(error: &ConnectError, target: &SshTarget, platform: Platform) -> SshFailureLite {
    let message = error.to_string();
    let kind = classify(error, &message, target, platform);
    let code = match error {
        ConnectError::Bootstrap(bootstrap) => bootstrap.code.clone(),
        ConnectError::Ssh(ssh) if matches!(kind, SshFailureKind::Failed { .. }) => match ssh.kind {
            FailureClass::Terminal => "ssh-terminal".to_owned(),
            FailureClass::Transient => "ssh-transient".to_owned(),
        },
        ConnectError::Ssh(_) => kind_name(&kind),
    };
    let shown = match &kind {
        SshFailureKind::UnsupportedPlatform { message }
        | SshFailureKind::InstallFailed { message }
        | SshFailureKind::ProtocolMismatch { message }
        | SshFailureKind::Internal { message }
        | SshFailureKind::RemoteShell { message }
        | SshFailureKind::DaemonBusy { message }
        | SshFailureKind::PortUnavailable { message }
        | SshFailureKind::DaemonStop { message }
        | SshFailureKind::DaemonReplace { message }
        | SshFailureKind::DaemonUnproven { message }
        | SshFailureKind::DaemonUnmanaged { message }
        | SshFailureKind::DaemonDataInUse { message }
        | SshFailureKind::Failed { message } => message.clone(),
        _ => String::new(),
    };
    let settings_required = matches!(kind, SshFailureKind::HostKeyChanged { .. } | SshFailureKind::Auth { .. });
    SshFailureLite { kind, code, message: shown, settings_required }
}

fn classify(error: &ConnectError, message: &str, target: &SshTarget, platform: Platform) -> SshFailureKind {
    let text = match error {
        ConnectError::Bootstrap(bootstrap) => return classify_bootstrap(bootstrap, message),
        ConnectError::Ssh(ssh) => format!("{}\n{message}", ssh.stderr_tail),
    };
    if is_missing_message(&text) {
        return SshFailureKind::SshMissing { command: client_install_command(platform).map(str::to_owned) };
    }
    if hit(&HOST_KEY_CHANGED, &text) && !hit(&HOST_KEY_UNKNOWN, &text) {
        return SshFailureKind::HostKeyChanged { previous: None, current: None };
    }
    if hit(&LOGIN_REFUSED, &text) {
        let (keygen, register) = login_key_commands(target, platform);
        return SshFailureKind::Auth { keygen, register, agent: None };
    }
    SshFailureKind::Failed { message: bounded(message) }
}

fn classify_bootstrap(error: &RemoteBootstrapError, message: &str) -> SshFailureKind {
    let shown = bounded(message);
    match error.code.as_str() {
        // This desktop is older than the core on the server: the fix is updating this PC, which the server's own words say.
        "client-outdated" => SshFailureKind::Failed { message: shown },
        "daemon-not-proxy" | "daemon-model-login" => match pid_of(&error.message) {
            Some(pid) => SshFailureKind::DaemonRunning { pid },
            None => SshFailureKind::Failed { message: shown },
        },
        // Codes the server install reports, compared as text so the two sides can evolve apart.
        "unsupported-platform" => SshFailureKind::UnsupportedPlatform { message: shown },
        "install-failed" | "local-payload" => SshFailureKind::InstallFailed { message: shown },
        "protocol-mismatch" => SshFailureKind::ProtocolMismatch { message: shown },
        "internal" | "protocol" => SshFailureKind::Internal { message: shown },
        "remote-shell" | "remote-home" => SshFailureKind::RemoteShell { message: shown },
        "install-locked" => SshFailureKind::InstallLocked,
        "daemon-busy-other-version" => SshFailureKind::DaemonBusy { message: shown },
        "port-unavailable" => SshFailureKind::PortUnavailable { message: shown },
        "daemon-stop" => SshFailureKind::DaemonStop { message: shown },
        "daemon-replace" => SshFailureKind::DaemonReplace { message: shown },
        "daemon-unproven" => SshFailureKind::DaemonUnproven { message: shown },
        "daemon-unmanaged" => SshFailureKind::DaemonUnmanaged { message: shown },
        "daemon-data-in-use" => SshFailureKind::DaemonDataInUse { message: shown },
        _ => SshFailureKind::Failed { message: shown },
    }
}
