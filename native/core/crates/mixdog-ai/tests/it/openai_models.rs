//! `ModelListing` of the OpenAI routes against Node's own catalog code run with
//! a stubbed fetch (`oracles/openai-models-golden.json`): the request, and every
//! row as `_normalizeCodexModel` reads it.

#![allow(clippy::disallowed_methods, reason = "test-only: reads a recorded fixture synchronously")]

use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_ai::catalog::ListingLookup;
use mixdog_ai::providers::openai::adapter::Attempt;
use mixdog_ai::providers::openai::adapter::Credential;
use mixdog_ai::providers::openai::adapter::CredentialSource;
use mixdog_ai::providers::openai::codec::OpenAiCodec;
use mixdog_ai::providers::openai::config::CodexIdentity;
use mixdog_ai::providers::openai::config::NoFacts;
use mixdog_ai::providers::openai::config::OpenAiConfig;
use mixdog_ai::providers::openai::config::WireContext;
use mixdog_ai::providers::openai::models::OpenAiModels;
use mixdog_ai::transport::BodyStream;
use mixdog_ai::transport::HttpResponse;
use mixdog_ai::transport::HttpSend;
use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ModelListing;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_core_api::domain::provider::WireRequest;
use serde_json::Value;
use serde_json::json;

struct Ctx;
impl WireContext for Ctx {
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

struct OneChunk(Option<Bytes>);

#[async_trait]
impl BodyStream for OneChunk {
    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        self.0.take().map(Ok)
    }
}

struct Endpoint {
    status: u16,
    body: Vec<u8>,
    seen: Mutex<Vec<WireRequest>>,
    /// The head window each request was handed and the words its expiry reads as.
    windows: Mutex<Vec<(Option<std::time::Duration>, Option<String>)>>,
}

#[async_trait]
impl HttpSend for Endpoint {
    async fn send(&self, request: WireRequest, exchange: mixdog_ai::transport::Exchange) -> Result<HttpResponse, ProviderError> {
        let window = exchange.liveness.head_deadline();
        self.windows.lock().unwrap().push((window, window.and_then(|wait| exchange.surface.timeout_text(wait))));
        self.seen.lock().unwrap().push(request);
        Ok(HttpResponse { status: self.status, headers: vec![], body: Box::new(OneChunk(Some(Bytes::from(self.body.clone())))) })
    }
}

struct Creds(Credential);

#[async_trait]
impl CredentialSource for Creds {
    async fn current(&self) -> Result<Attempt, ProviderError> {
        Ok(self.0.clone().into())
    }
    async fn after_rejection(&self, _: &Attempt) -> Result<Option<Attempt>, ProviderError> {
        Ok(None)
    }
}

fn listing(codex: bool, status: u16, body: Vec<u8>) -> (OpenAiModels, Arc<Endpoint>) {
    let config = if codex {
        let identity = CodexIdentity { installation_id: "i".into(), user_agent: "ua".into(), version: "0.166.0".into(), beta_features: "b".into() };
        OpenAiConfig::codex(false, identity, Arc::new(NoFacts), Arc::new(Ctx))
    } else {
        OpenAiConfig::api_key(true, Arc::new(NoFacts), Arc::new(Ctx))
    };
    let endpoint = Arc::new(Endpoint { status, body, seen: Mutex::new(Vec::new()), windows: Mutex::new(Vec::new()) });
    let credential = if codex {
        Credential { bearer: "tok-1".into(), account_id: Some("acct-1".into()) }
    } else {
        Credential { bearer: "sk-test".into(), account_id: None }
    };
    let models = OpenAiModels::new(OpenAiCodec::new(config, TransportKind::Http1), endpoint.clone(), Arc::new(Creds(credential)), ListingLookup::new());
    (models, endpoint)
}

