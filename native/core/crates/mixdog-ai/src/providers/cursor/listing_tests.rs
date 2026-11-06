//! Replays what Node's `listModels` recorded (`providers/cursor-models`): the
//! same `AvailableModels` answer must give the same rows, and the same
//! request must be sent.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::WireRequest;
use serde_json::Value;

use super::AccessToken;
use super::CLIENT_VERSION_FLOOR;
use super::CursorAdapter;
use super::models::ParameterAsk;
use super::models::decode_available_models;
use super::models::resolve_selection;
use crate::providers::listing_row::testing::Replay;
use crate::providers::listing_row::testing::fixture;
use crate::providers::listing_row::testing::unhex;
use crate::transport::http::BidiOpen;
use crate::transport::http::FrameSink;
use crate::transport::http::HttpResponse;

struct Token;

#[async_trait]
impl AccessToken for Token {
    async fn access_token(&self, _force_refresh: bool) -> Result<String, ProviderError> {
        Ok("fixture-cursor-token".to_owned())
    }
}

/// Listing opens no run.
struct NoRun;

#[async_trait]
impl BidiOpen for NoRun {
    async fn open(&self, _request: WireRequest, _first: Vec<u8>) -> Result<(HttpResponse, Arc<dyn FrameSink>), ProviderError> {
        unreachable!("a listing opens no run")
    }
}

fn adapter(answer: Vec<u8>) -> (Arc<Replay>, CursorAdapter) {
    let http = Arc::new(Replay::new(move |_request: &WireRequest| (200, answer.clone())));
    let adapter = CursorAdapter::new("cursor-api", None, Some(CLIENT_VERSION_FLOOR.to_owned()), http.clone(), Arc::new(NoRun), Arc::new(Token));
    (http, adapter)
}

#[tokio::test]
async fn every_recorded_case_gives_node_rows_and_request() {
    let recorded = fixture("cursor-models/cases.json");
    for (name, case) in recorded["cases"].as_object().unwrap() {
        let (http, adapter) = adapter(unhex(case["response"].as_str().unwrap()));
        let records = adapter.models().expect("cursor lists models").list_models().await.unwrap();

        let sent = http.requests.lock().unwrap().clone();
        let want = &case["requests"][0];
        assert_eq!(sent.len(), 1, "{name}");
        assert_eq!(sent[0].method, want["method"].as_str().unwrap());
        assert!(sent[0].url.ends_with(want["path"].as_str().unwrap()), "{name}: {}", sent[0].url);
        assert_eq!(sent[0].body, unhex(want["body"].as_str().unwrap()), "{name}");
        // Every header Node sent, with the same value; the request id is fresh.
        for (key, value) in want["headers"].as_object().unwrap() {
            let sent_value = sent[0].headers.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str());
            assert_eq!(sent_value, value.as_str(), "{name}: {key}");
        }
        assert!(sent[0].headers.iter().any(|(k, _)| k == "x-request-id"));

        let expected = case["expected"].as_array().unwrap();
        assert_eq!(records.len(), expected.len(), "{name}");
        for (record, row) in records.iter().zip(expected) {
            assert_eq!(record.raw.as_ref(), Some(row), "{name}: {}", row["id"]);
            assert_eq!(record.id, row["id"].as_str().unwrap());
            assert_eq!(record.display_name.as_deref(), row["display"].as_str());
            assert_eq!(record.context_window, row["contextWindow"].as_u64());
            assert_eq!(record.supports_reasoning, row["supportsReasoning"].as_bool());
            assert_eq!(record.supports_images, row["supportsVision"].as_bool());
            assert_eq!(record.mode.as_deref(), Some("chat"));
            assert_eq!(record.default_reasoning_level.as_deref(), row["defaultEffort"].as_str());
            let strings = |key: &str| -> Vec<String> {
                row[key].as_array().into_iter().flatten().map(|v| v.as_str().unwrap().to_owned()).collect()
            };
            assert_eq!(record.reasoning_levels, strings("reasoningLevels"));
            // The picker fields: fast efforts, parameter options and each variant's route.
            assert_eq!(record.picker.fast_efforts, strings("fastEfforts"));
            assert_eq!(
                serde_json::to_value(&record.picker.model_parameter_options).unwrap(),
                row.get("modelParameterOptions").cloned().unwrap_or_else(|| serde_json::json!([])),
                "{name}: {}",
                row["id"]
            );
            assert_eq!(
                serde_json::to_value(&record.picker.parameter_variants).unwrap(),
                row.get("parameterVariants").cloned().unwrap_or_else(|| serde_json::json!([])),
                "{name}: {}",
                row["id"]
            );
            let ladder: Vec<Value> = row["reasoningOptions"].as_array().cloned().unwrap_or_default();
            assert_eq!(serde_json::to_value(&record.picker.reasoning_options).unwrap(), Value::Array(ladder));
        }
    }
}

