//! The model listing of the OpenAI-compatible family (`openai-compat-models.mjs`
//! `listCompatModels` and the listings of MiMo, Muse Code, Command Code and the
//! OpenCode Go console config). What differs per provider is
//! [`ListingRules`] data on its profile; the steps are Node's, in Node's
//! order: the roster, the provider's own row filter, the shared enrichment,
//! the native limits restored over it, the shared sanitizer.
//!
//! A listing is one fetch with no retry and no fallback list, except the one
//! Node itself shows (MiMo's seed roster). The metadata tables are the
//! catalog service's, read through the adapter's [`ListingLookup`]; the rows a
//! listing "publishes" in Node (the persisted roster the lookup reads back)
//! are applied here directly, since the enrichment reads the row itself.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::LazyLock;

use async_trait::async_trait;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ModelListing;
use mixdog_core_api::domain::provider::ModelRecord;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::ReasoningOption;
use mixdog_js::JsRegex;
use mixdog_js::js_trim;
use mixdog_js::to_number;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::adapter::CompatAdapter;
use super::adapter::fetch_json;
use super::models::CompatModelInfo;
use super::models::parse_models;
use super::models::stated_limit;
use super::profile::ListingRules;
use super::profile::ListingShape;
use super::profile::Wire;
use super::wire_route::WireFacts;
use super::wire_route::route_for;
use super::wire_route::wire_of_package;
use crate::catalog::keep_native;
use crate::catalog::seed_display_name;
use crate::catalog::seed_roster;

/// The package a models.dev row serves over unless it names its own.
const MODELS_DEV_PACKAGE: &str = "@ai-sdk/openai-compatible";

static TIER_MARKER: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static("\\s*\\(c\\)\\s*$", "i"));
static NOT_ALNUM: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static("[^a-z0-9]+", "g"));

fn catalog_error(message: String) -> ProviderError {
    let mut error = ProviderError::new(ErrorKind::Unknown, DeliveryState::Accepted);
    error.message = message;
    error
}

fn effort_options(levels: &[String]) -> Vec<ReasoningOption> {
    vec![ReasoningOption { kind: "effort".into(), values: levels.to_vec() }]
}

/// The row a fetched roster entry is before enrichment (`listCompatModels`);
/// `name` is the id, as Node's rows carry it.
fn native_record(info: &CompatModelInfo, publish_names: bool) -> ModelRecord {
    let mut record = ModelRecord::new(&info.id);
    record.name = Some(info.id.clone());
    if publish_names {
        record.display_name = info.display_name.clone();
    }
    record.context_window = info.context_window.map(u64::from);
    record.max_output_tokens = info.output_tokens.map(u64::from);
    record.created = info.created;
    record.mode = info.mode.clone();
    record.alias_target = info.alias_target.clone();
    record.supports_reasoning = info.supports_reasoning;
    record.reasoning_levels = info.reasoning_levels.iter().map(|l| (*l).to_owned()).collect();
    if !record.reasoning_levels.is_empty() {
        record.picker.reasoning_options = effort_options(&record.reasoning_levels);
    }
    record
}

impl CompatAdapter {
    /// `GET url` with the credential; the console config reloads a rejected
    /// token once, as a send does.
    async fn get_json(&self, url: String, reload_on_401: bool) -> Result<Value, ProviderError> {
        let profile = self.codec.profile();
        let mut key = match &self.key {
            Some(source) => Some(source.key().await?),
            None => None,
        };
        let mut reloaded = false;
        loop {
            let result = fetch_json(self.http.as_ref(), profile, url.clone(), self.codec.extra_headers(), key.as_deref()).await;
            if let Err(error) = &result
                && reload_on_401
                && error.status == Some(401)
                && !reloaded
                && let Some(source) = &self.key
            {
                reloaded = true;
                key = Some(source.reload().await?);
                continue;
            }
            return result;
        }
    }

    /// The `data` array of `GET {base}/models`, or a bare array; anything else lists nothing.
    async fn roster_items(&self) -> Result<Vec<Value>, ProviderError> {
        let body = self.get_json(format!("{}/models", self.codec.base_url()), false).await?;
        Ok(match body {
            Value::Array(items) => items,
            Value::Object(mut map) => match map.remove("data") {
                Some(Value::Array(items)) => items,
                _ => Vec::new(),
            },
            _ => Vec::new(),
        })
    }

