//! `grok-oauth` model listing: the union of the api.x.ai catalog and the Grok
//! CLI proxy catalog, merged per id, each row normalized the way the picker
//! reads it, the newest dated chat model marked `latest`.
//!
//! api.x.ai is the primary catalog: its failure is the listing's failure. The
//! proxy catalog adds the served names, context windows, effort levels and
//! proxy-only variants; a proxy that cannot answer leaves the api.x.ai rows
//! as they are. The rows end with the metadata enrichment, the Grok-specific
//! settling of the enriched rows and the shared picker sanitizer, in Node's
//! order (`_fetchAndCacheCatalog`).

use crate::transport::deadlines::GROK_LISTING;
use std::sync::Arc;
use std::sync::LazyLock;

use async_trait::async_trait;
use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ModelListing;
use mixdog_core_api::domain::provider::ModelRecord;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::WireCodec;
use mixdog_core_api::domain::provider::WireRequest;
use mixdog_js::JsRegex;
use mixdog_js::js_trim;
use mixdog_js::to_number;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::INFERENCE_BASE_URL;
use super::PROVIDER_ID;
use super::PROXY_BASE_URL;
use super::identity_headers;
use crate::catalog::ListingLookup;
use crate::providers::compat::CompatProfile;
use crate::providers::connect::rewrite::Credential;
use crate::providers::listing_row;
use crate::transport::http::HttpSend;

/// Effort levels in canonical low-to-high order, whatever order a source lists them.
const KNOWN_EFFORTS: [&str; 6] = ["none", "low", "medium", "high", "xhigh", "max"];
/// A model whose roster publishes no efforts and the catalog is silent on.
const FALLBACK_EFFORTS: [&str; 3] = ["low", "medium", "high"];

static NON_CHAT: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static("imagine|image|video", "i"));
static NON_REASONING: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static("non[-_]?reasoning", ""));
static BUILD_FAMILY: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static("^grok[-_]build", ""));
static GROK_PREFIX: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static("^grok-", "i"));
static DATE_SUFFIX: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static("-0?309\\b", ""));
static WORD_START: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static("\\b\\w", ""));
static SPACES: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static("\\s+", ""));

/// What the metadata catalog says of an xAI model's reasoning effort, with the
/// closed legacy generations held back when the catalog does not know the
/// model: the shared xAI rule, owned by the catalog.
pub trait XaiEffortRule: Send + Sync {
    /// `text` is the lower-cased model id.
    fn takes_effort(&self, text: &str) -> bool;
}

/// The rule without a metadata catalog: the xAI profile's exact ids of the
/// generations that reject an effort; any other model is sent the effort and
/// the server decides.
pub struct SeedEffortRule;

impl XaiEffortRule for SeedEffortRule {
    fn takes_effort(&self, text: &str) -> bool {
        if !text.starts_with("grok") {
            return true;
        }
        CompatProfile::xai()
            .seed_models
            .iter()
            .find(|seed| seed.id == text)
            .is_none_or(|seed| seed.supports_reasoning != Some(false))
    }
}

pub struct GrokListing {
    http: Arc<dyn HttpSend>,
    credential: Arc<dyn Credential>,
    /// Classifies a refused listing request like a refused turn.
    codec: Arc<dyn WireCodec>,
    client_version: crate::client_versions::Live,
    effort_rule: Arc<dyn XaiEffortRule>,
    /// The metadata enrichment and the picker sanitizer the listing ends with.
    lookup: ListingLookup,
}

impl GrokListing {
    pub fn new(
        http: Arc<dyn HttpSend>,
        credential: Arc<dyn Credential>,
        codec: Arc<dyn WireCodec>,
        client_version: crate::client_versions::Live,
        effort_rule: Arc<dyn XaiEffortRule>,
        lookup: ListingLookup,
    ) -> Self {
        Self { http, credential, codec, client_version, effort_rule, lookup }
    }

    /// The `data` array of one catalog. A redirect is refused like any other
    /// refusal: the bearer is never replayed to another host.
    async fn items(&self, url: String, headers: Vec<(String, String)>) -> Result<Vec<Value>, ProviderError> {
        let head = self
            .http
            .send(
                WireRequest {
                    transport: TransportKind::Http1,
                    method: "GET".to_owned(),
                    url,
                    headers,
                    body: Vec::new(),
                },
                GROK_LISTING,
            )
            .await?;
        let success = head.is_success();
        let response = head.read_all().await?;
        if !success {
            return Err(self.codec.classify(&response));
        }
        let mut body: Value = serde_json::from_slice(&response.body).map_err(|e| malformed(&format!("/models is not JSON ({e})")))?;
        match body.get_mut("data").map(Value::take) {
            Some(Value::Array(items)) => Ok(items),
            _ => Err(malformed("unexpected /models response shape (no data[])")),
        }
    }

