//! A custom provider's model list (`custom-provider.mjs` `withCustomModels`
//! and `custom-provider-config.mjs` `effectiveCustomModelRows`): discovery
//! always runs, the user's per-model overrides layer over what it found, and
//! manual overrides the endpoint does not list are appended.
//!
//! A failed discovery keeps the last successful rows plus the manual ones and
//! is an error only when nothing is usable. The error carries the status, with
//! the key redacted from its text.

use crate::transport::deadlines::MODEL_LIST_WAIT;
use crate::transport::deadlines::abort_signal;
use crate::transport::deadlines::compat_model_list_within;
use std::collections::BTreeMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::time::Duration;

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
            levels: reasoning.and_then(|r| r.get("levels")).and_then(Value::as_array).map(|a| ranked(a.iter().filter_map(|v| v.as_str().map(str::to_owned)))),
            wire_format: reasoning.and_then(|r| r.get("wireFormat")).and_then(Value::as_str).map(str::to_owned),
            wire_values: reasoning
                .and_then(|r| r.get("wireValues"))
                .and_then(Value::as_object)
                .map(|m| m.iter().filter_map(|(k, v)| Some((canonical_level(k)?.to_owned(), v.as_str()?.to_owned()))).collect())
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
    let wire_values: BTreeMap<String, String> =
        ov.wire_values.iter().filter(|(level, _)| levels.as_ref().is_none_or(|l| l.contains(level))).map(|(k, v)| (k.clone(), v.clone())).collect();
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
    base.picker.custom_reasoning = Some(CustomReasoning { wire_format: ov.wire_format.clone().unwrap_or_else(|| "standard".into()), wire_values, replay });
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

/// The error safe to surface: the key redacted, the status kept, and a timer's expiry coded `EPROVIDERTIMEOUT`
/// (`sanitizeDiscoveryError`: a `TimeoutError` becomes one too).
fn sanitized(mut error: ProviderError, key: &str) -> ProviderError {
    if !key.is_empty() {
        error.message = error.message.split(key).collect::<Vec<_>>().join("[redacted]");
    }
    if error.timed_out {
        error.code = Some("EPROVIDERTIMEOUT".to_owned());
    }
    error
}

impl CustomListing {
    /// `listModels({ timeoutMs })`: the discovery under the window the caller waits (the runtime's refresh waits
    /// [`MODEL_LIST_WAIT`], the settings page's probe longer).
    pub async fn list_models_within(&self, wait: Duration) -> Result<Vec<ModelRecord>, ProviderError> {
        let mut key = String::new();
        let failure = match self.discover(&mut key, wait).await {
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

#[async_trait]
impl ModelListing for CustomListing {
    async fn list_models(&self) -> Result<Vec<ModelRecord>, ProviderError> {
        self.list_models_within(MODEL_LIST_WAIT).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::connect::rewrite::StaticCredential;
    use crate::providers::listing_row::testing::Replay;

    /// `res.json()` of a 200 that is not JSON throws (`openai-compat-models.mjs:116`): the user sees the request
    /// error, not an empty list.
    #[tokio::test]
    async fn a_model_list_that_is_not_json_is_a_request_error() {
        let page = b"<html>nope</html>".to_vec();
        let http = Arc::new(Replay::new(move |_| (200, page.clone())));
        let listing = CustomListing::new(
            "custom-listing",
            Protocol::OpenaiChat,
            "http://x.test/v1",
            Vec::new(),
            http,
            Arc::new(StaticCredential(Some(("authorization".to_owned(), "Bearer fixture-list-key".to_owned())))),
            false,
            &json!({}),
            ListingLookup::new(),
        );
        let error = listing.list_models().await.expect_err("not a list");
        assert!(error.message.contains("Unexpected token '<', \"<html>nope</html>\" is not valid JSON"), "{}", error.message);
    }

    /// A discovery whose request outlives the timer its protocol arms throws what the real Node provider's discovery
    /// threw (`sites.customOpenaiChatListing`, `customAnthropicListing`): the labelled compat timer on the OpenAI
    /// protocols, `AbortSignal.timeout` on the Anthropic one, each coded `EPROVIDERTIMEOUT` by the sanitizer.
    #[tokio::test(start_paused = true)]
    async fn a_discovery_that_outlives_its_timer_throws_what_nodes_provider_throws() {
        use crate::transport::site_probe::TimingOut;
        use crate::transport::site_probe::assert_thrown;
        use crate::transport::site_probe::assert_transport;
        use crate::transport::site_probe::thrown_code;

        for (site, protocol, base) in
            [("customOpenaiChatListing", Protocol::OpenaiChat, "http://x.test/v1"), ("customAnthropicListing", Protocol::Anthropic, "http://x.test")]
        {
            let transport = TimingOut::new();
            let listing = CustomListing::new(
                "custom-listing",
                protocol,
                base,
                Vec::new(),
                transport.clone(),
                Arc::new(StaticCredential(Some(("authorization".to_owned(), "Bearer k".to_owned())))),
                false,
                &json!({}),
                ListingLookup::new(),
            );
            let error = listing.list_models().await.expect_err("nothing is listed");
            assert_transport(site, &transport);
            assert_thrown(site, &error.message);
            assert_eq!(error.code.as_deref(), thrown_code(site), "{site}: code");
        }
    }
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
        let header = self.credential.header().await?;
        let key = header.as_ref().map(|(_, v)| v.strip_prefix("Bearer ").unwrap_or(v).to_owned()).unwrap_or_default();
        let header = match (header, &self.protocol) {
            (Some(h), _) => h,
            (None, Protocol::Anthropic) => ("x-api-key".to_owned(), String::new()),
            (None, _) => ("authorization".to_owned(), "Bearer no-key".to_owned()),
        };
        Ok((Some(header), key))
    }

    async fn fetch(&self, key: &mut String, wait: Duration) -> Result<Value, ProviderError> {
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
                WireRequest { transport: TransportKind::Http1, method: "GET".into(), url: self.url(), headers, body: Vec::new() },
                // Node: the Anthropic protocol fetches under `AbortSignal.timeout` (`custom-provider.mjs:116`), every
                // other under the labelled compat list timer (`openai-compat-models.mjs:104`).
                match self.protocol {
                    Protocol::Anthropic => abort_signal(wait),
                    _ => compat_model_list_within(&self.id, wait),
                },
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
        // `res.json()` (`custom-provider.mjs:127`, `openai-compat-models.mjs:116`): a body that is not JSON is the
        // request's error.
        crate::providers::compat::listing::json_answer(&body.body)
    }

    /// The protocol's own discovery, rows enriched.
    async fn discover(&self, key: &mut String, wait: Duration) -> Result<Vec<ModelRecord>, ProviderError> {
        let body = self.fetch(key, wait).await?;
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
