//! The `setup` actions whose setting lives behind a domain method: the web-search route, model
//! preferences, compaction, auto-clear and the network proxy (`setup-tool/executor.mjs` handlers
//! over the runtime facade). The executor's own argument rules run here, in Node's order and
//! words; the change itself is the domain method the Settings UI also calls, so both paths share
//! one implementation.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_ports::ports::setup_actions::SetupActions;
use mixdog_core_ports::ports::setup_actions::SetupCall;
use mixdog_tools::orch::util::PortError;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::invalid;
use super::models;
use super::require_boolean;
use super::settings::clean;
use super::settings::truthy;

/// One method of the core's domain table as an internal call.
#[async_trait]
pub trait DomainCalls: Send + Sync {
    async fn call(&self, method: &'static str, params: Value) -> Result<Value, CoreError>;
}

pub struct DomainSettings {
    domains: Arc<dyn DomainCalls>,
}

const ACTIONS: &[&str] = &[
    "set_web_search_route",
    "set_model_preferences",
    "set_compaction",
    "set_autoclear",
    "set_network_proxy",
    "set_workflow",
    "set_orchestration_mode",
    "set_local_context",
    "list_models",
];

fn failed(message: impl Into<String>) -> PortError {
    PortError::Failed { capability: "setup".into(), message: message.into() }
}

/// What a domain method refused with: the sentence Node's runtime threw.
pub(super) fn refused(error: CoreError) -> PortError {
    match error {
        CoreError::DomainError { message: Some(message), .. } => failed(message.to_string()),
        other => failed(format!("{other:?}")),
    }
}

fn require_text(args: &Value, field: &str) -> Result<String, PortError> {
    let text = clean(args.get(field));
    if text.is_empty() { Err(invalid(field, format!("{field} is required"))) } else { Ok(text) }
}

fn has_own(value: &Value, key: &str) -> bool {
    value.as_object().is_some_and(|fields| fields.contains_key(key))
}

/// `{ ...value }`.
fn spread(value: &Value) -> Map<String, Value> {
    match value {
        Value::Object(fields) => fields.clone(),
        Value::Array(items) => items.iter().enumerate().map(|(i, item)| (i.to_string(), item.clone())).collect(),
        Value::String(text) => text.chars().enumerate().map(|(i, c)| (i.to_string(), Value::String(c.to_string()))).collect(),
        _ => Map::new(),
    }
}

/// `routeInput(source)`: the route fields a caller may set, cleaned; fallbacks recurse.
fn route_input(source: Option<&Value>) -> Result<Value, PortError> {
    let source = match source {
        None => return Err(failed("Cannot read properties of undefined (reading 'provider')")),
        Some(Value::Null) => return Err(failed("Cannot read properties of null (reading 'provider')")),
        Some(source) => source,
    };
    let field = |key: &str| source.as_object().and_then(|fields| fields.get(key));
    let mut next = Map::new();
    if !clean(field("provider")).is_empty() || has_own(source, "provider") {
        next.insert("provider".into(), Value::String(clean(field("provider"))));
    }
    for key in ["model", "effort"] {
        let text = clean(field(key));
        if !text.is_empty() {
            next.insert(key.into(), Value::String(text));
        }
    }
    for key in ["fast", "autoEffort"] {
        if let Some(flag @ Value::Bool(_)) = field(key) {
            next.insert(key.into(), flag.clone());
        }
    }
    if let Some(parameters) = field("modelParameters") {
        next.insert("modelParameters".into(), Value::Object(spread(parameters)));
    }
    for key in ["contextPercent", "contextTokens", "disabled"] {
        if let Some(value) = field(key) {
            next.insert(key.into(), value.clone());
        }
    }
    if let Some(fallbacks) = field("fallbacks") {
        let Value::Array(items) = fallbacks else {
            return Err(failed(match fallbacks {
                Value::Null => "Cannot read properties of null (reading 'map')".to_owned(),
                _ => "source.fallbacks.map is not a function".to_owned(),
            }));
        };
        let routes = items.iter().map(|item| route_input(Some(item))).collect::<Result<Vec<_>, _>>()?;
        next.insert("fallbacks".into(), Value::Array(routes));
    }
    Ok(Value::Object(next))
}

impl DomainSettings {
    pub fn new(domains: Arc<dyn DomainCalls>) -> Self {
        Self { domains }
    }

    async fn call(&self, method: &'static str, params: Value) -> Result<Value, PortError> {
        self.domains.call(method, params).await.map_err(refused)
    }

