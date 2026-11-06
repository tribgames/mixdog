//! The `setup` tool backend (`session-runtime/setup-tool/executor.mjs`): validates the call,
//! applies the caller-scope rules, runs the action and answers the receipt.
//!
//! The settings this crate owns run here: the tool-module toggles and installs, the
//! instruction-files mode, the auto-effort base, web search, memory, recap and the worktree
//! settings. Every other action belongs to the package that owns what it changes (routes,
//! agents, MCP, plugins, local models, automations, …): the owner registers a
//! [`SetupActions`] for its action names, and an action nobody registered answers
//! `Unavailable`. The desktop-hosted features (browser, computer) and the desktop's own
//! preparation of git and office go through [`SetupDesktop`].

mod definitions;
mod mcp;
mod requests;
#[cfg(test)]
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup")]
mod tests;

pub use definitions::DefinitionSetup;
pub use mcp::McpSetup;
pub use requests::SetupRequests;
pub use requests::SetupUiSurface;

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_protocol::ThreadId;
use mixdog_tools::orch::service::ServiceCall;
use mixdog_tools::orch::service::ToolService;
use mixdog_tools::orch::util::PortError;
use serde_json::Map;
use serde_json::Value;

use crate::config::Config;
use crate::config::OutputStyles;
use crate::config::Settings;
use crate::tool_modules::AUTO_EFFORT_BASES;
use crate::tool_modules::INSTRUCTION_FILES_MODES;
use crate::tool_modules::ToolModules;
use crate::tool_modules::ToolModulesError;

/// `scheduleCallerScope`: who the calling session is. `agent_id` is the scope's `agentId`:
/// the agent the session is bound to (its provenance), or for an unattended run the agent
/// that run belongs to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CallerScope {
    Human,
    Agent { agent_id: String, unattended: bool },
    RoomMember,
    Headless,
}

/// What the session layer knows about the caller of a setup call.
#[async_trait]
pub trait SetupCallers: Send + Sync {
    async fn scope(&self, thread: &ThreadId) -> CallerScope;
    /// Mixy's heartbeat session.
    async fn is_heartbeat(&self, thread: &ThreadId) -> bool;
    /// The agent a human's session acts as (`caller.agent`; the agent-id half of
    /// `resolveSessionMode`), empty when it acts as none. Added as a method rather than a
    /// `CallerScope` field because `CallerScope` is built in other owners' code; WP-SESSION's
    /// composition fills it. A thread that fails to open is Node's missing caller record: the
    /// call is refused as a background run.
    async fn acting_agent(&self, _thread: &ThreadId) -> Result<String, CoreError> {
        Ok(String::new())
    }
    /// Whether the session runs in agent mode (`resolveSessionMode(..).mode`): Mixy's or a
    /// contact's chat, not a coding task. A bot created from Mixy's agent-mode chat is a bot.
    async fn agent_mode(&self, _thread: &ThreadId) -> bool {
        false
    }
    /// `mixyDisplayName()`: the representative agent's name in messages.
    async fn mixy_name(&self) -> String {
        "Mixy".into()
    }
    /// `settingsReachCurrentSession()`: an empty session takes a changed global setting at its
    /// next turn start, a conversation keeps its own until a cold point.
    async fn settings_reach_session(&self, _thread: &ThreadId) -> bool {
        false
    }
}

/// What `requestDesktop` came to.
#[derive(Clone, Debug, PartialEq)]
pub enum DesktopAnswer {
    /// The window ran it and answered the receipt's result.
    Done(Value),
    /// No window claimed the request (`SETUP_DESKTOP_UNCLAIMED`): nothing ran, the message says
    /// why.
    Unclaimed(String),
}

/// `requestDesktop`: the window that hosts a feature takes the request.
#[async_trait]
pub trait SetupDesktop: Send + Sync {
    async fn request(&self, thread: &ThreadId, args: &Value) -> Result<DesktopAnswer, PortError>;
}