    /// Whether the profile lists a fetched row at all.
    fn lists(&self, rules: &ListingRules, info: &CompatModelInfo) -> bool {
        let id = &info.id;
        if rules.drop_id_containing.iter().any(|part| id.to_lowercase().contains(part)) {
            return false;
        }
        if rules.drop_id_pattern.is_some_and(|pattern| JsRegex::new_static(pattern, "i").is_match(id)) {
            return false;
        }
        if rules.servable_only {
            // A row declaring no endpoint is served on Chat Completions by convention.
            let wires = info.endpoints.clone().unwrap_or_else(|| vec![Wire::Chat]);
            let facts = WireFacts { endpoints: Some(&wires), known: true, ..WireFacts::default() };
            let profile = self.codec.profile();
            return route_for(profile, profile.id, id, facts, &Default::default()).is_some();
        }
        true
    }

    /// `listCompatModels` past the fetch: enrichment, then the native limits
    /// and mode restored over what it derived, then the sanitizer.
    fn compat_rows(&self, infos: &[CompatModelInfo], publish_names: bool) -> Vec<ModelRecord> {
        let provider = self.codec.profile().id;
        let native: Vec<ModelRecord> = infos.iter().map(|info| native_record(info, publish_names)).collect();
        // A published roster is the lookup's base layer, and a base's display name
        // is never replaced by the listed row's own `name` (which is only the id).
        let mut lent = native.clone();
        if publish_names {
            for row in &mut lent {
                row.name = None;
            }
        }
        let mut enriched = self.lookup.enrich_listed(provider, lent);
        for (row, native) in enriched.iter_mut().zip(&native) {
            row.name.clone_from(&native.name);
        }
        self.lookup.sanitize_listed(provider, keep_native(&native, enriched))
    }

    async fn compat_listing(&self, rules: &ListingRules, decorate: Option<(&[&str], bool)>) -> Result<Vec<ModelRecord>, ProviderError> {
        let fetched = match self.roster_items().await {
            Ok(items) => parse_models(&Value::Array(items)).into_iter().filter(|info| self.lists(rules, info)).collect(),
            // A rejected key is the caller's to hear; another failure shows the seed roster.
            Err(error) if decorate.is_some() && error.status != Some(401) => Vec::new(),
            Err(error) => return Err(error),
        };
        let seeded = decorate.is_some_and(|(_, seed)| seed) && fetched.is_empty();
        let infos: Vec<CompatModelInfo> = if seeded {
            seed_roster(self.codec.profile().id)
                .into_iter()
                .map(|(id, name)| CompatModelInfo { id: id.to_owned(), display_name: Some(name.to_owned()), ..CompatModelInfo::default() })
                .collect()
        } else {
            fetched
        };
        // The seed roster is never published, so its names do not reach the enrichment.
        let mut rows = self.compat_rows(&infos, rules.publishes_roster && !seeded);
        if !seeded {
            self.codec.models().replace(infos.clone());
        }
        if let Some((levels, _)) = decorate {
            let names: HashMap<&str, &str> =
                infos.iter().filter_map(|i| Some((i.id.as_str(), js_trim(i.display_name.as_deref()?)))).filter(|(_, n)| !n.is_empty()).collect();
            for row in &mut rows {
                if let Some(name) = names.get(row.id.as_str()) {
                    row.name = Some((*name).to_owned());
                }
                if row.reasoning_levels.is_empty() {
                    row.reasoning_levels = levels.iter().map(|l| (*l).to_owned()).collect();
                }
                row.raw = Some(json!({ "reasoningContentField": "reasoning_content" }));
            }
        }
        Ok(rows)
    }

