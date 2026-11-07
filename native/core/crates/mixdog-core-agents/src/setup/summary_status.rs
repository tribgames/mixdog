//! The `summary` domain of the setup tool's `status` (`SETUP_STATUS_READERS.summary`): the Lead
//! route, the active workflow, the output style, the profile, the built-in features and the
//! onboarding status in one object.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::ids::ThreadId;
use mixdog_tools::orch::util::PortError;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::domain_settings::DomainCalls;
use super::features_status::FeatureStatus;
use super::settings::truthy;
use super::status::StatusReader;
use super::workflow_status::WorkflowFacts;

/// The live Lead route as the runtime facade carries it (`rt.provider`, `rt.model`, `rt.effort`,
/// `rt.fast`, `rt.fastCapable`, `rt.modelParameters`, `rt.contextPercent`, `rt.contextTokens`,
/// and for the model status `rt.autoEffort`, `rt.effortOptions`): the session's fact.
#[async_trait]
pub trait LiveRoute: Send + Sync {
    /// An object holding those properties as the conversation `thread` has them (absent when unset).
    fn route(&self, thread: &ThreadId) -> Value;
    /// `listPresets().find(preset => preset.id === 'workflow-lead')?.fallbacks`: the Lead route's fallback chain (absent: none).
    fn lead_fallbacks(&self) -> Value;
    /// `routePositionsStatus({ caller, config, keep })` for the Lead conversations (lead) or for the bot chats and sub-agents: an
    /// object holding `session` (the caller's own place on its chain, when it acts as an agent) and `sessions`. Async because a
    /// position reads the bot route store on the IO lane; `Err` when that read never ran.
    async fn positions(&self, thread: &ThreadId, lead: bool) -> Result<Value, PortError>;
}

/// The model domain: the Lead route with its fallback chain, the effort choices and where the live Lead conversations are on their chains.
pub struct ModelStatus {
    route: Arc<dyn LiveRoute>,
}

impl ModelStatus {
    pub fn new(route: Arc<dyn LiveRoute>) -> Self {
        Self { route }
    }
}

#[async_trait]
impl StatusReader for ModelStatus {
    fn domains(&self) -> &'static [&'static str] {
        &["model"]
    }

    async fn read(&self, _domain: &str, _detail: bool, thread: &ThreadId) -> Result<Value, PortError> {
        let live = self.route.route(thread);
        let mut route = main_route(&live);
        route.insert("autoEffort".into(), Value::Bool(live.get("autoEffort") != Some(&Value::Bool(false))));
        let fallbacks = self.route.lead_fallbacks();
        route.insert("fallbacks".into(), if truthy(Some(&fallbacks)) { fallbacks } else { Value::Array(Vec::new()) });
        let mut out = Map::new();
        out.insert("route".into(), Value::Object(route));
        out.insert("effortOptions".into(), or(&live, "effortOptions", Value::Array(Vec::new())));
        if let Value::Object(positions) = self.route.positions(thread, true).await? {
            out.extend(positions);
        }
        Ok(Value::Object(out))
    }
}

pub struct SummaryStatus {
    domains: Arc<dyn DomainCalls>,
    facts: Arc<dyn WorkflowFacts>,
    features: Arc<FeatureStatus>,
    route: Arc<dyn LiveRoute>,
}

fn refused(error: CoreError) -> PortError {
    PortError::Failed { capability: "setup".into(), message: format!("{error:?}") }
}

/// `value || fallback`.
fn or(route: &Value, key: &str, fallback: Value) -> Value {
    match route.get(key) {
        Some(value) if truthy(Some(value)) => value.clone(),
        _ => fallback,
    }
}

/// `value ?? null`.
fn or_null(route: &Value, key: &str) -> Value {
    route.get(key).cloned().unwrap_or(Value::Null)
}

/// `mainRoute(rt)`.
pub(super) fn main_route(route: &Value) -> Map<String, Value> {
    let mut out = Map::new();
    out.insert("provider".into(), or(route, "provider", Value::String(String::new())));
    out.insert("model".into(), or(route, "model", Value::String(String::new())));
    out.insert("effort".into(), or(route, "effort", Value::Null));
    out.insert("fast".into(), Value::Bool(route.get("fast") == Some(&Value::Bool(true))));
    out.insert("fastCapable".into(), Value::Bool(route.get("fastCapable") == Some(&Value::Bool(true))));
    out.insert("modelParameters".into(), or(route, "modelParameters", json!({})));
    out.insert("contextPercent".into(), or_null(route, "contextPercent"));
    out.insert("contextTokens".into(), or_null(route, "contextTokens"));
    out
}

impl SummaryStatus {
    pub fn new(domains: Arc<dyn DomainCalls>, facts: Arc<dyn WorkflowFacts>, features: Arc<FeatureStatus>, route: Arc<dyn LiveRoute>) -> Self {
        Self { domains, facts, features, route }
    }
}

#[async_trait]
impl StatusReader for SummaryStatus {
    fn domains(&self) -> &'static [&'static str] {
        &["summary"]
    }

    async fn read(&self, _domain: &str, _detail: bool, thread: &ThreadId) -> Result<Value, PortError> {
        let route = Value::Object(main_route(&self.route.route(thread)));
        let workflows = self.facts.workflows().await?;
        let workflow = workflows
            .as_array()
            .and_then(|rows| rows.iter().find(|row| truthy(row.get("active"))))
            .cloned()
            .unwrap_or(Value::Null);
        let style = self.domains.call("config/getOutputStyle", json!({})).await.map_err(refused)?;
        let output_style = match style.get("configured") {
            Some(value) if truthy(Some(value)) => value.clone(),
            _ => Value::Null,
        };
        let profile = self.domains.call("config/getProfile", json!({})).await.map_err(refused)?;
        let mut shown = Map::new();
        for key in ["title", "language", "experienceLevel"] {
            if let Some(value) = profile.get(key) {
                shown.insert(key.into(), value.clone());
            }
        }
        let features = self.features.status().await?;
        let onboarding = self.facts.onboarding()?;
        let onboarding = if truthy(Some(&onboarding)) { onboarding } else { Value::Null };
        Ok(json!({
            "route": route,
            "workflow": workflow,
            "outputStyle": output_style,
            "profile": Value::Object(shown),
            "features": features,
            "onboarding": onboarding,
        }))
    }
}