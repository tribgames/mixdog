//! The model listing against `fixtures/providers/anthropic-models/cases.json`:
//! Node's real `listModels` requests and Node's own normalizers on one roster.

#[cfg(node_twin)]
use std::collections::BTreeMap;
#[cfg(node_twin)]
use std::path::PathBuf;
use std::sync::Arc;

use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ModelListing;
use mixdog_core_api::domain::provider::ProviderAdapter;
#[cfg(node_twin)]
use mixdog_core_api::domain::provider::ReasoningOption;
use serde_json::Value;
use serde_json::json;

use super::AnthropicAdapter;
use super::AnthropicModel;
use super::Flavor;
use super::CapsLookup;
#[cfg(node_twin)]
use super::ModelCaps;
use super::models::parse_listing;
use super::tests::FixedKey;
#[cfg(node_twin)]
use super::tests::MemoryStore;
use super::tests::Scripted;
use super::tests::ScriptedHttp;
use super::tests::config;
use super::tests::cpu_bulk;
#[cfg(node_twin)]
use super::tests::oauth_adapter;
use super::tests::request;
use super::tests::text_message;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::Role;

#[cfg(node_twin)]
fn headers_of(request: &mixdog_core_api::domain::provider::WireRequest) -> BTreeMap<String, String> {
    request.headers.iter().map(|(k, v)| (k.to_lowercase(), v.clone())).collect()
}

#[cfg(node_twin)]
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

#[cfg(node_twin)]
async fn listed_request(adapter: AnthropicAdapter, http: &ScriptedHttp) -> mixdog_core_api::domain::provider::WireRequest {
    adapter.list_models().await.expect("listing");
    http.sent().remove(0)
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
fn the_subscription_route_sends_no_extra_headers() {
    let mut cfg = config("https://api.anthropic.com");
    cfg.extra_headers = vec![("x-gateway-tenant".to_owned(), "t".to_owned())];
    let codec = super::AnthropicCodec::new(Flavor::OAuth, cfg);
    let wire = mixdog_core_api::domain::provider::WireCodec::encode(&codec, &hi_request())
        .expect("encode");
    assert!(!wire.headers.iter().any(|(n, _)| n == "x-gateway-tenant"));
}

#[cfg(node_twin)]
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

fn hi_request() -> ModelRequest {
    request(vec![text_message(Role::User, "hi")], RequestOptions::default())
}

fn listed(ids: &[&str]) -> Vec<AnthropicModel> {
    let rows: Vec<Value> = ids.iter().map(|id| json!({ "id": id })).collect();
    parse_listing(&serde_json::to_vec(&json!({ "data": rows })).unwrap(), Flavor::OAuth, &empty_catalog()).expect("listing")
}

/// `resolveAnthropicModelAfter404`: the family's newest listed id, only while the requested one is gone.
#[test]
fn a_retired_id_resolves_to_its_family_s_newest_listed_id() {
    use super::models::resolve_after_404;
    let rows = listed(&["claude-sonnet-4-5", "claude-sonnet-4-7", "claude-opus-4-7"]);
    assert_eq!(resolve_after_404(&rows, "claude-sonnet-4-6").as_deref(), Some("claude-sonnet-4-7"));
    assert_eq!(resolve_after_404(&rows, "claude-sonnet-4-7"), None, "a listed id is not substituted");
    assert_eq!(resolve_after_404(&rows, "claude-haiku-4-5"), None, "no listed model of its family");
    assert_eq!(resolve_after_404(&rows, "claude-opus-4-1").as_deref(), Some("claude-opus-4-7"));
}


#[cfg(node_twin)]
#[allow(clippy::disallowed_methods, reason = "test-only read of a checked-in fixture file")]
fn recording() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/providers/anthropic-models/cases.json");
    let text = std::fs::read_to_string(path).expect("recorded cases");
    serde_json::from_str(&text).expect("json")
}
#[cfg(node_twin)]
fn roster_body(recording: &Value) -> Vec<u8> {
    serde_json::to_vec(&json!({ "data": recording["roster"], "has_more": false })).expect("json")
}
#[cfg(node_twin)]
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
        // The typed record states what the Node row states.
        let record = model.to_record();
        assert_eq!(record.picker.tier.as_deref(), node["tier"].as_str(), "{id} record tier");
        assert_eq!(record.picker.latest, node["latest"].as_bool().expect("latest"), "{id} record latest");
        assert_eq!(record.name, None, "{id}: the Anthropic row states no `name`");
    }
}
#[cfg(node_twin)]
#[test]
fn api_key_rows_normalize_like_node() {
    check_rows(Flavor::ApiKey, "anthropic");
}
#[cfg(node_twin)]
#[test]
fn subscription_rows_normalize_like_node() {
    check_rows(Flavor::OAuth, "anthropic-oauth");
}
#[cfg(node_twin)]
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
#[cfg(node_twin)]
fn serve(recording: &Value) -> Arc<ScriptedHttp> {
    ScriptedHttp::new([Scripted::body(200, &String::from_utf8(roster_body(recording)).expect("utf8"))])
}
#[cfg(node_twin)]
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
#[cfg(node_twin)]
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
#[cfg(node_twin)]
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
#[cfg(node_twin)]
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
#[cfg(node_twin)]
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
#[cfg(node_twin)]
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
#[cfg(node_twin)]
#[tokio::test]
async fn the_api_key_listing_ends_with_the_rows_nodes_list_models_returns() {
    let recording = recording();
    let http = serve(&recording);
    let adapter = AnthropicAdapter::api_key(config("https://api.anthropic.com"), http, Arc::new(FixedKey), cpu_bulk());
    let rows = adapter.list_models().await.expect("listing");
    assert_eq!(final_rows(&rows), node_final_rows(&recording, "anthropic"));
}
#[cfg(node_twin)]
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

