//! `ModelListing` of `openai` and `openai-oauth`: one fetch of the provider's
//! own list, no retry, cache, timer or fallback list (the catalog owns those).
//!
//! * `openai`: `GET https://api.openai.com/v1/models` with the API key
//!   (`openai-ws.mjs listModels`); `data[].id` and the release `created`
//!   stamp, which stays in the verbatim record.
//! * `openai-oauth`: `GET <codex>/models?client_version=<v>` (`fetchCodexCatalog`),
//!   each row normalized as `_normalizeCodexModel` does (`openai-codex-model.mjs`).
//!
//! Node answers a failed fetch with an empty list or the cached one; here a
//! failure is the typed error of the response.
//!
//! Each route ends as Node's does: `openai` enriches then sanitizes
//! (`openai-ws.mjs:312`); `openai-oauth` enriches only
//! (`openai-oauth-catalog.mjs:137`), because the backend curates that list.

#![allow(clippy::result_large_err, reason = "the frozen provider error type is returned unboxed")]

use crate::transport::deadlines::OPENAI_CATALOG;
use std::sync::Arc;
use std::sync::LazyLock;

use async_trait::async_trait;
use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ModelListing;
use mixdog_core_api::domain::provider::ModelRecord;
use mixdog_core_api::domain::provider::PickerFields;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::ReasoningOption;
use mixdog_core_api::domain::provider::ServiceTier;
use mixdog_core_api::domain::provider::WireCodec;
use mixdog_core_api::domain::provider::WireRequest;
use mixdog_js::JsRegex;
use serde_json::Value;

use super::adapter::CredentialSource;
use super::codec::OpenAiCodec;
use super::config::CODEX_ORIGINATOR;
use super::config::Route;
use crate::catalog::ListingLookup;
use crate::transport::HttpSend;

const API_MODELS_URL: &str = "https://api.openai.com/v1/models";
const CODEX_MODELS_URL: &str = "https://chatgpt.com/backend-api/codex/models";
/// `outputTokens` when the catalog row names none.
const DEFAULT_OUTPUT_TOKENS: u64 = 32768;
/// The program a standard model carries; a model whose list names programs
/// but not this one exists only as another program's variant.
const STANDARD_PROGRAM: &str = "standard";

pub struct OpenAiModels {
    codec: OpenAiCodec,
    http: Arc<dyn HttpSend>,
    credentials: Arc<dyn CredentialSource>,
    /// The catalog tables the enrichment and the sanitizer read: the handle the
    /// catalog service publishes into.
    lookup: ListingLookup,
}

impl OpenAiModels {
    /// `codec` is the route's HTTP codec: it classifies a refusal.
    pub fn new(codec: OpenAiCodec, http: Arc<dyn HttpSend>, credentials: Arc<dyn CredentialSource>, lookup: ListingLookup) -> Self {
        Self { codec, http, credentials, lookup }
    }
}

fn malformed(what: &str) -> ProviderError {
    let mut err = ProviderError::new(ErrorKind::Unknown, DeliveryState::Accepted);
    err.message = format!("the model list is not {what}");
    err
}

/// A positive whole number (`_positiveCodexContextWindow`), or none.
fn positive(value: Option<&Value>) -> Option<u64> {
    let n = value?.as_f64()?;
    (n.is_finite() && n >= 1.0).then(|| n.floor() as u64)
}

/// Models whose served window was validated up to 1M tokens.
const VALIDATED_1M: [&str; 3] = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];

/// `_codexMaxContextWindow`: the reported value, raised to 1M for a validated model.
fn max_context_window(id: &str, reported: Option<&Value>) -> Option<u64> {
    let reported = positive(reported);
    if VALIDATED_1M.contains(&id.to_lowercase().as_str()) { Some(reported.unwrap_or(0).max(1_000_000)) } else { reported }
}

/// `String(value || '').trim()`.
fn trimmed(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(s)) => s.trim().to_owned(),
        Some(Value::Number(n)) if n.as_f64().is_some_and(|n| n != 0.0) => n.to_string(),
        Some(Value::Bool(true)) => "true".to_owned(),
        Some(Value::Array(_)) => String::new(),
        Some(Value::Object(_)) => "[object Object]".to_owned(),
        _ => String::new(),
    }
}