    /// Whether the model takes a reasoning effort; `declared` is whether its
    /// own roster row publishes effort values.
    fn takes_effort(&self, id: &str, declared: bool) -> bool {
        let text = id.to_lowercase();
        if text.is_empty() || NON_CHAT.is_match(&text) {
            return false;
        }
        if declared {
            return true;
        }
        if NON_REASONING.is_match(&text) || BUILD_FAMILY.is_match(&text) {
            return false;
        }
        self.effort_rule.takes_effort(&text)
    }

    /// The efforts the picker offers (`_grokReasoningLevels`): none for a
    /// model that takes no effort, else the ladder `declared` states, else
    /// the fallback.
    fn reasoning_levels(&self, id: &str, declared: &[String]) -> Vec<String> {
        if !self.takes_effort(id, !declared.is_empty()) {
            Vec::new()
        } else if declared.is_empty() {
            FALLBACK_EFFORTS.iter().map(|e| (*e).to_owned()).collect()
        } else {
            declared.to_vec()
        }
    }

    /// What `_sanitizeGrokModels` does to a row after the catalog's enrichment:
    /// api.x.ai states no output limit (enrichment must not invent one), and
    /// the effort levels follow the ladder enrichment left on the row.
    pub(super) fn settle(&self, mut record: ModelRecord) -> ModelRecord {
        record.max_output_tokens = None;
        let ladder = record.picker.reasoning_options.iter().find(|option| js_trim(&option.kind).to_lowercase() == "effort");
        let declared = ladder.map_or_else(Vec::new, |option| {
            known_efforts(&option.values.iter().map(|v| Value::String(v.clone())).collect::<Vec<_>>())
        });
        record.reasoning_levels = self.reasoning_levels(&record.id, &declared);
        record
    }

    fn normalize(&self, item: &Map<String, Value>) -> Option<Map<String, Value>> {
        let id = item.get("id").and_then(Value::as_str).filter(|id| !id.is_empty())?;
        let efforts = declared_efforts(item);
        let levels = self.reasoning_levels(id, &efforts);
        let mut row = Map::new();
        row.insert("id".into(), json!(id));
        row.insert("name".into(), json!(id));
        row.insert("display".into(), json!(display(item, id)));
        row.insert("provider".into(), json!(PROVIDER_ID));
        row.insert("family".into(), json!(if self.takes_effort(id, false) { "grok" } else { "grok-static" }));
        row.insert("reasoningLevels".into(), json!(levels));
        if !efforts.is_empty() {
            row.insert("reasoningOptions".into(), json!([{"type": "effort", "values": efforts}]));
        }
        row.insert("tier".into(), json!("version"));
        row.insert("latest".into(), json!(false));
        row.insert("contextWindow".into(), context_window(item));
        row.insert("created".into(), item.get("created").filter(|v| v.is_number()).cloned().unwrap_or(Value::Null));
        Some(row)
    }
}

fn malformed(message: &str) -> ProviderError {
    let mut error = ProviderError::new(ErrorKind::Unknown, DeliveryState::Accepted);
    error.message = format!("[grok-oauth] {message}");
    error
}

fn effort_value(entry: &Value) -> String {
    let text = match entry {
        Value::String(text) => Some(text.as_str()),
        Value::Object(map) => map.get("value").filter(|v| !v.is_null()).or_else(|| map.get("id")).and_then(Value::as_str),
        _ => None,
    };
    js_trim(text.unwrap_or("")).to_lowercase()
}

fn known_efforts(values: &[Value]) -> Vec<String> {
    let present: Vec<String> = values.iter().map(effort_value).collect();
    KNOWN_EFFORTS.iter().filter(|e| present.iter().any(|p| p == *e)).map(|e| (*e).to_owned()).collect()
}

/// The effort levels the roster row itself publishes, under any of the
/// spellings the two catalogs use.
fn declared_efforts(item: &Map<String, Value>) -> Vec<String> {
    let meta = item.get("_meta");
    let found = [
        item.get("reasoningEfforts"),
        item.get("reasoning_efforts"),
        meta.and_then(|m| m.get("reasoningEfforts")),
        meta.and_then(|m| m.get("reasoning_efforts")),
        item.get("capabilities").and_then(|c| c.get("reasoning_effort")),
    ]
    .into_iter()
    .flatten()
    .find(|v| !v.is_null());
    found.and_then(Value::as_array).map(|values| known_efforts(values)).unwrap_or_default()
}