// ---------------------------------------------------------------------------
// Row normalization
// ---------------------------------------------------------------------------

fn rows_of(flavor: Flavor, rows: Value, catalog: &CapsLookup) -> Vec<AnthropicModel> {
    parse_listing(&serde_json::to_vec(&json!({ "data": rows })).unwrap(), flavor, catalog).expect("listing")
}

fn row_of<'a>(models: &'a [AnthropicModel], id: &str) -> &'a AnthropicModel {
    models.iter().find(|m| m.id == id).unwrap_or_else(|| panic!("{id}"))
}

#[test]
fn a_row_is_classified_by_the_shape_of_its_id_and_named_from_it() {
    let ids = json!([{ "id": "claude-opus-4-8" }, { "id": "claude-opus-4-8-20260101" }, { "id": "claude-sonnet-5" }, { "id": "claude-haiku" }, { "id": "other-model" }, { "name": "" }]);
    let models = rows_of(Flavor::OAuth, ids, &empty_catalog());
    assert_eq!(models.len(), 5, "a row naming no model is dropped");
    let facts = |id: &str| {
        let m = row_of(&models, id);
        (m.tier, m.family.clone(), m.display.clone())
    };
    assert_eq!(facts("claude-opus-4-8"), (super::Tier::Version, "opus".into(), "Opus 4.8".into()));
    assert_eq!(facts("claude-opus-4-8-20260101"), (super::Tier::Dated, "opus".into(), "Opus 4.8".into()));
    assert_eq!(facts("claude-sonnet-5"), (super::Tier::Version, "sonnet".into(), "Sonnet 5".into()));
    assert_eq!(facts("claude-haiku"), (super::Tier::Family, "haiku".into(), "Haiku".into()));
    assert_eq!(facts("other-model"), (super::Tier::Family, "other".into(), "Other".into()));
}

