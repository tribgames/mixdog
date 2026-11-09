//! The subscription route's whole request sequence against Node's recording
//! (`fixtures/wire-anthropic-gemini/anthropic.json`, recorded by
//! `benchmarks/rust-core/recorders/record-wire-anthropic-gemini.mjs` from `AnthropicOAuthProvider.send`
//! with the network replaced by a recorder, at `b6f10295a`): per model family a first turn, a tool-result
//! turn, a long thread, a resumed and a compacted thread, tail reminders, and the requests Node never
//! threads. Each send's requests (url, every header, the whole body with a gzip body decoded) are
//! compared with what `AnthropicAdapter::attempt` puts on the wire when the recorded answers come back;
//! the model's capabilities are an input (the catalog's), taken from the recorded body's own fields.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::PathBuf;
use std::sync::Arc;

use flate2::read::GzDecoder;
use mixdog_core_api::domain::provider::CacheTier;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::MessageSource;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::ToolCall;
use mixdog_core_api::domain::provider::WireRequest;
use serde_json::Value;

use super::AnthropicAdapter;
use super::AnthropicConfig;
use super::ModelCaps;
use super::effort_tests::tool_of;
use super::tests::MemoryStore;
use super::tests::Scripted;
use super::tests::ScriptedHttp;
use super::tests::cpu_bulk;

#[allow(clippy::disallowed_methods, reason = "test-only read of a checked-in fixture file")]
pub(crate) fn recording(file: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/wire-anthropic-gemini").join(file);
    let text = std::fs::read_to_string(path).expect("recorded scenarios");
    mixdog_js::fixture_tools::parse_golden(&text).expect("json")
}

fn message_of(recorded: &Value) -> Message {
    let role = match recorded["role"].as_str().expect("role") {
        "system" => Role::System,
        "user" => Role::User,
        "assistant" => Role::Assistant,
        "tool" => Role::Tool,
        other => panic!("{other}"),
    };
    let mut message = Message::new(role, Content::Text(recorded["content"].as_str().expect("content").into()));
    message.cache_tier = match recorded["cacheTier"].as_str() {
        Some("tier3") => Some(CacheTier::Tier3),
        Some("env") => Some(CacheTier::Env),
        _ => None,
    };
    for call in recorded["toolCalls"].as_array().into_iter().flatten() {
        message.tool_calls.push(ToolCall {
            id: call["id"].as_str().expect("id").into(),
            name: call["name"].as_str().expect("name").into(),
            arguments: call["arguments"].clone(),
            native_type: None,
        });
    }
    message.tool_call_id = recorded["toolCallId"].as_str().map(str::to_owned);
    if recorded["meta"]["source"] == "tail-reminder" {
        message.source = Some(MessageSource::TailReminder);
    }
    message.turn_reminder = recorded["turnReminder"].as_str().map(str::to_owned);
    message
}

fn options_of(recorded: &Value) -> RequestOptions {
    RequestOptions {
        session_id: recorded["sessionId"].as_str().map(str::to_owned),
        request_kind: recorded["requestKind"].as_str().map(str::to_owned),
        shared_cache_prefix_count: recorded["sharedCachePrefixCount"].as_u64().map(|count| count as usize),
        ..RequestOptions::default()
    }
}

/// The catalog's capabilities of the model, as the first recorded body shows them.
fn caps_of_body(body: &Value) -> ModelCaps {
    let adaptive = body["thinking"]["type"] == "adaptive";
    ModelCaps {
        adaptive_thinking: adaptive,
        manual_thinking: false,
        ladder_stated: false,
        effort_levels: if adaptive { ["low", "medium", "high", "max"].map(str::to_owned).to_vec() } else { Vec::new() },
        max_output_tokens: body["max_tokens"].as_u64().map(|v| v as u32),
        fast_mode: false,
        context_window: None,
        thinking_display_updates: body["thinking"]["display"] == "updates",
    }
}

/// Everything of a request the recording holds: method, url, headers by lowercase name, the body's text.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Seen {
    pub method: String,
    pub url: String,
    pub headers: BTreeMap<String, String>,
    pub body: String,
}

pub(crate) fn seen_of_recorded(request: &Value) -> Seen {
    Seen {
        method: request["method"].as_str().expect("method").to_owned(),
        url: request["url"].as_str().expect("url").to_owned(),
        headers: request["headers"].as_object().expect("headers").iter().map(|(k, v)| (k.to_lowercase(), v.as_str().expect("header").to_owned())).collect(),
        body: request["body"].as_str().expect("body").to_owned(),
    }
}

pub(crate) fn seen_of_sent(request: &WireRequest) -> Seen {
    let headers: BTreeMap<String, String> = request.headers.iter().map(|(k, v)| (k.to_lowercase(), v.clone())).collect();
    let body = if headers.get("content-encoding").map(String::as_str) == Some("gzip") {
        let mut text = String::new();
        GzDecoder::new(request.body.as_slice()).read_to_string(&mut text).expect("a gzip body");
        text
    } else {
        String::from_utf8(request.body.clone()).expect("utf8")
    };
    Seen { method: request.method.clone(), url: request.url.clone(), headers, body }
}