/// `rt.setVoiceEnabled`: the runtime toggle the Built-in card also uses (enabling installs any
/// missing whisper/ffmpeg component first). Answers `{ status: { enabled, installed,
/// components? }, error? }`; whether that is the state asked for is the dispatcher's to judge.
#[async_trait]
pub trait SetupVoice: Send + Sync {
    async fn set_enabled(&self, enabled: bool) -> Result<Value, PortError>;
}

/// The actions of one owner.
#[async_trait]
pub trait SetupActions: Send + Sync {
    fn actions(&self) -> &'static [&'static str];
    async fn run(&self, call: &SetupCall<'_>) -> Result<Value, PortError>;
}

pub struct SetupCall<'a> {
    pub action: &'a str,
    pub args: &'a Value,
    pub thread: &'a ThreadId,
}

/// `SETUP_BUILTIN_TOGGLE_FEATURES` and `SETUP_INSTALLABLE_FEATURES`.
const TOGGLE_FEATURES: [&str; 10] = [
    "git", "office", "tidy", "localProvider", "autoEffort", "browser", "computer", "voice",
    "visualize", "media",
];
const INSTALLABLE_FEATURES: [&str; 9] = [
    "git", "memory", "office", "tidy", "localProvider", "autoEffort", "browser", "computer", "voice",
];
const DESKTOP_HOSTED: [&str; 2] = ["browser", "computer"];
/// A request no window takes keeps the runtime-only install.
const DESKTOP_PREPARED: [&str; 2] = ["git", "office"];

const READ_ONLY: [&str; 11] = [
    "status", "open", "list_models", "get_mcp_server", "connect_connector", "read_definition",
    "search_local_models", "inspect_hf_model", "local_model_details", "read_agent_settings",
    "read_project_connectors",
];
/// Actions that start or steer work rather than saving a setting.
const BACKGROUND: [&str; 8] = [
    "start_local_installation", "maintain_local_model", "cancel_local_installation", "reconnect_mcp",
    "run_automation", "reset_route_fallback", "continue_in_model", "schedule_quota_resume",
];
/// `AGENT_DEFINITION_ACTIONS`.
const AGENT_DEFINITION: [&str; 4] = ["create_definition", "save_definition", "delete_definition", "restore_definition"];
/// `MIXY_AGENT_ID`: the representative agent's id.
const MIXY_AGENT_ID: &str = "lead";
/// `OWN_AGENT_ACTIONS`: actions on one agent's own settings.
const OWN_AGENT: [&str; 4] = ["set_agent_route", "set_agent_permission", "set_agent_connector", "set_agent_connector_tool"];
/// What an unattended run may still change.
const UNATTENDED_OWN: [&str; 5] = [
    "save_automation", "set_automation_enabled", "delete_automation", "run_automation",
    "set_agent_route",
];

const NATIVE: [&str; 11] = [
    "set_memory_enabled", "set_recap_enabled", "set_web_search_enabled", "set_instruction_files",
    "set_auto_effort_base", "set_builtin_enabled", "install_builtin", "set_worktree_settings",
    "set_bot_order", "set_cache_warming_enabled", "set_output_style",
];

