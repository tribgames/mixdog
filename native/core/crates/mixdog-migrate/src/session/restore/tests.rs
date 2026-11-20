#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test fixtures read the corpus with blocking std::fs")]

use std::collections::HashMap;

use serde_json::Value;
use serde_json::json;

use super::*;

/// An attachment store held in memory.
#[derive(Default)]
struct MemoryBlobs(HashMap<String, Vec<u8>>);

impl MemoryBlobs {
    fn put(&mut self, bytes: &[u8]) -> String {
        let hex = crate::durable::sha256_hex(bytes);
        self.0.insert(hex.clone(), bytes.to_vec());
        hex
    }
}

impl Blobs for MemoryBlobs {
    fn text_within(&self, hex: &str, max_bytes: u64) -> Result<Option<String>, ReadError> {
        let bytes = self.0.get(hex).ok_or(ReadError::Missing)?;
        Ok((bytes.len() as u64 <= max_bytes).then(|| String::from_utf8_lossy(bytes).into_owned()))
    }
}

fn shown(message: Value) -> Shown {
    user_row(&message, &mut UserText::new(&MemoryBlobs::default()))
}

#[test]
fn rows_node_hides_restore_as_nothing() {
    for message in [
        json!({"role": "user", "content": "loaded skill body", "meta": "skill"}),
        json!({"role": "user", "content": "hook output", "meta": "hook"}),
        json!({"role": "user", "content": "<system-reminder>\nx\n</system-reminder>"}),
        json!({"role": "user", "content": "[mixdog-runtime] The app restarted mid-turn."}),
        json!({"role": "user", "content": "[Request interrupted by user]"}),
        json!({"role": "user", "content": "   "}),
    ] {
        assert_eq!(shown(message.clone()), Shown::Nothing, "{message}");
    }
}

#[test]
fn the_cancel_line_is_an_interrupted_turn_end() {
    for (text, cause) in [("[Request interrupted]", Value::Null), ("[request interrupted by process restart]", json!("restart"))] {
        let mut message = json!({"role": "user", "content": text});
        mixdog_protocol::message_class::row_facts(&mut message, &mut UserText::new(&MemoryBlobs::default()));
        assert_eq!(message["meta"]["turnEnd"]["status"], "cancelled", "{text}");
        assert_eq!(message["meta"]["turnEnd"]["cause"], cause, "{text}");
    }
    for text in ["[Request interrupted]", "[request interrupted by process restart]"] {
        assert_eq!(shown(json!({"role": "user", "content": text})), Shown::TurnEnd, "{text}");
    }
}

#[test]
fn notices_steering_and_imports_keep_their_meaning() {
    let held = json!({"role": "user", "content": "[mixdog-runtime] Held", "meta": {"source": "held-request", "heldRequest": {"id": "h1"}}});
    assert_eq!(shown(held), Shown::Notice);
    let result = json!({"role": "user", "content": "report", "meta": {"source": "schedule-result"}});
    assert_eq!(shown(result), Shown::Notice);
    let steering = json!({"role": "user", "content": " also this ", "meta": {"source": "steering"}});
    assert_eq!(shown(steering), Shown::User("also this".into()));
    // Imported prose is verbatim, whatever it looks like.
    let imported = json!({"role": "user", "content": "[Request interrupted]", "meta": {"source": "import"}});
    assert_eq!(shown(imported), Shown::User("[Request interrupted]".into()));
}

#[test]
fn a_task_notification_is_a_card() {
    let text = "<task-notification>\n<task-id>job-1</task-id>\n<status>completed</status>\n<summary>Shell task completed (exit 0)</summary>\n<result>\nok\n</result>\n</task-notification>";
    let message = json!({"role": "user", "content": text, "meta": {"source": "task-notification"}});
    let Shown::Card(card) = shown(message) else { panic!("not a card") };
    assert_eq!(card["name"], "shell");
    assert_eq!(card["args"]["task_id"], "job-1");
    assert_eq!(card["result"], "ok");
    assert_eq!(card["isError"], false);
}

#[test]
fn stored_text_parts_show_as_their_chips() {
    let mut blobs = MemoryBlobs::default();
    let paste = blobs.put(b"one\ntwo\nthree\n");
    let named = blobs.put(b"x");
    let file = blobs.put(b"file body");
    let content = json!([
        {"type": "text", "attachmentRef": paste, "textKind": "paste"},
        {"type": "text", "attachmentRef": named, "textKind": "paste", "filename": "Pasted · 12 lines"},
        {"type": "text", "attachmentRef": file, "textKind": "file", "filename": "notes.md"},
        {"type": "text", "text": "[Image: shot.png]"},
        {"type": "image", "mimeType": "image/png"},
        {"type": "image", "mimeType": "image/jpeg"},
    ]);
    let text = UserText::new(&blobs).text(Some(&content));
    assert_eq!(text, "[Pasted text #1 +3 lines]\n[Pasted text #2 +12 lines]\n[File #3: notes.md]\n[Image: shot.png]\n[Image: image/jpeg]");
}

#[test]
fn an_offloaded_prompt_restores_only_without_companion_text() {
    let mut blobs = MemoryBlobs::default();
    let long = blobs.put("long prompt ".repeat(10).as_bytes());
    let alone = json!([{"type": "text", "attachmentRef": long}]);
    assert_eq!(UserText::new(&blobs).text(Some(&alone)), "long prompt ".repeat(10));
    let beside = json!([{"type": "text", "attachmentRef": long}, {"type": "text", "text": "real"}]);
    assert_eq!(UserText::new(&blobs).text(Some(&beside)), "real");
}

#[test]
fn visualize_feedback_shows_as_the_live_lines() {
    let content = "before\n<visualize_feedback>\npin 1 · Header\n  note: make it\n    bigger\nchoices:\n  · group: \"Theme\" → choice: \"dark\" (\"Dark\")\n</visualize_feedback>";
    let text = UserText::new(&MemoryBlobs::default()).text(Some(&json!(content)));
    assert_eq!(text, "before\n📌 1 · Header — make it bigger\n☑ Theme: Dark");
}

#[test]
fn room_user_lines_count_for_prompt_history() {
    let own = json!({"role": "user", "content": "hi all", "meta": {"source": "agent-room", "room": {"kind": "user"}}});
    let speech = json!({"role": "user", "content": "reply", "meta": {"source": "agent-room", "room": {"kind": "speech"}}});
    assert_eq!(room_prompt(&own), Some("hi all".into()));
    assert_eq!(room_prompt(&speech), None);
}

#[test]
fn only_segments_the_archive_index_reads_are_shown() {
    use crate::session::source::indexed_segment;
    let line = |bytes: usize, body: &str| format!(r#"{{"v":1,"seq":2,"id":"seg2","prev":"seg1","at":5,"count":1,"bytes":{bytes},"items":{body}}}"#);
    assert!(indexed_segment(line(9, r#"[{"a":1}]"#).as_bytes()));
    assert!(!indexed_segment(line(8, r#"[{"a":1}]"#).as_bytes()), "bytes short of the line");
    assert!(!indexed_segment(line(10, r#"[{"a":1}]"#).as_bytes()), "bytes past the line");
    let reordered = r#"{"seq":2,"v":1,"id":"seg2","prev":null,"at":5,"count":1,"bytes":2,"items":[]}"#;
    assert!(!indexed_segment(reordered.as_bytes()));
}