/// `catalogAccessPrograms`: `available_access_programs.cyber` as strings.
fn access_programs(row: &Value) -> Option<Vec<String>> {
    let cyber = row.get("available_access_programs")?.get("cyber")?.as_array()?;
    Some(
        cyber
            .iter()
            .map(|p| match p {
                Value::String(s) => s.trim().to_owned(),
                Value::Null => String::new(),
                other => other.to_string(),
            })
            .filter(|p| !p.is_empty())
            .collect(),
    )
}

/// The picker facts of a Codex catalog row (`serviceTiers`,
/// `additionalSpeedTiers`, `accessPrograms`).
fn picker_of(row: &Value) -> PickerFields {
    let service_tiers = row
        .get("service_tiers")
        .and_then(Value::as_array)
        .map(|tiers| {
            tiers
                .iter()
                .map(|t| ServiceTier {
                    id: trimmed(t.get("id")),
                    name: trimmed(t.get("name")),
                    description: trimmed(t.get("description")),
                })
                .filter(|t| !t.id.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let additional_speed_tiers = row
        .get("additional_speed_tiers")
        .and_then(Value::as_array)
        .map(|tiers| tiers.iter().map(|t| trimmed(Some(t))).filter(|t| !t.is_empty()).collect())
        .unwrap_or_default();
    PickerFields { service_tiers, additional_speed_tiers, access_programs: access_programs(row), ..PickerFields::default() }
}

/// `_normalizeCodexModel` for one catalog row; a row naming no model is none.
pub fn codex_record(row: &Value) -> Option<ModelRecord> {
    let id = ["slug", "id"]
        .iter()
        .filter_map(|key| row.get(*key).and_then(Value::as_str))
        .find(|s| !s.is_empty())?;
    let picker = picker_of(row);
    let levels: Vec<String> = row
        .get("supported_reasoning_levels")
        .and_then(Value::as_array)
        .map(|levels| levels.iter().filter_map(|l| l.get("effort").and_then(Value::as_str).map(str::to_owned)).collect())
        .unwrap_or_default();
    let display = row.get("display_name").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or(id);
    let access_only = picker
        .access_programs
        .as_ref()
        .is_some_and(|p| !p.is_empty() && !p.iter().any(|p| p == STANDARD_PROGRAM));
    let mut record = ModelRecord::new(id);
    record.picker = picker;
    record.picker.tier = Some("version".to_owned());
    // `m?.description || ''`: the catalog's text as stated, else empty.
    record.picker.description = Some(row.get("description").and_then(Value::as_str).unwrap_or_default().to_owned());
    record.picker.default_service_tier =
        row.get("default_service_tier").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned);
    record.supports_reasoning_effort_updates = row.get("supports_reasoning_effort_updates").and_then(Value::as_bool);
    // `supportsReasoningSummaries: m?.supports_reasoning_summaries === true`: always stated.
    record.supports_reasoning_summaries = Some(row.get("supports_reasoning_summaries").and_then(Value::as_bool) == Some(true));
    record.display_name = Some(display.to_owned());
    record.name = Some(display.to_owned());
    record.context_window = positive(row.get("context_window")).or_else(|| positive(row.get("max_context_window")));
    record.max_context_window = max_context_window(id, row.get("max_context_window"));
    record.max_output_tokens = Some(
        ["max_output_tokens", "output_tokens"]
            .iter()
            .find_map(|key| row.get(*key).and_then(Value::as_f64).filter(|n| *n != 0.0))
            .map_or(DEFAULT_OUTPUT_TOKENS, |n| n as u64),
    );
    record.supports_reasoning = (!levels.is_empty()).then_some(true);
    // The route's own levels as effort options, so the catalog's never replace them.
    if !levels.is_empty() {
        record.picker.reasoning_options = vec![ReasoningOption { kind: "effort".into(), values: levels.clone() }];
    }
    record.default_reasoning_level =
        row.get("default_reasoning_level").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned);
    record.reasoning_levels = levels;
    record.hidden = row.get("visibility").and_then(Value::as_str) == Some("hide") || access_only;
    record.raw = Some(row.clone());
    Some(record)
}

/// `_codexFamily`: the group `latest` is decided in.
fn codex_family(id: &str) -> &'static str {
    let s = id.to_lowercase();
    if s.contains("nano") {
        "gpt-nano"
    } else if s.contains("mini") {
        "gpt-mini"
    } else if s.contains("codex") {
        "gpt-codex"
    } else if s.starts_with("gpt-5.5") {
        "gpt-5.5"
    } else if s.starts_with("gpt-5.4") {
        "gpt-5.4"
    } else if s.starts_with("gpt-5.2") {
        "gpt-5.2"
    } else if s.starts_with("gpt-5") {
        "gpt-5"
    } else {
        "gpt"
    }
}

