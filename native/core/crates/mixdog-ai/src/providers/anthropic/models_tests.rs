//! The model listing against `fixtures/providers/anthropic-models/cases.json`:
//! Node's real `listModels` requests and Node's own normalizers on one roster.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ModelListing;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ReasoningOption;
use serde_json::Value;
use serde_json::json;

use super::AnthropicAdapter;
use super::AnthropicModel;
use super::Flavor;
use super::CapsLookup;
use super::ModelCaps;
use super::models::parse_listing;
use super::tests::FixedKey;
use super::tests::MemoryStore;
use super::tests::Scripted;
use super::tests::ScriptedHttp;
use super::tests::config;
use super::tests::cpu_bulk;
use super::tests::oauth_adapter;
use super::tests::request;
use super::tests::text_message;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::Role;

#[allow(clippy::disallowed_methods, reason = "test-only read of a checked-in fixture file")]
fn recording() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/providers/anthropic-models/cases.json");
    let text = std::fs::read_to_string(path).expect("recorded cases");
    serde_json::from_str(&text).expect("json")
}

fn roster_body(recording: &Value) -> Vec<u8> {
    serde_json::to_vec(&json!({ "data": recording["roster"], "has_more": false })).expect("json")
}

fn headers_of(request: &mixdog_core_api::domain::provider::WireRequest) -> BTreeMap<String, String> {
    request.headers.iter().map(|(k, v)| (k.to_lowercase(), v.clone())).collect()
}

fn recorded_headers(request: &Value) -> BTreeMap<String, String> {
    request["headers"]
        .as_object()
        .expect("headers")
        .iter()
        .map(|(k, v)| (k.clone(), v.as_str().expect("header").to_owned()))
        .collect()
}

/// No catalog metadata: the state Node's recorder ran in.
fn empty_catalog() -> CapsLookup {
    Arc::new(|_: &str| None)
}

fn check_rows(flavor: Flavor, route: &str) {
    let recording = recording();
    let models = parse_listing(&roster_body(&recording), flavor, &empty_catalog()).expect("listing");
    let roster = recording["roster"].as_array().expect("roster");
    let expected: Vec<(&Value, &Value)> = roster
        .iter()
        .zip(recording["expected"][route].as_array().expect("expected"))
        .filter(|(_, row)| !row.is_null())
        .collect();
    assert_eq!(models.len(), expected.len(), "{route}: rows the normalizer drops");
    for (model, (raw, node)) in models.iter().zip(expected) {
        let id = node["id"].as_str().expect("id");
        assert_eq!(model.id, id);
        assert_eq!(model.display, node["display"].as_str().expect("display"), "{id} display");
        assert_eq!(model.family, node["family"].as_str().expect("family"), "{id} family");
        assert_eq!(model.provider, node["provider"].as_str().expect("provider"), "{id} provider");
        let tier = match model.tier {
            super::Tier::Dated => "dated",
            super::Tier::Version => "version",
            super::Tier::Family => "family",
        };
        assert_eq!(tier, node["tier"].as_str().expect("tier"), "{id} tier");
        assert_eq!(model.latest, node["latest"].as_bool().expect("latest"), "{id} latest");
        assert_eq!(model.output_tokens, node["outputTokens"].as_u64(), "{id} output tokens");
        assert_eq!(model.supports_reasoning, node["supportsReasoning"].as_bool().expect("reasoning"), "{id}");
        assert_eq!(model.release_date.as_deref(), node.get("releaseDate").and_then(Value::as_str), "{id} release date");
        // Stated, else (no catalog here) the release-generation default.
        assert_eq!(Some(model.context_window), node["contextWindow"].as_u64(), "{id} context window");
        let options: Vec<ReasoningOption> = serde_json::from_value(node["reasoningOptions"].clone()).expect("options");
        assert_eq!(model.reasoning_options(), options, "{id} reasoning options");
        let types = node.get("thinkingTypes");
        assert_eq!(model.thinking_adaptive, types.and_then(|t| t["adaptive"].as_bool()), "{id} adaptive");
        assert_eq!(model.thinking_enabled, types.and_then(|t| t["enabled"].as_bool()), "{id} enabled");
        assert_eq!(&model.raw, raw, "{id} raw row");
    }
}

#[test]
fn api_key_rows_normalize_like_node() {
    check_rows(Flavor::ApiKey, "anthropic");
}

#[test]
fn subscription_rows_normalize_like_node() {
    check_rows(Flavor::OAuth, "anthropic-oauth");
}

