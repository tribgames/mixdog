//! A custom provider's model list (`custom-provider.mjs` `withCustomModels`
//! and `custom-provider-config.mjs` `effectiveCustomModelRows`): discovery
//! always runs, the user's per-model overrides layer over what it found, and
//! manual overrides the endpoint does not list are appended.
//!
//! A failed discovery keeps the last successful rows plus the manual ones and
//! is an error only when nothing is usable. The error carries the status, with
//! the key redacted from its text.

use crate::transport::deadlines::compat_model_list;
use std::collections::BTreeMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;

use async_trait::async_trait;
use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::CustomReasoning;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ModelListing;
use mixdog_core_api::domain::provider::ModelRecord;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::ReasoningOption;
use mixdog_core_api::domain::provider::WireRequest;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::Protocol;
use super::reasoning::EFFORT_LEVELS;
use super::reasoning::canonical_level;
use crate::catalog::ListingLookup;
use crate::providers::anthropic::ANTHROPIC_VERSION;
use crate::providers::compat::listing::compat_rows_of;
use crate::providers::compat::models::parse_models;
use crate::providers::connect::rewrite::Credential;
use crate::transport::http::HttpSend;

/// One model's stored override (`normalizeOverride`'s output).
#[derive(Clone, Debug, Default)]
struct Override {
    manual: bool,
    hidden: Option<bool>,
    name: Option<String>,
    context_window: Option<u64>,
    max_output_tokens: Option<u64>,
    supports_vision: Option<bool>,
    levels: Option<Vec<String>>,
    wire_format: Option<String>,
    wire_values: BTreeMap<String, String>,
    replay: Option<bool>,
}

fn rank(level: &str) -> usize {
    EFFORT_LEVELS.iter().position(|l| *l == level).unwrap_or(usize::MAX)
}

/// The levels weakest to strongest, each in canonical spelling, once.
fn ranked(levels: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for level in levels {
        if let Some(level) = canonical_level(&level)
            && !out.iter().any(|l| l == level)
        {
            out.push(level.to_owned());
        }
    }
    out.sort_by_key(|l| rank(l));
    out
}

impl Override {
    fn parse(raw: &Value) -> Self {
        let text = |key: &str| raw.get(key).and_then(Value::as_str).map(str::to_owned);
        let number = |key: &str| raw.get(key).and_then(Value::as_u64).filter(|n| *n > 0);
        let reasoning = raw.get("reasoning");
        Self {
            manual: raw.get("manual").and_then(Value::as_bool) == Some(true),
            hidden: raw.get("hidden").and_then(Value::as_bool),
            name: text("name"),
            context_window: number("contextWindow"),
            max_output_tokens: number("maxOutputTokens"),
            supports_vision: raw.get("supportsVision").and_then(Value::as_bool),
            levels: reasoning
                .and_then(|r| r.get("levels"))
                .and_then(Value::as_array)
                .map(|a| ranked(a.iter().filter_map(|v| v.as_str().map(str::to_owned)))),
            wire_format: reasoning.and_then(|r| r.get("wireFormat")).and_then(Value::as_str).map(str::to_owned),
            wire_values: reasoning
                .and_then(|r| r.get("wireValues"))
                .and_then(Value::as_object)
                .map(|m| {
                    m.iter()
                        .filter_map(|(k, v)| Some((canonical_level(k)?.to_owned(), v.as_str()?.to_owned())))
                        .collect()
                })
                .unwrap_or_default(),
            replay: reasoning.and_then(|r| r.get("replay")).and_then(Value::as_bool),
        }
    }
}

/// `catalogLevels`: the effort levels the catalog's ladder names, ranked; none when it names none.
fn catalog_levels(row: &ModelRecord) -> Option<Vec<String>> {
    let levels = ranked(row.picker.reasoning_options.iter().filter(|o| o.kind == "effort").flat_map(|o| o.values.iter().cloned()));
    (!levels.is_empty()).then_some(levels)
}

fn positive(n: Option<u64>) -> Option<u64> {
    n.filter(|n| *n > 0)
}