/// The proxy's serving window wins over api.x.ai's public one; both are
/// merged under the same keys, proxy first.
fn context_window(item: &Map<String, Value>) -> Value {
    let stated = ["context_window", "context_length", "contextWindow"]
        .iter()
        .find_map(|key| item.get(*key).filter(|v| !v.is_null()))
        .map_or(0.0, to_number);
    if stated.is_finite() && stated > 0.0 && stated.fract() == 0.0 && stated < 9e15 {
        json!(stated as u64)
    } else if stated.is_finite() && stated > 0.0 {
        json!(stated)
    } else {
        json!(0)
    }
}

/// A given name wins, then the roster's own; else the id, spelled for reading.
fn display(item: &Map<String, Value>, id: &str) -> String {
    let raw = js_trim(id);
    for key in ["display", "name"] {
        let given = js_trim(item.get(key).and_then(Value::as_str).unwrap_or(""));
        if !given.is_empty() && given != raw {
            return given.to_owned();
        }
    }
    let text = GROK_PREFIX.replace_all_with(raw, |_| "Grok ".to_owned());
    let text = DATE_SUFFIX.replace_all_with(&text, |_| String::new()).replace('-', " ");
    let text = WORD_START.replace_all_with(&text, |c| c.get(0).unwrap_or("").to_uppercase());
    let text = SPACES.replace_all_with(&text, |_| " ".to_owned());
    let text = js_trim(&text);
    if text.is_empty() { raw.to_owned() } else { text.to_owned() }
}

fn is_chat(id: &str) -> bool {
    !NON_CHAT.is_match(id)
}

/// Proxy rows first (without their `created`, which only api.x.ai knows),
/// then api.x.ai rows over them, field by field; the first appearance of an
/// id fixes its position.
fn merge(proxy: Vec<Value>, api: Vec<Value>) -> Vec<Map<String, Value>> {
    let mut by_id: Map<String, Value> = Map::new();
    for item in proxy {
        let Value::Object(mut row) = item else { continue };
        let Some(id) = row.get("id").and_then(Value::as_str).filter(|id| !id.is_empty()).map(str::to_owned) else { continue };
        row.shift_remove("created");
        by_id.insert(id, Value::Object(row));
    }
    for item in api {
        let Value::Object(row) = item else { continue };
        let Some(id) = row.get("id").and_then(Value::as_str).filter(|id| !id.is_empty()).map(str::to_owned) else { continue };
        let mut merged = match by_id.get(&id) {
            Some(Value::Object(existing)) => existing.clone(),
            _ => Map::new(),
        };
        merged.extend(row);
        by_id.insert(id, Value::Object(merged));
    }
    by_id.into_iter().filter_map(|(_, row)| if let Value::Object(row) = row { Some(row) } else { None }).collect()
}

/// Marks the newest dated chat model by release date. Dates come only from
/// api.x.ai, so a proxy-only variant is never marked.
fn mark_latest(rows: &mut [Map<String, Value>]) {
    let mut best: Option<(usize, f64)> = None;
    for (index, row) in rows.iter().enumerate() {
        let id = row.get("id").and_then(Value::as_str).unwrap_or("");
        let created = row.get("created").map_or(0.0, to_number);
        if is_chat(id) && created > 0.0 && best.is_none_or(|(_, newest)| created > newest) {
            best = Some((index, created));
        }
    }
    if let Some((index, _)) = best {
        rows[index].insert("latest".into(), json!(true));
    }
}

#[async_trait]
impl ModelListing for GrokListing {
    async fn list_models(&self) -> Result<Vec<ModelRecord>, ProviderError> {
        // One credential read for both catalogs: two concurrent refreshes would
        // rotate the same refresh token twice.
        let (name, value) = self.credential.header(false).await?.ok_or_else(|| malformed("no credential"))?;
        let bearer = vec![(name, value)];
        let mut proxy_headers = bearer.clone();
        proxy_headers.extend(identity_headers(&self.client_version.get()));
        let (api, proxy) = futures::future::join(
            self.items(format!("{INFERENCE_BASE_URL}/models"), bearer),
            self.items(format!("{PROXY_BASE_URL}/models"), proxy_headers),
        )
        .await;
        // The proxy is best-effort by design; the primary catalog is not.
        let mut rows: Vec<Map<String, Value>> =
            merge(proxy.unwrap_or_default(), api?).iter().filter_map(|item| self.normalize(item)).collect();
        mark_latest(&mut rows);
        let listed: Vec<ModelRecord> = rows
            .into_iter()
            .filter(|row| row.get("id").and_then(Value::as_str).is_some_and(is_chat))
            .map(listing_row::record)
            .collect();
        // `enrichModels`, `_sanitizeGrokModels`, then the shared sanitizer.
        let enriched = self.lookup.enrich_listed(PROVIDER_ID, listed);
        let settled = enriched.into_iter().map(|record| self.settle(record)).collect();
        Ok(self.lookup.sanitize_listed(PROVIDER_ID, settled))
    }
}
