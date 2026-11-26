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
    /// server and a tool it lists is Mixdog's own, as is one whose `_meta.mcp` names the two in `server` and `tool`, or
    /// whose `rawInput` names them in `ServerName` and `ToolName`; nothing else of a call is read for this. `None` knows
    /// a call by `_meta.mcp` and `rawInput` alone.
    pub mcp_tool_name: Option<String>,
    /// How long the agent waits for one call of a tool of an MCP server the client gave it before it gives the call up
    /// and tells its model the call timed out; `None` for an agent that waits until the call ends. A call of a Mixdog
    /// tool not over in time is answered before it and goes on as a background task of the session.
    pub mcp_call_deadline: Option<std::time::Duration>,
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
    /// The models of the agent's list a session on this preset runs: the agent lists others, which run on another
    /// preset of the same agent.
    pub model_scope: ModelScope,
    /// A route or a call may name the agent's own default model ([`crate::agents::DEFAULT_MODEL`]) and it runs. The
    /// picker lists only named models.
    pub runs_default: bool,
    /// Mixdog's word on how to call the tools it hands over ([`crate::mcp::preference`]) follows its prompt.
    pub append_tool_guidance: bool,
    /// The most bytes of one MCP call's result the agent hands its model whole, asked of it when it opens a session it
    /// is handed Mixdog's tools in; `None` for an agent that takes no such setting.
    pub mcp_max_output_bytes: Option<u64>,
}

/// Which of the models an agent lists a preset runs, by the start of a model's id.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ModelScope {
    OnlyPrefixes(Vec<String>),
    ExceptPrefixes(Vec<String>),
}

impl ModelScope {
    /// Whether the model `id` (the agent's id of it, or the id it is listed under) is one the preset runs.
    pub fn admits(&self, id: &str) -> bool {
        let starts = |prefixes: &[String]| prefixes.iter().any(|prefix| id.starts_with(prefix.as_str()));
        match self {
            Self::OnlyPrefixes(prefixes) => starts(prefixes),
            Self::ExceptPrefixes(prefixes) => !starts(prefixes),
        }
    }
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

/// Where a CLI may be: its file under the folder an environment variable names, or, with no variable, `path` as it
/// is, an absolute file or a name `PATH` finds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Location {
    pub env: Option<String>,
    pub path: String,
}

/// How many sessions one process of the agent serves.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProcessScope {
    /// A process of its own for each session, ended by force with it.
    PerSession,
    /// One process, started when the first session needs it, serves every later session of the preset, each with its own
    /// folder, tool server and settings. It runs with a temporary folder of its own and is closed by the end of its stdin.
    Shared,
}

/// How the agent's program gets onto this machine and stays current.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Distribution {
    /// The vendor's CLI, found on `PATH` (the preset's `command`) or where its installer puts it.
    Cli {
        /// The vendor's installer for this platform; `None` where it has none.
        installer: Option<Command>,
        /// Where the installer puts the CLI. An installer changes `PATH` for new processes only, so a CLI not on
        /// this process's `PATH` is looked for here.
        installed_at: Vec<Location>,
        /// The CLI's own arguments that bring it to its newest version and exit; a current CLI exits 0 unchanged.
        update_args: Option<Vec<String>>,
    },
    /// A build of the agent `agent_id` of the ACP registry at `index_url`, which Mixdog keeps in a folder of its own
    /// (`<acp data>/bin/<preset id>/`) and names in that folder's `installed.json` (`{version, cmd, args, sha256}`). One
    /// on `PATH` is never run.
    Registry {
        index_url: String,
        agent_id: String,
        /// The hosts a build's archive may come from, every redirect of its download included.
        allowed_archive_hosts: Vec<String>,
        /// The programs beside the build's own that it starts, relative to the folder the archive is unpacked into: an
        /// archive without one of them is no build, and each is left executable with it.
        helpers: Vec<String>,
        /// The registry's build of the agent runs on this system.
        supported: bool,
        /// The variable that gives the agent a home of Mixdog's own, `<acp data>/homes/<preset id>`: its sign-in and
        /// settings are none of another client's.
        home_env: String,
        /// The files of its home, relative to it, that hold its sign-in, the credential last: all of them there is an
        /// agent signed in, and a sign-in moves them into the home.
        sign_in_files: Vec<String>,
        /// Mixdog installs the build and keeps it current; `false` for a run that only uses the build the app installed.
        kept_current: bool,
    },
}