/// `ACTION_APPLIES_TO`: when a saved change reaches what already runs.
fn applies_to(action: &str) -> &'static str {
    const NEXT_TURN: &str = "every conversation, this one included, from its next turn";
    match action {
        "set_route" => "new sessions (an established conversation keeps its model); a changed fallback chain reaches running sessions on that route from their next fallback hop ([] stops further hops at once; the turn ends with the provider error): Lead conversations and agents that inherit Main",
        "set_agent_route" => "the bot's chats from their next turn (a running turn finishes on the old model); a changed fallback chain reaches running sessions on that route from their next fallback hop ([] stops further hops at once; the turn ends with the provider error): its chats and sub-agents; an agent switched on or off reaches open conversations from their next turn as an agent list reminder",
        "reset_route_fallback" => "each listed session from its next turn (a running turn finishes on its fallback model): it returns to its primary and its chain starts over",
        "continue_in_model" => "that session now; its stopped turn is not resent",
        "schedule_quota_resume" => "that session's stopped turn, resent at the provider's reset time",
        "cancel_quota_resume" => "that session: its pending resume is dropped; the turn stays stopped",
        "set_cache_warming_enabled" => "the next prompt-cache warm of every session; no restart required",
        "set_agent_permission" => "that agent's next action of the kind, in every session",
        "set_agent_connector" => "that agent's next connector tool call, in every session",
        "set_agent_connector_tool" => "that agent's next call of the tool, in every session",
        "set_project_connector" => "the next connector tool call of sessions in that Project",
        "restore_definition" => "now: the bot, its chat and its routines (as they were) return",
        "set_bot_order" => "the Bots page and the Sessions bot section on every device",
        "set_orchestration_mode" => "new sessions and an empty current one (the default mode); a conversation keeps its own mode until it is switched with the composer's mode selector",
        "set_recap_enabled" => "background Memory cycles; no restart required",
        "set_auto_update" => "subsequent automatic update checks",
        "set_ai_session_titles" => "titles generated from now on; existing titles are unchanged",
        "set_quota_auto_resume" => "subsequent usage-limit stops; turning it off cancels pending resumes",
        "set_model_preferences" => "the /model picker and model management lists",
        "set_heartbeat_enabled" => "Mixy's next heartbeat check; no restart required",
        "set_heartbeat_interval" => "Mixy's heartbeat from the next tick: the next check is due the new interval after the last one; no restart required",
        "set_reactions_enabled" => "bots' chats, this conversation included, from their next turn; while off a reaction is refused at once; reactions already left stay visible",
        "set_profile" | "set_instruction_files" | "set_memory_enabled" | "set_web_search_enabled"
        | "set_builtin_enabled" | "install_builtin" | "set_output_style" => NEXT_TURN,
        "set_worktree_settings" => "new tasks and worktrees created afterwards; existing worktrees are unchanged",
        "set_network_proxy" => "the next request of every provider path; pooled connections opened under the old route are closed, and a request already in flight finishes on its connection",
        "set_system_shell" => "subsequent shell calls",
        "save_automation" => "the automation worker; scheduled runs follow the saved timing",
        "delete_automation" | "set_automation_enabled" => "future automation runs",
        "run_automation" => "one run now; its result posts into the owning agent's thread",
        "set_webhook_config" => "the webhook worker after configuration reload",
        "add_hook_rule" | "set_hook_rule_enabled" | "delete_hook_rule" => "subsequent tool calls; no restart required",
        "set_media_default" => "media generations that name no lane/model; lane \"\" returns the kind to Auto",
        _ => "new sessions unless appliedToCurrentSession is true",
    }
}

/// The voice receipt's own `appliesTo` (`setVoice`).
const VOICE_APPLIES_TO: &str = "channel voice transcription and Desktop dictation now";

fn invalid(field: &str, reason: impl Into<String>) -> PortError {
    PortError::Invalid { field: field.into(), reason: reason.into() }
}

fn require_enum<'a>(args: &'a Value, field: &str, allowed: &[&str]) -> Result<&'a str, PortError> {
    let value = args.get(field).and_then(Value::as_str).map(mixdog_js::js_trim).unwrap_or_default();
    if allowed.contains(&value) {
        Ok(value)
    } else {
        Err(invalid(field, format!("{field} must be one of {}", allowed.join(", "))))
    }
}

fn require_boolean(args: &Value, field: &str) -> Result<bool, PortError> {
    args.get(field)
        .and_then(Value::as_bool)
        .ok_or_else(|| invalid(field, format!("{field} (boolean) is required")))
}

fn from_modules(error: ToolModulesError) -> PortError {
    match error {
        ToolModulesError::InvalidArgument(message) => invalid("args", message),
        ToolModulesError::Failed(message) => {
            PortError::Failed { capability: "setup".into(), message }
        }
        ToolModulesError::Config(error) => {
            PortError::Failed { capability: "config".into(), message: error.to_string() }
        }
    }
}

pub struct SetupService {
    tool_modules: Arc<ToolModules>,
    config: Config,
    callers: Arc<dyn SetupCallers>,
    desktop: Arc<dyn SetupDesktop>,
    voice: Arc<dyn SetupVoice>,
    owners: HashMap<&'static str, Arc<dyn SetupActions>>,
    settings: Option<Settings>,
    output_styles: Option<OutputStyles>,
}

