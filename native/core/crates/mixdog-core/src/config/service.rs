//! The `config/` domain service: the raw reads and typed writes of the `Config` actor
//! (`config/read`, `config/value/write`, `config/batchWrite`), the tool-module settings
//! (`getToolModuleSettings` and its setters, [`ToolModules`]) and the worktree settings.
//!
//! `config/read` answers only the published subtrees, so provider credentials never leave the
//! core through it. The other `config/*` session actions of today's settings API are ported by
//! the packages that own what they change; until then they answer `capabilityUnavailable`.

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
use super::ConfigEdit;
use super::ConfigError;
use super::PUBLISHED_SUBTREES;
use crate::tool_modules::ToolModules;
use crate::tool_modules::ToolModulesError;

pub struct ConfigService {
    config: Config,
    tool_modules: Arc<ToolModules>,
}

impl ConfigService {
    pub fn new(config: Config, tool_modules: Arc<ToolModules>) -> Self {
        Self { config, tool_modules }
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
            other => Err(CoreError::CapabilityUnavailable {
                capability: other.into(),
                detail: "not served by the config actor yet".into(),
            }),
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
pub(crate) async fn set_worktree_settings(config: &Config, patch: &Value) -> Result<Value, CoreError> {
    let current = config.get("worktree").unwrap_or(Value::Null);
    let next = apply_patch(&current, patch)
        .map_err(|error| invalid("params.patch", &error.to_string()))?;
    let stored = serde_json::to_value(&next).expect("settings serialize");
    config
        .update(move |doc| {
            doc.insert("worktree".into(), stored);
            Ok(())
        })
        .await
        .map_err(core_error)?;
    Ok(worktree_view(config))
}

fn worktree_view(config: &Config) -> Value {
    let settings = normalize(&config.get("worktree").unwrap_or(Value::Null));
    serde_json::to_value(settings).expect("settings serialize")
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
        Some(_) => return Err(invalid("params.mode", "replace | initializeIfMissing")),
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

fn core_error(error: ConfigError) -> CoreError {
    match error {
        ConfigError::InvalidParams { path, expected } => {
            CoreError::InvalidParams { path: path.into(), expected: expected.into() }
        }
        other => CoreError::DomainError {
            domain: "config".into(),
            code: match other {
                ConfigError::Overloaded(_) => "overloaded",
                ConfigError::Parse(_) => "configInvalid",
                _ => "configFailed",
            }
            .into(),
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
            code: "settingFailed".into(),
            detail: None,
        },
        ToolModulesError::Config(error) => core_error(error),
    })
}

#[async_trait]
impl DomainService for ConfigService {
    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        Ok(Reply::Value(self.dispatch(req.method.as_str(), &req.params).await?))
    }

    fn notify(&self, _method: Method, _params: Value, _from: ConnectionId) -> Admit {
        Admit::Accepted
    }
}