#[tokio::test]
async fn a_failed_list_is_a_typed_error_never_an_empty_list() {
    for codex in [true, false] {
        let (models, _) = listing(codex, 429, br#"{"error":{"code":"rate_limit_exceeded"}}"#.to_vec());
        assert_eq!(models.list_models().await.unwrap_err().kind, ErrorKind::RateLimited);
        let (models, _) = listing(codex, 401, br#"{"error":{"code":"invalid_api_key"}}"#.to_vec());
        assert_eq!(models.list_models().await.unwrap_err().kind, ErrorKind::Auth);
        let (models, _) = listing(codex, 200, b"<html>".to_vec());
        assert!(models.list_models().await.is_err());
    }
}

#[tokio::test]
async fn a_catalog_read_hands_its_transport_ten_seconds_read_as_the_timeout_signal_on_both_routes() {
    for (codex, body) in [(false, br#"{"data":[]}"#.to_vec()), (true, br#"{"models":[]}"#.to_vec())] {
        let (models, endpoint) = listing(codex, 200, body);
        models.list_models().await.unwrap();
        assert_eq!(
            *endpoint.windows.lock().unwrap(),
            [(Some(std::time::Duration::from_secs(10)), Some(mixdog_ai::transport::SIGNAL_TIMED_OUT.to_owned()))],
            "codex route: {codex}"
        );
    }
}

#[tokio::test]
async fn each_route_ends_as_node_s_listing_does() {
    // `openai` sanitizes after enriching (openai-ws.mjs:312); `openai-oauth`
    // enriches only (openai-oauth-catalog.mjs:137), so a row the sanitizer
    // would drop stays on the Codex list.
    let (api, _) = listing(false, 200, br#"{"data":[{"id":"gpt-5.5","created":1},{"id":"text-embedding-3-small","created":2}]}"#.to_vec());
    let ids: Vec<String> = api.list_models().await.unwrap().into_iter().map(|r| r.id).collect();
    assert_eq!(ids, ["gpt-5.5"]);

    let (codex, _) = listing(true, 200, br#"{"models":[{"slug":"gpt-5.5"},{"slug":"text-embedding-3-small"}]}"#.to_vec());
    let ids: Vec<String> = codex.list_models().await.unwrap().into_iter().map(|r| r.id).collect();
    assert_eq!(ids, ["gpt-5.5", "text-embedding-3-small"]);
}

#[tokio::test]
async fn the_codex_list_asks_the_models_endpoint_for_the_clients_version_and_reads_each_row() {
    let rows = json!([
        {
            "slug": "gpt-5.5", "display_name": "GPT-5.5", "description": "The frontier model", "default_service_tier": "priority",
            "supports_reasoning_effort_updates": true, "context_window": 272000, "max_context_window": 272000, "max_output_tokens": 128000,
            "supported_reasoning_levels": [{"effort": "low"}, {"effort": "high"}], "default_reasoning_level": "low",
            "service_tiers": [{"id": "priority", "name": "Fast", "description": "Faster, at a higher rate"}],
            "additional_speed_tiers": ["fast"]
        },
        {"slug": "gpt-5.1", "context_window": 100000},
        {"slug": "gpt-5.6-sol", "max_context_window": 500000, "visibility": "hide"},
        {"id": "gpt-5.4-mini", "available_access_programs": {"cyber": ["trusted"]}},
        {"display_name": "a row that names no model"}
    ]);
    let (models, endpoint) = listing(true, 200, serde_json::to_vec(&json!({"models": rows})).unwrap());
    let records = models.list_models().await.unwrap();

    let request = endpoint.seen.lock().unwrap()[0].clone();
    assert_eq!((request.method.as_str(), request.url.as_str()), ("GET", "https://chatgpt.com/backend-api/codex/models?client_version=0.166.0"));
    let headers: Vec<(&str, &str)> = request.headers.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    assert_eq!(
        headers,
        [("Authorization", "Bearer tok-1"), ("OpenAI-Beta", "responses=experimental"), ("originator", "codex_cli_rs"), ("chatgpt-account-id", "acct-1")]
    );

    let ids: Vec<&str> = records.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(ids, ["gpt-5.5", "gpt-5.1", "gpt-5.6-sol", "gpt-5.4-mini"], "a row naming no model is left out");
    let frontier = &records[0];
    assert_eq!((frontier.display_name.as_deref(), frontier.name.as_deref()), (Some("GPT-5.5"), Some("GPT-5.5")));
    assert_eq!(frontier.picker.tier.as_deref(), Some("version"));
    assert_eq!(frontier.picker.description.as_deref(), Some("The frontier model"));
    assert_eq!(frontier.picker.default_service_tier.as_deref(), Some("priority"));
    assert_eq!(frontier.supports_reasoning_effort_updates, Some(true));
    assert_eq!((frontier.context_window, frontier.max_context_window, frontier.max_output_tokens), (Some(272000), Some(272000), Some(128000)));
    assert_eq!(frontier.reasoning_levels, ["low", "high"]);
    assert_eq!(frontier.default_reasoning_level.as_deref(), Some("low"));
    let options: Vec<(&str, &[String])> = frontier.picker.reasoning_options.iter().map(|o| (o.kind.as_str(), o.values.as_slice())).collect();
    assert_eq!(options, [("effort", &["low".to_owned(), "high".to_owned()][..])], "the row's own effort levels survive enrichment");
    let tiers: Vec<(&str, &str, &str)> = frontier.picker.service_tiers.iter().map(|t| (t.id.as_str(), t.name.as_str(), t.description.as_str())).collect();
    assert_eq!(tiers, [("priority", "Fast", "Faster, at a higher rate")]);
    assert_eq!(frontier.picker.additional_speed_tiers, ["fast"]);
    assert_eq!(frontier.picker.access_programs, None);
    assert!(!frontier.hidden);
    assert_eq!(frontier.raw.as_ref(), Some(&rows[0]), "the row verbatim");

    // The newest of each family is the latest one: 5.6 over 5.1, and a family's only model is its own latest.
    let latest: Vec<bool> = records.iter().map(|r| r.picker.latest).collect();
    assert_eq!(latest, [true, false, true, true]);
    // A row the catalog hides, and one that exists only as another program's variant, are hidden; a validated 1M model is raised to it.
    assert!(records[2].hidden && records[3].hidden);
    assert_eq!((records[2].context_window, records[2].max_context_window, records[2].max_output_tokens), (Some(500000), Some(1_000_000), Some(32768)));
}

#[tokio::test]
async fn the_api_key_list_asks_the_public_endpoint_and_keeps_each_row_named_by_its_id() {
    let rows = json!([{"id": "gpt-5.5", "object": "model", "created": 1700000000}, {"id": "gpt-5.4", "object": "model", "created": 1690000000}]);
    let (models, endpoint) = listing(false, 200, serde_json::to_vec(&json!({"data": rows})).unwrap());
    let records = models.list_models().await.unwrap();

    let request = endpoint.seen.lock().unwrap()[0].clone();
    assert_eq!((request.method.as_str(), request.url.as_str()), ("GET", "https://api.openai.com/v1/models"));
    assert_eq!(request.headers, [("Authorization".to_owned(), "Bearer sk-test".to_owned())]);
    assert_eq!(records.len(), 2);
    for (record, row) in records.iter().zip(rows.as_array().unwrap()) {
        assert_eq!(record.id, row["id"].as_str().unwrap());
        assert_eq!(record.display_name, None, "a public row has a name but no display name");
        assert_eq!(record.name.as_deref(), row["id"].as_str());
        assert_eq!(record.created, row["created"].as_i64(), "the release stamp is a field of the record");
        assert_eq!(record.context_window, None, "the public list does not say a window");
        assert_eq!(record.raw.as_ref(), Some(row), "the row verbatim");
    }
}

#[test]
fn the_max_context_window_is_the_reported_whole_number_raised_to_a_million_for_a_validated_model() {
    use mixdog_ai::providers::openai::models::codex_record;
    let cases: [(&str, Value, Option<u64>); 10] = [
        ("gpt-5.5", json!(272000), Some(272000)),
        ("gpt-5.5", json!(272000.9), Some(272000)),
        ("gpt-5.5", json!(0), None),
        ("gpt-5.5", json!(-5), None),
        ("gpt-5.5", Value::Null, None),
        ("gpt-5.6-sol", json!(272000), Some(1_000_000)),
        ("gpt-5.6-sol", Value::Null, Some(1_000_000)),
        ("GPT-5.6-Terra", json!(1_500_000), Some(1_500_000)),
        ("gpt-5.6-luna", json!(0), Some(1_000_000)),
        ("gpt-5.6-lunar", json!(272000), Some(272000)),
    ];
    for (id, reported, want) in cases {
        let record = codex_record(&json!({"slug": id, "max_context_window": reported})).unwrap();
        assert_eq!(record.max_context_window, want, "{id} reported {reported}");
    }
}
