//! `fixtures/message-attachments-cases` (`record-message-attachments-cases.mjs`, b6f10295a): the case "the persisted and restored user row
//! keep the attachments, and drop malformed ones", replayed through the core's attachment normaliser and its stored-message restore.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mixdog_store::schema::blob::Slot;
use mixdog_store::schema::record::ItemRecord;
use mixdog_testkit::exact::Exact;
use serde_json::Value;
use serde_json::json;

use super::user_text::AttachmentText;
use super::user_text::PASTED_LINE_READ_BUDGET_BYTES;
use super::user_text::ReadFailure;
use super::user_text::user_display_text;
use super::transcript::transcript_rows::Restored;
use super::transcript::transcript_rows::normalize_attachments;
use super::transcript::transcript_rows::restore;

fn observed() -> Value {
    let golden: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/message-attachments-cases/golden.json")).expect("golden.json");
    let golden = Exact::decode(&golden).expect("exact");
    let case = golden.get("cases").as_array()[0].clone();
    assert_eq!(case.get("case").as_str(), "the persisted and restored user row keep the attachments, and drop malformed ones");
    case.get("observed").to_plain().expect("plain")
}

/// The one row a stored user message restores to.
fn restored_row(message: &Value) -> serde_json::Map<String, Value> {
    let mut record: ItemRecord = serde_json::from_value(json!({
        "iid": "m1", "form": "message", "model": true, "visible": true, "refs": [], "body": { "inline": {} },
    }))
    .expect("record shape");
    record.body = Slot::Inline(message.clone());
    record.prompt = Some(Slot::Inline(message["content"].as_str().expect("a prompt").to_owned()));
    let mut rows = restore(&record, message).into_iter();
    let Some(Restored::Row { row, .. }) = rows.next() else { panic!("a user message restores to one row") };
    assert!(rows.next().is_none());
    row
}

/// The attachment store as the restore reads it: the recorded blobs by reference.
struct Planted(serde_json::Map<String, Value>);

impl AttachmentText for Planted {
    fn read_within(&mut self, attachment_ref: &str, max_bytes: usize) -> Result<Option<String>, ReadFailure> {
        let Some(base64) = self.0.get(attachment_ref).and_then(Value::as_str) else { return Err(ReadFailure::Missing) };
        let bytes = STANDARD.decode(base64).expect("base64");
        Ok((bytes.len() <= max_bytes).then(|| String::from_utf8(bytes).expect("text")))
    }
}

fn named_attachment_case(name: &str) -> Value {
    let golden: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/named-attachment-file-cases/golden.json")).expect("golden.json");
    let golden = Exact::decode(&golden).expect("exact");
    let found = golden.get("cases").as_array().iter().find(|case| case.get("case").as_str() == name).cloned();
    found.unwrap_or_else(|| panic!("no recorded case {name:?}")).get("observed").to_plain().expect("plain")
}

/// Case "the note is model-facing only: the restored bubble does not show it": the restored text of the prompt with the note part
/// appended is the text without it.
#[test]
fn the_restored_bubble_does_not_show_the_files_note_as_node_recorded() {
    let want = named_attachment_case("the note is model-facing only: the restored bubble does not show it");
    let text = |parts: Vec<Value>| {
        let mut reader = Planted(want["blobs"].as_object().unwrap().clone());
        let mut budget = PASTED_LINE_READ_BUDGET_BYTES;
        user_display_text(&Value::Array(parts), &mut reader, &mut budget)
    };
    let prompt = want["prompt"].as_array().unwrap().clone();
    let mut with_note = prompt.clone();
    with_note.push(json!({ "type": "text", "text": want["note"]["text"], "attachmentReference": want["note"]["attachmentReference"] }));
    assert_eq!(json!(text(with_note)), want["withNote"]);
    assert_eq!(json!(text(prompt)), want["without"]);
}

/// Case "a message record keeps the picked file referenced": the original's reference survives the record's normaliser only when it is a
/// store reference.
#[test]
fn a_message_record_keeps_the_picked_file_referenced_as_node_recorded() {
    let want = named_attachment_case("a message record keeps the picked file referenced");
    let normalized = |offered: &Value| normalize_attachments(Some(offered));
    assert_eq!(Value::Array(normalized(&want["offered"])), json!([want["kept"]]));
    let bare = normalized(&want["refused"]);
    assert_eq!(Value::Array(bare.clone()), json!([want["bare"]]));
    assert_eq!(json!(bare[0].get("original").is_some()), want["bareHasOriginal"]);
}

#[test]
fn the_restored_user_row_keeps_the_attachments_and_malformed_ones_are_dropped_as_node_recorded() {
    let want = observed();
    let mut offered = want["attachments"].as_array().unwrap().clone();
    offered.extend(want["malformed"].as_array().unwrap().iter().cloned());
    assert_eq!(Value::Array(normalize_attachments(Some(&Value::Array(offered)))), want["normalized"]);
    assert_eq!(want["normalized"], want["attachments"]);

    let row = restored_row(&json!({ "role": "user", "content": "hello", "meta": { "transcript": want["persistedMeta"] } }));
    assert_eq!(row["kind"], want["restoredKind"]);
    assert_eq!(row["attachments"], want["restoredAttachments"]);

    let legacy = restored_row(&json!({ "role": "user", "content": "legacy", "meta": { "transcript": { "messageId": "m" } } }));
    assert_eq!(legacy["kind"], want["legacyKind"]);
    assert_eq!(json!(legacy.contains_key("attachments")), want["legacyHasAttachments"], "a legacy row has no attachment records");
}
