//! Agent presets: what tells one ACP agent from another, as data. The runner reads a preset and
//! holds no agent's name.

/// A `major.minor.patch` version as a CLI prints it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Version {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
}

impl Version {
    pub const fn new(major: u64, minor: u64, patch: u64) -> Self {
        Self { major, minor, patch }
    }

    /// The first `N.N.N` in `text`.
    pub fn find(text: &str) -> Option<Self> {
        let bytes = text.as_bytes();
        (0..bytes.len()).filter(|&at| bytes[at].is_ascii_digit() && (at == 0 || !bytes[at - 1].is_ascii_digit())).find_map(|at| {
            let mut parts = text[at..].splitn(3, '.');
            let major = parts.next()?.parse().ok()?;
            let minor = parts.next()?.parse().ok()?;
            let rest = parts.next()?;
            let digits = rest.len() - rest.trim_start_matches(|c: char| c.is_ascii_digit()).len();
            Some(Self { major, minor, patch: rest[..digits].parse().ok()? })
        })
    }
}

impl std::fmt::Display for Version {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

/// How a stored agent session is reopened in a new process.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reopen {
    /// `session/resume`: the agent restores its own state and replays nothing.
    Resume,
    /// `session/load`: the agent replays the conversation as updates, which the client drops.
    Load,
}

/// Where one agent departs from the protocol's plain reading.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Quirks {
    pub reopen: Reopen,
    /// The object path, under `agentCapabilities._meta` where the agent advertises it and under
    /// the new session's `_meta` where the client sends it, of a system prompt appendix.
    pub system_prompt_append: Option<Vec<String>>,
    /// A reply can start with no prompt open (a finished background command wakes the agent):
    /// such a reply gets a turn of its own, which ends at the reply's `usage_update`.
    pub replies_without_prompt: bool,
    /// The name the agent's `tool_call` and permission request carry, in their `name` field, for a call of an MCP
    /// server's tool: `{server}` and `{tool}` stand for the two names. A call whose `name` is exactly that for Mixdog's
    /// server and a tool it lists is Mixdog's own, as is one whose `rawInput` names the two in `ServerName` and
    /// `ToolName`; nothing else of a call is read for this. `None` knows a call by `rawInput` alone.
    pub mcp_tool_name: Option<String>,
    /// What the agent says, as a whole reply with no tool call, when the signed-in account may not use it (suspended,
    /// no access): a reply that holds one of these is the turn's failure and the agent's state, not an answer.
    pub account_refusals: Vec<String>,
    /// How the agent tells of a failure of its own inside a reply: a whole text chunk `"\n<mark> <what failed>\n"` that
    /// closes a prompt the agent answers with no usage. Such a chunk is the turn's failure, not reply text; the same
    /// text anywhere else in a reply is the reply's.
    pub failure_mark: Option<String>,
    /// What a failure the agent tells of (a notice, or the error it answers the prompt with) says when the account's
    /// sign-in no longer holds: the agent is signed out.
    pub signed_out_failures: Vec<String>,
    /// What such a failure says when the agent's session is gone: the next turn starts a new one.
    pub lost_session_failures: Vec<String>,
    /// The effort tiers the agent lists one model at, lowest first: a model id that ends in `-<tier>` is that model at
    /// that effort (`tiers`). Empty for an agent whose every model id is a model of its own.
    pub effort_tiers: Vec<String>,
    /// The id prefixes of the entries of the agent's model list that are no model but the agent's own split of one
    /// session's work over several (a planner that hands work to an executor). They are not offered: how work is
    /// split is the session's orchestration mode.
    pub own_orchestration: Vec<String>,
    /// The object path, under a new session's answer `_meta`, of the name of the plan the signed-in account is on.
    pub plan_name: Option<Vec<String>>,
}

impl Quirks {
    /// What the agent's text chunk `chunk` tells of, where it has the form of the agent's notice of a failure of its
    /// own; whether it is one, only the prompt's end tells.
    pub fn failure_notice(&self, chunk: &str) -> Option<String> {
        let mark = self.failure_mark.as_deref()?;
        let said = chunk.strip_prefix('\n')?.strip_suffix('\n')?.strip_prefix(mark)?.strip_prefix(' ')?;
        (!said.trim().is_empty() && !said.contains('\n')).then(|| said.to_owned())
    }
}

/// A program run to its exit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Command {
    pub program: String,
    pub args: Vec<String>,
}

/// A file under the folder an environment variable names.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Location {
    pub env: String,
    pub path: String,
}

/// How the agent's CLI gets onto this machine and stays current.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Upkeep {
    /// The vendor's installer for this platform; `None` where it has none.
    pub installer: Option<Command>,
    /// Where the installer puts the CLI. An installer changes `PATH` for new processes only, so a CLI not on
    /// this process's `PATH` is looked for here.
    pub installed_at: Vec<Location>,
    /// The CLI's own arguments that bring it to its newest version and exit; a current CLI exits 0 unchanged.
    pub update_args: Option<Vec<String>>,
}

/// The CLI's own interactive sign-in: it prints the page to open, reads the code that page shows from its
/// stdin where the page gives one, and exits 0 once it stored the credential itself.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Login {
    pub args: Vec<String>,
    /// Variables the login runs without, so it prints its link instead of opening a browser of its own.
    pub env_remove: Vec<String>,
}

