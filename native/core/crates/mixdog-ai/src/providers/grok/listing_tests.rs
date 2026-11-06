//! Replays what Node's `listModels` recorded (`providers/grok-models`): the
//! same scripted answers of the two catalogs must give the same rows.

use std::sync::Arc;

use mixdog_core_api::domain::provider::ModelListing;
use mixdog_core_api::domain::provider::ModelRecord;
use mixdog_core_api::domain::provider::ReasoningOption;
use mixdog_core_api::domain::provider::WireRequest;
use serde_json::Value;

use super::listing::GrokListing;
use crate::catalog::ListingLookup;
use super::listing::SeedEffortRule;
use crate::providers::connect::rewrite::StaticCredential;
use crate::providers::listing_row::testing::Replay;
use crate::providers::listing_row::testing::fixture;

const VERSION: &str = "1.0.70";

/// The recorded answer of one catalog.
fn answer(script: &Value, side: &str) -> (u16, Vec<u8>) {
    if let Some(status) = script.get(format!("{side}Status")).and_then(Value::as_u64) {
        return (status as u16, b"{}".to_vec());
    }
    let body = match script.get(format!("{side}Body")) {
        Some(body) => body.clone(),
        None => serde_json::json!({ "data": script.get(side).cloned().unwrap_or_else(|| serde_json::json!([])) }),
    };
    (200, serde_json::to_vec(&body).unwrap())
}

fn side_of(request: &WireRequest) -> &'static str {
    if request.url == "https://api.x.ai/v1/models" { "api" } else { "proxy" }
}

fn listing(script: Value) -> (Arc<Replay>, GrokListing) {
    let http = Arc::new(Replay::new(move |request: &WireRequest| answer(&script, side_of(request))));
    let credential = StaticCredential(Some(("authorization".to_owned(), "Bearer fixture-grok-access".to_owned())));
    let listing = GrokListing::new(
        http.clone(),
        Arc::new(credential),
        super::codec(VERSION),
        VERSION.to_owned(),
        Arc::new(SeedEffortRule),
        // Empty tables: the catalog answers "not found", as in the recording.
        ListingLookup::new(),
    );
    (http, listing)
}

fn sorted_headers(headers: &[(String, String)]) -> Vec<(String, String)> {
    let mut headers: Vec<_> = headers.iter().map(|(k, v)| (k.to_lowercase(), v.clone())).collect();
    headers.sort();
    headers
}

/// After the catalog's enrichment (`_sanitizeGrokModels`): no output limit
/// survives, and the effort levels are the ladder the row now carries, in
/// canonical order, else the fallback; a model that takes none lists none.
#[test]
fn an_enriched_row_loses_its_output_limit_and_follows_its_ladder() {
    let (_http, listing) = listing(serde_json::json!({}));
    let mut enriched = ModelRecord::new("grok-4");
    enriched.max_output_tokens = Some(500_000);
    enriched.reasoning_levels = vec!["none".into()];
    enriched.picker.reasoning_options = vec![ReasoningOption { kind: "effort".into(), values: vec!["high".into(), "low".into(), "bogus".into()] }];
    let settled = listing.settle(enriched);
    assert_eq!(settled.max_output_tokens, None);
    assert_eq!(settled.reasoning_levels, ["low", "high"]);

    let bare = listing.settle(ModelRecord::new("grok-new"));
    assert_eq!(bare.reasoning_levels, ["low", "medium", "high"]);
    // A generation the xAI profile knows rejects an effort.
    assert!(listing.settle(ModelRecord::new("grok-4")).reasoning_levels.is_empty());
    assert!(listing.settle(ModelRecord::new("grok-build-fast")).reasoning_levels.is_empty());
}

#[tokio::test]
async fn every_recorded_case_gives_node_rows_and_requests() {
    let recorded = fixture("grok-models/cases.json");
    for (name, case) in recorded["cases"].as_object().unwrap() {
        let (http, listing) = listing(case["script"].clone());
        let result = listing.list_models().await;

        // Both catalogs are asked, with the headers Node sent.
        let sent = http.requests.lock().unwrap().clone();
        for expected in case["requests"].as_array().unwrap() {
            let request = sent.iter().find(|r| side_of(r) == expected["side"]).unwrap_or_else(|| panic!("{name}: {expected}"));
            assert_eq!(request.method, expected["method"].as_str().unwrap(), "{name}");
            assert_eq!(request.url, expected["url"].as_str().unwrap(), "{name}");
            let want: Vec<(String, String)> = expected["headers"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned()))
                .collect();
            assert_eq!(sorted_headers(&request.headers), sorted_headers(&want), "{name}");
        }

        if case["error"].is_string() {
            assert!(result.is_err(), "{name}: Node failed with {}", case["error"]);
            continue;
        }
        let records = result.unwrap_or_else(|e| panic!("{name}: {e:?}"));
        let expected = case["expected"].as_array().unwrap();
        assert_eq!(records.len(), expected.len(), "{name}");
        for (record, row) in records.iter().zip(expected) {
            assert_eq!(record.raw.as_ref(), Some(row), "{name}: {}", row["id"]);
            assert_eq!(record.id, row["id"].as_str().unwrap());
            assert_eq!(record.display_name.as_deref(), row["display"].as_str());
            assert_eq!(record.context_window, row["contextWindow"].as_u64().filter(|n| *n > 0));
            assert_eq!(record.created, row["created"].as_i64());
            let levels: Vec<&str> = row["reasoningLevels"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
            assert_eq!(record.reasoning_levels, levels, "{name}: {}", row["id"]);
            // The ladder a row declares is also its picker option.
            let option_values: Vec<&Value> = row["reasoningOptions"].as_array().into_iter().flatten().collect();
            assert_eq!(record.picker.reasoning_options.len(), option_values.len());
            assert_eq!(record.max_output_tokens, None);
            assert_eq!(record.supports_reasoning, None);
        }
    }
}
