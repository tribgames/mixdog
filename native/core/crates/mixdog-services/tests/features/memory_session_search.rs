//! Which transcript messages become searchable rows, with which position, time and text.

use mixdog_services::memory::session_search::db::{search_rows, search_rows_from};
use serde_json::json;

#[test]
fn every_conversation_message_is_a_row_at_its_position_in_the_transcript() {
    let messages = [
        json!({"role": "user", "content": "first question", "ts": 1_700_000_000_123_i64}),
        json!({"role": "tool", "content": "trace"}),
        json!({"role": "assistant", "content": "an answer"}),
    ];
    let rows = search_rows("s1", &messages);
    assert_eq!(rows.iter().map(|r| (r.ordinal, r.role, r.content.as_str(), r.ts)).collect::<Vec<_>>(), [(0, "user", "first question", Some(1_700_000_000_123)), (2, "assistant", "an answer", None)]);
    assert!(rows.iter().all(|r| r.session_id == "s1" && r.source_ref.starts_with("session:s1:")));
}

#[test]
fn a_transcript_without_a_session_id_has_no_rows() {
    assert!(search_rows("", &[json!({"role": "user", "content": "hello"})]).is_empty());
}

#[test]
fn system_reminders_are_not_searchable_and_a_message_that_was_only_a_reminder_is_no_row() {
    let messages = [
        json!({"role": "user", "content": "real text <system-reminder>hidden\nnote</system-reminder> more text"}),
        json!({"role": "user", "content": "<SYSTEM-REMINDER>only this</SYSTEM-REMINDER>"}),
    ];
    let rows = search_rows("s", &messages);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].content, "real text   more text");
}

#[test]
fn a_time_is_the_number_or_the_date_text_of_the_message_when_it_has_a_usable_one() {
    let at = |stamp: serde_json::Value| search_rows("s", &[json!({"role": "user", "content": "x", "ts": stamp})])[0].ts;
    assert_eq!(at(json!(1_700_000_000_000.9)), Some(1_700_000_000_000));
    assert_eq!(at(json!("2026-01-01T00:00:00Z")), Some(1_767_225_600_000));
    assert_eq!(at(json!("not a date")), None);
}

#[test]
fn a_very_long_message_is_cut_to_a_searchable_size_by_utf16_units() {
    let long = "😀".repeat(60_000);
    let rows = search_rows("s", &[json!({"role": "assistant", "content": long})]);
    assert_eq!(rows[0].content.encode_utf16().count(), 100_000);
}

#[test]
fn the_rows_of_a_tail_are_the_rows_the_whole_transcript_gives_for_it() {
    let messages = [json!({"role": "user", "content": "a"}), json!({"role": "assistant", "content": "b"}), json!({"role": "user", "content": "c"})];
    let whole = search_rows("s", &messages);
    let tail = search_rows_from("s", &messages[1..], 1);
    assert_eq!(tail, whole[1..]);
}
