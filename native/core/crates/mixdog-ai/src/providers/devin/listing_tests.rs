//! Replays what Node's `listModels` recorded (`providers/devin-models`): the
//! same `GetCliModelConfigs` answer must give the same rows, and the first
//! request must be the one Node sent.

#[cfg(node_twin)]
use std::sync::Arc;

#[cfg(node_twin)]
use async_trait::async_trait;
#[cfg(node_twin)]
use mixdog_core_api::domain::provider::ProviderAdapter;
#[cfg(node_twin)]
use mixdog_core_api::domain::provider::ProviderError;
#[cfg(node_twin)]
use mixdog_core_api::domain::provider::WireRequest;

#[cfg(node_twin)]
use super::DevinAdapter;
#[cfg(node_twin)]
use super::SessionToken;
#[cfg(node_twin)]
use super::models::ModelRow;
#[cfg(node_twin)]
use super::models::normalize_models;
#[cfg(node_twin)]
use super::schema::decode_cli_model_configs;
#[cfg(node_twin)]
use crate::providers::listing_row::testing::Replay;
#[cfg(node_twin)]
use crate::providers::listing_row::testing::assert_row_facts;
#[cfg(node_twin)]
use crate::providers::listing_row::testing::fixture;
#[cfg(node_twin)]
use crate::providers::listing_row::testing::unhex;

#[cfg(node_twin)]
struct Token;

#[cfg(node_twin)]
#[async_trait]
impl SessionToken for Token {
    async fn session_token(&self) -> Result<String, ProviderError> {
        Ok("fixture-devin-session".to_owned())
    }

    fn account(&self) -> String {
        "fixture devin account".to_owned()
    }
}

#[cfg(node_twin)]
#[tokio::test]
async fn every_recorded_case_gives_node_rows_and_request() {
    let recorded = fixture("devin-models/cases.json");
    for (name, case) in recorded["cases"].as_object().unwrap() {
        let status = case["status"].as_u64().unwrap() as u16;
        let body = case["response"].as_str().map(unhex).unwrap_or_else(|| b"{}".to_vec());
        let http = Arc::new(Replay::new(move |_request: &WireRequest| (status, body.clone())));
        let adapter = DevinAdapter::new(Some("https://devin.example.invalid".to_owned()), http.clone(), Arc::new(Token));
        let result = adapter.models().expect("devin lists models").list_models().await;

        // The first request is the one Node sent (the legacy identity is asked second, and every recorded
        // answer is the same for both).
        let sent = http.requests.lock().unwrap().clone();
        let want = &case["requests"][0];
        assert_eq!(sent[0].method, want["method"].as_str().unwrap(), "{name}");
        assert_eq!(sent[0].url, want["url"].as_str().unwrap(), "{name}");
        assert_eq!(sent[0].body, unhex(want["body"].as_str().unwrap()), "{name}");
        for (key, value) in want["headers"].as_object().unwrap() {
            let sent_value = sent[0].headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| v.as_str());
            assert_eq!(sent_value, value.as_str(), "{name}: {key}");
        }

        if !case["error"].is_null() {
            let error = result.unwrap_err();
            assert_eq!(error.status, case["error"]["status"].as_u64().map(|s| s as u16), "{name}");
            continue;
        }
        let records = result.unwrap_or_else(|e| panic!("{name}: {e:?}"));
        let expected = case["expected"].as_array().unwrap();
        assert_eq!(records.len(), expected.len(), "{name}");
        for (record, row) in records.iter().zip(expected) {
            assert_eq!(record.raw.as_ref(), Some(row), "{name}: {}", row["id"]);
            assert_row_facts(record, row, &format!("{name}: {}", row["id"]));
            assert_eq!(record.id, row["id"].as_str().unwrap());
            assert_eq!(record.display_name.as_deref(), row["display"].as_str());
            assert_eq!(record.context_window, row["contextWindow"].as_u64());
            assert_eq!(record.max_output_tokens, row["outputTokens"].as_u64());
            assert_eq!(record.supports_reasoning, row["supportsReasoning"].as_bool());
            assert_eq!(record.supports_images, row["supportsVision"].as_bool());
            assert_eq!(record.mode.as_deref(), Some("chat"));
            let levels: Vec<String> =
                row["reasoningLevels"].as_array().into_iter().flatten().map(|l| l.as_str().unwrap().to_owned()).collect();
            assert_eq!(record.reasoning_levels, levels, "{name}: {}", row["id"]);
            assert_eq!(record.default_reasoning_level.as_deref(), row["defaultEffort"].as_str(), "{name}: {}", row["id"]);
            let ladder = row.get("reasoningOptions").cloned().unwrap_or_else(|| serde_json::json!([]));
            assert_eq!(serde_json::to_value(&record.picker.reasoning_options).unwrap(), ladder, "{name}: {}", row["id"]);
        }
    }
}