/// `effectiveRow`: one discovered (or manual) row under its override.
fn effective_row(mut base: ModelRecord, over: Option<&Override>, discovered: bool, new_models_hidden: bool) -> ModelRecord {
    let none = Override::default();
    let ov = over.unwrap_or(&none);
    let created_stated = base.raw.as_ref().and_then(|raw| raw.get("createdStated")) == Some(&Value::Bool(true));
    let levels = ov.levels.clone().or_else(|| catalog_levels(&base));
    let replay = ov.replay.unwrap_or(base.reasoning_content_field.as_deref() == Some("reasoning_content"));
    let wire_values: BTreeMap<String, String> = ov
        .wire_values
        .iter()
        .filter(|(level, _)| levels.as_ref().is_none_or(|l| l.contains(level)))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    let inherited = json!({
        "name": base.name.clone().filter(|n| !n.is_empty()).unwrap_or_else(|| base.id.clone()),
        "contextWindow": positive(base.context_window).unwrap_or(0),
        "maxOutputTokens": positive(base.max_output_tokens),
    });
    base.name = Some(ov.name.clone().or_else(|| base.name.clone().filter(|n| !n.is_empty())).unwrap_or_else(|| base.id.clone()));
    base.context_window = ov.context_window.or_else(|| positive(base.context_window));
    base.max_output_tokens = ov.max_output_tokens.or_else(|| positive(base.max_output_tokens));
    base.hidden = ov.hidden.unwrap_or(discovered && over.is_none() && new_models_hidden);
    if let Some(vision) = ov.supports_vision {
        base.supports_images = Some(vision);
    }
    base.supports_reasoning = Some(match &levels {
        Some(l) => l.iter().any(|l| l != "none"),
        None => base.supports_reasoning == Some(true),
    });
    base.picker.reasoning_options = match &levels {
        Some(l) if !l.is_empty() => vec![ReasoningOption { kind: "effort".into(), values: l.clone() }],
        _ => Vec::new(),
    };
    let leveled = levels.is_some();
    base.reasoning_levels = levels.unwrap_or_default();
    base.picker.custom_reasoning =
        Some(CustomReasoning { wire_format: ov.wire_format.clone().unwrap_or_else(|| "standard".into()), wire_values, replay });
    base.reasoning_content_field = replay.then(|| "reasoning_content".to_owned());
    // `leveled`: the row states its effort levels (Node's row then has the
    // `reasoningOptions` / `reasoningLevels` keys, even when empty).
    base.manual = ov.manual;
    base.raw = Some(json!({ "inherited": inherited, "leveled": leveled, "createdStated": created_stated }));
    base
}

/// The rows a config states without any network: its manual models under their overrides
/// (`effectiveCustomModelRows(config, [])`).
pub fn manual_rows(cfg: &Value) -> Vec<ModelRecord> {
    let overrides = cfg.get("modelOverrides").and_then(Value::as_object).cloned().unwrap_or_default();
    let hidden = cfg.get("discovery").and_then(|d| d.get("newModelsHidden")).and_then(Value::as_bool) == Some(true);
    effective_rows(&overrides, hidden, &[])
}