#[test]
fn only_the_subscription_route_derives_release_dates_and_marks_the_newest_alias_of_each_family() {
    let ids = json!([
        { "id": "claude-opus-4-6" }, { "id": "claude-opus-4-8" }, { "id": "claude-opus-4-8-20260101" },
        { "id": "claude-sonnet-5" }, { "id": "claude-haiku-4-5-20251001" }
    ]);
    let oauth = rows_of(Flavor::OAuth, ids.clone(), &empty_catalog());
    let latest: Vec<&str> = oauth.iter().filter(|m| m.latest).map(|m| m.id.as_str()).collect();
    assert_eq!(latest, ["claude-opus-4-8", "claude-sonnet-5"], "a dated snapshot never competes, and a family with no alias has none");
    assert_eq!(row_of(&oauth, "claude-opus-4-8-20260101").release_date.as_deref(), Some("2026-01-01"));
    assert_eq!(row_of(&oauth, "claude-haiku-4-5-20251001").release_date.as_deref(), Some("2025-10-01"));
    assert_eq!(row_of(&oauth, "claude-opus-4-8").release_date, None);
    let api = rows_of(Flavor::ApiKey, ids, &empty_catalog());
    assert!(api.iter().all(|m| m.release_date.is_none() && !m.latest));
}

#[test]
fn the_api_key_route_also_reads_the_alias_fields_a_gateway_uses_and_the_subscription_route_does_not() {
    let row = json!([{ "name": "claude-sonnet-4-6", "displayName": "Sonnet", "input_token_limit": 150000, "output_token_limit": 9000 }]);
    let api = &rows_of(Flavor::ApiKey, row.clone(), &empty_catalog())[0];
    assert_eq!((api.id.as_str(), api.display.as_str(), api.context_window, api.output_tokens), ("claude-sonnet-4-6", "Sonnet", 150_000, Some(9000)));
    let oauth = &rows_of(Flavor::OAuth, row, &empty_catalog())[0];
    assert_eq!((oauth.display.as_str(), oauth.context_window, oauth.output_tokens), ("Sonnet 4.6", 1_000_000, None));
}

#[test]
fn the_context_window_is_what_the_row_states_then_the_catalog_then_the_generations_default() {
    let catalog: CapsLookup = Arc::new(|id: &str| (id == "claude-opus-4-1").then(|| super::ModelCaps { context_window: Some(123_456), ..super::ModelCaps::default() }));
    let rows = json!([
        { "id": "claude-opus-4-1" }, { "id": "claude-opus-4-1-20250805", "max_input_tokens": 321 }, { "id": "claude-sonnet-4-5" },
        { "id": "claude-sonnet-4-6" }, { "id": "claude-opus-4-8" }, { "id": "claude-opus-5" }, { "id": "claude-haiku-4-5" }
    ]);
    let models = rows_of(Flavor::OAuth, rows, &catalog);
    let window = |id: &str| row_of(&models, id).context_window;
    assert_eq!(window("claude-opus-4-1"), 123_456, "the catalog beats the default");
    assert_eq!(window("claude-opus-4-1-20250805"), 321, "the row beats everything");
    assert_eq!(window("claude-sonnet-4-5"), 200_000);
    for long in ["claude-sonnet-4-6", "claude-opus-4-8", "claude-opus-5"] {
        assert_eq!(window(long), 1_000_000, "{long}");
    }
    assert_eq!(window("claude-haiku-4-5"), 200_000);
}

