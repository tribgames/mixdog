//! The quick (offline) main-model picker rows: `quickProviderModelRows` of
//! `session-runtime/quick-model-rows/provider-rows.mjs`, with `declaredCustomFields` and
//! `metadataFor` (`quick-model-rows/model-meta.mjs`) and the custom provider's rows of
//! `custom-provider-config.mjs` (`normalizeCustomProviderConfig`, `effectiveCustomModelRows`).
//!
//! Before any catalog was loaded, a quick read answers from the profile: every enabled provider's
//! models it can name without the network (a custom provider's configured models, a provider's
//! cached roster) plus the routes the profile already names (the live route, presets, workflow
//! routes, agent routes), one row per `provider:model`.

use std::collections::HashSet;

use mixdog_ai::catalog::CatalogSnapshot;
use mixdog_ai::providers::custom::reasoning::is_custom_provider_name;
use mixdog_ai::service::admin_models::provider_model_cache_row;
use mixdog_ai::service::admin_route::Obj;
use mixdog_ai::service::routes::web_search_capable_for;
use mixdog_js::json_number;
use serde_json::{Map, Value, json};

use super::model_list::ModelListService;
use crate::domains::ai_account::custom_config::{canonical_reasoning_level, normalize};

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

/// Reasoning levels ranked weakest to strongest (`byRank`).
const LEVELS: [&str; 7] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/// The value when JS reads it as true.
fn truthy(value: Option<&Value>) -> Option<&Value> {
    value.filter(|v| match v {
        Value::Null | Value::Bool(false) => false,
        Value::String(s) => !s.is_empty(),
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        _ => true,
    })
}

/// `clean(value)`: the text, trimmed; empty for an absent value.
fn clean(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(other) => mixdog_js::js_trim(&mixdog_js::value_to_string(other)).to_owned(),
    }
}

fn is_true(value: &Value, key: &str) -> bool {
    value.get(key) == Some(&Value::Bool(true))
}

/// `Number(value)`: NaN for what is not a number.
fn number(value: Option<&Value>) -> f64 {
    mixdog_js::to_number_of(value)
}

/// `x ?? y`: the value unless it is null or absent.
fn present(value: Option<&Value>) -> Option<&Value> {
    value.filter(|v| !v.is_null())
}

/// `a || b || …` over the named fields, as text.
fn first_text(model: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| truthy(model.get(key)).map(mixdog_js::value_to_string))
}

/// `catalogLevels(row)`: the effort levels the row's ladder names, ranked; none when it names none.
fn catalog_levels(row: &Map<String, Value>) -> Option<Vec<String>> {
    let mut levels: Vec<&'static str> = Vec::new();
    for option in row.get("reasoningOptions").and_then(Value::as_array).into_iter().flatten() {
        if option.get("type").and_then(Value::as_str) != Some("effort") {
            continue;
        }
        for value in option.get("values").and_then(Value::as_array).into_iter().flatten() {
            if let Some(level) = canonical_reasoning_level(value)
                && !levels.contains(&level)
            {
                levels.push(level);
            }
        }
    }
    levels.sort_by_key(|level| LEVELS.iter().position(|l| l == level).unwrap_or(usize::MAX));
    (!levels.is_empty()).then(|| levels.into_iter().map(str::to_owned).collect())
}

