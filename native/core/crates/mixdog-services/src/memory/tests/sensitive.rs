//! Sensitive-value redaction against the outputs recorded from the Node
//! product (`fixtures/tools/memory/sensitive/golden.json`).

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{Value, json};

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

/// `fixtures/sensitive-feed` (`record-sensitive-feed.mjs`): a marked value in a tool call's arguments, a tool result, an
/// attachment's name and a compaction summary. The messages as stored (and handed to the close and search ingests),
/// what the close ingest feeds memory, and the session search rows, each whole as Node's.
#[test]
fn a_marked_value_in_tool_results_attachments_and_summaries_reaches_memory_as_in_node() {
    use crate::memory::ingest_shape::{normalize_ingest_role, session_message_content_for_ingest, should_exclude_ingest_message};
    let path = format!("{}/../../fixtures/sensitive-feed/sensitive-feed.json", env!("CARGO_MANIFEST_DIR"));
    let recorded: Value = serde_json::from_str(&std::fs::read_to_string(path).expect("recording")).expect("json");
    let session = recorded["session"].as_str().expect("session");
    let store = SensitiveStore::default();
    assert!(store.remember(session, recorded["calls"].as_array().expect("calls")));
    let stored = store.redact_messages(session, recorded["messages"].as_array().expect("messages"));
    // Node b6f10295a keeps an attachment's name as given ("hunter2-notes.pdf"); with
    // `node-patches/node-fix-sensitive-attachment-names.patch` it stores it redacted, as the core does.
    let mut patched = recorded["stored"].clone();
    let name = patched.pointer_mut("/3/content/1/name").expect("the attachment's name");
    assert_eq!(*name, "hunter2-notes.pdf");
    *name = json!("[redacted]-notes.pdf");
    assert_eq!(Value::Array(stored.clone()), patched, "the messages as stored");

    // `projectSessionMessagesForIngest`, from the core's own shaping functions.
    let ingest: Vec<Value> = stored
        .iter()
        .filter_map(|message| {
            let role = normalize_ingest_role(message.get("role"))?;
            if should_exclude_ingest_message(message) {
                return None;
            }
            let content = session_message_content_for_ingest(message);
            if content.trim().is_empty() {
                return None;
            }
            let mut next = serde_json::json!({ "role": role, "content": content });
            for key in ["ts", "timestamp"] {
                if let Some(value) = message.get(key) {
                    next[key] = value.clone();
                }
            }
            if let Some(id) = message.get("toolCallId").filter(|v| v.as_str().is_some_and(|s| !s.is_empty())) {
                next["toolCallId"] = id.clone();
            }
            if let Some(calls) = message.get("toolCalls").and_then(Value::as_array) {
                let ids: Vec<Value> = calls.iter().filter_map(|c| c.get("id").filter(|v| !v.is_null())).map(|id| serde_json::json!({ "id": id })).collect();
                if !ids.is_empty() {
                    next["toolCalls"] = Value::Array(ids);
                }
            }
            Some(next)
        })
        .collect();
    assert_eq!(Value::Array(ingest), recorded["ingest"], "what the close ingest feeds memory");

    let rows: Vec<Value> = crate::memory::session_search::db::search_rows(session, &stored)
        .into_iter()
        .map(|row| serde_json::json!({ "sourceRef": row.source_ref, "sessionId": row.session_id, "ordinal": row.ordinal, "role": row.role, "ts": row.ts, "content": row.content }))
        .collect();
    assert_eq!(Value::Array(rows), recorded["search"], "the session search rows");
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