/// The catalog rows a turn sends from and the wire uid of every model and
/// effort equal Node's (`devinWireUid`), for server families, the reviewed
/// table and thinking pairs.
#[cfg(node_twin)]
#[test]
fn every_recorded_effort_goes_to_nodes_wire_uid() {
    let recorded = fixture("devin-models/cases.json");
    let mut checked = 0;
    for (name, case) in recorded["cases"].as_object().unwrap() {
        let Some(wire) = case.get("wire") else { continue };
        let configs = decode_cli_model_configs(&unhex(case["response"].as_str().unwrap())).unwrap();
        let rows = normalize_models(&configs);
        let node_rows = case["rows"].as_array().unwrap();
        assert_eq!(rows.len(), node_rows.len(), "{name}");
        for (row, want) in rows.iter().zip(node_rows) {
            assert_eq!(row.id, want["id"].as_str().unwrap(), "{name}");
            assert_eq!(row.uid, want["uid"].as_str().unwrap(), "{name}: {}", row.id);
            assert_eq!(row.requires_effort, want["requiresEffort"].as_bool().unwrap(), "{name}: {}", row.id);
            assert_eq!(row.default_effort.as_deref(), want["defaultEffort"].as_str(), "{name}: {}", row.id);
            // A JS object states no order the route lookup depends on.
            let efforts: std::collections::BTreeMap<String, String> = want["effortUids"]
                .as_object()
                .into_iter()
                .flatten()
                .map(|(level, uid)| (level.clone(), uid.as_str().unwrap().to_owned()))
                .collect();
            assert_eq!(row.effort_uids.iter().cloned().collect::<std::collections::BTreeMap<_, _>>(), efforts, "{name}: {}", row.id);
        }
        for entry in wire.as_array().unwrap() {
            let model = entry["model"].as_str().unwrap();
            let row = rows.iter().find(|r| r.id == model);
            let got = ModelRow::wire_uid(row, model, entry["effort"].as_str());
            assert_eq!(got, entry["uid"].as_str().unwrap(), "{name}: {model} at {}", entry["effort"]);
            checked += 1;
        }
    }
    assert!(checked > 1000, "the recording has the routes ({checked})");
}

/// A native discovery that fails is answered by the legacy identity (`fetchDevinModels`).
#[cfg(node_twin)]
#[tokio::test]
async fn a_failed_native_discovery_falls_to_the_legacy_identity() {
    let recorded = fixture("devin-models/cases.json");
    let (_, case) = recorded["cases"]
        .as_object()
        .unwrap()
        .iter()
        .find(|(_, case)| case["error"].is_null() && case["response"].is_string() && !case["expected"].as_array().unwrap().is_empty())
        .expect("a recorded answer with rows");
    let body = unhex(case["response"].as_str().unwrap());
    let http = Arc::new(Replay::new(move |request: &WireRequest| {
        if request.body.windows(8).any(|w| w == b"windsurf") { (200, body.clone()) } else { (500, Vec::new()) }
    }));
    let adapter = DevinAdapter::new(Some("https://devin.example.invalid".to_owned()), http.clone(), Arc::new(Token));
    let records = adapter.models().expect("devin lists models").list_models().await.unwrap();
    assert_eq!(records.len(), case["expected"].as_array().unwrap().len());
    assert_eq!(http.requests.lock().unwrap().len(), 2);
}