/// `effectiveRow(base, override, { providerId, discovered, newModelsHidden })`.
fn effective_row(base: &Map<String, Value>, over: Option<&Value>, provider_id: &str, discovered: bool, new_models_hidden: bool) -> Value {
    let none = json!({});
    let ov = over.unwrap_or(&none);
    let reasoning = ov.get("reasoning").filter(|r| r.is_object()).cloned().unwrap_or_else(|| json!({}));
    let mut row: Map<String, Value> = base.clone();
    for key in ["reasoningOptions", "reasoningLevels", "reasoningContentField", "customReasoning"] {
        row.shift_remove(key);
    }
    let levels: Option<Vec<String>> = match present(reasoning.get("levels")) {
        Some(Value::Array(list)) => Some(list.iter().map(mixdog_js::value_to_string).collect()),
        _ => catalog_levels(base),
    };
    let replay = match present(reasoning.get("replay")) {
        Some(value) => truthy(Some(value)).is_some(),
        None => base.get("reasoningContentField").and_then(Value::as_str) == Some("reasoning_content"),
    };
    let mut wire_values = Map::new();
    for (level, value) in reasoning.get("wireValues").and_then(Value::as_object).into_iter().flatten() {
        if levels.as_ref().is_none_or(|l| l.contains(level)) {
            wire_values.insert(level.clone(), value.clone());
        }
    }
    let id = clean(base.get("id"));
    let base_name = first_text(&Value::Object(base.clone()), &["name"]).unwrap_or_else(|| id.clone());
    let positive = |key: &str| {
        let n = number(base.get(key));
        (n > 0.0).then_some(n)
    };
    let hidden = if ov.as_object().is_some_and(|o| o.contains_key("hidden")) {
        ov["hidden"].clone()
    } else {
        Value::Bool(discovered && over.is_none() && new_models_hidden)
    };
    row.insert("id".into(), json!(id));
    row.insert("name".into(), present(ov.get("name")).cloned().unwrap_or_else(|| json!(base_name)));
    let provider = if provider_id.is_empty() { base.get("provider").cloned().unwrap_or(Value::Null) } else { json!(provider_id) };
    row.insert("provider".into(), provider);
    row.insert("contextWindow".into(), present(ov.get("contextWindow")).cloned().unwrap_or_else(|| json_number(positive("contextWindow").unwrap_or(0.0))));
    row.insert("outputTokens".into(), present(ov.get("maxOutputTokens")).cloned().unwrap_or_else(|| positive("outputTokens").map_or(Value::Null, json_number)));
    row.insert("hidden".into(), hidden);
    row.insert("manual".into(), json!(is_true(ov, "manual")));
    row.insert(
        "inherited".into(),
        json!({
            "name": base_name,
            "contextWindow": json_number(positive("contextWindow").unwrap_or(0.0)),
            "maxOutputTokens": positive("outputTokens").map_or(Value::Null, json_number),
        }),
    );
    if let Some(vision) = ov.get("supportsVision").filter(|v| v.is_boolean()) {
        row.insert("supportsVision".into(), vision.clone());
    }
    row.insert(
        "supportsReasoning".into(),
        json!(match &levels {
            Some(l) => l.iter().any(|level| level != "none"),
            None => is_true(&Value::Object(base.clone()), "supportsReasoning"),
        }),
    );
    if let Some(l) = &levels {
        row.insert("reasoningOptions".into(), if l.is_empty() { json!([]) } else { json!([{ "type": "effort", "values": l }]) });
        row.insert("reasoningLevels".into(), json!(l));
    }
    let wire_format = present(reasoning.get("wireFormat")).cloned().unwrap_or_else(|| json!("standard"));
    row.insert("customReasoning".into(), json!({ "wireFormat": wire_format, "wireValues": wire_values, "replay": replay }));
    if replay {
        row.insert("reasoningContentField".into(), json!("reasoning_content"));
    }
    Value::Object(row)
}

/// `effectiveCustomModelRows(config, discoveredRows, { providerId })` over a normalized config:
/// discovered rows (the first of each id) under their overrides, then the manual overrides
/// discovery did not list. Hidden rows are kept.
fn effective_custom_model_rows(config: &Value, discovered: &[Value], provider_id: &str) -> Vec<Value> {
    let empty = Map::new();
    let overrides = config.get("modelOverrides").and_then(Value::as_object).unwrap_or(&empty);
    let new_models_hidden = config.get("discovery").and_then(|d| d.get("newModelsHidden")) == Some(&Value::Bool(true));
    let mut rows = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for row in discovered {
        let Some(id) = row.get("id").and_then(Value::as_str).filter(|id| !id.is_empty()) else { continue };
        if !seen.insert(id.to_owned()) {
            continue;
        }
        rows.push(effective_row(row.as_object().unwrap_or(&empty), overrides.get(id), provider_id, true, new_models_hidden));
    }
    for (id, over) in overrides {
        if !is_true(over, "manual") || !seen.insert(id.clone()) {
            continue;
        }
        let mut base = Map::new();
        base.insert("id".into(), json!(id));
        base.insert("name".into(), json!(id));
        base.insert("provider".into(), if provider_id.is_empty() { Value::Null } else { json!(provider_id) });
        base.insert("contextWindow".into(), json!(0));
        base.insert("outputTokens".into(), Value::Null);
        rows.push(effective_row(&base, Some(over), provider_id, false, new_models_hidden));
    }
    rows
}

