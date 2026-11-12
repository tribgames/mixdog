//! Node's relay pricing cases (`fixtures/relay-pricing-cases`, `record-relay-pricing-cases.mjs`): the test's LiteLLM
//! table warmed from disk into a `CatalogService` (no models.dev table, as in the test), then each recorded call through
//! `sync_meta` (`getModelMetadataSync`), `CatalogPricing::price_usage` (`priceUsage`; `computeCostUsd` is its cost or 0)
//! and `enrich_model` over the service's lookup; every whole answer against Node's. Named cases are left out.
#![allow(clippy::disallowed_methods, reason = "fixture files")]

use std::sync::Arc;

use serde_json::Value;
use serde_json::json;

use super::CatalogService;
use super::ModelsDevSource;
use super::facts::tests::Offline;
use super::facts::tests::io;
use super::lookup::enrich_model;
use super::modelsdev_source::LITELLM_CACHE_FILE;
use super::pricing::CatalogPricing;
use super::store::CatalogSnapshot;
use crate::registry::accounting::UsagePricing;

fn fixture(name: &str) -> Value {
    let path = format!("{}/../../fixtures/relay-pricing-cases/{name}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

#[tokio::test]
async fn every_recorded_relay_price_is_nodes() {
    let golden = fixture("golden.json");
    let excluded = fixture("MANIFEST.json")["excluded"].as_object().unwrap().clone();
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join(LITELLM_CACHE_FILE), json!({ "fetchedAt": 1, "data": golden["litellm"] }).to_string()).unwrap();
    let metadata = ModelsDevSource::new(Arc::new(Offline), dir.path().to_path_buf(), io());
    let litellm = ModelsDevSource::litellm(Arc::new(Offline), dir.path().to_path_buf(), io());
    let service = Arc::new(CatalogService::cold_start(CatalogSnapshot::default(), Vec::new(), metadata).await.with_litellm(litellm).await);
    let pricing = CatalogPricing(service.clone());
    let cases = golden["cases"].as_array().unwrap();
    let mut failures = Vec::new();
    for case in cases.iter().filter(|c| !excluded.contains_key(c["case"].as_str().unwrap())) {
        let recorded = &case["recorded"];
        let mut got = serde_json::Map::new();
        if let Some(rows) = recorded.get("meta").and_then(Value::as_array) {
            let meta: Vec<Value> = rows
                .iter()
                .map(|r| {
                    let (model, provider) = (r["model"].as_str().unwrap(), r["provider"].as_str().unwrap());
                    json!({ "model": model, "provider": provider, "meta": service.sync_meta(model, provider).map_or(Value::Null, Value::Object) })
                })
                .collect();
            got.insert("meta".into(), json!(meta));
        }
        if let Some(rows) = recorded.get("cost").and_then(Value::as_array) {
            let cost: Vec<Value> = rows
                .iter()
                .map(|r| {
                    let priced = pricing.price_usage(&serde_json::from_value(r["usage"].clone()).unwrap());
                    json!({
                        "usage": r["usage"],
                        "costUsd": priced.cost_usd.unwrap_or(0.0),
                        "priced": { "input": priced.input, "costUsd": priced.cost_usd, "rates": priced.rates },
                    })
                })
                .collect();
            got.insert("cost".into(), json!(cost));
        }
        if let Some(rows) = recorded.get("rows").and_then(Value::as_array) {
            let enriched: Vec<Value> = rows.iter().map(|row| service.with_lookup(|lookup| enrich_model(lookup, row))).collect();
            let same: Vec<bool> = enriched.iter().zip(rows).map(|(e, r)| e == r).collect();
            got.insert("rows".into(), json!(rows));
            got.insert("enriched".into(), json!(enriched));
            got.insert("same".into(), json!(same));
        }
        // Numbers compare by value: Node writes 1000000 where the core holds 1000000.0.
        let (got, want) = (Value::Object(got).to_string(), recorded.to_string());
        let normalize = |text: &str| serde_json::from_str::<Value>(text).unwrap();
        if !numbers_equal(&normalize(&got), &normalize(&want)) {
            failures.push(format!("{}:\n  want {want}\n  got  {got}", case["case"]));
        }
    }
    assert!(failures.is_empty(), "{} case(s) differ:\n{}", failures.len(), failures.join("\n"));
    assert_eq!(cases.len() + excluded.len(), 9, "every case of the test file is replayed or named");
}

fn numbers_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(x, y)| numbers_equal(x, y)),
        (Value::Object(x), Value::Object(y)) => x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| numbers_equal(v, w))),
        _ => a == b,
    }
}