    /// Muse Code: the roster alone, enriched, named and given its default ladder.
    async fn roster_listing(&self, rules: &ListingRules, default_levels: &[&str]) -> Result<Vec<ModelRecord>, ProviderError> {
        let provider = self.codec.profile().id;
        let items = self.roster_items().await?;
        let mut kept = Vec::new();
        let mut native = Vec::new();
        for item in &items {
            let Some(id) = item.get("id").and_then(Value::as_str).filter(|id| !id.is_empty()) else { continue };
            let probe = CompatModelInfo { id: id.to_owned(), ..CompatModelInfo::default() };
            if !self.lists(rules, &probe) {
                continue;
            }
            let mut record = ModelRecord::new(id);
            // `name` first, then `display_name`, as the roster states them.
            record.display_name = ["name", "display_name"]
                .iter()
                .filter_map(|key| item.get(key).and_then(Value::as_str))
                .map(js_trim)
                .find(|name| !name.is_empty())
                .map(str::to_owned);
            record.context_window = stated_limit(&[item.get("context_window"), item.get("max_context_window"), item.get("context_length"), Some(&json!(0))]).map(u64::from);
            record.max_output_tokens = stated_limit(&[item.get("max_output_tokens"), item.get("output_tokens"), Some(&json!(0))]).map(u64::from);
            record.created = item.get("created").filter(|v| v.is_number()).and_then(Value::as_i64);
            native.push(record);
            kept.push(item.clone());
        }
        self.codec.models().replace(parse_models(&Value::Array(kept)));
        let named: Vec<Option<String>> = native.iter().map(|r| r.display_name.clone().filter(|n| *n != r.id)).collect();
        let mut rows = self.lookup.enrich_listed(provider, native);
        let levels: Vec<String> = default_levels.iter().map(|l| (*l).to_owned()).collect();
        for (row, discovered) in rows.iter_mut().zip(named) {
            // The discovered name, else the catalog's; a name that is the
            // seed's own label keeps the seed's spelling ("(C)" tier marker).
            let candidate = discovered.or_else(|| row.display_name.clone().filter(|n| *n != row.id)).unwrap_or_default();
            let name = tier_name(&candidate, seed_display_name(provider, &row.id).as_deref());
            row.display_name = (name != row.id && !name.is_empty()).then(|| name.clone());
            row.name = Some(if name.is_empty() { row.id.clone() } else { name });
            if row.picker.reasoning_options.is_empty() && row.supports_reasoning != Some(false) {
                row.picker.reasoning_options = effort_options(&levels);
            }
            if row.reasoning_levels.is_empty() {
                row.reasoning_levels =
                    row.picker.reasoning_options.iter().find(|o| o.kind == "effort").map(|o| o.values.clone()).unwrap_or_default();
            }
        }
        Ok(rows)
    }

    /// OpenCode Go: the organization's console config is the roster.
    async fn console_listing(&self, url: &str, provider_key: &str) -> Result<Vec<ModelRecord>, ProviderError> {
        let provider = self.codec.profile().id;
        let config = self.get_json(url.to_owned(), true).await?;
        let entry = config.get("providers").and_then(|p| p.get(provider_key));
        let configured = entry
            .and_then(|e| e.get("models"))
            .and_then(Value::as_object)
            .filter(|models| !models.is_empty());
        // A config that lists no models takes the models.dev catalog of the
        // same provider, which must be loaded.
        let fallback = match configured {
            Some(_) => None,
            None => match self.lookup.models_dev_models(provider_key).filter(|m| !m.is_empty()) {
                Some(models) => Some(models),
                None => {
                    return Err(catalog_error(format!(
                        "[{provider}] the OpenCode organization config lists no models and the models.dev OpenCode Go catalog is unavailable"
                    )));
                }
            },
        };
        let Some(entry) = entry.filter(|e| e.is_object()) else {
            return Err(catalog_error(format!("[{provider}] the OpenCode organization config has no OpenCode Go provider")));
        };
        let package = if fallback.is_some() { MODELS_DEV_PACKAGE } else { entry.get("package").and_then(Value::as_str).unwrap_or("") };
        let source: Vec<(String, Value)> = match &fallback {
            Some(models) => models.iter().map(|(id, row)| (id.clone(), config_model_from_models_dev(row))).collect(),
            None => configured.map(|m| m.iter().map(|(id, model)| (id.clone(), model.clone())).collect()).unwrap_or_default(),
        };
        let mut wires = HashMap::new();
        let mut native = Vec::new();
        for (id, model) in &source {
            let Some(model) = model.as_object().filter(|m| !id.is_empty() && m.get("disabled") != Some(&Value::Bool(true))) else { continue };
            let (record, wire) = console_record(id, model, package);
            if let Some(wire) = wire {
                wires.insert(id.clone(), wire);
            }
            native.push(record);
        }
        self.roster_wires.store(Arc::new(wires));
        Ok(self.lookup.enrich_listed(provider, native))
    }
}