/// `publicCustomModelRows`: the setup UI's view of effective rows, one field vocabulary for a
/// provider row and for discovery.
pub fn public_rows(rows: &[ModelRecord]) -> Vec<Value> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut models = Vec::new();
    for item in rows {
        let id = mixdog_js::js_trim(&item.id).to_owned();
        if id.is_empty() || !seen.insert(id.clone()) {
            continue;
        }
        let mut model = Map::new();
        model.insert("id".into(), json!(id));
        let name = item.name.as_deref().or(item.display_name.as_deref()).map(mixdog_js::js_trim).unwrap_or_default();
        if !name.is_empty() && name != id {
            model.insert("name".into(), json!(name));
        }
        if let Some(window) = positive(item.context_window) {
            model.insert("contextWindow".into(), json!(window));
        }
        if let Some(out) = positive(item.max_output_tokens) {
            model.insert("maxOutputTokens".into(), json!(out));
        }
        let raw = item.raw.as_ref();
        model.insert("hidden".into(), json!(item.hidden));
        model.insert("manual".into(), json!(item.manual));
        if let Some(inherited) = raw.and_then(|r| r.get("inherited")).filter(|v| !v.is_null()) {
            model.insert("inherited".into(), inherited.clone());
        }
        if let Some(vision) = item.supports_images {
            model.insert("supportsVision".into(), json!(vision));
        }
        if let Some(reasoning) = item.supports_reasoning {
            model.insert("supportsReasoning".into(), json!(reasoning));
        }
        if raw.and_then(|r| r.get("leveled")) == Some(&Value::Bool(true)) {
            model.insert("reasoningOptions".into(), json!(item.picker.reasoning_options));
            model.insert("reasoningLevels".into(), json!(item.reasoning_levels));
        }
        if let Some(custom) = &item.picker.custom_reasoning {
            model.insert("customReasoning".into(), json!(custom));
        }
        if let Some(field) = &item.reasoning_content_field {
            model.insert("reasoningContentField".into(), json!(field));
        }
        models.push(Value::Object(model));
    }
    models
}

/// `effectiveCustomModelRows`: discovered rows (first of each id) under their
/// overrides, then the manual overrides discovery did not list.
fn effective_rows(overrides: &Map<String, Value>, new_models_hidden: bool, discovered: &[ModelRecord]) -> Vec<ModelRecord> {
    let parsed: Vec<(&String, Override)> = overrides.iter().map(|(id, raw)| (id, Override::parse(raw))).collect();
    let find = |id: &str| parsed.iter().find(|(k, _)| k.as_str() == id).map(|(_, o)| o);
    let mut seen: HashSet<&str> = HashSet::new();
    let mut rows = Vec::new();
    for row in discovered {
        if row.id.is_empty() || !seen.insert(row.id.as_str()) {
            continue;
        }
        rows.push(effective_row(row.clone(), find(&row.id), true, new_models_hidden));
    }
    for (id, over) in &parsed {
        if !over.manual || !seen.insert(id.as_str()) {
            continue;
        }
        let mut base = ModelRecord::new(id.as_str());
        base.name = Some((*id).clone());
        rows.push(effective_row(base, Some(over), false, new_models_hidden));
    }
    rows
}

/// What a custom provider's discovery needs besides its config.
pub struct CustomListing {
    id: String,
    protocol: Protocol,
    /// The config's base URL, trailing slashes removed.
    base_url: String,
    headers: Vec<(String, String)>,
    http: Arc<dyn HttpSend>,
    credential: Arc<dyn Credential>,
    keyless: bool,
    overrides: Map<String, Value>,
    new_models_hidden: bool,
    lookup: ListingLookup,
    discovered: Mutex<Vec<ModelRecord>>,
    discovery_error: Mutex<Option<ProviderError>>,
}

impl CustomListing {
    /// `credential` supplies the discovery header (`authorization: Bearer …` on
    /// the OpenAI protocols, `x-api-key` on `anthropic`).
    #[allow(clippy::too_many_arguments, reason = "one value per input of Node's custom provider")]
    pub fn new(
        id: &str,
        protocol: Protocol,
        base_url: &str,
        headers: Vec<(String, String)>,
        http: Arc<dyn HttpSend>,
        credential: Arc<dyn Credential>,
        keyless: bool,
        cfg: &Value,
        lookup: ListingLookup,
    ) -> Self {
        Self {
            id: id.to_owned(),
            protocol,
            base_url: base_url.trim_end_matches('/').to_owned(),
            headers,
            http,
            credential,
            keyless,
            overrides: cfg.get("modelOverrides").and_then(Value::as_object).cloned().unwrap_or_default(),
            new_models_hidden: cfg.get("discovery").and_then(|d| d.get("newModelsHidden")).and_then(Value::as_bool) == Some(true),
            lookup,
            discovered: Mutex::new(Vec::new()),
            discovery_error: Mutex::new(None),
        }
    }

    /// The sanitized error of the latest discovery (`customDiscoveryError`); none after a success.
    pub fn discovery_error(&self) -> Option<ProviderError> {
        self.discovery_error.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }

    /// The rows without a fresh discovery: what the last one found, under the overrides.
    pub fn cached_rows(&self) -> Vec<ModelRecord> {
        let discovered = self.discovered.lock().unwrap_or_else(PoisonError::into_inner);
        effective_rows(&self.overrides, self.new_models_hidden, &discovered)
    }

    fn url(&self) -> String {
        match self.protocol {
            Protocol::Anthropic => {
                // The Anthropic SDK appends /v1 itself; a /v1 base is accepted.
                let base = &self.base_url;
                let stem = match base.len().checked_sub(3).filter(|at| base.is_char_boundary(*at)) {
                    Some(at) if base[at..].eq_ignore_ascii_case("/v1") => &base[..at],
                    _ => base.as_str(),
                };
                format!("{stem}/v1/models")
            }
            _ => format!("{}/models", self.base_url),
        }
    }

    /// The key the request carries, for redaction.
    async fn auth(&self) -> Result<(Option<(String, String)>, String), ProviderError> {
        if self.keyless {
            return Ok((None, String::new()));
        }
        let header = self.credential.header(false).await?;
        let key = header.as_ref().map(|(_, v)| v.strip_prefix("Bearer ").unwrap_or(v).to_owned()).unwrap_or_default();
        let header = match (header, &self.protocol) {
            (Some(h), _) => h,
            (None, Protocol::Anthropic) => ("x-api-key".to_owned(), String::new()),
            (None, _) => ("authorization".to_owned(), "Bearer no-key".to_owned()),
        };
        Ok((Some(header), key))
    }

    async fn fetch(&self, key: &mut String) -> Result<Value, ProviderError> {
        let (auth, request_key) = self.auth().await?;
        *key = request_key;
        let mut headers: Vec<(String, String)> = Vec::new();
        if self.protocol == Protocol::Anthropic {
            headers.push(("anthropic-version".into(), ANTHROPIC_VERSION.into()));
        }
        headers.extend(auth);
        headers.extend(self.headers.iter().cloned());
        let response = self
            .http
            .send(
                WireRequest {
                    transport: TransportKind::Http1,
                    method: "GET".into(),
                    url: self.url(),
                    headers,
                    body: Vec::new(),
                },
                compat_model_list(&self.id),
            )
            .await?;
        let status = response.status;
        let ok = response.is_success();
        let body = response.read_all().await?;
        if !ok {
            let kind = match status {
                401 => ErrorKind::Auth,
                403 => ErrorKind::Permission,
                429 => ErrorKind::RateLimited,
                s if s >= 500 => ErrorKind::Transient,
                _ => ErrorKind::Unknown,
            };
            let mut error = ProviderError::new(kind, DeliveryState::Accepted);
            error.status = Some(status);
            error.message = format!("{} models {status}", self.id);
            return Err(error);
        }
        // A reachable endpoint that answers something else lists nothing.
        Ok(serde_json::from_slice(&body.body).unwrap_or(Value::Null))
    }

    /// The protocol's own discovery, rows enriched.
    async fn discover(&self, key: &mut String) -> Result<Vec<ModelRecord>, ProviderError> {
        let body = self.fetch(key).await?;
        if self.protocol != Protocol::Anthropic {
            // The compat steps: enrichment, native limits restored, sanitizer.
            let mut rows = compat_rows_of(&self.lookup, &self.id, &parse_models(&body), false);
            // The compat normalizer states `created` (`null` when the endpoint lists none); the Anthropic one has no such key.
            for row in &mut rows {
                row.raw = Some(json!({ "createdStated": true }));
            }
            return Ok(rows);
        }
        let items = body.get("data").and_then(Value::as_array).cloned().unwrap_or_default();
        let rows: Vec<ModelRecord> = items
            .iter()
            .filter_map(|m| {
                let id = m.get("id").and_then(Value::as_str).filter(|id| !id.is_empty())?;
                let mut row = ModelRecord::new(id);
                row.name = Some(m.get("display_name").and_then(Value::as_str).filter(|n| !n.is_empty()).unwrap_or(id).to_owned());
                let limit = |key: &str| m.get(key).map(mixdog_js::to_number).filter(|n| n.is_finite() && *n > 0.0).map(|n| n as u64);
                row.context_window = limit("max_input_tokens");
                row.max_output_tokens = limit("max_tokens");
                Some(row)
            })
            .collect();
        Ok(self.lookup.enrich_listed(&self.id, rows))
    }
}