#[test]
fn effort_levels_come_from_the_rows_map_or_from_the_generation_when_the_row_says_only_supported() {
    let levels = |id: &str, effort: Value| {
        let rows = json!([{ "id": id, "capabilities": { "effort": effort } }]);
        let model = rows_of(Flavor::OAuth, rows, &empty_catalog()).remove(0);
        (model.effort_levels.clone(), model.supports_reasoning)
    };
    // An enumerated map is the truth: listed levels only, in display order, flags are not levels.
    assert_eq!(levels("claude-x", json!({ "supported": true, "high": { "supported": true }, "low": true, "max": { "supported": false }, "default": "high" })).0, ["low", "high"]);
    let (listed, reasoning) = levels("claude-x", json!({ "none": { "supported": true }, "xhigh": { "supported": true }, "low": { "supported": true } }));
    assert_eq!(listed, ["none", "low", "xhigh"]);
    assert!(reasoning);
    // Blanket support takes the ladder the id's generation allows.
    assert_eq!(levels("claude-sonnet-4-1", json!(true)).0, ["low", "medium", "high"]);
    assert_eq!(levels("claude-opus-4-5", json!({ "supported": true })).0, ["low", "medium", "high", "max"]);
    assert_eq!(levels("claude-opus-4-7", json!(true)).0, ["low", "medium", "high", "xhigh", "max"]);
    assert_eq!(levels("claude-opus-4-7", json!({ "supported": false })), (Vec::new(), false));
    assert_eq!(levels("claude-opus-4-7", json!([])), (Vec::new(), false));
    assert_eq!(levels("claude-opus-4-7", json!(false)), (Vec::new(), false));
}

#[test]
fn thinking_types_are_read_as_declared_and_make_a_model_a_reasoning_model_without_effort() {
    let rows = json!([
        { "id": "claude-a", "capabilities": { "thinking": { "supported": true, "types": { "adaptive": { "supported": true }, "enabled": false } } } },
        { "id": "claude-b", "capabilities": { "thinking": true } },
        { "id": "claude-c" }
    ]);
    let models = rows_of(Flavor::OAuth, rows, &empty_catalog());
    let a = row_of(&models, "claude-a");
    assert_eq!((a.thinking_adaptive, a.thinking_enabled, a.supports_reasoning), (Some(true), Some(false), true));
    let b = row_of(&models, "claude-b");
    assert_eq!((b.thinking_adaptive, b.thinking_enabled, b.supports_reasoning), (None, None, true));
    let c = row_of(&models, "claude-c");
    assert_eq!((c.thinking_adaptive, c.supports_reasoning), (None, false));
}

#[test]
fn a_record_states_the_picker_facts_of_a_dated_effort_row() {
    let rows = json!([{ "id": "claude-opus-5-20260101", "display_name": "Opus Five", "max_tokens": 128000, "max_input_tokens": 1000000, "capabilities": { "effort": { "supported": true } } }]);
    let model = rows_of(Flavor::OAuth, rows, &empty_catalog()).remove(0);
    let record = model.to_record();
    assert_eq!(record.display_name.as_deref(), Some("Opus Five"));
    assert_eq!(record.reasoning_levels, ["low", "medium", "high", "xhigh", "max"]);
    assert_eq!(record.supports_reasoning, Some(true));
    assert_eq!((record.context_window, record.max_output_tokens), (Some(1_000_000), Some(128_000)));
    assert_eq!(record.picker.release_date.as_deref(), Some("2026-01-01"));
    assert_eq!(record.picker.tier.as_deref(), Some("dated"));
    assert_eq!(record.picker.reasoning_options.len(), 1);
    assert_eq!(record.picker.reasoning_options[0].values, record.reasoning_levels);
    assert_eq!(record.raw.as_ref(), Some(&model.raw));
    let plain = rows_of(Flavor::OAuth, json!([{ "id": "claude-x" }]), &empty_catalog()).remove(0).to_record();
    assert!(plain.picker.reasoning_options.is_empty(), "a model with no effort has no picker option");
    assert!(plain.efforts_stated);
}

#[test]
fn the_listing_url_is_the_api_key_routes_own_base_and_always_anthropics_for_the_subscription() {
    let mut cfg = config("https://gateway.example/");
    assert_eq!(super::models::listing_url(Flavor::ApiKey, &cfg), "https://gateway.example/v1/models");
    cfg.base_url = "http://127.0.0.1:9".into();
    assert_eq!(super::models::listing_url(Flavor::ApiKey, &cfg), "http://127.0.0.1:9/v1/models");
    assert_eq!(super::models::listing_url(Flavor::OAuth, &cfg), "https://api.anthropic.com/v1/models");
}
