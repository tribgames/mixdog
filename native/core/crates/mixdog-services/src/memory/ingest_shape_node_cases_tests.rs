//! `execution-tail.test.mjs:21`: a tagged agent completion is no memory conversation. Node's
//! `projectSessionMessagesForIngest` over each recorded row (`fixtures/compact-node-cases/golden.json`,
//! `benchmarks/rust-core/recorders/record-compact-node-cases.mjs`) against the rows the core's ingest keeps of the
//! same stored rows: the role it normalizes, the exclusion and the ingest text, the projected rows compared whole.

use serde_json::Value;
use serde_json::json;

use super::normalize_ingest_role;
use super::session_message_content_for_ingest;
use super::should_exclude_ingest_message;

/// The rows the ingest reads of a transcript (`assign_occurrences`): role, exclusion, then non-empty text.
fn ingested(messages: &[Value]) -> Vec<Value> {
    messages
        .iter()
        .filter(|m| m.is_object())
        .filter_map(|m| {
            let role = normalize_ingest_role(m.get("role"))?;
            if should_exclude_ingest_message(m) {
                return None;
            }
            let content = session_message_content_for_ingest(m);
            (!mixdog_js::js_trim(&content).is_empty()).then(|| json!({ "role": role, "content": content }))
        })
        .collect()
}

/// `session-ingest-projection.test.mjs` (`fixtures/session-ingest-projection/golden.json`,
/// `benchmarks/rust-core/recorders/record-session-ingest-projection.mjs`): every case.
#[test]
fn the_ingest_projection_equals_node() {
    let golden: Value = serde_json::from_str(include_str!("../../../../fixtures/session-ingest-projection/golden.json")).unwrap();
    for case in golden["projections"].as_array().unwrap() {
        assert_eq!(Value::Array(ingested(case["messages"].as_array().unwrap())), case["projected"], "{}", case["test"]);
    }
    for case in golden["contents"].as_array().unwrap() {
        assert_eq!(session_message_content_for_ingest(&case["message"]), case["content"].as_str().unwrap(), "{}", case["message"]);
    }
    for case in golden["exclusions"].as_array().unwrap() {
        assert_eq!(Value::Bool(should_exclude_ingest_message(&case["message"])), case["excluded"], "{}", case["message"]);
    }
}

#[test]
fn a_tagged_completion_is_not_ingested_as_in_node() {
    let golden: Value = serde_json::from_str(include_str!("../../../../fixtures/compact-node-cases/golden.json")).unwrap();
    for case in golden["instruction"].as_array().unwrap() {
        assert_eq!(Value::Array(ingested(std::slice::from_ref(&case["message"]))), case["ingestProjection"], "{}", case["message"]);
    }
}