impl SetupService {
    /// Serves `set_output_style`.
    pub fn with_output_styles(mut self, styles: OutputStyles) -> Self {
        self.output_styles = Some(styles);
        self
    }

    /// Serves the config-backed roster actions (`set_bot_order`, `set_cache_warming_enabled`).
    pub fn with_settings(mut self, settings: Settings) -> Self {
        self.settings = Some(settings);
        self
    }

    pub fn new(
        config: Config,
        tool_modules: Arc<ToolModules>,
        callers: Arc<dyn SetupCallers>,
        desktop: Arc<dyn SetupDesktop>,
        voice: Arc<dyn SetupVoice>,
    ) -> Self {
        Self { tool_modules, config, callers, desktop, voice, owners: HashMap::new(), settings: None, output_styles: None }
    }

    /// Registers the actions an owner serves; a name this service serves itself is refused.
    pub fn with_actions(mut self, owner: Arc<dyn SetupActions>) -> Self {
        for action in owner.actions() {
            assert!(!NATIVE.contains(action), "setup {action} is served by the config actor");
            self.owners.insert(action, owner.clone());
        }
        self
    }

    /// `assertHeartbeatSetupAction` and `assertInteractiveCaller`.
    async fn authorize(&self, thread: &ThreadId, action: &str, args: &Value) -> Result<(), PortError> {
        if !READ_ONLY.contains(&action) {
            // `getCallerSession(sessionId)` (executor.mjs `execute`): Node does not throw for a
            // session that cannot be opened, it gets no record, and `scheduleCallerScope(null)`
            // is a headless run, so every mutating action is refused as one.
            let (scope, acting) = match self.callers.acting_agent(thread).await {
                Ok(acting) => (self.callers.scope(thread).await, acting),
                Err(_) => (CallerScope::Headless, String::new()),
            };
            // `assertAgentEditorAccess`: agent definitions change only from Mixy, the human's
            // own session or one acting as her.
            if AGENT_DEFINITION.contains(&action)
                && args.get("definitionKind").and_then(Value::as_str) == Some("agent")
                && !matches!(scope, CallerScope::RoomMember | CallerScope::Headless)
                && !matches!(scope, CallerScope::Agent { unattended: true, .. })
            {
                let acting = mixdog_js::js_trim(&acting);
                if !(scope == CallerScope::Human && (acting.is_empty() || acting == MIXY_AGENT_ID)) {
                    let name = self.callers.mixy_name().await;
                    return Err(PortError::Denied(format!(
                        "Only {name} (the representative agent) can create, edit or delete agents (setup {action}); ask the user to do it with {name} or in the Agents settings"
                    )));
                }
            }
            match scope {
                CallerScope::Agent { unattended: true, .. } if !UNATTENDED_OWN.contains(&action) => {
                    return Err(PortError::Denied(format!("An unattended run cannot change settings (setup {action})")));
                }
                CallerScope::RoomMember => {
                    return Err(PortError::Denied(format!("A group-room member cannot change settings (setup {action})")));
                }
                CallerScope::Headless => {
                    return Err(PortError::Denied(format!("A background run cannot change settings (setup {action})")));
                }
                // `assertOwnAgentSettings`: another agent's thread changes only its own.
                CallerScope::Agent { agent_id, .. } if OWN_AGENT.contains(&action) => {
                    let named = args.get("agent").map(mixdog_js::value_to_string).unwrap_or_default();
                    if mixdog_js::js_trim(&named) != agent_id {
                        return Err(PortError::Denied(format!(
                            "This thread manages only its own agent's settings (setup {action})"
                        )));
                    }
                }
                _ => {}
            }
        }
        if self.callers.is_heartbeat(thread).await {
            let pauses = action == "set_automation_enabled" && args.get("enabled") == Some(&Value::Bool(false));
            if action != "run_automation" && !pauses {
                return Err(PortError::Denied(format!(
                    "A heartbeat turn only pauses a routine or runs one again (setup {action} is refused); propose other changes with session action suggest"
                )));
            }
        }
        Ok(())
    }

