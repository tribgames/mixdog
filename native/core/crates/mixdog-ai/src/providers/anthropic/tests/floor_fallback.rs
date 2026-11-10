//! A request whose version-floor feature the model refuses, against the `fallback` scenarios of
//! `fixtures/claude-floors/golden.json` (recorded by `record-claude-floors.mjs` from the real sends of
//! both routes, `AnthropicProvider.send` and `AnthropicOAuthProvider.send`): per send, the same requests
//! go out (path, `anthropic-beta`, whole body), the same text reaches the caller and the send ends the
//! same way; the switch-off carries to the later sends of a scenario as it does in Node's process.

use std::sync::Arc;

use mixdog_core_api::domain::provider::ProviderAdapter;
use serde_json::Value;
use serde_json::json;

use super::*;
use crate::claude_floors;
use crate::providers::anthropic::effort_tests::caps_of;
use crate::providers::anthropic::effort_tests::message_of;

fn reply_of(spec: &Value) -> Scripted {
    Scripted {
        status: spec["status"].as_u64().expect("status") as u16,
        headers: vec![("content-type".to_owned(), spec["contentType"].as_str().expect("content type").to_owned())],
        chunks: vec![spec["body"].as_str().expect("body").as_bytes().to_vec()],
        fault: None,
    }
}

/// One recorded send through the production adapter of its route: what went out, what reached the
/// caller and how it ended, in the recording's shape.
async fn send_as_node(send: &Value) -> Value {
    let model = send["model"].as_str().expect("model").to_owned();
    // The catalog's caps as Node's first request shows them (an input of the codec, as in
    // effort_tests); the display follows the floor, as `builder_env` states it.
    let caps = caps_of(&send["requests"][0]["body"])
        .map(|caps| ModelCaps { thinking_display_updates: claude_floors::emits_progress_updates(&model), ..caps });
    let mut config = AnthropicConfig::new(Arc::new(move |_: &str| caps.clone()));
    config.base_url = "https://api.anthropic.com".to_owned();
    let http = ScriptedHttp::new(send["replies"].as_array().expect("replies").iter().map(reply_of));
    let store = MemoryStore::signed_in();
    let adapter = match send["route"].as_str().expect("route") {
        "anthropic" => AnthropicAdapter::api_key(config, http.clone(), Arc::new(FixedKey), cpu_bulk()),
        "anthropic-oauth" => {
            let session = Arc::new(OAuthSession::new(store.file.clone(), http.clone()));
            AnthropicAdapter::oauth(config, http.clone(), session, false, cpu_bulk())
        }
        other => panic!("route {other}"),
    };
    let messages = send["messages"].as_array().expect("messages").iter().map(message_of).collect();
    let req = ModelRequest { model, messages, tools: Vec::new(), options: RequestOptions::default() };
    let mut emitted = Vec::new();
    let outcome = match adapter.attempt(Arc::new(req)).await {
        Err(err) => json!({ "error": { "status": err.status } }),
        Ok(mut stream) => {
            let mut failed = None;
            while let Some(next) = stream.next().await {
                match next {
                    Ok(StreamEvent::TextDelta(text)) => emitted.push(text),
                    Ok(_) => {}
                    Err(err) => {
                        failed = Some(err);
                        break;
                    }
                }
            }
            match failed {
                Some(err) => json!({ "error": { "status": err.status } }),
                None => json!({ "ok": { "content": emitted.concat() } }),
            }
        }
    };
    let requests: Vec<Value> = http
        .sent()
        .iter()
        .map(|got| {
            let url = url::Url::parse(&got.url).expect("url");
            let path = match url.query() {
                Some(query) => format!("{}?{query}", url.path()),
                None => url.path().to_owned(),
            };
            let beta = got.headers.iter().find(|h| h.0.eq_ignore_ascii_case("anthropic-beta")).map(|h| h.1.clone());
            json!({ "path": path, "betaHeader": beta, "body": serde_json::from_slice::<Value>(&got.body).expect("json body") })
        })
        .collect();
    json!({ "requests": requests, "emitted": emitted, "outcome": outcome })
}

#[tokio::test]
async fn a_refused_floor_feature_is_switched_off_and_replayed_once_as_node_does() {
    let golden: Value = serde_json::from_str(include_str!("../../../../../../fixtures/claude-floors/golden.json")).expect("fixture");
    let scenarios = golden["fallback"].as_array().expect("fallback");
    assert!(scenarios.len() >= 16, "both routes of every scenario");
    for scenario in scenarios {
        let name = scenario["name"].as_str().expect("name");
        for (i, send) in scenario["sends"].as_array().expect("sends").iter().enumerate() {
            let recorded = json!({ "requests": send["requests"], "emitted": send["emitted"], "outcome": send["outcome"] });
            assert_eq!(send_as_node(send).await, recorded, "{name} #{i}");
        }
    }
}
