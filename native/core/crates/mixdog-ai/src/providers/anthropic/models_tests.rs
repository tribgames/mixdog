//! The model listing against `fixtures/providers/anthropic-models/cases.json`:
//! Node's real `listModels` requests and Node's own normalizers on one roster.

use std::sync::Arc;

use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ModelListing;
use mixdog_core_api::domain::provider::ProviderAdapter;
use serde_json::Value;
use serde_json::json;

use super::AnthropicAdapter;
use super::AnthropicModel;
use super::CapsLookup;
use super::Flavor;
use super::models::parse_listing;
use super::tests::FixedKey;
use super::tests::Scripted;
use super::tests::ScriptedHttp;
use super::tests::config;
use super::tests::cpu_bulk;
use super::tests::request;
use super::tests::text_message;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::Role;

/// No catalog metadata: the state Node's recorder ran in.
fn empty_catalog() -> CapsLookup {
    Arc::new(|_: &str| None)
}

#[tokio::test]
async fn a_listing_is_one_request_and_its_failure_is_the_typed_error() {
    let http = ScriptedHttp::new([Scripted::body(401, r#"{"type":"error","error":{"type":"authentication_error","message":"bad key"}}"#)]);
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
    let wire = mixdog_core_api::domain::provider::WireCodec::encode(&codec, &hi_request()).expect("encode");
    assert!(!wire.headers.iter().any(|(n, _)| n == "x-gateway-tenant"));
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

// Row normalization

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
    let catalog: CapsLookup =
        Arc::new(|id: &str| (id == "claude-opus-4-1").then(|| super::ModelCaps { context_window: Some(123_456), ..super::ModelCaps::default() }));
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
    assert_eq!(
        levels("claude-x", json!({ "supported": true, "high": { "supported": true }, "low": true, "max": { "supported": false }, "default": "high" })).0,
        ["low", "high"]
    );
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
