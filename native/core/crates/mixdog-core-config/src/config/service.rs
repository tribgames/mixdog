//! The `config/` domain service: the raw reads and typed writes of the `Config` actor
//! (`config/read`, `config/value/write`, `config/batchWrite`), the tool-module settings
//! (`getToolModuleSettings` and its setters, [`ToolModules`]), the worktree settings and the
//! scalar settings of the agent config.
//!
//! `config/read` answers only the published subtrees, so provider credentials never leave the
//! core through it. The service claims exactly [`METHODS`]; the other `config/*` methods
//! belong to the service that owns their data.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use mixdog_protocol::ConfigWriteMode;
use mixdog_scm::worktree::settings::apply_patch;
use mixdog_scm::worktree::settings::normalize;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::Config;
use super::OutputStyles;
use super::ConfigEdit;
use super::ConfigError;
use super::PUBLISHED_SUBTREES;
use super::Settings;
use mixdog_core_base::support::wrong_method;
use crate::tool_modules::ToolModules;
use crate::tool_modules::ToolModulesError;

/// What [`ConfigService`] serves: `dispatch` handles the first twelve, `settings_call` the rest.
/// The compaction and network-proxy methods are their services' own.
const METHODS: &[&str] = &[
    "config/read",
    "config/value/write",
    "config/batchWrite",
    "config/getToolModuleSettings",
    "config/setWebSearchEnabled",
    "config/setAutoEffortBase",
    "config/setRecapEnabled",
    "config/setMemoryToolsEnabled",
    "config/setBuiltinToolEnabled",
    "config/installBuiltinFeature",
    "config/getWorktreeSettings",
    "config/setWorktreeSettings",
    "config/getHeartbeatSettings",
    "config/getReactionSettings",
    "config/getSessionTitleSettings",
    "config/getCacheWarmingSettings",
    "config/getRecapSettings",
    "config/getSystemShell",
    "config/getDeveloperSettings",
    "config/getTheme",
    "config/setTheme",
    "config/getProfile",
    "config/setProfile",
    "config/setHeartbeatEnabled",
    "config/setHeartbeatInterval",
    "config/setReactionsEnabled",
    "config/setAiSessionTitles",
    "config/setCacheWarmingEnabled",
    "config/setSystemShell",
    "config/setDeveloperOption",
    "config/saveStarterGuideState",
    "config/getBotOrder",
    "config/setBotOrder",
    "config/getOutputStyle",
    "config/listOutputStyles",
];

pub struct ConfigService {
    config: Config,
    tool_modules: Arc<ToolModules>,
    /// The scalar settings of the agent config (heartbeat, reactions, AI session titles, cache
    /// warming, system shell, developer options, recap, starter guide).
    settings: Settings,
    output_styles: OutputStyles,
}

impl ConfigService {
    pub fn new(config: Config, tool_modules: Arc<ToolModules>, settings: Settings, output_styles: OutputStyles) -> Self {
        Self { config, tool_modules, settings, output_styles }
    }

    async fn dispatch(&self, method: &str, params: &Value) -> Result<Value, CoreError> {
        match method {
            "config/read" => self.read(params),
            "config/value/write" => {
                let edit = edit_of(params)?;
                self.write(vec![edit]).await
            }
            "config/batchWrite" => {
                let edits = params
                    .get("edits")
                    .and_then(Value::as_array)
                    .ok_or_else(|| invalid("params.edits", "array of edits"))?
                    .iter()
                    .map(edit_of)
                    .collect::<Result<Vec<_>, _>>()?;
                self.write(edits).await
            }
            "config/getToolModuleSettings" => Ok(self.tool_modules.settings().await),
            "config/setWebSearchEnabled" => {
                let enabled = flag(params, "enabled")?;
                tool(self.tool_modules.set_web_search_enabled(enabled).await)
            }
            "config/setAutoEffortBase" => {
                let level = text(params, "level")?;
                tool(self.tool_modules.set_auto_effort_base(level).await)
            }
            "config/setRecapEnabled" => {
                let enabled = flag(params, "enabled")?;
                tool(self.tool_modules.set_recap_enabled(enabled).await)
            }
            "config/setMemoryToolsEnabled" => {
                let enabled = flag(params, "enabled")?;
                tool(self.tool_modules.set_memory_tools_enabled(enabled).await)
            }
            "config/setBuiltinToolEnabled" => {
                let name = text(params, "name")?;
                let enabled = flag(params, "enabled")?;
                tool(self.tool_modules.set_builtin_tool_enabled(name, enabled).await)
            }
            "config/installBuiltinFeature" => {
                let name = text(params, "name")?;
                let engines = params
                    .pointer("/options/engines")
                    .and_then(Value::as_array)
                    .map(|engines| {
                        engines.iter().filter_map(Value::as_str).map(str::to_owned).collect()
                    });
                tool(self.tool_modules.install_builtin_feature(name, engines).await)
            }
            "config/getWorktreeSettings" => Ok(worktree_view(&self.config)),
            "config/setWorktreeSettings" => {
                let patch = params.get("patch").cloned().unwrap_or(Value::Null);
                set_worktree_settings(&self.config, &patch).await
            }
            "config/getOutputStyle" | "config/listOutputStyles" => tool(self.output_styles.status().await),
            other => settings_call(&self.settings, other, params).await,
        }
    }