/// `tierName`: a label naming the seeded model keeps the seed's spelling.
fn tier_name(candidate: &str, seed_name: Option<&str>) -> String {
    let key = |name: &str| {
        let bare = TIER_MARKER.replace_all_with(name, |_| String::new());
        NOT_ALNUM.replace_all_with(&bare.to_lowercase(), |_| String::new())
    };
    match seed_name {
        Some(seed) if !candidate.is_empty() && key(candidate) == key(seed) => seed.to_owned(),
        _ => candidate.to_owned(),
    }
}

fn positive_number(value: Option<&Value>) -> Option<u64> {
    let n = to_number(value?);
    (n.is_finite() && n > 0.0).then_some(n as u64)
}

/// A models.dev row in the console config's model shape (`configModelFromModelsDev`).
fn config_model_from_models_dev(row: &Value) -> Value {
    let mut model = Map::new();
    if let Some(name) = row.get("name") {
        model.insert("name".into(), name.clone());
    }
    if let Some(npm) = row.get("npm").filter(|v| v.is_string()) {
        model.insert("package".into(), npm.clone());
    }
    if let Some(limit) = row.get("limit") {
        model.insert("limit".into(), limit.clone());
    }
    if let Some(reasoning) = row.get("reasoning").and_then(Value::as_bool) {
        let effort = row
            .get("reasoning_options")
            .and_then(Value::as_array)
            .and_then(|options| options.iter().find(|o| o.get("type").and_then(Value::as_str) == Some("effort")))
            .and_then(|o| o.get("values"));
        let mut supported = Map::new();
        supported.insert("supported".into(), Value::Bool(reasoning));
        if let Some(effort) = effort {
            supported.insert("effort".into(), effort.clone());
        }
        model.insert("capabilities".into(), json!({ "reasoning": supported }));
    }
    Value::Object(model)
}

/// `catalogRow`: the listed row and the wire the config states for the model.
fn console_record(id: &str, model: &Map<String, Value>, provider_package: &str) -> (ModelRecord, Option<Wire>) {
    let mut record = ModelRecord::new(id);
    let name = model.get("name").and_then(Value::as_str).map(js_trim).filter(|n| !n.is_empty()).unwrap_or(id);
    record.name = Some(name.to_owned());
    let package = model.get("package").and_then(Value::as_str).unwrap_or(provider_package);
    let limit = model.get("limit");
    record.context_window = positive_number(limit.and_then(|l| l.get("context")));
    record.max_output_tokens = positive_number(limit.and_then(|l| l.get("output")));
    let reasoning = model.get("capabilities").and_then(|c| c.get("reasoning"));
    if let Some(supported) = reasoning.and_then(|r| r.get("supported")).and_then(Value::as_bool) {
        record.supports_reasoning = Some(supported);
        let levels: Vec<String> = match reasoning.and_then(|r| r.get("effort")).and_then(Value::as_array) {
            Some(effort) if supported => effort.iter().filter_map(Value::as_str).filter(|v| !v.is_empty()).map(str::to_owned).collect(),
            _ => Vec::new(),
        };
        if !levels.is_empty() {
            record.picker.reasoning_options = effort_options(&levels);
            record.reasoning_levels = levels;
        }
    }
    (record, wire_of_package(Some(package)))
}

#[async_trait]
impl ModelListing for CompatAdapter {
    async fn list_models(&self) -> Result<Vec<ModelRecord>, ProviderError> {
        let rules = self.codec.profile().listing;
        match rules.shape {
            ListingShape::Compat => self.compat_listing(&rules, None).await,
            ListingShape::Decorated { default_levels, seed_when_empty } => {
                self.compat_listing(&rules, Some((default_levels, seed_when_empty))).await
            }
            ListingShape::Roster { default_levels } => self.roster_listing(&rules, default_levels).await,
            ListingShape::ConsoleConfig { url, provider_key } => self.console_listing(url, provider_key).await,
        }
    }
}