#[test]
fn only_the_subscription_route_derives_release_dates_and_latest() {
    let recording = recording();
    let body = roster_body(&recording);
    let api = parse_listing(&body, Flavor::ApiKey, &empty_catalog()).expect("api");
    assert!(api.iter().all(|m| m.release_date.is_none() && !m.latest));
    let oauth = parse_listing(&body, Flavor::OAuth, &empty_catalog()).expect("oauth");
    let dates: Vec<_> = oauth.iter().filter_map(|m| m.release_date.as_deref()).collect();
    assert!(dates.contains(&"2025-05-14"), "{dates:?}");
    assert!(oauth.iter().any(|m| m.latest));
}

async fn listed_request(adapter: AnthropicAdapter, http: &ScriptedHttp) -> mixdog_core_api::domain::provider::WireRequest {
    adapter.list_models().await.expect("listing");
    http.sent().remove(0)
}

fn serve(recording: &Value) -> Arc<ScriptedHttp> {
    ScriptedHttp::new([Scripted::body(200, &String::from_utf8(roster_body(recording)).expect("utf8"))])
}

#[tokio::test]
async fn the_api_key_listing_request_equals_the_recording() {
    let recording = recording();
    for (name, base) in [("anthropic", "https://gateway.example.invalid/"), ("anthropic-default-base", "https://api.anthropic.com")] {
        let http = serve(&recording);
        let adapter = AnthropicAdapter::api_key(config(base), http.clone(), Arc::new(FixedKey), cpu_bulk());
        let sent = listed_request(adapter, &http).await;
        let node = &recording["requests"][name][0];
        assert_eq!(sent.method, node["method"].as_str().expect("method"), "{name}");
        assert_eq!(sent.url, node["url"].as_str().expect("url"), "{name}");
        assert_eq!(headers_of(&sent), recorded_headers(node), "{name}");
        assert!(sent.body.is_empty());
    }
}

#[tokio::test]
async fn the_subscription_listing_request_equals_the_recording() {
    let recording = recording();
    let http = serve(&recording);
    // The store owns the temp credential directory: it must outlive the call.
    let store = MemoryStore::signed_in();
    let adapter = oauth_adapter(http.clone(), store.clone());
    let sent = listed_request(adapter, &http).await;
    drop(store);
    let node = &recording["requests"]["anthropic-oauth"][0];
    assert_eq!(sent.method, node["method"].as_str().expect("method"));
    assert_eq!(sent.url, node["url"].as_str().expect("url"));
    assert_eq!(headers_of(&sent), recorded_headers(node));
}

#[tokio::test]
async fn a_listing_is_one_request_and_its_failure_is_the_typed_error() {
    let http = ScriptedHttp::new([Scripted::body(
        401,
        r#"{"type":"error","error":{"type":"authentication_error","message":"bad key"}}"#,
    )]);
    let adapter = AnthropicAdapter::api_key(config("https://api.anthropic.com"), http.clone(), Arc::new(FixedKey), cpu_bulk());
    let err = adapter.list_models().await.expect_err("401 surfaces");
    assert_eq!(err.kind, ErrorKind::Auth);
    assert_eq!(http.sent().len(), 1, "no retry, no replay");
    assert!(adapter.models().is_some());
}

#[test]
fn the_catalog_window_beats_the_default_and_the_row_beats_the_catalog() {
    let recording = recording();
    let catalog: CapsLookup = Arc::new(|_: &str| Some(ModelCaps { context_window: Some(123_456), ..ModelCaps::default() }));
    let models = parse_listing(&roster_body(&recording), Flavor::OAuth, &catalog).expect("listing");
    let window = |id: &str| models.iter().find(|m| m.id == id).expect(id).context_window;
    // `claude-opus-4-7` states none: the catalog's window, not the 1M default.
    assert_eq!(window("claude-opus-4-7"), 123_456);
    // `claude-opus-5` states 1M itself.
    assert_eq!(window("claude-opus-5"), 1_000_000);
}

#[tokio::test]
async fn configured_extra_headers_ride_the_listing_and_the_messages_send() {
    let recording = recording();
    let extra: Vec<(String, String)> = recorded_headers(&recording["requests"]["anthropic-extra-headers"][0])
        .into_iter()
        .filter(|(name, _)| name != "anthropic-version" && name != "x-api-key")
        .chain([
            ("anthropic-version".to_owned(), "2099-01-01".to_owned()),
            ("x-api-key".to_owned(), "extra-key".to_owned()),
        ])
        .collect();
    let mut cfg = config("https://gateway.example.invalid");
    cfg.extra_headers = extra;
    // The listing: extras replace the default version and key; no beta of its own, so theirs goes out.
    let http = serve(&recording);
    let adapter = AnthropicAdapter::api_key(cfg.clone(), http.clone(), Arc::new(FixedKey), cpu_bulk());
    let sent = listed_request(adapter, &http).await;
    let node = &recording["requests"]["anthropic-extra-headers"][0];
    assert_eq!(headers_of(&sent), recorded_headers(node));
    // The messages send: extras replace version and key; the request's own betas win over the extra beta.
    let http = ScriptedHttp::new([Scripted::body(
        200,
        "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"m\",\"usage\":{\"input_tokens\":1}}}\n\n",
    )]);
    let adapter = AnthropicAdapter::api_key(cfg, http.clone(), Arc::new(FixedKey), cpu_bulk());
    let request = Arc::new(hi_request());
    let _ = adapter.attempt(request).await.expect("attempt");
    let sent = headers_of(&http.sent()[0]);
    let node = recording["requests"]["messages-extra-headers"]["headers"].as_object().expect("headers");
    for (name, value) in node {
        assert_eq!(sent.get(name), value.as_str().map(str::to_owned).as_ref(), "{name}");
    }
}