    /// The published subtrees, or the requested paths inside them.
    fn read(&self, params: &Value) -> Result<Value, CoreError> {
        let mut config = Map::new();
        match params.get("keys").filter(|keys| !keys.is_null()) {
            None => {
                for name in PUBLISHED_SUBTREES {
                    if let Some(value) = self.config.get(name) {
                        config.insert((*name).to_owned(), value);
                    }
                }
            }
            Some(keys) => {
                for key in keys.as_array().ok_or_else(|| invalid("params.keys", "array of paths"))? {
                    let path = key.as_str().ok_or_else(|| invalid("params.keys", "array of paths"))?;
                    let top = path.split('.').next().unwrap_or_default();
                    if !PUBLISHED_SUBTREES.contains(&top) {
                        return Err(invalid("params.keys", "a path inside a published subtree"));
                    }
                    if let Some(value) = self.config.get(path) {
                        config.insert(path.to_owned(), value);
                    }
                }
            }
        }
        Ok(json!({ "config": config }))
    }

    async fn write(&self, edits: Vec<ConfigEdit>) -> Result<Value, CoreError> {
        self.config.batch_write(&edits).await.map_err(core_error)?;
        let values: Vec<Value> = edits
            .iter()
            .map(|edit| self.config.get(&edit.path).unwrap_or(Value::Null))
            .collect();
        Ok(json!({ "revision": self.config.revision(), "values": values }))
    }
}

/// `setWorktreeSettings(patch)`: the patch is applied strictly to the stored section and the
/// whole effective section is stored; answers the effective settings.
pub async fn set_worktree_settings(config: &Config, patch: &Value) -> Result<Value, CoreError> {
    let current = config.agent().get("worktree").cloned().unwrap_or(Value::Null);
    let next = apply_patch(&current, patch)
        .map_err(|error| invalid("params.patch", &error.to_string()))?;
    let stored = serde_json::to_value(&next).expect("settings serialize");
    config
        .update_agent(move |doc| {
            doc.insert("worktree".into(), stored);
            Ok(())
        })
        .await
        .map_err(core_error)?;
    Ok(worktree_view(config))
}

fn worktree_view(config: &Config) -> Value {
    let settings = normalize(&config.agent().get("worktree").cloned().unwrap_or(Value::Null));
    serde_json::to_value(settings).expect("settings serialize")
}

