//! memory-session-ingest-projection: the transcript shaping of `memory/ingest_shape.rs`, one test per recorded case.
//!
//! - `projections` ↔ `project_session_messages_for_ingest`, which the memory runtime's tool entry
//!   (`LocalMemory::memory`, `ingest_session`) applies as Node's proxy does (`tool-wire.mjs`); the result whole.
//! - `rows` ↔ `session_message_content_for_ingest` (content) and `should_exclude_ingest_message` (exclude).
//! - helpers: `normalizeIngestRole` ↔ `normalize_ingest_role`, `allTextContent` ↔ `all_text_content`. Node's exported
//!   `isUnquotedToolCompletionHead` has no public Rust counterpart: it is one clause of the shared exclusion predicate
//!   (`mixdog-agent` `compact/ingest.rs` `ASYNC_HEAD`), so each probe is compared through `should_exclude_ingest_message`
//!   on a user row holding the text; every recorded probe answers false, and none of those texts meets another clause.
//!
//! A message member recorded as `undefined` is absent in the JSON the core receives (Node's `m.toolCalls` reads the same
//! for both); an `undefined` argument is `None`.

use mixdog_testkit::Exact;
use serde_json::{Value, json};

use super::{assert_case_count, case, golden, opt, same, string};
use crate::memory::ingest_shape::{
    all_text_content, normalize_ingest_role, project_session_messages_for_ingest, session_message_content_for_ingest,
    should_exclude_ingest_message,
};

const SET: &str = "memory-session-ingest-projection";

/// The JSON the core receives for a recorded value: an `undefined` member is absent.
fn json_of(value: &Exact) -> Value {
    match value {
        Exact::Object(entries) => Value::Object(
            entries.iter().filter(|(_, v)| !matches!(v, Exact::Undefined)).map(|(k, v)| (k.clone(), json_of(v))).collect(),
        ),
        Exact::Array(items) => Value::Array(items.iter().map(json_of).collect()),
        other => other.to_plain().unwrap_or_else(|e| panic!("a recorded input with no JSON form: {e}")),
    }
}

fn argument(value: &Exact) -> Option<Value> {
    (!matches!(value, Exact::Undefined)).then(|| json_of(value))
}

fn projections(case: &Exact, what: &str) {
    for projection in case.get("projections").as_array() {
        let name = format!("{what}: {}", projection.get("name").as_str());
        let actual = project_session_messages_for_ingest(&json_of(projection.get("messages")));
        same(&name, projection.get("result"), &Exact::plain(&Value::Array(actual)));
    }
}

fn rows(case: &Exact, what: &str) {
    for row in case.get("rows").as_array() {
        let name = format!("{what}: {}", row.get("name").as_str());
        let message = json_of(row.get("message"));
        same(&format!("{name}: content"), row.get("content").get("result"), &string(session_message_content_for_ingest(&message)));
        same(&format!("{name}: exclude"), row.get("exclude").get("result"), &Exact::Bool(should_exclude_ingest_message(&message)));
    }
}

#[test]
fn the_recording_has_five_cases() {
    assert_case_count(&golden(SET), 5);
}

#[test]
fn session_ingest_projection_preserves_every_text_block_in_a_user_message() {
    let g = golden(SET);
    let name = "session ingest projection preserves every text block in a user message";
    projections(case(&g, 0, name), name);
}

#[test]
fn session_ingest_projection_excludes_compact_active_turn_continuation_rows() {
    let g = golden(SET);
    let name = "session ingest projection excludes Compact active-turn continuation rows";
    projections(case(&g, 1, name), name);
}

#[test]
fn user_turn_prefix_envelopes_strip_only_manager_mjs_start_anchored_sections() {
    let g = golden(SET);
    let name = "user-turn prefix envelopes strip only manager.mjs start-anchored sections";
    rows(case(&g, 2, name), name);
}

#[test]
fn ingest_exclusion_drops_synthetic_rows_and_keeps_conversation() {
    let g = golden(SET);
    let name = "ingest exclusion drops synthetic rows and keeps conversation";
    rows(case(&g, 3, name), name);
}

#[test]
fn further_shapes_beyond_the_test_file() {
    let g = golden(SET);
    let name = "further shapes (beyond the test file)";
    let case = case(&g, 4, name);
    projections(case, name);
    rows(case, name);
    for (index, probe) in case.get("helpers").as_array().iter().enumerate() {
        let what = format!("{name}: helper {index}");
        let actual = match probe.get("fn").as_str() {
            "normalizeIngestRole" => opt(normalize_ingest_role(argument(probe.get("role")).as_ref()), string),
            "allTextContent" => string(all_text_content(argument(probe.get("content")).as_ref())),
            "isUnquotedToolCompletionHead" => {
                let text = argument(probe.get("text")).unwrap_or(Value::Null);
                Exact::Bool(should_exclude_ingest_message(&json!({ "role": "user", "content": text })))
            }
            other => panic!("{what}: an unknown helper {other}"),
        };
        same(&what, probe.get("result"), &actual);
    }
}
