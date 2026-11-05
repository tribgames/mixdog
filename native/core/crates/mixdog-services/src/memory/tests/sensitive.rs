//! Sensitive-value redaction against the outputs recorded from the Node
//! product (`fixtures/tools/memory/sensitive/golden.json`).

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::Value;

use crate::memory::sensitive::SensitiveStore;

const GOLDEN: &str = include_str!("../../../../../fixtures/tools/memory/sensitive/golden.json");

fn golden() -> Value {
    serde_json::from_str(GOLDEN).expect("golden parses")
}

fn calls(session: &Value) -> Vec<Value> {
    session["calls"].as_array().cloned().unwrap_or_default()
}

#[test]
fn redaction_matches_the_node_product() {
    let g = golden();
    let store = SensitiveStore::default();
    for session in g["sessions"].as_array().expect("sessions") {
        let Some(texts) = session["texts"].as_array() else { continue };
        let id = session["id"].as_str().expect("id");
        store.remember(id, &calls(session));
        assert_eq!(store.version(id), session["version"].as_u64().expect("version"), "{id}");
        for case in texts {
            let text = case["text"].as_str().expect("text");
            assert_eq!(store.redact_text(id, text), case["redacted"].as_str().expect("redacted"), "{id}: {text}");
            assert_eq!(store.contains(id, text), case["contains"].as_bool().expect("contains"), "{id}: {text}");
            assert_eq!(store.redact_settled_text(id, text), case["settled"].as_str().expect("settled"), "{id} settled: {text}");
            let projected = store.redact_content(id, &Value::String(text.to_owned()));
            assert_eq!(projected, case["projected"], "{id} projected: {text}");
        }
        if !session["messages"].is_null() {
            let input: Vec<Value> = session["messages"]["input"].as_array().expect("input").clone();
            let got = store.redact_messages(id, &input);
            assert_eq!(Value::Array(got), session["messages"]["output"], "{id} messages");
        }
    }
}

#[test]
fn a_growing_stream_settles_prefix_by_prefix() {
    let g = golden();
    let store = SensitiveStore::default();
    let first = &g["sessions"][0];
    store.remember("s-code", &calls(first));
    let stream = g["sessions"].as_array().expect("sessions").iter().find(|s| s["streaming"].is_array()).expect("stream");
    for step in stream["streaming"].as_array().expect("steps") {
        let text = step["text"].as_str().expect("text");
        assert_eq!(store.redact_settled_text("s-code", text), step["settled"].as_str().expect("settled"), "{text}");
    }
}

#[test]
fn only_sensitive_browser_fills_are_remembered_and_listeners_hear_each_new_value() {
    let g = golden();
    let store = Arc::new(SensitiveStore::default());
    for (index, probe) in g["remembered"].as_array().expect("remembered").iter().enumerate() {
        let id = format!("probe-{index}");
        let calls: Vec<Value> = probe["calls"].as_array().expect("calls").clone();
        let heard = Arc::new(AtomicU64::new(0));
        let subscription = {
            let heard = heard.clone();
            store.on_marked(&id, move |version| heard.store(version, Ordering::SeqCst))
        };
        assert_eq!(store.remember(&id, &calls), probe["marked"].as_bool().expect("marked"), "{index}");
        assert_eq!(store.version(&id), probe["version"].as_u64().expect("version"), "{index}");
        assert_eq!(heard.load(Ordering::SeqCst), store.version(&id), "{index}: listeners run before remember returns");
        assert_eq!(store.remember(&id, &calls), probe["again"].as_bool().expect("again"), "{index}");
        drop(subscription);
    }
}