static GPT_VERSION: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"gpt-(\d+)\.(\d+)", ""));

/// `[major, minor]` of `gpt-X.Y`; none when the id has no dotted version.
fn gpt_version(id: &str) -> Vec<f64> {
    GPT_VERSION.captures(id).map_or_else(Vec::new, |caps| {
        (1..=2).map(|i| caps.get(i).and_then(|part| part.parse::<f64>().ok()).unwrap_or(0.0)).collect()
    })
}

/// `_compareVersion(a, b) > 0`.
fn newer(a: &str, b: &str) -> bool {
    let (va, vb) = (gpt_version(a), gpt_version(b));
    for i in 0..va.len().max(vb.len()) {
        let (x, y) = (va.get(i).copied().unwrap_or(0.0), vb.get(i).copied().unwrap_or(0.0));
        if x != y {
            return x > y;
        }
    }
    mixdog_js::locale_compare(a, b) == std::cmp::Ordering::Greater
}

/// `_markLatestCodex`: the highest-versioned model of each family is `latest`.
fn mark_latest(rows: &mut [ModelRecord]) {
    let mut best: Vec<(&'static str, usize)> = Vec::new();
    for (at, row) in rows.iter().enumerate() {
        let family = codex_family(&row.id);
        match best.iter_mut().find(|(f, _)| *f == family) {
            Some((_, current)) if newer(&row.id, &rows[*current].id) => *current = at,
            Some(_) => {}
            None => best.push((family, at)),
        }
    }
    for (_, at) in best {
        rows[at].picker.latest = true;
    }
}

/// A public-API list row: the id and the release stamp `created` (a number
/// only), with the whole row kept. Node's row has a `name` but no `display`,
/// so the catalog may still supply the display name.
fn api_record(row: &Value) -> Option<ModelRecord> {
    let id = row.get("id").and_then(Value::as_str).filter(|s| !s.is_empty())?;
    let mut record = ModelRecord::new(id);
    record.name = Some(id.to_owned());
    record.created = row.get("created").and_then(|c| c.as_i64().or_else(|| c.as_f64().map(|n| n as i64)));
    record.raw = Some(row.clone());
    Some(record)
}

#[async_trait]
impl ModelListing for OpenAiModels {
    async fn list_models(&self) -> Result<Vec<ModelRecord>, ProviderError> {
        let credential = self.credentials.current().await?;
        let (url, headers) = match self.codec.route() {
            Route::ApiKey => (
                API_MODELS_URL.to_owned(),
                vec![("Authorization".to_owned(), format!("Bearer {}", credential.bearer))],
            ),
            Route::Codex => {
                let version = self.codec.identity().map(|i| i.version.get()).unwrap_or_default();
                (
                    format!("{CODEX_MODELS_URL}?client_version={version}"),
                    vec![
                        ("Authorization".to_owned(), format!("Bearer {}", credential.bearer)),
                        ("OpenAI-Beta".to_owned(), "responses=experimental".to_owned()),
                        ("originator".to_owned(), CODEX_ORIGINATOR.to_owned()),
                        ("chatgpt-account-id".to_owned(), credential.account_id.clone().unwrap_or_default()),
                    ],
                )
            }
        };
        let response = self
            .http
            .send(
                WireRequest {
                    transport: TransportKind::Http1,
                    method: "GET".into(),
                    url,
                    headers,
                    body: Vec::new(),
                },
                OPENAI_CATALOG,
            )
            .await?;
        let success = response.is_success();
        let read = response.read_all().await?;
        if !success {
            return Err(self.codec.classify(&read));
        }
        let document: Value = serde_json::from_slice(&read.body).map_err(|_| malformed("JSON"))?;
        match self.codec.route() {
            Route::ApiKey => {
                let rows = document.get("data").map_or(Some(&[][..]), |d| d.as_array().map(Vec::as_slice));
                let listed = rows.ok_or_else(|| malformed("a list"))?.iter().filter_map(api_record).collect();
                Ok(self.lookup.sanitize_listed("openai", self.lookup.enrich_listed("openai", listed)))
            }
            Route::Codex => {
                let rows = document.get("models").map_or(Some(&[][..]), |m| m.as_array().map(Vec::as_slice));
                let mut listed: Vec<ModelRecord> = rows.ok_or_else(|| malformed("a list"))?.iter().filter_map(codex_record).collect();
                mark_latest(&mut listed);
                Ok(self.lookup.enrich_listed("openai-oauth", listed))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// `_markLatestCodex` over these slugs, run in Node: the family and the mark of each.
    const NODE_MARKS: [(&str, &str, bool); 11] = [
        ("gpt-5.4", "gpt-5.4", true),
        ("gpt-5.5", "gpt-5.5", true),
        ("gpt-5.4-mini", "gpt-mini", false),
        ("gpt-5.5-mini", "gpt-mini", true),
        ("gpt-5.3-codex", "gpt-codex", true),
        ("gpt-5.1-codex", "gpt-codex", false),
        ("gpt-6", "gpt", false),
        ("gpt-5", "gpt-5", false),
        ("o3", "gpt", true),
        ("gpt-5.10", "gpt-5", true),
        ("gpt-5.9", "gpt-5", false),
    ];

    struct Ctx;

    impl crate::providers::openai::config::WireContext for Ctx {
        fn request_id(&self) -> String {
            "0".repeat(32)
        }
        fn now_unix_ms(&self) -> u64 {
            0
        }
        fn turn_state(&self, _: &str, _: &str) -> Option<String> {
            None
        }
    }

    struct Creds;

    #[async_trait]
    impl crate::providers::openai::adapter::CredentialSource for Creds {
        async fn current(&self) -> Result<crate::providers::openai::adapter::Credential, ProviderError> {
            Ok(crate::providers::openai::adapter::Credential { bearer: "t".into(), account_id: Some("a".into()) })
        }
        async fn after_rejection(&self, _: &crate::providers::openai::adapter::Credential) -> Result<Option<crate::providers::openai::adapter::Credential>, ProviderError> {
            Ok(None)
        }
    }

    /// The catalog that outlives its timer reads as the real Node function did (`sites.openaiCatalog`).
    #[tokio::test(start_paused = true)]
    async fn a_catalog_that_outlives_its_timer_reads_as_nodes() {
        use crate::providers::openai::config::{CodexIdentity, NoFacts, OpenAiConfig};
        use crate::transport::site_probe::{TimingOut, assert_transport};

        let identity = CodexIdentity { installation_id: "i".into(), user_agent: "ua".into(), version: "0.166.0".into(), beta_features: "b".into() };
        let config = OpenAiConfig::codex(false, false, identity, Arc::new(NoFacts), Arc::new(Ctx));
        let transport = TimingOut::new();
        let models = OpenAiModels::new(OpenAiCodec::new(config, TransportKind::Http1), transport.clone(), Arc::new(Creds), ListingLookup::new());
        models.list_models().await.expect_err("never answers");
        assert_transport("openaiCatalog", &transport);
    }

    #[test]
    fn the_newest_of_each_family_is_latest_as_nodes_pass_marks_it() {
        let mut rows: Vec<ModelRecord> = NODE_MARKS.iter().filter_map(|(id, ..)| codex_record(&json!({ "slug": id }))).collect();
        mark_latest(&mut rows);
        for (row, (id, family, latest)) in rows.iter().zip(NODE_MARKS) {
            assert_eq!(codex_family(id), family, "{id} family");
            assert_eq!(row.picker.latest, latest, "{id} latest");
        }
    }

    #[test]
    fn the_catalogs_effort_update_flag_and_default_tier_are_stated_only_when_the_row_states_them() {
        let stated = codex_record(&json!({ "slug": "m", "supports_reasoning_effort_updates": false, "default_service_tier": "priority" })).unwrap();
        assert_eq!(stated.supports_reasoning_effort_updates, Some(false));
        assert_eq!(stated.picker.default_service_tier.as_deref(), Some("priority"));
        let silent = codex_record(&json!({ "slug": "m", "supports_reasoning_effort_updates": "yes", "default_service_tier": "" })).unwrap();
        assert_eq!((silent.supports_reasoning_effort_updates, silent.picker.default_service_tier), (None, None));
    }
}