/// The scalar settings: reads answer the view, writes the view after the change. Argument
/// names are the Node parameter names.
async fn settings_call(settings: &Settings, method: &str, params: &Value) -> Result<Value, CoreError> {
    let arg = |key: &str| params.get(key).cloned().unwrap_or(Value::Null);
    let result = match method {
        "config/getHeartbeatSettings" => return Ok(settings.heartbeat()),
        "config/getReactionSettings" => return Ok(settings.reactions()),
        "config/getSessionTitleSettings" => return Ok(settings.session_titles()),
        "config/getCacheWarmingSettings" => return Ok(settings.cache_warming()),
        "config/getRecapSettings" => return Ok(settings.recap()),
        "config/getSystemShell" => return Ok(settings.system_shell()),
        "config/getDeveloperSettings" => return Ok(settings.developer()),
        "config/getTheme" => return Ok(settings.theme()),
        "config/setTheme" => settings.set_theme(&arg("id"), &arg("options")).await,
        "config/getProfile" => return Ok(settings.profile()),
        "config/setProfile" => settings.set_profile(&arg("input")).await,
        "config/setHeartbeatEnabled" => settings.set_heartbeat_enabled(&arg("enabled")).await,
        "config/setHeartbeatInterval" => settings.set_heartbeat_interval(&arg("minutes")).await,
        "config/setReactionsEnabled" => settings.set_reactions_enabled(&arg("enabled")).await,
        "config/setAiSessionTitles" => settings.set_ai_session_titles(&arg("enabled")).await,
        "config/setCacheWarmingEnabled" => settings.set_cache_warming_enabled(&arg("enabled")).await,
        "config/setSystemShell" => settings.set_system_shell(&arg("command")).await,
        "config/setDeveloperOption" => settings.set_developer_option(&arg("id"), &arg("enabled")).await,
        "config/saveStarterGuideState" => settings.save_starter_guide_state(&arg("state")).await,
        "config/getBotOrder" => return Ok(settings.bot_order()),
        "config/setBotOrder" => settings.set_bot_order(&arg("order")).await,
        other => return Err(wrong_method("config", other)),
    };
    tool(result)
}

fn edit_of(params: &Value) -> Result<ConfigEdit, CoreError> {
    let path = params
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("params.path", "string"))?
        .to_owned();
    let value = params.get("value").cloned().ok_or_else(|| invalid("params.value", "any value"))?;
    let mode = match params.get("mode").and_then(Value::as_str) {
        None | Some("replace") => ConfigWriteMode::Replace,
        Some("initializeIfMissing") => ConfigWriteMode::InitializeIfMissing,
        Some("mergePatch") => ConfigWriteMode::MergePatch,
        Some("mergePatchBots") => ConfigWriteMode::MergePatchBots,
        Some("setConversation") => ConfigWriteMode::SetConversation,
        Some(_) => return Err(invalid("params.mode", "replace | initializeIfMissing | mergePatch | mergePatchBots | setConversation")),
    };
    Ok(ConfigEdit { path, value, mode })
}

fn flag(params: &Value, key: &str) -> Result<bool, CoreError> {
    params
        .get(key)
        .and_then(Value::as_bool)
        .ok_or_else(|| invalid(&format!("params.{key}"), "boolean"))
}

fn text<'a>(params: &'a Value, key: &str) -> Result<&'a str, CoreError> {
    params
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| invalid(&format!("params.{key}"), "string"))
}

fn invalid(path: &str, expected: &str) -> CoreError {
    CoreError::InvalidParams { path: path.into(), expected: expected.into() }
}

pub(super) fn core_error(error: ConfigError) -> CoreError {
    match error {
        ConfigError::Rejected(error) => error,
        ConfigError::InvalidParams { path, expected } => {
            CoreError::InvalidParams { path: path.into(), expected: expected.into() }
        }
        other => CoreError::DomainError {
            domain: "config".into(),
            code: Some(
                match other {
                    ConfigError::Overloaded(_) => "overloaded",
                    ConfigError::Parse(_) => "configInvalid",
                    _ => "configFailed",
                }
                .into(),
            ),
            message: None,
            detail: None,
        },
    }
}

/// The setters throw `TypeError` for a bad argument and `Error` for a failed step.
fn tool(result: Result<Value, ToolModulesError>) -> Result<Value, CoreError> {
    result.map_err(|error| match error {
        ToolModulesError::InvalidArgument(message) => {
            CoreError::InvalidParams { path: "params".into(), expected: message.into() }
        }
        ToolModulesError::Failed(_) => CoreError::DomainError {
            domain: "config".into(),
            code: Some("settingFailed".into()),
            message: None,
            detail: None,
        },
        ToolModulesError::Config(error) => core_error(error),
    })
}

#[async_trait]
impl DomainService for ConfigService {
    fn methods(&self) -> &'static [&'static str] {
        METHODS
    }

    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        Ok(Reply::Value(self.dispatch(req.method.as_str(), &req.params).await?))
    }

    fn notify(&self, _method: Method, _params: Value, _from: ConnectionId) -> Admit {
        Admit::Accepted
    }
}