/// `customProviderModels(provider, providerConfig, discovered)`: a config that does not normalize
/// cannot run, so it lists nothing.
fn custom_provider_models(provider: &str, config: &Value, discovered: &[Value]) -> Vec<Value> {
    let Ok(config) = normalize(config) else { return Vec::new() };
    let provider_name = clean(config.get("name"));
    effective_custom_model_rows(&config, discovered, provider)
        .into_iter()
        .map(|mut row| {
            if !provider_name.is_empty()
                && let Some(map) = row.as_object_mut()
            {
                map.insert("providerName".into(), Value::String(provider_name.clone()));
            }
            row
        })
        .collect()
}

struct Quick<'a> {
    list: &'a ModelListService,
    providers: &'a Map<String, Value>,
    rows: Vec<Value>,
    seen: HashSet<String>,
}

impl Quick<'_> {
    /// `metadataFor(provider, modelId)`: `getModelMetadataSync(modelId, provider) || {}`.
    fn metadata_for(&self, provider: &str, model: &str) -> Value {
        self.list.catalog.sync_meta(model, provider).map_or_else(|| json!({}), Value::Object)
    }

    /// A custom-* id with no live custom config entry was deleted: stale routes must not bring it
    /// back into the picker.
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
        let meta = self.metadata_for(provider, &id);
        let either = |key: &str| truthy(model.get(key)).or_else(|| truthy(meta.get(key))).cloned().unwrap_or(Value::Null);
        let flag = |key: &str| Value::Bool(is_true(&model, key) || is_true(&meta, key));
        let mut row: Map<String, Value> = model.as_object().cloned().unwrap_or_default();
        row.insert("id".into(), json!(id));
        row.insert("name".into(), json!(first_text(&model, &["name", "display"]).unwrap_or_else(|| id.clone())));
        row.insert("display".into(), json!(first_text(&model, &["display", "name"]).unwrap_or_else(|| id.clone())));
        row.insert("contextWindow".into(), either("contextWindow"));
        row.insert("outputTokens".into(), either("outputTokens"));
        // An explicit value (an override's false included) wins; the catalog fills the rest.
        match present(model.get("supportsVision")).or_else(|| present(meta.get("supportsVision"))) {
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
        if is_custom_provider_name(provider) {
            let mut declared = Map::new();
            for key in CUSTOM_DECLARED_FIELDS {
                if let Some(value) = model.get(key).filter(|v| !v.is_null()) {
                    declared.insert(key.to_owned(), value.clone());
                }
            }
            if declared.contains_key("reasoningLevels") && !declared.contains_key("reasoningOptions") {
                declared.insert("reasoningOptions".into(), json!([]));
            }
            row.extend(declared);
        }
        let row = Value::Object(row);
        let web_search = web_search_capable_for(provider, &id, Some(&row), Some(&meta));
        let cached = provider_model_cache_row(provider, &row, web_search);
        // A hidden model leaves the picker (a saved route on it included).
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
        let meta = self.metadata_for(&provider, &model);
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
        match custom {
            Some(config) => {
                let found = custom_provider_models(&provider, &config, &[route_row]).into_iter().find(|item| item.get("id").and_then(Value::as_str) == Some(model.as_str()));
                if let Some(row) = found {
                    self.add_model(&provider, &row);
                }
            }
            None => self.add_model(&provider, &route_row),
        }
    }
}

impl ModelListService {
    /// The quick rows over the providers of the loaded config, the live `route` and the loaded
    /// config's presets, workflow routes and agent routes; availability applied and sorted.
    pub(super) fn quick_rows(&self, snapshot: &CatalogSnapshot, providers: &Map<String, Value>, agent: &Obj, route: &Obj) -> Vec<Value> {
        let mut quick = Quick { list: self, providers, rows: Vec::new(), seen: HashSet::new() };
        for (name, config) in providers {
            if truthy(config.get("enabled")).is_none() {
                continue;
            }
            // A custom provider's configured models are listed at once, before any catalog refresh.
            let models: Vec<Value> = if config.get("type").and_then(Value::as_str) == Some("custom") {
                custom_provider_models(name, config, &self.catalog.cached_models(name))
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
        let values = |key: &str| agent.get(key).and_then(Value::as_object).map(|m| m.iter().filter(|(k, _)| key != "workflowRoutes" || k.as_str() != "search").map(|(_, v)| v.clone()).collect::<Vec<_>>()).unwrap_or_default();
        for route in values("workflowRoutes").iter().chain(values("agents").iter()) {
            quick.add_route(route);
        }
        let rows = quick.rows;
        self.from_cache_rows(snapshot, &rows)
    }
}