impl Distribution {
    /// As a run that never installs or updates the agent has it: what is on this machine is found as it is.
    pub fn without_mutations(self) -> Self {
        match self {
            Self::Cli { installed_at, .. } => Self::Cli { installer: None, installed_at, update_args: None },
            Self::Registry { index_url, agent_id, allowed_archive_hosts, helpers, supported, home_env, sign_in_files, .. } => {
                Self::Registry { index_url, agent_id, allowed_archive_hosts, helpers, supported, home_env, sign_in_files, kept_current: false }
            }
        }
    }
}

/// How the user signs in to an agent from the app.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Login {
    /// The CLI's own interactive sign-in: it prints the page to open, reads the code that page shows from its stdin where
    /// the page gives one, and exits 0 once it stored the credential itself.
    Cli {
        args: Vec<String>,
        /// Variables the login runs without, so it prints its link instead of opening a browser of its own.
        env_remove: Vec<String>,
        /// The login may open its page in the system's browser itself.
        opens_browser: bool,
    },
    /// The protocol's `authenticate` with the method `method_id`, asked of a process of its own in a home of its own: the
    /// agent writes the line `link_line` followed by the page to open on its stderr, and answers once the user signed in
    /// there. Where the page sends the browser back to a loopback address of the agent's, the address the browser ended
    /// on, or its code, is delivered there for a browser on another machine.
    AcpAuthenticate {
        method_id: String,
        /// The agent opens the page in the system's browser itself.
        opens_browser: bool,
        /// What starts the agent's stderr line that names the sign-in page: it writes it whenever it asks for a sign-in.
        link_line: String,
    },
}

impl Login {
    /// What starts the agent's stderr line that asks for a sign-in in the browser; `None` for a CLI's own sign-in.
    pub fn link_line(&self) -> Option<&str> {
        match self {
            Self::AcpAuthenticate { link_line, .. } => Some(link_line),
            Self::Cli { .. } => None,
        }
    }

    /// The sign-in opens its page in the system's browser itself.
    pub fn opens_browser(&self) -> bool {
        match self {
            Self::Cli { opens_browser, .. } | Self::AcpAuthenticate { opens_browser, .. } => *opens_browser,
        }
    }
}

/// Where the signed-in account's quota is read. Neither asks a model or starts a conversation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum UsageReport {
    /// The CLI's own report: run to its exit with `args`, it prints one JSON object whose `command.data.groups` hold the
    /// quota's buckets (each with an `id`, a `window`, a `remaining_fraction` and a `reset_time`).
    Command { args: Vec<String> },
    /// The quota summary of Cloud Code Assist (`retrieveUserQuotaSummary`), asked with the Google credential the agent
    /// keeps at `token_file` of its home (its `client_id`, `client_secret`, `refresh_token` and `project_id`).
    Summary { token_file: String },
}

/// How an agent runs with none of its own tools, for a session that is handed Mixdog's.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OwnToolsOff {
    AgentFile(AgentFile),
    SessionMeta(SessionMeta),
}

/// The settings a session is opened and reopened with, under its `_meta` at `path`: the agent's own tools
/// `disabled_tools` off in every session, and, in one handed Mixdog's tools, the servers `eager_mcp_servers` whose tools
/// the model is offered by name with their schemas, and the preset's `mcp_max_output_bytes`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionMeta {
    pub path: Vec<String>,
    pub disabled_tools: Vec<String>,
    pub eager_mcp_servers: Vec<String>,
}

