//! The quick (offline) main-model picker rows: `quickProviderModelRows` of
//! `session-runtime/quick-model-rows/provider-rows.mjs`. Before any catalog was loaded, a quick
//! read answers from the profile: every enabled provider's models it can name without the network
//! (a custom provider's configured models, a provider's cached roster) plus the routes the profile
//! already names (the live route, presets, workflow routes, agent routes), one row per
//! `provider:model`.
//!
//! Not ported: a custom provider's discovered models are not merged into its rows (the roster
//! rows of Node's `providerCachedModelsSync` carry no override semantics here), and a custom route
//! on an unconfigured model keeps its route row rather than a row built from the discovery
//! overrides.

use std::collections::HashSet;

use mixdog_ai::catalog::CatalogSnapshot;
use mixdog_ai::providers::custom::listing::{manual_rows, public_rows};
use mixdog_ai::service::admin_models::provider_model_cache_row;
use mixdog_ai::service::admin_route::Obj;
use mixdog_ai::service::routes::web_search_capable_for;
use serde_json::{Map, Value, json};

use super::model_list::ModelListService;

/// `CUSTOM_DECLARED_FIELDS` of `quick-model-rows/model-meta.mjs`.
const CUSTOM_DECLARED_FIELDS: [&str; 9] = [
    "supportsVision",
    "supportsReasoning",
    "reasoningOptions",
    "reasoningLevels",
    "reasoningContentField",
    "providerName",
    "hidden",
    "manual",
    "customReasoning",
];

/// The value when JS reads it as true.
fn truthy(value: Option<&Value>) -> Option<&Value> {
    value.filter(|v| match v {
        Value::Null | Value::Bool(false) => false,
        Value::String(s) => !s.is_empty(),
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        _ => true,
    })
}

/// `clean(value)`: the text, trimmed; none for an absent value.
fn clean(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(other) => mixdog_js::js_trim(&mixdog_js::value_to_string(other)).to_owned(),
    }
}

fn is_true(value: &Value, key: &str) -> bool {
    value.get(key) == Some(&Value::Bool(true))
}

/// `a || b || …` over the named fields, as text.
fn first_text(model: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| truthy(model.get(key)).map(|v| mixdog_js::value_to_string(v)))
}

struct Quick<'a> {
    list: &'a ModelListService,
    providers: &'a Map<String, Value>,
    rows: Vec<Value>,
    seen: HashSet<String>,
}