    fn model_preferences(args: &Value) -> Result<Value, PortError> {
        let mut change = Map::new();
        change.insert("model".into(), Value::String(require_text(args, "model")?));
        for key in ["hidden", "favorite"] {
            if has_own(args, key) {
                change.insert(key.into(), Value::Bool(require_boolean(args, key)?));
            }
        }
        if change.len() == 1 {
            return Err(failed("hidden or favorite is required"));
        }
        Ok(json!({ "providerId": require_text(args, "provider")?, "changes": [change] }))
    }

    fn compaction(args: &Value) -> Result<Value, PortError> {
        let stored = args.get("compaction").filter(|value| truthy(Some(value)));
        let compaction = stored.map(spread).unwrap_or_default();
        let enabled = args.get("enabled");
        if enabled.is_none() && compaction.is_empty() {
            return Err(failed("enabled or compaction is required"));
        }
        if compaction.contains_key("mainBufferTokens") && compaction.contains_key("mainBufferPercent") {
            return Err(failed("Choose mainBufferTokens or mainBufferPercent, not both"));
        }
        let mut input = compaction;
        if let Some(enabled) = enabled {
            input.insert("auto".into(), enabled.clone());
        }
        Ok(Value::Object(input))
    }

    fn autoclear(args: &Value) -> Result<Value, PortError> {
        let input = args.get("autoclear").filter(|value| value.is_object() || value.is_array());
        let Some(input) = input.filter(|input| !spread(input).is_empty()) else {
            return Err(failed("autoclear with enabled, duration, or provider is required"));
        };
        let field = |key: &str| input.as_object().and_then(|fields| fields.get(key));
        if truthy(field("resetProvider")) && clean(field("provider")).is_empty() {
            return Err(failed("resetProvider requires provider"));
        }
        if truthy(field("reset")) && truthy(field("provider")) {
            return Err(failed("Use resetProvider for a provider override"));
        }
        if truthy(field("duration")) && (truthy(field("reset")) || truthy(field("resetProvider"))) {
            return Err(failed("Cannot reset and set a duration together"));
        }
        Ok(input.clone())
    }
}

#[async_trait]
impl SetupActions for DomainSettings {
    fn actions(&self) -> &'static [&'static str] {
        ACTIONS
    }

    async fn run(&self, call: &SetupCall<'_>) -> Result<Value, PortError> {
        let args = call.args;
        let thread = call.thread.as_str();
        match call.action {
            "set_web_search_route" => {
                let next = route_input(args.get("route"))?;
                Ok(json!({ "route": self.call("config/setWebSearchRoute", json!({ "next": next })).await? }))
            }
            "set_model_preferences" => self.call("config/setModelPreferences", Self::model_preferences(args)?).await,
            "set_compaction" => {
                let input = Self::compaction(args)?;
                let mut saved = self.call("config/setCompactionSettings", json!({ "input": input, "threadId": thread })).await?;
                if let Some(fields) = saved.as_object_mut() {
                    fields.insert("appliedToCurrentSession".into(), Value::Bool(true));
                }
                Ok(saved)
            }
            "set_autoclear" => {
                let input = Self::autoclear(args)?;
                self.call("config/setAutoClear", json!({ "input": input, "threadId": thread })).await
            }
            "set_network_proxy" => {
                let patch = args.get("networkProxy").cloned().unwrap_or(Value::Null);
                self.call("config/setNetworkProxy", json!({ "patch": patch })).await
            }
            "set_workflow" => {
                let workflow = require_text(args, "workflow")?;
                self.call("thread/setWorkflow", json!({ "threadId": thread, "workflowId": workflow })).await
            }
            "set_orchestration_mode" => {
                // The tool schema holds the mode to the listed ids; anything else reaches the
                // runtime's own refusal.
                let mode = args.get("mode").and_then(Value::as_str).unwrap_or_default();
                self.call("thread/setOrchestrationMode", json!({ "threadId": thread, "mode": mode })).await
            }
            "set_local_context" => {
                let model = args.get("modelId").and_then(Value::as_str).unwrap_or_default();
                let tokens = args.get("localContextWindow").cloned().unwrap_or(Value::Null);
                self.call("localProvider/setLocalProviderContext", json!({ "modelId": model, "tokens": tokens })).await?;
                // The facade answers the whole tool-module settings, not the local provider's view.
                self.call("config/getToolModuleSettings", json!({})).await
            }
            "list_models" => {
                let query = models::Query::of(args);
                let rows = if query.web_search {
                    self.call("account/listWebSearchModels", json!({ "threadId": thread, "options": { "refresh": query.refresh } })).await?
                } else {
                    self.call("model/list", json!({ "refresh": query.refresh })).await?
                };
                let rows = rows.as_array().cloned().unwrap_or_default();
                models::answer(&query, &rows).map_err(failed)
            }
            other => Err(PortError::Unavailable { capability: format!("setup.{other}"), message: format!("setup {other} is not a domain setting") }),
        }
    }
}