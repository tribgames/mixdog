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

mod mcp;
mod requests;

pub use mcp::McpSetup;
pub use requests::SetupRequests;
pub use requests::SetupUiSurface;

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_protocol::ThreadId;
use mixdog_tools::orch::service::ServiceCall;
use mixdog_tools::orch::service::ToolService;
use mixdog_tools::orch::util::PortError;
use serde_json::Map;
use serde_json::Value;

use crate::config::Config;
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
}

/// `requestDesktop`: the window that hosts a feature takes the request.
#[async_trait]
pub trait SetupDesktop: Send + Sync {
    /// `Ok(None)`: no window claimed the request (`SETUP_DESKTOP_UNCLAIMED`).
    async fn request(&self, thread: &ThreadId, args: &Value) -> Result<Option<Value>, PortError>;
}

/// `setVoice`: the runtime toggle the Built-in card also uses (enabling installs any missing
/// whisper/ffmpeg component first). Answers the public voice status, or the failure.
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
/// What an unattended run may still change.
const UNATTENDED_OWN: [&str; 5] = [
    "save_automation", "set_automation_enabled", "delete_automation", "run_automation",
    "set_agent_route",
];

const NATIVE: [&str; 10] = [
    "set_memory_enabled", "set_recap_enabled", "set_web_search_enabled", "set_instruction_files",
    "set_auto_effort_base", "set_builtin_enabled", "install_builtin", "set_worktree_settings",
    "set_bot_order", "set_cache_warming_enabled",
];

fn applies_to(action: &str) -> &'static str {
    match action {
        "set_recap_enabled" => "background Memory cycles; no restart required",
        "set_instruction_files" | "set_memory_enabled" | "set_web_search_enabled"
        | "set_builtin_enabled" | "install_builtin" => {
            "every conversation, this one included, from its next turn"
        }
        "set_worktree_settings" => {
            "new tasks and worktrees created afterwards; existing worktrees are unchanged"
        }
        _ => "new sessions unless appliedToCurrentSession is true",
    }
}

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
}

impl SetupService {
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
        Self { tool_modules, config, callers, desktop, voice, owners: HashMap::new(), settings: None }
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
        if self.callers.is_heartbeat(thread).await {
            let pauses = action == "set_automation_enabled" && args.get("enabled") == Some(&Value::Bool(false));
            if action != "run_automation" && !pauses {
                return Err(PortError::Denied(format!(
                    "A heartbeat turn only pauses a routine or runs one again (setup {action} is refused); propose other changes with session action suggest"
                )));
            }
        }
        if READ_ONLY.contains(&action) {
            return Ok(());
        }
        match self.callers.scope(thread).await {
            CallerScope::Agent { unattended: true, .. } if !UNATTENDED_OWN.contains(&action) => Err(
                PortError::Denied(format!("An unattended run cannot change settings (setup {action})")),
            ),
            CallerScope::Human | CallerScope::Agent { .. } => Ok(()),
            CallerScope::RoomMember => Err(PortError::Denied(format!(
                "A group-room member cannot change settings (setup {action})"
            ))),
            CallerScope::Headless => Err(PortError::Denied(format!(
                "A background run cannot change settings (setup {action})"
            ))),
        }
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
                    return self.voice.set_enabled(require_boolean(args, "enabled")?).await;
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
                    return self.voice.set_enabled(true).await;
                }
                if DESKTOP_PREPARED.contains(&name)
                    && let Some(done) = self.desktop.request(call.thread, args).await?
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
        self.desktop.request(call.thread, call.args).await?.ok_or_else(|| PortError::Unavailable {
            capability: "desktop".into(),
            message: "No Desktop window took this setup request; open the app and try again.".into(),
        })
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