impl Quick<'_> {
    fn deleted_custom(&self, provider: &str) -> bool {
        provider.starts_with("custom-")
            && !self.providers.get(provider).is_some_and(|c| c.get("type").and_then(Value::as_str) == Some("custom") && c.get("enabled") != Some(&Value::Bool(false)))
    }

    /// `addModel(provider, modelLike)`.
    fn add_model(&mut self, provider: &str, model_like: &Value) {
        let model = if model_like.is_object() { model_like.clone() } else { json!({ "id": clean(Some(model_like)) }) };
        let id = first_text(&model, &["id", "name"]).map(|t| mixdog_js::js_trim(&t).to_owned()).unwrap_or_default();
        if provider.is_empty() || id.is_empty() || !self.seen.insert(format!("{provider}:{id}")) {
            return;
        }
        let meta = self.list.catalog.model_meta(provider, &id);
        let either = |key: &str| truthy(model.get(key)).or_else(|| truthy(meta.get(key))).cloned().unwrap_or(Value::Null);
        let flag = |key: &str| Value::Bool(is_true(&model, key) || is_true(&meta, key));
        let mut row: Map<String, Value> = model.as_object().cloned().unwrap_or_default();
        row.insert("id".into(), json!(id));
        row.insert("name".into(), json!(first_text(&model, &["name", "display"]).unwrap_or_else(|| id.clone())));
        row.insert("display".into(), json!(first_text(&model, &["display", "name"]).unwrap_or_else(|| id.clone())));
        row.insert("contextWindow".into(), either("contextWindow"));
        row.insert("outputTokens".into(), either("outputTokens"));
        // An explicit value (an override's false included) wins; the catalog fills the rest.
        match model.get("supportsVision").filter(|v| !v.is_null()).or_else(|| meta.get("supportsVision")) {
            Some(vision) => {
                row.insert("supportsVision".into(), vision.clone());
            }
            None => {
                row.shift_remove("supportsVision");
            }
        }
        for key in ["supportsReasoning", "supportsFunctionCalling", "supportsPromptCaching"] {
            row.insert(key.into(), flag(key));
        }
        let options = match model.get("reasoningOptions") {
            Some(Value::Array(own)) if !own.is_empty() => Value::Array(own.clone()),
            _ => truthy(meta.get("reasoningOptions")).cloned().unwrap_or_else(|| json!([])),
        };
        row.insert("reasoningOptions".into(), options);
        row.insert("reasoningContentField".into(), either("reasoningContentField"));
        row.insert("mode".into(), truthy(model.get("mode")).or_else(|| truthy(meta.get("mode"))).cloned().unwrap_or_else(|| json!("chat")));
        if provider.starts_with("custom-") {
            for key in CUSTOM_DECLARED_FIELDS {
                if let Some(value) = model.get(key).filter(|v| !v.is_null()) {
                    row.insert(key.into(), value.clone());
                }
            }
            if model.get("reasoningLevels").is_some_and(|v| !v.is_null()) && model.get("reasoningOptions").is_none_or(Value::is_null) {
                row.insert("reasoningOptions".into(), json!([]));
            }
        }
        let row = Value::Object(row);
        let web_search = web_search_capable_for(provider, &id, Some(&row), Some(&meta));
        let cached = provider_model_cache_row(provider, &row, web_search);
        // A hidden model leaves the picker.
        if cached.get("hidden") != Some(&Value::Bool(true)) {
            self.rows.push(Value::Object(cached));
        }
    }

    /// `addRoute(routeLike)`.
    fn add_route(&mut self, route: &Value) {
        let (provider, model) = (clean(route.get("provider")), clean(route.get("model")));
        if provider.is_empty() || model.is_empty() || self.deleted_custom(&provider) {
            return;
        }
        let meta = self.list.catalog.model_meta(&provider, &model);
        let display = first_text(route, &["modelDisplay", "display"]).unwrap_or_else(|| model.clone());
        let route_row = json!({
            "id": model,
            "name": display,
            "display": display,
            "contextWindow": truthy(meta.get("contextWindow")).cloned().unwrap_or(Value::Null),
            "outputTokens": truthy(meta.get("outputTokens")).cloned().unwrap_or(Value::Null),
            "latest": is_true(route, "latest"),
            "supportsVision": meta.get("supportsVision").cloned().unwrap_or(Value::Null),
            "supportsReasoning": truthy(route.get("effort")).is_some() || is_true(&meta, "supportsReasoning"),
            "supportsFunctionCalling": is_true(&meta, "supportsFunctionCalling"),
            "supportsPromptCaching": is_true(&meta, "supportsPromptCaching"),
            "reasoningOptions": truthy(meta.get("reasoningOptions")).cloned().unwrap_or_else(|| json!([])),
            "reasoningContentField": truthy(meta.get("reasoningContentField")).cloned().unwrap_or(Value::Null),
            "mode": "chat",
        });
        let custom = self.providers.get(&provider).filter(|c| c.get("type").and_then(Value::as_str) == Some("custom")).cloned();
        let Some(config) = custom else {
            self.add_model(&provider, &route_row);
            return;
        };
        let configured = public_rows(&manual_rows(&config)).into_iter().find(|row| row.get("id").and_then(Value::as_str) == Some(model.as_str()));
        let new_models_hidden = config.get("discovery").and_then(|d| d.get("newModelsHidden")) == Some(&Value::Bool(true));
        match configured {
            Some(row) => self.add_model(&provider, &with_provider_name(row, &config)),
            None if !new_models_hidden => self.add_model(&provider, &with_provider_name(route_row, &config)),
            None => {}
        }
    }
}

/// `{ ...row, providerName }` when the config names the provider.
fn with_provider_name(mut row: Value, config: &Value) -> Value {
    let name = clean(config.get("name"));
    if !name.is_empty()
        && let Some(map) = row.as_object_mut()
    {
        map.insert("providerName".into(), Value::String(name));
    }
    row
}

impl ModelListService {
    /// The quick rows over the providers of the loaded config, the live `route` and the
    /// profile's presets, workflow routes and agent routes; availability applied and sorted.
    pub(super) fn quick_rows(&self, snapshot: &CatalogSnapshot, providers: &Map<String, Value>, agent: &Obj, route: &Obj) -> Vec<Value> {
        let mut quick = Quick { list: self, providers, rows: Vec::new(), seen: HashSet::new() };
        for (name, config) in providers {
            if config.get("enabled") != Some(&Value::Bool(true)) {
                continue;
            }
            // A custom provider's configured models are listed at once, before any catalog refresh.
            let models: Vec<Value> = if config.get("type").and_then(Value::as_str) == Some("custom") {
                public_rows(&manual_rows(config)).into_iter().map(|row| with_provider_name(row, config)).collect()
            } else {
                self.catalog.cached_models(name)
            };
            for model in &models {
                quick.add_model(name, model);
            }
        }
        quick.add_route(&Value::Object(route.clone()));
        for preset in mixdog_core_config::workflow::effective_presets(agent) {
            quick.add_route(&preset);
        }
        let routes = |key: &str| agent.get(key).and_then(Value::as_object).map(|m| m.iter().filter(|(k, _)| key != "workflowRoutes" || k.as_str() != "search").map(|(_, v)| v.clone()).collect::<Vec<_>>()).unwrap_or_default();
        for route in routes("workflowRoutes").iter().chain(routes("agents").iter()) {
            quick.add_route(route);
        }
        let rows = quick.rows;
        self.from_cache_rows(snapshot, &rows)
    }
}
