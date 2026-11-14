//! Is there an ssh-agent holding keys? A passphrase-protected login key only works unattended through one, so a
//! failed login shows what is wrong with it.

use std::path::Path;
use std::sync::LazyLock;
use std::time::Duration;

use regex::Regex;

use crate::binary::ssh_tool_command;
use crate::context::{SshEnv, ToolOutput};

const TIMEOUT: Duration = Duration::from_millis(6_000);

const WINDOWS_AGENT_START_COMMAND: &str = "Set-Service ssh-agent -StartupType Manual; Start-Service ssh-agent; ssh-add";
const WINDOWS_AGENT_STARTED_COMMAND: &str = "Start-Service ssh-agent; ssh-add";
const POSIX_AGENT_COMMAND: &str = r#"eval "$(ssh-agent -s)" && ssh-add"#;

/// The state of the agent (mirrors the protocol's `SshAgentState`, which the ops convert into).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentState {
    Running,
    Empty,
    Stopped,
    Disabled,
    Missing,
    Unknown,
}

/// What the login guidance shows of the agent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SshAgentStatusLite {
    pub state: AgentState,
    /// Commands that bring the agent up and load a key, when there is something to run.
    pub command: Option<String>,
}

impl SshAgentStatusLite {
    fn new(state: AgentState, command: Option<&str>) -> Self {
        Self { state, command: command.map(str::to_owned) }
    }
}

/// The state of a Windows service as `sc query` prints it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ServiceState {
    Running,
    Stopped,
    Missing,
    Unknown,
}

/// `sc query` text to the service state.
pub fn parse_service_state(text: &str) -> ServiceState {
    static MISSING: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(r"(?i)1060|does not exist").ok());
    static STATE: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(r"(?i)STATE\s*:\s*\d+\s+(\w+)").ok());
    if MISSING.as_ref().is_some_and(|pattern| pattern.is_match(text)) {
        return ServiceState::Missing;
    }
    let Some(word) = STATE.as_ref().and_then(|pattern| pattern.captures(text)).and_then(|found| found.get(1)) else {
        return ServiceState::Unknown;
    };
    if word.as_str().eq_ignore_ascii_case("RUNNING") { ServiceState::Running } else { ServiceState::Stopped }
}

/// `sc qc` text: is the service disabled?
pub fn service_is_disabled(text: &str) -> bool {
    static DISABLED: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(r"(?i)START_TYPE\s*:\s*\d+\s+DISABLED").ok());
    DISABLED.as_ref().is_some_and(|pattern| pattern.is_match(text))
}

/// One tool run; a tool that cannot be started or passes its deadline is no answer.
async fn attempt(env: &SshEnv, command: &Path, args: &[&str]) -> Option<ToolOutput> {
    let args: Vec<String> = args.iter().map(|arg| (*arg).to_owned()).collect();
    env.tools.run(command, &args, TIMEOUT).await.ok()
}

/// The agent of this PC: the Windows service, or the socket the environment names, and what `ssh-add -l` says.
pub async fn agent_status(env: &SshEnv) -> SshAgentStatusLite {
    let windows = env.platform.is_windows();
    if windows {
        let service = attempt(env, Path::new("sc.exe"), &["query", "ssh-agent"]).await;
        let state = service.as_ref().map_or(ServiceState::Unknown, |run| parse_service_state(&run.stdout));
        if state == ServiceState::Missing {
            return SshAgentStatusLite::new(AgentState::Missing, None);
        }
        if state == ServiceState::Stopped {
            let config = attempt(env, Path::new("sc.exe"), &["qc", "ssh-agent"]).await;
            return if config.is_some_and(|run| service_is_disabled(&run.stdout)) {
                SshAgentStatusLite::new(AgentState::Disabled, Some(WINDOWS_AGENT_START_COMMAND))
            } else {
                SshAgentStatusLite::new(AgentState::Stopped, Some(WINDOWS_AGENT_STARTED_COMMAND))
            };
        }
    } else if env.var("SSH_AUTH_SOCK").is_none_or(str::is_empty) {
        return SshAgentStatusLite::new(AgentState::Missing, Some(POSIX_AGENT_COMMAND));
    }
    let Some(listed) = attempt(env, &ssh_tool_command("ssh-add", env), &["-l"]).await else {
        return SshAgentStatusLite::new(AgentState::Unknown, None);
    };
    match listed.exit_code {
        Some(0) => SshAgentStatusLite::new(AgentState::Running, None),
        Some(1) => SshAgentStatusLite::new(AgentState::Empty, Some("ssh-add")),
        _ => SshAgentStatusLite::new(
            AgentState::Missing,
            Some(if windows { WINDOWS_AGENT_STARTED_COMMAND } else { POSIX_AGENT_COMMAND }),
        ),
    }
}
