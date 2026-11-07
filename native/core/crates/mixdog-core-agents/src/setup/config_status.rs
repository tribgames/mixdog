//! The `setup` tool's config-backed `status` domains (`SETUP_STATUS_READERS` of
//! `setup-tool/executor.mjs`): each reads the getters the Settings UI also uses, through the
//! domain table, and shapes them as the executor does. Objects are built in Node's key order.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::ids::ThreadId;
use mixdog_tools::orch::util::PortError;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::domain_settings::DomainCalls;
use super::settings::truthy;
use super::status::StatusReader;

const DOMAINS: &[&str] = &[
    "autoclear", "compaction", "developer", "shell", "update", "worktree", "network-proxy", "output-style",
    "local-provider", "memory", "profile",
];

pub struct ConfigStatus {
    domains: Arc<dyn DomainCalls>,
}

fn refused(error: CoreError) -> PortError {
    match error {
        CoreError::DomainError { message: Some(message), .. } => PortError::Failed { capability: "setup".into(), message: message.to_string() },
        other => PortError::Failed { capability: "setup".into(), message: format!("{other:?}") },
    }
}

/// `{ ...value }` of a getter's answer; a missing or non-object answer spreads nothing.
fn fields(value: &Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

/// `entry.id || entry`.
fn id_or_entry(entry: &Value) -> Value {
    match entry.get("id") {
        Some(id) if truthy(Some(id)) => id.clone(),
        _ => entry.clone(),
    }
}

impl ConfigStatus {
    pub fn new(domains: Arc<dyn DomainCalls>) -> Self {
        Self { domains }
    }

    async fn get(&self, method: &'static str, params: Value) -> Result<Value, PortError> {
        self.domains.call(method, params).await.map_err(refused)
    }

    async fn plain(&self, method: &'static str) -> Result<Value, PortError> {
        Ok(Value::Object(fields(&self.get(method, json!({})).await?)))
    }

    fn profile(profile: &Value) -> Value {
        let text = |key: &str, default: &str| match profile.get(key) {
            Some(value) if truthy(Some(value)) => value.clone(),
            _ => Value::String(default.to_owned()),
        };
        let ids = |key: &str| {
            let rows = profile.get(key).and_then(Value::as_array).map(|rows| rows.iter().map(id_or_entry).collect()).unwrap_or_default();
            Value::Array(rows)
        };
        json!({
            "title": text("title", ""),
            "language": text("language", "system"),
            "experienceLevel": text("experienceLevel", ""),
            "languages": ids("languages"),
            "experienceLevels": ids("experienceLevels"),
        })
    }
}

#[async_trait]
impl StatusReader for ConfigStatus {
    fn domains(&self) -> &'static [&'static str] {
        DOMAINS
    }

    async fn read(&self, domain: &str, _detail: bool, thread: &ThreadId) -> Result<Value, PortError> {
        match domain {
            "autoclear" => Ok(Value::Object(fields(&self.get("config/getAutoClear", json!({ "threadId": thread.as_str() })).await?))),
            "shell" => self.plain("config/getSystemShell").await,
            "developer" => self.plain("config/getDeveloperSettings").await,
            "update" => self.plain("config/getUpdateSettings").await,
            "worktree" => self.plain("config/getWorktreeSettings").await,
            "network-proxy" => self.plain("config/getNetworkProxy").await,
            "output-style" => self.plain("config/getOutputStyle").await,
            "local-provider" => {
                let tools = self.get("config/getToolModuleSettings", json!({})).await?;
                Ok(Value::Object(tools.get("localProvider").map(fields).unwrap_or_default()))
            }
            "memory" => {
                let tools = self.get("config/getToolModuleSettings", json!({})).await?;
                let mut out = tools.get("memory").map(fields).unwrap_or_default();
                let recap = self.get("config/getRecapSettings", json!({})).await?;
                out.insert("recap".into(), if truthy(Some(&recap)) { recap } else { Value::Null });
                Ok(Value::Object(out))
            }
            "compaction" => {
                let mut out = fields(&self.get("config/getCompactionSettings", json!({})).await?);
                out.extend(fields(&self.get("config/getSessionTitleSettings", json!({})).await?));
                let warming = self.get("config/getCacheWarmingSettings", json!({})).await?;
                if let Some(enabled) = warming.get("enabled") {
                    out.insert("promptCacheWarming".into(), enabled.clone());
                }
                Ok(Value::Object(out))
            }
            "profile" => Ok(Self::profile(&self.get("config/getProfile", json!({})).await?)),
            other => Err(PortError::Unavailable { capability: format!("setup.status.{other}"), message: format!("{other} is not a config status domain") }),
        }
    }
}