/// The CLI's own report of the signed-in account's quota: run to its exit, it prints one JSON object whose
/// `command.data.groups` hold the quota's buckets (each with an `id`, a `window`, a `remaining_fraction` and a
/// `reset_time`), asks no model and starts no conversation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UsageReport {
    pub args: Vec<String>,
    /// The provider of Mixdog's own that signs in with the same vendor and reads the same quota: an account
    /// connected both ways is one entry, the provider's.
    pub same_quota_as: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentPreset {
    pub id: String,
    /// The picker entry's name.
    pub label: String,
    /// The route provider id a session on this agent carries.
    pub provider: String,
    pub command: String,
    /// The arguments that start the agent's ACP mode.
    pub args: Vec<String>,
    /// The arguments that print the CLI's version and exit.
    pub version_args: Vec<String>,
    /// Set for the agent's ACP mode and its sign-in, not for its version, install and update runs.
    pub env: Vec<(String, String)>,
    pub minimum_version: Version,
    pub quirks: Quirks,
    pub upkeep: Upkeep,
    pub login: Option<Login>,
    /// `None` for an agent whose CLI reports no quota.
    pub usage: Option<UsageReport>,
}

fn antigravity_installer() -> Option<Command> {
    let command = |program: &str, args: &[&str]| Command { program: program.into(), args: args.iter().map(|arg| (*arg).to_owned()).collect() };
    if cfg!(windows) {
        Some(command(
            "powershell",
            &["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "irm https://antigravity.google/cli/install.ps1 | iex"],
        ))
    } else {
        Some(command("bash", &["-c", "curl -fsSL https://antigravity.google/cli/install.sh | bash"]))
    }
}

fn antigravity_installed_at() -> Vec<Location> {
    let (env, path) = if cfg!(windows) { ("LOCALAPPDATA", "agy/bin/agy.exe") } else { ("HOME", ".local/bin/agy") };
    vec![Location { env: env.into(), path: path.into() }]
}

/// The presets Mixdog ships.
pub fn builtin() -> Vec<AgentPreset> {
    vec![AgentPreset {
        id: "antigravity".into(),
        // Mixdog has a provider of its own that signs in with the same vendor: this is the agent, and reads apart from it.
        label: "Antigravity ACP".into(),
        provider: "acp-antigravity".into(),
        command: "agy".into(),
        args: vec!["acp".into(), "--disable-telemetry".into()],
        version_args: vec!["--version".into()],
        // The CLI replaces its own binary in the background of a regular run; a session's process is not to have
        // that happen under it, so Mixdog runs the update itself while no session's agent is running.
        env: vec![("AGY_CLI_DISABLE_AUTO_UPDATE".into(), "1".into())],
        upkeep: Upkeep { installer: antigravity_installer(), installed_at: antigravity_installed_at(), update_args: Some(vec!["update".into()]) },
        // Without a display the CLI prints its sign-in link only.
        login: Some(Login { args: vec!["acp".into(), "--login".into()], env_remove: vec!["DISPLAY".into(), "WAYLAND_DISPLAY".into()] }),
        // The `/usage` command in print mode: the account's quota as data, with no turn.
        usage: Some(UsageReport {
            args: vec!["--print".into(), "/usage".into(), "--output-format".into(), "json".into()],
            same_quota_as: Some("antigravity-oauth".into()),
        }),
        // Below it the CLI lists only Gemini models to a client that is not an allowed editor.
        minimum_version: Version::new(1, 5, 1),
        quirks: Quirks {
            // Its `session/load` replays past tool calls.
            reopen: Reopen::Resume,
            system_prompt_append: Some(vec!["antigravity".into(), "systemPrompt".into(), "append".into()]),
            replies_without_prompt: true,
            mcp_tool_name: Some("mcp_{server}_{tool}".into()),
            account_refusals: vec!["has been disabled in this account".into()],
            // 1.5.15 sends a failure inside a turn as the text chunk "\n⚠ <error>\n" and ends the prompt with
            // `end_turn` and no usage; it answers a prompt of a session it does not hold with the error
            // "Session not found: <id>".
            // "Failed to rebuild agent" is not in 1.5.15 and is held for the versions other clients met it in.
            failure_mark: Some("⚠".into()),
            signed_out_failures: vec!["UNAUTHENTICATED".into(), "(code 401)".into()],
            lost_session_failures: vec!["Session not found".into(), "Failed to rebuild agent".into()],
            effort_tiers: ["low", "medium", "high", "xhigh"].map(str::to_owned).to_vec(),
            own_orchestration: vec!["gemini-pro-orchestrator".into()],
            plan_name: Some(["antigravity", "tier", "name"].map(str::to_owned).to_vec()),
        },
    }]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_version_is_read_from_the_clis_own_line() {
        assert_eq!(Version::find("1.3.3\n"), Some(Version::new(1, 3, 3)));
        assert_eq!(Version::find("agy version 1.5.14 (build 7)"), Some(Version::new(1, 5, 14)));
        assert_eq!(Version::find("no version here"), None);
        assert!(Version::new(1, 3, 3) < Version::new(1, 5, 1));
        assert!(Version::new(1, 10, 0) > Version::new(1, 5, 1));
    }
}