impl SessionMeta {
    /// The settings of a session that is handed Mixdog's tools (`handed`) or none, for an agent that takes `max_output`.
    pub fn settings(&self, handed: bool, max_output: Option<u64>) -> serde_json::Value {
        let mut settings = serde_json::json!({ "disabledTools": self.disabled_tools });
        if handed {
            settings["eagerMcpServers"] = serde_json::json!(self.eager_mcp_servers);
            if let Some(bytes) = max_output {
                settings["mcpMaxOutputBytes"] = serde_json::json!(bytes);
            }
        }
        settings
    }
}

/// How a CLI is started with none of its own tools, for a session that is handed Mixdog's: an agent definition the CLI
/// finds under its start folder, and the arguments that select it and start the CLI as such a session needs it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentFile {
    pub args: Vec<String>,
    /// Where the definition goes, under the folder the CLI is started in.
    pub file: String,
    /// The agent's name, the one `args` select.
    pub name: String,
    /// The definition's instructions to the model.
    pub body: String,
}

impl AgentFile {
    /// The definition of an agent with none of the CLI's tools and the tools `server` lists. The CLI declares a server's
    /// tool to the model with its schema only where the definition names it eager; any other it lists by name alone,
    /// behind a call that reads the schema from a file first. It leaves out the CLI's default prompt sections, which
    /// describe the CLI's own tools and workspace: Mixdog's prompt describes the session's.
    pub fn definition(&self, server: &str, tools: &[String]) -> String {
        let eager: String = tools.iter().map(|tool| format!("      {}:\n        eager: true\n", serde_json::Value::from(tool.as_str()))).collect();
        format!(
            "---\nname: {}\ndescription: Works with the tools Mixdog hands over.\ntools: []\nmcpServers:\n  - name: {server}\n    tools:\n{eager}subagent: false\nexcludeDefaultComponents: true\n---\n{}",
            self.name, self.body
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentPreset {
    pub id: String,
    /// The picker entry's name. The presets of one agent share it: the user sees one agent, and the presets apart by
    /// their providers.
    pub label: String,
    /// The name the cards of the agent's own tools' calls go by, `<tool_prefix>_<kind>`: the presets of one agent share it.
    pub tool_prefix: String,
    /// The route provider id a session on this agent carries.
    pub provider: String,
    /// The CLI as `PATH` finds it; for an agent of the registry, the name its program goes by.
    pub command: String,
    /// The arguments that start the agent's ACP mode.
    pub args: Vec<String>,
    pub scope: ProcessScope,
    /// `None` for an agent whose own tools stay on when a session is handed Mixdog's.
    pub own_tools_off: Option<OwnToolsOff>,
    /// The arguments that print the CLI's version and exit; an agent of the registry is never run for its version.
    pub version_args: Vec<String>,
    /// Set for the agent's ACP mode and its sign-in, not for its version, install and update runs.
    pub env: Vec<(String, String)>,
    pub minimum_version: Version,
    pub quirks: Quirks,
    pub distribution: Distribution,
    pub login: Option<Login>,
    /// `None` for an agent whose CLI reports no quota.
    pub usage: Option<UsageReport>,
    /// The provider of Mixdog's own that signs in with the same vendor and reads the same quota: the agent's usage is
    /// priced as that provider's, and an account connected both ways is one quota entry, the provider's.
    pub same_quota_as: Option<String>,
}

fn antigravity_installer() -> Command {
    let command = |program: &str, args: &[&str]| Command { program: program.into(), args: args.iter().map(|arg| (*arg).to_owned()).collect() };
    if cfg!(windows) {
        command(
            "powershell",
            &["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "irm https://antigravity.google/cli/install.ps1 | iex"],
        )
    } else {
        command("bash", &["-c", "curl -fsSL https://antigravity.google/cli/install.sh | bash"])
    }
}

/// Where the agy CLI is, past `agy` on `PATH`: where its installer puts it, the folders Homebrew links into (which an app
/// started from the Finder or the Dock has no `PATH` to), and the same under its other name.
fn antigravity_installed_at() -> Vec<Location> {
    let under = |env: &str, path: &str| Location { env: Some(env.into()), path: path.into() };
    let at = |path: &str| Location { env: None, path: path.into() };
    if cfg!(windows) {
        return vec![under("LOCALAPPDATA", "agy/bin/agy.exe"), at("antigravity"), under("LOCALAPPDATA", "agy/bin/antigravity.exe")];
    }
    let homebrew: &[&str] = if cfg!(target_os = "macos") { &["/opt/homebrew/bin", "/usr/local/bin"] } else { &[] };
    let mut found = vec![under("HOME", ".local/bin/agy")];
    found.extend(homebrew.iter().map(|folder| at(&format!("{folder}/agy"))));
    found.extend([at("antigravity"), under("HOME", ".local/bin/antigravity")]);
    found.extend(homebrew.iter().map(|folder| at(&format!("{folder}/antigravity"))));
    found
}

/// What a Python agent's `webbrowser` runs in place of a browser (`BROWSER`): it takes the page and exits 0, so no other
/// browser is tried. The `%s` has it read as a command line.
fn no_browser() -> String {
    if cfg!(windows) { "cmd /d /c exit 0 %s" } else { "true %s" }.to_owned()
}

/// The model ids of Google's own models in Antigravity's list: Google's official ACP server runs them, and offers no
/// other model to a client it does not name as an editor.
fn gemini() -> Vec<String> {
    vec!["gemini-".into()]
}

/// What the agy CLI and Google's official ACP server share.
fn antigravity_quirks() -> Quirks {
    Quirks {
        // Its `session/load` replays past tool calls.
        reopen: Reopen::Resume,
        system_prompt_append: Some(vec!["antigravity".into(), "systemPrompt".into(), "append".into()]),
        replies_without_prompt: true,
        mcp_tool_name: Some("mcp_{server}_{tool}".into()),
        // 1.5.16 ends every call of a tool of a server `session/new` names after exactly 3 minutes ("timed out after
        // 3m0s: context deadline exceeded"), its documented default; its `timeoutSeconds` setting does not reach such a
        // server, as a field of the entry, under its `_meta` or in the agent definition. The official server 1.5.2 does
        // the same.
        mcp_call_deadline: Some(std::time::Duration::from_secs(180)),
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
        model_scope: ModelScope::ExceptPrefixes(gemini()),
        runs_default: false,
        append_tool_guidance: true,
        mcp_max_output_bytes: None,
    }
}

/// The presets Mixdog ships. Antigravity's Gemini models run on Google's official ACP server, every other model on the
/// agy CLI: each preset is a provider of its own, and both read the quota of the provider that signs in with Google.
pub fn builtin() -> Vec<AgentPreset> {
    let official = AgentPreset {
        id: "antigravity".into(),
        // One Antigravity to the user: the two presets are told apart by their providers alone.
        label: "Antigravity".into(),
        tool_prefix: "antigravity".into(),
        provider: "acp-antigravity".into(),
        command: "agy_acp_server".into(),
        args: Vec::new(),
        // It takes 4-6 s to start and about 300 MB, and each start unpacks about 137 MB into its temporary folder.
        scope: ProcessScope::Shared,
        // With every built-in tool off, the server offers its model the MCP tools and its resource reads alone.
        own_tools_off: Some(OwnToolsOff::SessionMeta(SessionMeta {
            path: vec!["antigravity".into()],
            disabled_tools: [
                "list_directory",
                "search_directory",
                "find_file",
                "view_file",
                "create_file",
                "edit_file",
                "run_command",
                "ask_question",
                "invoke_subagent",
                "run_workflow",
                "generate_image",
                "search_web",
                "read_url_content",
                "schedule",
                "finish",
            ]
            .map(str::to_owned)
            .to_vec(),
            // A server not named eager has its tools behind a read of each one's schema from a file.
            eager_mcp_servers: vec![crate::mcp::SERVER_NAME.into()],
        })),
        // The server has no version flag: it names its version in `initialize`.
        version_args: Vec::new(),
        // Its sign-in is kept in a file of its home, not in the system's keychain entry every other client of Google shares.
        // It opens no browser: a check or a sign-out that meets a sign-in it asks for shows nothing, a terminal browser
        // never holds it, and the sign-in's page is opened by the window that asked for it, on whichever machine it is.
        env: vec![("AGY_ACP_FORCE_FILE_STORAGE".into(), "1".into()), ("BROWSER".into(), no_browser())],
        // The build whose settings and answers this preset was measured on.
        minimum_version: Version::new(1, 5, 2),
        quirks: Quirks {
            // It replies only to a prompt, and tells a failure only as the prompt's error.
            replies_without_prompt: false,
            // Its calls of an MCP server's tool name the server and the tool under `_meta.mcp` alone.
            mcp_tool_name: None,
            failure_mark: None,
            signed_out_failures: vec!["UNAUTHENTICATED".into(), "(code 401)".into(), "Authentication required".into()],
            // It answers a prompt of a session it does not hold with -32002, which is a lost session whatever it says.
            lost_session_failures: vec!["Session not found".into(), "session is unknown".into()],
            model_scope: ModelScope::OnlyPrefixes(gemini()),
            runs_default: true,
            // Mixdog's own prompt already says how to group calls and give a tool its items as an array, and the server
            // shows a call's result whole.
            append_tool_guidance: false,
            // Above 4096 bytes it withholds a result from its model and saves it to a file instead.
            mcp_max_output_bytes: Some(100_000),
            ..antigravity_quirks()
        },
        distribution: Distribution::Registry {
            index_url: "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json".into(),
            agent_id: "antigravity-acp".into(),
            allowed_archive_hosts: vec!["dl.google.com".into()],
            // The harness the server drives: without it the server starts and fails each turn ("Localharness not found.").
            helpers: vec![if cfg!(windows) { "localharness_external.exe" } else { "localharness_external" }.into()],
            // 1.5.2 hangs at its start on an Intel Mac.
            supported: !(cfg!(target_os = "macos") && cfg!(target_arch = "x86_64")),
            home_env: "GEMINI_HOME".into(),
            sign_in_files: vec!["antigravity-acp/settings.json".into(), "antigravity-acp/acp_token.json".into()],
            kept_current: true,
        },
        // Google's own sign-in, whose page sends the browser back to the server's loopback address.
        login: Some(Login::AcpAuthenticate {
            method_id: "oauth-personal".into(),
            opens_browser: false,
            link_line: "Open the following link to authenticate the ACP server:".into(),
        }),
        usage: Some(UsageReport::Summary { token_file: "antigravity-acp/acp_token.json".into() }),
        same_quota_as: Some("antigravity-oauth".into()),
    };
    let cli = AgentPreset {
        id: "antigravity-cli".into(),
        label: "Antigravity".into(),
        tool_prefix: "antigravity".into(),
        provider: "acp-antigravity-cli".into(),
        command: "agy".into(),
        args: vec!["acp".into(), "--disable-telemetry".into()],
        // Its own tools are off through the agent definition in the folder it starts in, which differs by session.
        scope: ProcessScope::PerSession,
        // A custom agent whose `tools` list is empty has none of the CLI's file, shell, search and planning tools. The
        // CLI asks the client before each call of an MCP tool, and with none of its own tools all it asks about are
        // Mixdog's calls, which the session's own pipeline judges: it asks nothing.
        own_tools_off: Some(OwnToolsOff::AgentFile(AgentFile {
            args: vec!["--agent".into(), "mixdog".into(), "--dangerously-skip-permissions".into()],
            file: ".agents/agents/mixdog/agent.md".into(),
            name: "mixdog".into(),
            body: "You are a coding agent working in the user's workspace, with the tools Mixdog hands you.\n".into(),
        })),
        version_args: vec!["--version".into()],
        // The CLI replaces its own binary in the background of a regular run; a session's process is not to have
        // that happen under it, so Mixdog runs the update itself while no session's agent is running.
        env: vec![("AGY_CLI_DISABLE_AUTO_UPDATE".into(), "1".into())],
        distribution: Distribution::Cli {
            installer: Some(antigravity_installer()),
            installed_at: antigravity_installed_at(),
            update_args: Some(vec!["update".into()]),
        },
        // Without a display the CLI prints its sign-in link only; Windows and macOS always have one.
        login: Some(Login::Cli {
            args: vec!["acp".into(), "--login".into()],
            env_remove: vec!["DISPLAY".into(), "WAYLAND_DISPLAY".into()],
            opens_browser: cfg!(windows) || cfg!(target_os = "macos"),
        }),
        // The `/usage` command in print mode: the account's quota as data, with no turn.
        usage: Some(UsageReport::Command { args: vec!["--print".into(), "/usage".into(), "--output-format".into(), "json".into()] }),
        same_quota_as: Some("antigravity-oauth".into()),
        // Below it the CLI lists only Gemini models to a client that is not an allowed editor.
        minimum_version: Version::new(1, 5, 1),
        quirks: antigravity_quirks(),
    };
    vec![official, cli]
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

    fn shipped(id: &str) -> AgentPreset {
        builtin().into_iter().find(|preset| preset.id == id).expect("the preset")
    }

    /// Antigravity's two presets are two providers that split its models between them, every model to exactly one, and
    /// both price their usage as the provider that signs in with Google.
    #[test]
    fn the_official_server_runs_the_gemini_models_and_the_cli_every_other() {
        let (official, cli) = (shipped("antigravity"), shipped("antigravity-cli"));
        // One Antigravity to the user: one name, and one name for its own tools' cards.
        assert_eq!((official.provider.as_str(), official.label.as_str(), official.tool_prefix.as_str()), ("acp-antigravity", "Antigravity", "antigravity"));
        assert_eq!((cli.provider.as_str(), cli.label.as_str(), cli.tool_prefix.as_str()), ("acp-antigravity-cli", "Antigravity", "antigravity"));
        for model in ["gemini-4-neon-high", "gemini-3.8-flash", "claude-opus-5-5-low", "gpt-oss-120b-medium", "m1"] {
            let runs = [&official, &cli].map(|preset| preset.quirks.model_scope.admits(model));
            assert_eq!(runs, [model.starts_with("gemini-"), !model.starts_with("gemini-")], "{model}");
        }
        assert_eq!((official.quirks.runs_default, cli.quirks.runs_default), (true, false));
        assert_eq!([&official, &cli].map(|preset| preset.same_quota_as.as_deref()), [Some("antigravity-oauth"); 2]);
        assert!(matches!(official.distribution, Distribution::Registry { .. }) && official.version_args.is_empty());
        assert!(matches!(cli.distribution, Distribution::Cli { .. }));
    }

    /// The CLI is looked for under its other name too, and on macOS in the folders Homebrew links into, which an app
    /// started from the Finder has no `PATH` to.
    #[test]
    fn the_cli_is_looked_for_under_both_names_and_where_homebrew_links_it() {
        let Distribution::Cli { installed_at, .. } = shipped("antigravity-cli").distribution else { panic!("the CLI's preset") };
        let paths: Vec<&str> = installed_at.iter().map(|location| location.path.as_str()).collect();
        assert!(paths.contains(&"antigravity"), "{paths:?}");
        if cfg!(target_os = "macos") {
            for path in ["/opt/homebrew/bin/agy", "/usr/local/bin/agy"] {
                assert!(paths.contains(&path), "{paths:?}");
            }
        }
    }

    /// A session handed Mixdog's tools asks the official server for its whole results and Mixdog's tools by name; one
    /// handed none only has the server's own tools off.
    #[test]
    fn the_official_servers_session_settings_depend_on_whether_it_is_handed_the_tools() {
        let official = shipped("antigravity");
        let Some(OwnToolsOff::SessionMeta(meta)) = &official.own_tools_off else { panic!("the official server is told its settings") };
        let handed = meta.settings(true, official.quirks.mcp_max_output_bytes);
        assert_eq!((&handed["mcpMaxOutputBytes"], &handed["eagerMcpServers"]), (&serde_json::json!(100_000), &serde_json::json!(["mixdog"])));
        assert_eq!(handed["disabledTools"].as_array().map(Vec::len), Some(15));
        assert_eq!(meta.settings(false, official.quirks.mcp_max_output_bytes), serde_json::json!({ "disabledTools": handed["disabledTools"] }));
    }
}