/// What a turn sends for each requested id and ask equals what Node's
/// `_resolveCursorModel` sent: the parameterized variants, the aliases, and
/// the id-named variants chosen by suffix.
#[test]
fn every_recorded_resolution_equals_nodes() {
    let recorded = fixture("cursor-models/cases.json");
    let mut checked = 0;
    for (name, case) in recorded["cases"].as_object().unwrap() {
        let Some(resolutions) = case.get("resolutions") else { continue };
        let catalog = decode_available_models(&unhex(case["response"].as_str().unwrap())).unwrap();
        for entry in resolutions.as_array().unwrap() {
            let ask = &entry["ask"];
            let route = ask.get("modelParameters").and_then(Value::as_object);
            let got = resolve_selection(
                &catalog,
                entry["model"].as_str().unwrap(),
                &ParameterAsk {
                    effort: ask["effort"].as_str(),
                    fast: ask["fast"].as_bool().unwrap_or(false),
                    route,
                    selected_context_window: ask["selectedContextWindow"].as_u64(),
                },
            );
            let label = format!("{name}: {} {ask}", entry["model"]);
            match (got, entry.get("ok")) {
                (Ok(got), Some(want)) => {
                    assert_eq!(got.model_id, want["modelId"].as_str().unwrap(), "{label}");
                    let parameters: Vec<Value> =
                        got.parameters.iter().map(|(id, value)| serde_json::json!({"id": id, "value": value})).collect();
                    assert_eq!(Value::Array(parameters), want["parameters"], "{label}");
                    assert_eq!(got.max_mode, want["maxMode"].as_bool().unwrap_or(false), "{label}");
                }
                (Err(got), None) => assert_eq!(got.message, entry["error"].as_str().unwrap(), "{label}"),
                (got, _) => panic!("{label}: Rust {got:?}, Node {entry}"),
            }
            checked += 1;
        }
    }
    assert!(checked > 500, "the recording has the resolutions ({checked})");
}

/// What a turn sends equals Node's: the model on the chat body and the
/// `pricingModel` a pinned suffix id bills as, including `auto` against a
/// server that lists no Auto (Node sends `auto` for it).
#[test]
fn every_recorded_send_has_nodes_model_and_pricing_model() {
    let recorded = fixture("cursor-models/cases.json");
    let mut checked = 0;
    for (name, case) in recorded["cases"].as_object().unwrap() {
        let Some(sends) = case.get("sends") else { continue };
        let catalog = decode_available_models(&unhex(case["response"].as_str().unwrap())).unwrap();
        for entry in sends.as_array().unwrap() {
            let model = entry["model"].as_str().unwrap();
            let got = resolve_selection(
                &catalog,
                model,
                &ParameterAsk { effort: entry["ask"]["effort"].as_str(), ..ParameterAsk::default() },
            );
            match (got, entry.get("ok")) {
                (Ok(got), Some(want)) => {
                    assert_eq!(got.model_id, want["sentModel"].as_str().unwrap(), "{name}: {model}");
                    assert_eq!(got.pricing_model.as_deref(), want["pricingModel"].as_str(), "{name}: {model}");
                }
                (Err(got), None) => assert_eq!(got.message, entry["error"].as_str().unwrap(), "{name}: {model}"),
                (got, _) => panic!("{name}: {model}: Rust {got:?}, Node {entry}"),
            }
            checked += 1;
        }
    }
    assert!(checked > 150, "the recording has the sends ({checked})");
}

#[test]
fn a_server_without_auto_still_lists_it_first() {
    let recorded = fixture("cursor-models/cases.json");
    let case = &recorded["cases"]["no-auto-bare"];
    let catalog = decode_available_models(&unhex(case["response"].as_str().unwrap())).unwrap();
    assert!(catalog.iter().any(|m| m.id == "auto" && m.name == "Auto"));
    let auto = case["expected"].as_array().unwrap().iter().find(|row| row["id"] == "auto").expect("Node lists Auto");
    assert_eq!(auto["display"], "Auto");
}

#[tokio::test]
async fn an_answer_without_parameterized_models_is_an_error_not_a_list() {
    let (_http, adapter) = adapter(Vec::new());
    assert!(adapter.models().unwrap().list_models().await.is_err());
}
