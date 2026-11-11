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

/// A carry makes a session's values, those it holds and those it gains later, its target's, and on along the target's
/// own carries; the target's listeners hear it, the carried listener is told each session that gained one, and a cycle
/// of carries ends.
#[test]
fn a_carried_session_takes_the_values_its_source_holds_and_gains_up_the_chain() {
    let fill = |text: &str| serde_json::json!({ "name": "browser", "arguments": { "action": "fill", "input": { "sensitive": true, "text": text } } });
    let store = Arc::new(SensitiveStore::default());
    let told: Arc<std::sync::Mutex<Vec<String>>> = Arc::default();
    let sink = told.clone();
    assert!(store.on_carried(move |session| sink.lock().unwrap().push(session.to_owned())));
    assert!(!store.on_carried(|_| {}), "one carried listener");
    let heard = Arc::new(AtomicU64::new(0));
    let _parent = {
        let heard = heard.clone();
        store.on_marked("parent", move |version| heard.store(version, Ordering::SeqCst))
    };
    assert!(store.remember("child", &[fill("before")]));
    store.carry("child", "parent");
    assert_eq!(store.redact_text("parent", "before"), "[redacted]", "what the source held is carried");
    store.carry("grandchild", "child");
    store.carry("parent", "child");
    assert!(store.remember("grandchild", &[fill("after")]));
    for session in ["grandchild", "child", "parent"] {
        assert_eq!(store.redact_text(session, "before after"), if session == "grandchild" { "before [redacted]" } else { "[redacted] [redacted]" }, "{session}");
    }
    assert_eq!(heard.load(Ordering::SeqCst), store.version("parent"));
    assert_eq!(*told.lock().unwrap(), ["parent", "child", "parent"]);
    assert_eq!(store.redact_text("unrelated", "after"), "after");
}

/// A completion's message keeps its card (`meta.taskCard`, a core-only field: the report as the card shows it and the raw
/// notification); stored after a mark, the card holds the marker like the content does.
#[test]
fn a_completion_card_on_a_stored_message_takes_the_marker() {
    let fill = serde_json::json!({ "name": "browser", "arguments": { "action": "fill", "input": { "sensitive": true, "text": "730215" } } });
    let store = SensitiveStore::default();
    store.remember("owner", &[fill]);
    let message = serde_json::json!({
        "role": "user",
        "content": "<result>\nThe code is 730215.\n</result>",
        "meta": { "source": "task-notification", "taskCard": { "name": "agent", "args": { "tag": "s2h" }, "result": "The code is 730215.", "rawResult": "<result>\nThe code is 730215.\n</result>" } },
    });
    let stored = store.redact_message("owner", &message);
    assert!(!stored.to_string().contains("730215"), "{stored}");
    assert_eq!(stored["meta"]["taskCard"]["result"], "The code is [redacted].");
    assert_eq!(stored["meta"]["source"], "task-notification");
}
