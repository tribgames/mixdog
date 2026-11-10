//! A request whose version-floor feature the model refuses, against the `fallback` scenarios of
//! `fixtures/claude-floors/golden.json` (recorded by `record-claude-floors.mjs` from the real sends of
//! both routes, `AnthropicProvider.send` and `AnthropicOAuthProvider.send`): per send, the same requests
//! go out (path, `anthropic-beta`, content encoding and the body's bytes), the same text reaches the caller
//! and the send ends the same way, with the usage Node answers (a replayed attempt's own usage is not
//! counted; a failure carries the usage Node's error carries); the switch-off carries to the later sends
//! of a scenario as it does in Node's process.

use std::sync::Arc;

use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::Usage;
use serde_json::Value;
use serde_json::json;

use super::*;
use crate::claude_floors;
use crate::claude_floors::Feature;
use crate::providers::anthropic::effort_tests::caps_of;
use crate::providers::anthropic::effort_tests::message_of;

/// Node's usage object (`buildAnthropicTurnResult`, the OAuth `parseSSEStream` result) of the core's: the core's input
/// is Node's `promptTokens` (fresh input plus cache read and write), `raw` and `cacheWrite1hTokens` only when present.
pub(super) fn node_usage(usage: &Usage) -> Value {
    let fresh = usage
        .input_tokens
        .checked_sub(usage.cache_read_tokens + usage.cache_write_tokens)
        .expect("the input holds the cache read and write");
    let mut out = json!({
        "inputTokens": fresh,
        "outputTokens": usage.output_tokens,
        "cachedTokens": usage.cache_read_tokens,
        "cacheWriteTokens": usage.cache_write_tokens,
        "promptTokens": usage.input_tokens,
    });
    if usage.cache_write_1h_tokens > 0 {
        out["cacheWrite1hTokens"] = json!(usage.cache_write_1h_tokens);
    }
    if let Some(raw) = &usage.raw {
        out["raw"] = raw.clone();
    }
    out
}

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
    let failure = |err: ProviderError| json!({ "error": { "status": err.status, "partialUsage": err.partial_usage.as_deref().map(node_usage) } });
    let outcome = match adapter.attempt(Arc::new(req)).await {
        Err(err) => failure(err),
        Ok(mut stream) => {
            let mut events = Vec::new();
            let mut failed = None;
            while let Some(next) = stream.next().await {
                match next {
                    Ok(event) => {
                        if let StreamEvent::TextDelta(text) = &event {
                            emitted.push(text.clone());
                        }
                        events.push(event);
                    }
                    Err(err) => {
                        failed = Some(err);
                        break;
                    }
                }
            }
            match failed {
                Some(err) => failure(err),
                None => {
                    let folded = fold(&events);
                    json!({ "ok": { "content": folded.content, "usage": folded.usage.as_ref().map(node_usage) } })
                }
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
            let header = |name: &str| got.headers.iter().find(|h| h.0.eq_ignore_ascii_case(name)).map(|h| h.1.clone());
            let text = String::from_utf8(got.body.clone()).expect("a UTF-8 body");
            json!({
                "path": path,
                "betaHeader": header("anthropic-beta"),
                "contentEncoding": header("content-encoding"),
                "bodyText": text,
                "body": serde_json::from_str::<Value>(&text).expect("json body"),
            })
        })
        .collect();
    json!({ "requests": requests, "emitted": emitted, "outcome": outcome })
}

#[tokio::test]
async fn a_refused_floor_feature_is_switched_off_and_replayed_once_as_node_does() {
    let golden: Value = serde_json::from_str(include_str!("../../../../../../fixtures/claude-floors/golden.json")).expect("fixture");
    let scenarios = golden["fallback"].as_array().expect("fallback");
    assert!(scenarios.len() >= 16, "both routes of every scenario");
    // Whatever ran before in this process may have switched these models off: the replay starts from the state of the
    // fresh process Node recorded in.
    for send in scenarios.iter().flat_map(|scenario| scenario["sends"].as_array().expect("sends")) {
        for feature in [Feature::ProgressUpdates, Feature::TurnScopedSystem] {
            for provider in ["anthropic", "anthropic-oauth"] {
                claude_floors::mark_unsupported(feature, provider, send["model"].as_str().expect("model"));
            }
        }
    }
    claude_floors::reset_process();
    for scenario in scenarios {
        let name = scenario["name"].as_str().expect("name");
        for (i, send) in scenario["sends"].as_array().expect("sends").iter().enumerate() {
            let recorded = json!({ "requests": send["requests"], "emitted": send["emitted"], "outcome": send["outcome"] });
            assert_eq!(send_as_node(send).await, recorded, "{name} #{i}");
        }
    }
}