/// The first path at which two parsed bodies differ.
fn first_difference(want: &Value, got: &Value, path: &str) -> Option<String> {
    match (want, got) {
        (Value::Object(a), Value::Object(b)) => a
            .keys()
            .chain(b.keys())
            .find_map(|key| match (a.get(key), b.get(key)) {
                (Some(x), Some(y)) => first_difference(x, y, &format!("{path}.{key}")),
                (x, y) => Some(format!("{path}.{key}: Node {} / Rust {}", x.map_or("absent".into(), short), y.map_or("absent".into(), short))),
            }),
        (Value::Array(a), Value::Array(b)) => (0..a.len().max(b.len())).find_map(|i| match (a.get(i), b.get(i)) {
            (Some(x), Some(y)) => first_difference(x, y, &format!("{path}[{i}]")),
            (x, y) => Some(format!("{path}[{i}]: Node {} / Rust {}", x.map_or("absent".into(), short), y.map_or("absent".into(), short))),
        }),
        _ if want == got => None,
        _ => Some(format!("{path}: Node {} / Rust {}", short(want), short(got))),
    }
}

fn short(value: &Value) -> String {
    let text = value.to_string();
    if text.len() > 120 { format!("{}…", text.chars().take(120).collect::<String>()) } else { text }
}

/// Why `got` is not `want`, or nothing when they are equal.
pub(crate) fn mismatch(want: &Seen, got: &Seen) -> Option<String> {
    if want == got {
        return None;
    }
    let mut what = Vec::new();
    if want.method != got.method || want.url != got.url {
        what.push(format!("request line: Node {} {} / Rust {} {}", want.method, want.url, got.method, got.url));
    }
    for name in want.headers.keys().chain(got.headers.keys()).collect::<std::collections::BTreeSet<_>>() {
        if want.headers.get(name) != got.headers.get(name) {
            what.push(format!("header {name}: Node {:?} / Rust {:?}", want.headers.get(name), got.headers.get(name)));
        }
    }
    if want.body != got.body {
        let parsed = |text: &str| serde_json::from_str::<Value>(text).expect("json body");
        match first_difference(&parsed(&want.body), &parsed(&got.body), "body") {
            Some(path) => what.push(path),
            None => what.push("body: the same JSON in another key order or spelling".to_owned()),
        }
    }
    Some(what.join("; "))
}

#[tokio::test]
async fn every_recorded_send_puts_the_requests_node_sent_on_the_wire() {
    let document = recording("anthropic.json");
    let scenarios = document["scenarios"].as_array().expect("scenarios");
    assert_eq!(scenarios.len(), 26);
    let mut differences = Vec::new();
    for scenario in scenarios {
        let id = scenario["id"].as_str().expect("id");
        let model = scenario["model"].as_str().expect("model");
        let sends = scenario["sends"].as_array().expect("sends");
        let caps = caps_of_body(&serde_json::from_str::<Value>(sends[0]["requests"][0]["body"].as_str().expect("body")).expect("json"));
        let tools: Vec<_> = scenario["tools"].as_array().expect("tools").iter().map(tool_of).collect();
        let replies = sends.iter().flat_map(|s| s["replies"].as_array().expect("replies")).map(|r| Scripted::body(r["status"].as_u64().expect("status") as u16, r["body"].as_str().expect("reply body")));
        let http = ScriptedHttp::new(replies);
        let store = MemoryStore::signed_in();
        let mut config = AnthropicConfig::new(Arc::new(move |_: &str| Some(caps.clone())));
        config.threads = Arc::new(super::threads::Threads::default());
        let adapter = AnthropicAdapter::oauth(config, http.clone(), store.session(http.clone()), false, cpu_bulk());
        for (n, send) in sends.iter().enumerate() {
            let before = http.sent().len();
            let request = ModelRequest {
                model: model.to_owned(),
                messages: send["messages"].as_array().expect("messages").iter().map(message_of).collect(),
                tools: tools.clone(),
                options: options_of(&send["opts"]),
            };
            let mut stream = adapter.attempt(Arc::new(request)).await.unwrap_or_else(|e| panic!("{id} #{n}: {}", e.message));
            while let Some(item) = stream.next().await {
                item.unwrap_or_else(|e| panic!("{id} #{n}: {}", e.message));
            }
            drop(stream);
            let sent = http.sent();
            let wanted = send["requests"].as_array().expect("requests");
            if sent.len() - before != wanted.len() {
                differences.push(format!("{id} #{n}: Node sent {} request(s), Rust {}", wanted.len(), sent.len() - before));
                continue;
            }
            for (i, (got, want)) in sent[before..].iter().zip(wanted).enumerate() {
                if let Some(why) = mismatch(&seen_of_recorded(want), &seen_of_sent(got)) {
                    differences.push(format!("{id} #{n} request {i}: {why}"));
                }
            }
        }
    }
    assert!(differences.is_empty(), "{} difference(s):\n{}", differences.len(), differences.join("\n"));
}