    async fn native(&self, call: &SetupCall<'_>) -> Result<Value, PortError> {
        let args = call.args;
        let modules = &self.tool_modules;
        match call.action {
            "set_memory_enabled" => modules
                .set_memory_tools_enabled(require_boolean(args, "enabled")?)
                .await
                .map_err(from_modules),
            "set_recap_enabled" => modules
                .set_recap_enabled(require_boolean(args, "enabled")?)
                .await
                .map_err(from_modules),
            "set_web_search_enabled" => modules
                .set_web_search_enabled(require_boolean(args, "enabled")?)
                .await
                .map_err(from_modules),
            "set_instruction_files" => modules
                .set_instruction_files(require_enum(args, "instructionFiles", &INSTRUCTION_FILES_MODES)?)
                .await
                .map_err(from_modules),
            "set_auto_effort_base" => modules
                .set_auto_effort_base(require_enum(args, "autoEffortBase", &AUTO_EFFORT_BASES)?)
                .await
                .map_err(from_modules),
            "set_builtin_enabled" => {
                let name = require_enum(args, "name", &TOGGLE_FEATURES)?;
                if DESKTOP_HOSTED.contains(&name) {
                    return self.hosted(call).await;
                }
                if name == "voice" {
                    return self.set_voice(require_boolean(args, "enabled")?).await;
                }
                modules
                    .set_builtin_tool_enabled(name, require_boolean(args, "enabled")?)
                    .await
                    .map_err(from_modules)
            }
            "install_builtin" => {
                let name = require_enum(args, "name", &INSTALLABLE_FEATURES)?;
                if DESKTOP_HOSTED.contains(&name) {
                    return self.hosted(call).await;
                }
                if name == "voice" {
                    return self.set_voice(true).await;
                }
                if DESKTOP_PREPARED.contains(&name)
                    && let DesktopAnswer::Done(done) = self.desktop.request(call.thread, args).await?
                {
                    return Ok(done);
                }
                modules.install_builtin_feature(name, None).await.map_err(from_modules)
            }
            "set_worktree_settings" => {
                let patch = args.get("worktree").cloned().unwrap_or(Value::Null);
                crate::config::set_worktree_settings(&self.config, &patch)
                    .await
                    .map_err(|error| match error {
                        mixdog_core_api::CoreError::InvalidParams { path, expected } => {
                            invalid(&path, expected.to_string())
                        }
                        other => PortError::Failed { capability: "config".into(), message: format!("{other:?}") },
                    })
            }
            "set_bot_order" => {
                let settings = self.settings()?;
                let order = settings.set_bot_order(args.get("botOrder").unwrap_or(&Value::Null)).await;
                Ok(serde_json::json!({ "botOrder": order.map_err(from_modules)?["order"] }))
            }
            "set_cache_warming_enabled" => {
                let settings = self.settings()?;
                let view = settings
                    .set_cache_warming_enabled(args.get("enabled").unwrap_or(&Value::Null))
                    .await
                    .map_err(from_modules)?;
                Ok(serde_json::json!({ "promptCacheWarming": view["enabled"] }))
            }
            "set_output_style" => {
                let styles = self.output_styles.as_ref().ok_or_else(|| PortError::Unavailable {
                    capability: "config.outputStyle".into(),
                    message: "the output styles are not wired".into(),
                })?;
                let style = args.get("style").map(mixdog_js::value_to_string).map(|s| mixdog_js::js_trim(&s).to_owned()).unwrap_or_default();
                if style.is_empty() {
                    return Err(invalid("style", "style is required"));
                }
                let status = styles.set(&style).await.map_err(from_modules)?;
                Ok(serde_json::json!({
                    "configured": status["configured"],
                    "appliedToCurrentSession": self.callers.settings_reach_session(call.thread).await,
                }))
            }
            other => Err(PortError::Unavailable {
                capability: format!("setup.{other}"),
                message: format!("setup {other} is not served by the config actor"),
            }),
        }
    }

