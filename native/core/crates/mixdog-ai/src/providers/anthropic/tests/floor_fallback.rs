//! A request whose version-floor feature the model refuses, against the `fallback` scenarios of
//! `fixtures/claude-floors/golden.json` (recorded by `record-claude-floors.mjs` from the real
//! `AnthropicProvider.send`): the same requests go out (does each carry `thinking.display: "updates"` and its
//! beta), the send ends the same way, and the switch-off carries to the next send of the model.

use std::sync::Arc;

use mixdog_core_api::domain::provider::ProviderAdapter;
use serde_json::Value;

use super::*;
use crate::claude_floors;

fn reply_of(spec: &Value) -> Scripted {
    Scripted {
        status: spec["status"].as_u64().expect("status") as u16,
        headers: vec![("content-type".to_owned(), spec["contentType"].as_str().expect("content type").to_owned())],
        chunks: vec![spec["body"].as_str().expect("body").as_bytes().to_vec()],
        fault: None,
    }
}

#[tokio::test]
async fn a_refused_floor_feature_is_switched_off_and_replayed_once_as_node_does() {
    let golden: Value = serde_json::from_str(include_str!("../../../../../../fixtures/claude-floors/golden.json")).expect("fixture");
    for scenario in golden["fallback"].as_array().expect("fallback") {
        let name = scenario["name"].as_str().expect("name");
        let model = scenario["model"].as_str().expect("model");
        // What `CatalogCaps` states for an id no catalog describes: the display follows the floor.
        let mut config = AnthropicConfig::new(Arc::new(|model: &str| {
            Some(ModelCaps { thinking_display_updates: claude_floors::emits_progress_updates(model), ..sonnet_caps() })
        }));
        config.base_url = "http://127.0.0.1:1".to_owned();
        for (i, send) in scenario["sends"].as_array().expect("sends").iter().enumerate() {
            let ctx = format!("{name} #{i}");
            let http = ScriptedHttp::new(send["replies"].as_array().expect("replies").iter().map(reply_of));
            let adapter = AnthropicAdapter::api_key(config.clone(), http.clone(), Arc::new(FixedKey), cpu_bulk());
            let mut req = request(base_messages(), RequestOptions::default());
            req.model = model.into();
            let outcome = adapter.attempt(Arc::new(req)).await;
            match &send["outcome"]["error"] {
                Value::Null => assert!(outcome.is_ok(), "{ctx}: Node succeeds"),
                error => {
                    let err = outcome.err().unwrap_or_else(|| panic!("{ctx}: Node fails"));
                    assert_eq!(err.status.map(u64::from), error["status"].as_u64(), "{ctx}: status");
                }
            }
            let sent: Vec<Value> = http
                .sent()
                .iter()
                .map(|got| {
                    let body: Value = serde_json::from_slice(&got.body).expect("json body");
                    let beta = got.headers.iter().find(|h| h.0.eq_ignore_ascii_case("anthropic-beta")).map_or("", |h| h.1.as_str());
                    serde_json::json!({
                        "display": body["thinking"].get("display").cloned().unwrap_or(Value::Null),
                        "displayBeta": beta.contains("thinking-display-updates"),
                    })
                })
                .collect();
            assert_eq!(&Value::Array(sent), &send["requests"], "{ctx}: requests");
        }
    }
}
