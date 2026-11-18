//! Which transcript messages are conversation, what text they contribute, and the stable identity of each.

use mixdog_services::memory::ingest_shape::{
    all_text_content, normalize_ingest_role, project_session_messages_for_ingest, session_message_content_for_ingest, should_exclude_ingest_message, stable_session_source_ref,
};
use serde_json::{Value, json};

#[test]
fn only_human_and_model_turns_are_conversation_whatever_the_transcript_calls_them() {
    for (role, kept) in [("user", "user"), ("Human", "user"), (" USER ", "user"), ("assistant", "assistant"), ("ai", "assistant"), ("MODEL", "assistant")] {
        assert_eq!(normalize_ingest_role(Some(&json!(role))), Some(kept), "{role}");
    }
    for other in [json!("tool"), json!("system"), json!(""), json!(null), json!(5)] {
        assert_eq!(normalize_ingest_role(Some(&other)), None, "{other}");
    }
    assert_eq!(normalize_ingest_role(None), None);
}

#[test]
fn a_message_contributes_its_text_blocks_and_never_its_tool_traces() {
    assert_eq!(all_text_content(Some(&json!("plain"))), "plain");
    let blocks = json!([{"type": "text", "text": "one"}, {"type": "tool_use", "name": "x"}, "two", {"type": "text", "text": ""}]);
    assert_eq!(all_text_content(Some(&blocks)), "one\ntwo");
    assert_eq!(all_text_content(Some(&json!({"type": "text", "text": "x"}))), "");
    assert_eq!(all_text_content(None), "");
}

#[test]
fn the_envelopes_the_session_manager_puts_before_a_prompt_are_taken_off_the_prompt() {
    let user = |text: &str| session_message_content_for_ingest(&json!({"role": "user", "content": text}));
    assert_eq!(user("# Session\nCwd: /work\nModel: m\n\nfix the bug"), "fix the bug");
    assert_eq!(user("# Task\nfix the bug"), "fix the bug");
    assert_eq!(user("# Project Instructions\nbe nice\n# Task\nfix the bug"), "fix the bug");
    // A person's own words are never stripped when they only look similar.
    assert_eq!(user("# Session notes\nare below"), "# Session notes\nare below");
    assert_eq!(user("prefix # Task\nkept"), "prefix # Task\nkept");
}

#[test]
fn an_assistant_reply_is_kept_whole() {
    let reply = "# Task\nlooks like a heading but is the model's text";
    assert_eq!(session_message_content_for_ingest(&json!({"role": "assistant", "content": reply})), reply);
}

#[test]
fn the_projection_keeps_conversation_rows_with_the_identity_fields_and_nothing_else() {
    let messages = json!([
        {"role": "user", "content": "hello", "ts": 1_700_000_000_000_i64, "extra": "dropped"},
        {"role": "tool", "content": "trace"},
        {"role": "assistant", "content": [{"type": "text", "text": "hi"}], "toolCalls": [{"id": "c1", "name": "x"}, {"name": "no id"}], "timestamp": "2026-01-01T00:00:00Z"},
        {"role": "assistant", "content": "   "},
        "not an object",
        ["array"],
    ]);
    let projected = project_session_messages_for_ingest(&messages);
    assert_eq!(
        projected,
        vec![
            json!({"role": "user", "content": "hello", "ts": 1_700_000_000_000_i64}),
            json!({"role": "assistant", "content": "hi", "timestamp": "2026-01-01T00:00:00Z", "toolCalls": [{"id": "c1"}]}),
        ]
    );
    assert!(project_session_messages_for_ingest(&json!({"not": "a list"})).is_empty());
}

#[test]
fn a_row_that_is_not_an_object_is_excluded_from_ingest() {
    assert!(should_exclude_ingest_message(&json!("text")));
    assert!(!should_exclude_ingest_message(&json!({"role": "user", "content": "a real question"})));
}

fn reference(message: &Value, ordinal: usize) -> String {
    stable_session_source_ref("s1", message, "user", "hello", ordinal)
}

#[test]
fn a_message_keeps_its_source_reference_when_the_transcript_is_reindexed() {
    let stamped = json!({"ts": 1_700_000_000_000_i64});
    let r = reference(&stamped, 1);
    assert!(r.starts_with("session:s1:") && r.len() == "session:s1:".len() + 24, "{r}");
    assert_eq!(reference(&stamped, 99), r, "a timestamped message ignores its position");
    assert_eq!(reference(&json!({"timestamp": 1_700_000_000_000_i64}), 3), r, "`timestamp` is the same stamp as `ts`");
    assert_ne!(reference(&json!({"ts": 1_700_000_000_001_i64}), 1), r);
}

#[test]
fn untimestamped_repeats_stay_distinct_rows_by_their_position() {
    let bare = json!({});
    assert_ne!(reference(&bare, 1), reference(&bare, 2));
    assert_eq!(reference(&bare, 2), reference(&bare, 2));
    // The tool a message called is part of what it is.
    assert_ne!(reference(&json!({"toolCallId": "t1"}), 1), reference(&bare, 1));
    assert_ne!(stable_session_source_ref("s1", &bare, "assistant", "hello", 1), reference(&bare, 1));
    assert_ne!(stable_session_source_ref("s1", &bare, "user", "other", 1), reference(&bare, 1));
}