    fn settings(&self) -> Result<&Settings, PortError> {
        self.settings.as_ref().ok_or_else(|| PortError::Unavailable {
            capability: "config.settings".into(),
            message: "the scalar settings are not wired".into(),
        })
    }

    /// Browser and computer run in the desktop window; nobody claiming is an error.
    async fn hosted(&self, call: &SetupCall<'_>) -> Result<Value, PortError> {
        match self.desktop.request(call.thread, call.args).await? {
            DesktopAnswer::Done(done) => Ok(done),
            DesktopAnswer::Unclaimed(message) => Err(PortError::Unavailable { capability: "desktop".into(), message }),
        }
    }

    /// `setVoice`: the toggle must end in the state asked for.
    async fn set_voice(&self, enabled: bool) -> Result<Value, PortError> {
        let answer = self.voice.set_enabled(enabled).await?;
        let status = answer.get("status").cloned().unwrap_or(Value::Null);
        let is = |field: &str| status.get(field) == Some(&Value::Bool(true));
        if is("enabled") != enabled || (enabled && !is("installed")) {
            let reason = answer
                .get("error")
                .and_then(Value::as_str)
                .filter(|error| !error.is_empty())
                .map(|error| format!(": {error}"))
                .unwrap_or_default();
            let state = if enabled { "installed and enabled" } else { "disabled" };
            return Err(PortError::Failed {
                capability: "setup".into(),
                message: format!("Voice did not reach the requested {state} state{reason}"),
            });
        }
        let mut voice = Map::new();
        voice.insert("enabled".into(), Value::Bool(is("enabled")));
        voice.insert("installed".into(), Value::Bool(is("installed")));
        if let Some(components) = status.get("components") {
            voice.insert("components".into(), components.clone());
        }
        Ok(serde_json::json!({ "voice": voice, "appliesTo": VOICE_APPLIES_TO }))
    }

}

fn receipt(action: &str, result: Value) -> String {
    let mut out = Map::new();
    if !BACKGROUND.contains(&action) {
        out.insert("saved".into(), Value::Bool(true));
    }
    out.insert("scope".into(), Value::String("installation".into()));
    out.insert("appliesTo".into(), Value::String(applies_to(action).into()));
    match result {
        Value::Object(fields) => out.extend(fields),
        Value::Null => {}
        other => {
            out.insert("result".into(), other);
        }
    }
    serde_json::to_string_pretty(&Value::Object(out)).expect("receipts serialize")
}

#[async_trait]
impl ToolService for SetupService {
    async fn call(&self, call: ServiceCall<'_>) -> Result<Vec<ToolPart>, PortError> {
        let args: &Value = call.args;
        let action = args
            .get("action")
            .and_then(Value::as_str)
            .map(mixdog_js::js_trim)
            .filter(|action| !action.is_empty())
            .ok_or_else(|| invalid("action", "action must be one of the setup actions"))?;
        // `validateSetupInput`, before the caller gate: GitHub is the signed-in CLI, not a
        // catalog connector.
        if action == "connect_connector"
            && args.get("connector").map(mixdog_js::value_to_string).is_some_and(|name| mixdog_js::js_trim(&name).to_lowercase() == "github")
        {
            return Err(PortError::Failed {
                capability: "setup".into(),
                message: "GitHub uses the signed-in GitHub CLI; no connector needed. Use the github tool or Settings → Git.".into(),
            });
        }
        self.authorize(call.thread, action, args).await?;
        let setup = SetupCall { action, args, thread: call.thread };
        let result = if NATIVE.contains(&action) {
            self.native(&setup).await?
        } else if let Some(owner) = self.owners.get(action) {
            owner.run(&setup).await?
        } else {
            return Err(PortError::Unavailable {
                capability: format!("setup.{action}"),
                message: format!("setup {action} has no owner registered"),
            });
        };
        let text = if READ_ONLY.contains(&action) {
            serde_json::to_string(&result).expect("results serialize")
        } else {
            receipt(action, result)
        };
        Ok(vec![ToolPart::Text(text)])
    }
}