/// The error safe to surface: the key redacted, the status kept.
fn sanitized(mut error: ProviderError, key: &str) -> ProviderError {
    if !key.is_empty() {
        error.message = error.message.split(key).collect::<Vec<_>>().join("[redacted]");
    }
    error
}

/// `getCachedModelInfo`: the effective rows, which hold the config's own manual models from the moment the provider is
/// built (`_applyCustomRows(_customRows())`) and the discovered ones under their overrides once it has listed.
impl crate::catalog::CachedModelInfo for CustomListing {
    fn cached_row(&self, model: &str) -> Option<std::sync::Arc<Value>> {
        let provider = mixdog_protocol::ProviderId::from(self.id.as_str());
        let row = self.cached_rows().into_iter().find(|row| row.id == model)?;
        crate::catalog::listed_row_of(&provider, row).map(std::sync::Arc::new)
    }
}

#[async_trait]
impl ModelListing for CustomListing {
    async fn list_models(&self) -> Result<Vec<ModelRecord>, ProviderError> {
        let mut key = String::new();
        let failure = match self.discover(&mut key).await {
            Ok(rows) => {
                *self.discovered.lock().unwrap_or_else(PoisonError::into_inner) = rows;
                *self.discovery_error.lock().unwrap_or_else(PoisonError::into_inner) = None;
                None
            }
            Err(error) => {
                let error = sanitized(error, &key);
                *self.discovery_error.lock().unwrap_or_else(PoisonError::into_inner) = Some(error.clone());
                Some(error)
            }
        };
        let rows = self.cached_rows();
        match failure {
            Some(error) if rows.is_empty() => Err(error),
            _ => Ok(rows),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::connect::rewrite::StaticCredential;
    use crate::providers::listing_row::testing::Replay;
    use crate::providers::listing_row::testing::fixture;

    fn script(scenario: &str, golden: &Value) -> (u16, Value) {
        match scenario {
            "failed-with-manual" => (403, json!({ "error": { "message": "bad key fixture-custom-key" } })),
            "failed-with-nothing" => (500, json!({ "error": "boom" })),
            "anthropic" => (200, json!({ "data": golden["anthropicRoster"] })),
            "catalog-replay" | "catalog-replay-overridden" => (200, json!({ "data": golden["catalogRoster"] })),
            "keyless" => (200, json!({ "data": golden["roster"].as_array().unwrap()[..3] })),
            _ => (200, json!({ "data": golden["roster"] })),
        }
    }

    /// Every recorded scenario gives Node's rows (overrides, hidden-by-default,
    /// manual rows, a failed discovery) and asks Node's URL with Node's headers.
    #[tokio::test]
    async fn every_recorded_custom_listing_gives_nodes_rows() {
        let golden = fixture("oracles/custom-listing.json");
        for case in golden["cases"].as_array().unwrap() {
            let scenario = case["scenario"].as_str().unwrap();
            let config = &case["config"];
            let protocol: Protocol = serde_json::from_value(config["protocol"].clone()).unwrap();
            let keyless = config["auth"] == "none";
            let (status, body) = script(scenario, &golden);
            let bytes = serde_json::to_vec(&body).unwrap();
            let http = Arc::new(Replay::new(move |_| (status, bytes.clone())));
            let header = match protocol {
                Protocol::Anthropic => ("x-api-key", "fixture-custom-key".to_owned()),
                _ => ("authorization", "Bearer fixture-custom-key".to_owned()),
            };
            let headers: Vec<(String, String)> = config["headers"]
                .as_object()
                .map(|m| m.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned())).collect())
                .unwrap_or_default();
            let listing = CustomListing::new(
                "custom-fixture",
                protocol,
                config["baseURL"].as_str().unwrap(),
                headers,
                http.clone(),
                Arc::new(StaticCredential((!keyless).then(|| (header.0.to_owned(), header.1)))),
                keyless,
                config,
                ListingLookup::with_models_dev(&json!({ "deepseek": { "models": golden["modelsDev"] } })),
            );
            let result = listing.list_models().await;

            let sent = http.requests.lock().unwrap();
            let want = &case["requests"][0];
            assert_eq!(sent[0].url, want["url"].as_str().unwrap(), "{scenario}");
            for (name, value) in want["headers"].as_object().unwrap() {
                let has = sent[0].headers.iter().any(|(k, v)| k.eq_ignore_ascii_case(name) && v == value.as_str().unwrap());
                assert!(has, "{scenario}: header {name}");
            }
            if case["error"].is_string() {
                let error = result.err().unwrap_or_else(|| panic!("{scenario}: Node failed with {}", case["error"]));
                assert_eq!(error.message, case["error"].as_str().unwrap(), "{scenario}");
                assert_eq!(error.status.map(u64::from), case["status"].as_u64(), "{scenario}");
                continue;
            }
            let rows = result.unwrap_or_else(|e| panic!("{scenario}: {e:?}"));
            let expected = case["rows"].as_array().unwrap();
            assert_eq!(rows.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), expected.iter().map(|r| r["id"].as_str().unwrap()).collect::<Vec<_>>(), "{scenario}: ids");
            for (row, node) in rows.iter().zip(expected) {
                let what = format!("{scenario}: {}", node["id"]);
                let raw = row.raw.as_ref().unwrap();
                assert_eq!(row.name.as_deref(), node["name"].as_str(), "{what} name");
                assert_eq!(row.context_window.unwrap_or(0), node["contextWindow"].as_u64().unwrap_or(0), "{what} contextWindow");
                assert_eq!(row.max_output_tokens, node["outputTokens"].as_u64(), "{what} outputTokens");
                assert_eq!(row.hidden, node["hidden"].as_bool().unwrap(), "{what} hidden");
                assert_eq!(json!(row.manual), node["manual"], "{what} manual");
                assert!(row.provider_name.is_none(), "{what}: the listing states no providerName; hydration sets it from the config");
                assert_eq!(row.reasoning_content_field.as_deref(), node["reasoningContentField"].as_str(), "{what} reasoningContentField");
                assert_eq!(raw["inherited"], node["inherited"], "{what} inherited");
                assert_eq!(row.supports_images, node["supportsVision"].as_bool(), "{what} supportsVision");
                assert_eq!(row.supports_reasoning, node["supportsReasoning"].as_bool(), "{what} supportsReasoning");
                assert_eq!(json!(row.reasoning_levels), node.get("reasoningLevels").cloned().unwrap_or(json!([])), "{what} reasoningLevels");
                assert_eq!(json!(row.picker.reasoning_options), node.get("reasoningOptions").cloned().unwrap_or(json!([])), "{what} reasoningOptions");
                // The row the catalog keeps as stated is Node's row, key for key (`getCachedModelInfo`).
                let mut node_row = node.clone();
                node_row.as_object_mut().unwrap().remove("provider");
                assert_eq!(crate::catalog::listed_row_of(&"custom-fixture".into(), row.clone()), Some(node_row.clone()), "{what} stated row");
                // The provider answers it as its `getCachedModelInfo` (`custom-provider.mjs:109`), manual rows included.
                assert_eq!(crate::catalog::CachedModelInfo::cached_row(&listing, &row.id).as_deref(), Some(&node_row), "{what} cached row");
                let custom = row.picker.custom_reasoning.as_ref().unwrap();
                assert_eq!(custom.replay, node["customReasoning"]["replay"], "{what} replay");
                assert_eq!(json!(custom.wire_format), node["customReasoning"]["wireFormat"], "{what} wireFormat");
                assert_eq!(json!(custom.wire_values), node["customReasoning"]["wireValues"], "{what} wireValues");
            }
        }
    }
}
