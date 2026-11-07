//! The `features` domain of the setup tool's `status` (`featureStatus` of `setup-tool/executor.mjs`):
//! every built-in's switches, the three bridge-gated tools, Mixy's heartbeat, bot reactions and
//! the voice runtime. The same object is the `features` part of the `summary` domain.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_config::config::Settings;
use mixdog_tools::orch::util::PortError;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::domain_settings::DomainCalls;
use super::status::StatusReader;

/// `FEATURE_STATUS_KEYS` and `FEATURE_EXTRA_STATUS_KEYS`.
const KEYS: [&str; 2] = ["enabled", "installed"];
const AUTO_EFFORT_KEYS: [&str; 3] = ["supported", "ready", "installing"];

/// `builtinFeatureActive(config, id)` for the bridge-gated tools (`browser`, `computer`,
/// `terminal`): the desktop's bridge is up, or the `MIXDOG_FEATURE_*` override says so. The
/// environment and the bridge files are the host's.
pub trait FeatureActivity: Send + Sync {
    fn active(&self, id: &str) -> bool;
}

pub struct FeatureStatus {
    domains: Arc<dyn DomainCalls>,
    settings: Settings,
    activity: Arc<dyn FeatureActivity>,
}

fn refused(error: CoreError) -> PortError {
    PortError::Failed { capability: "setup".into(), message: format!("{error:?}") }
}

impl FeatureStatus {
    pub fn new(domains: Arc<dyn DomainCalls>, settings: Settings, activity: Arc<dyn FeatureActivity>) -> Self {
        Self { domains, settings, activity }
    }

    /// `featureStatus(rt, getConfig)`.
    pub async fn status(&self) -> Result<Value, PortError> {
        let tools = self.domains.call("config/getToolModuleSettings", json!({})).await.map_err(refused)?;
        let mut out = Map::new();
        for (name, settings) in tools.as_object().into_iter().flatten() {
            let Some(fields) = settings.as_object() else {
                // Scalar settings (the instruction-files mode) pass through as they are.
                out.insert(name.clone(), settings.clone());
                continue;
            };
            let extra: &[&str] = if name == "autoEffort" { &AUTO_EFFORT_KEYS } else { &[] };
            let kept: Map<String, Value> = fields.iter().filter(|(key, _)| KEYS.contains(&key.as_str()) || extra.contains(&key.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect();
            out.insert(name.clone(), Value::Object(kept));
        }
        for id in ["browser", "computer", "terminal"] {
            out.insert(id.into(), json!({ "active": self.activity.active(id) }));
        }
        let heartbeat = self.settings.heartbeat();
        out.insert("heartbeat".into(), json!({ "enabled": heartbeat["heartbeat"], "intervalMinutes": heartbeat["intervalMinutes"] }));
        out.insert("reactions".into(), json!({ "enabled": self.settings.reactions()["reactions"] }));
        let voice = self.domains.call("voice/getVoiceStatus", json!({})).await.map_err(refused)?;
        let flag = |key: &str| voice.get(key) == Some(&Value::Bool(true));
        let mut shown = Map::new();
        shown.insert("enabled".into(), Value::Bool(flag("enabled")));
        shown.insert("installed".into(), Value::Bool(flag("installed")));
        if let Some(components) = voice.get("components") {
            shown.insert("components".into(), components.clone());
        }
        shown.insert("installing".into(), Value::Bool(flag("busy")));
        out.insert("voice".into(), Value::Object(shown));
        Ok(Value::Object(out))
    }
}

#[async_trait]
impl StatusReader for FeatureStatus {
    fn domains(&self) -> &'static [&'static str] {
        &["features"]
    }

    async fn read(&self, _domain: &str, _detail: bool, _thread: &ThreadId) -> Result<Value, PortError> {
        self.status().await
    }
}