#[test]
fn the_subscription_route_sends_no_extra_headers() {
    let mut cfg = config("https://api.anthropic.com");
    cfg.extra_headers = vec![("x-gateway-tenant".to_owned(), "t".to_owned())];
    let codec = super::AnthropicCodec::new(Flavor::OAuth, cfg);
    let wire = mixdog_core_api::domain::provider::WireCodec::encode(&codec, &hi_request())
        .expect("encode");
    assert!(!wire.headers.iter().any(|(n, _)| n == "x-gateway-tenant"));
}

#[test]
fn the_record_carries_the_picker_facts_of_the_row() {
    let recording = recording();
    let models = parse_listing(&roster_body(&recording), Flavor::OAuth, &empty_catalog()).expect("listing");
    let opus: &AnthropicModel = models.iter().find(|m| m.id == "claude-opus-5-20260101").expect("opus");
    let record = opus.to_record();
    assert_eq!(record.reasoning_levels, ["low", "medium", "high", "xhigh", "max"]);
    assert_eq!(record.supports_reasoning, Some(true));
    assert_eq!(record.context_window, Some(1_000_000));
    assert_eq!(record.max_output_tokens, Some(128_000));
    assert_eq!(opus.release_date.as_deref(), Some("2026-01-01"));
    assert_eq!(record.picker.release_date.as_deref(), Some("2026-01-01"));
    assert_eq!(
        record.picker.reasoning_options,
        [ReasoningOption { kind: "effort".into(), values: record.reasoning_levels.clone() }]
    );
}

/// The rows a route's `list_models` ends with against the recording's empty catalogs, as the fields
/// Node's `listModels` result states.
fn final_rows(rows: &[mixdog_core_api::domain::provider::ModelRecord]) -> Vec<Value> {
    rows.iter()
        .map(|r| {
            json!({
                "id": r.id,
                "display": r.display_name,
                "contextWindow": r.context_window,
                "outputTokens": r.max_output_tokens,
                "supportsReasoning": r.supports_reasoning,
                "releaseDate": r.picker.release_date,
                "reasoningOptions": r.picker.reasoning_options,
            })
        })
        .collect()
}

fn node_final_rows(recording: &Value, route: &str) -> Vec<Value> {
    let field = |row: &Value, key: &str| row.get(key).filter(|v| !v.is_null()).cloned().unwrap_or(Value::Null);
    recording["listed"][route]
        .as_array()
        .expect("listed")
        .iter()
        .map(|row| {
            json!({
                "id": row["id"],
                "display": field(row, "display"),
                "contextWindow": field(row, "contextWindow"),
                "outputTokens": field(row, "outputTokens"),
                "supportsReasoning": field(row, "supportsReasoning"),
                "releaseDate": field(row, "releaseDate"),
                "reasoningOptions": row["reasoningOptions"],
            })
        })
        .collect()
}

#[tokio::test]
async fn the_api_key_listing_ends_with_the_rows_nodes_list_models_returns() {
    let recording = recording();
    let http = serve(&recording);
    let adapter = AnthropicAdapter::api_key(config("https://api.anthropic.com"), http, Arc::new(FixedKey), cpu_bulk());
    let rows = adapter.list_models().await.expect("listing");
    assert_eq!(final_rows(&rows), node_final_rows(&recording, "anthropic"));
}

#[tokio::test]
async fn the_subscription_listing_ends_with_the_rows_nodes_list_models_returns() {
    let recording = recording();
    let http = serve(&recording);
    let store = MemoryStore::signed_in();
    let adapter = oauth_adapter(http, store.clone());
    let rows = adapter.list_models().await.expect("listing");
    drop(store);
    assert_eq!(final_rows(&rows), node_final_rows(&recording, "anthropic-oauth"));
}

fn hi_request() -> ModelRequest {
    request(vec![text_message(Role::User, "hi")], RequestOptions::default())
}
