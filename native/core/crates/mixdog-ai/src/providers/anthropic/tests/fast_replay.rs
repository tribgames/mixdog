//! A request that asks for fast speed and meets a fast-pool refusal, against
//! `fixtures/fast-replay/golden.json` (recorded by `record-fast-replay.mjs` from the real
//! `AnthropicProvider.send`): the same requests go out (does each carry `speed: "fast"` and the
//! fast-mode beta), the send ends the same way, and the fast-mode state is the same after each send.

use std::sync::Arc;

use mixdog_core_api::domain::provider::ProviderAdapter;
use serde_json::Value;

use super::*;
use crate::providers::anthropic::fast_mode::FastMode;
use crate::providers::anthropic::fast_mode::now_ms;

const MODEL: &str = "claude-opus-4-8";

fn reply_of(spec: &Value) -> Scripted {
    Scripted {
        status: spec["status"].as_u64().expect("status") as u16,
        headers: spec["headers"]
            .as_object()
            .map(|h| h.iter().map(|(k, v)| (k.clone(), v.as_str().expect("header").to_owned())).collect())
            .unwrap_or_default(),
        chunks: vec![spec["body"].as_str().expect("body").as_bytes().to_vec()],
        fault: None,
    }
}

#[tokio::test]
async fn a_fast_request_a_fast_pool_refuses_is_replayed_at_standard_speed_as_node_does() {
    let golden: Value = serde_json::from_str(include_str!("../../../../../../fixtures/fast-replay/golden.json")).expect("fixture");
    for scenario in golden["scenarios"].as_array().expect("scenarios") {
        let name = scenario["name"].as_str().expect("name");
        let fast = Arc::new(FastMode::new());
        let mut config = AnthropicConfig::new(Arc::new(|model: &str| {
            (model == MODEL).then(|| ModelCaps { fast_mode: true, ..sonnet_caps() })
        }));
        config.base_url = "http://127.0.0.1:1".to_owned();
        config.fast_mode = Arc::clone(&fast);
        for (i, send) in scenario["sends"].as_array().expect("sends").iter().enumerate() {
            let ctx = format!("{name} #{i}");
            let http = ScriptedHttp::new(send["replies"].as_array().expect("replies").iter().map(reply_of));
            let adapter = AnthropicAdapter::api_key(config.clone(), http.clone(), Arc::new(FixedKey), cpu_bulk());
            let mut req = request(base_messages(), RequestOptions { fast: send["fast"].as_bool().expect("fast"), ..RequestOptions::default() });
            req.model = MODEL.into();
            let outcome = adapter.attempt(Arc::new(req)).await;
            match (&send["outcome"]["ok"], &send["outcome"]["error"]) {
                (Value::Null, error) => {
                    let err = outcome.err().unwrap_or_else(|| panic!("{ctx}: Node fails"));
                    assert_eq!(err.status.map(u64::from), error["status"].as_u64(), "{ctx}: status");
                }
                _ => assert!(outcome.is_ok(), "{ctx}: Node succeeds"),
            }
            let sent = http.sent();
            let wanted = send["requests"].as_array().expect("requests");
            assert_eq!(sent.len(), wanted.len(), "{ctx}: POSTs");
            for (got, want) in sent.iter().zip(wanted) {
                let body: Value = serde_json::from_slice(&got.body).expect("json body");
                assert_eq!(body.get("speed").and_then(Value::as_str), want["speed"].as_str(), "{ctx}: speed");
                let beta = got.headers.iter().find(|h| h.0.eq_ignore_ascii_case("anthropic-beta")).map_or("", |h| h.1.as_str());
                assert_eq!(beta.contains("fast-mode"), want["fastBeta"].as_bool().expect("fastBeta"), "{ctx}: fast-mode beta");
            }
            let state = &send["state"];
            assert_eq!(fast.available(now_ms()), state["available"], "{ctx}: available");
            assert_eq!(fast.disabled_reason().as_deref(), state["disabledReason"].as_str(), "{ctx}: disabled reason");
            let remaining = fast.cooldown_remaining_ms(now_ms());
            match &state["cooldownSeconds"] {
                Value::String(_) => assert!(remaining.is_infinite(), "{ctx}: disabled for good"),
                seconds => assert_eq!(Some((remaining / 1000.0).round()), seconds.as_f64(), "{ctx}: cooldown seconds"),
            }
        }
    }
}
